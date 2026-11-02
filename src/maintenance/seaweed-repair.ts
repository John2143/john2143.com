/**
 * Seaweed archive repair and audit.
 *
 * The damage: objects were written with a 32-byte header in front of *every*
 * 1 MiB block, so a plaintext of `n` bytes occupies `n + 32 * ceil(n / 1048576)`
 * bytes. De-framing (dropping those headers) reproduces the clean bytes exactly.
 * Every write here is journaled before it starts, verified against an exact size
 * + SHA-256 before it can commit, keeps the previous bytes, and can be undone.
 *
 * Modes
 *   scan          read every flat key once; classify, hash (raw and de-framed),
 *                 find duplicate content. Read-only; the reference for the rest.
 *   from-disk     repair objects from the web pod's disk copy, and evict local
 *                 cache files that are corrupt framings of bytes Seaweed is
 *                 already proven to hold cleanly.
 *   from-seaweed  de-frame objects in place, and restore objects from the Spaces
 *                 copy when Seaweed has no usable bytes.
 *   undo          restore the previous bytes of every write in a run.
 *   audit         diff two scans and require every change to have a matching
 *                 committed journal record.
 *
 * Environment
 *   MODE              required: scan | from-disk | from-seaweed | undo | audit
 *   RUN_ID            required for from-disk, from-seaweed, undo
 *   DRY_RUN           "1" classifies and prints, writes nothing
 *   CONCURRENCY       default 4 (use 1 for from-disk)
 *   JUUSH_DIR         default /app/juushFiles
 *   MAX_OBJECT_BYTES  "0"/unset = no cap
 *   RECENT_MINUTES    default 30: skip documents uploaded more recently
 *   SCAN_KEY          scan report key (from-disk, from-seaweed, audit)
 *   POST_KEY          post-repair scan report key (audit)
 *   ONLY_ACTION       comma list of actions to allow (write actions and/or
 *                     evict-corrupt-cache); empty = all
 *   LIMIT             max committed writes; "0" = no limit
 *   SAMPLE            take at most N de-frame candidates, stratified by blocks
 *   IDS               undo: comma list of ids, or report:<reportKey>
 *   BUCKET, FOLDER    imagehost-files / public-prod
 *   DB, MINIO_*, S3_*  as in the web pods
 *
 * Journal: Mongo `juush.maintenance`, one document per (id, run): the intent,
 * the expected result, and the removed headers (hex) or quarantine key needed to
 * undo it. A `_id: "lease"` document stops two runs overlapping.
 *
 * Manifests: scripts/maintenance/seaweed-repair.job.yaml (home, has Seaweed and
 * Spaces credentials) and seaweed-repair-do.job.yaml (DO, mounts files-pvc).
 */
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform, TransformCallback, Writable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import * as U from "../juush/util.js";
import { putFilerFile } from "../juush/pipeline.js";
import * as C from "./common.js";
import { Report } from "./report.js";

const MODE = (process.env.MODE || "").trim();
const RUN_ID = (process.env.RUN_ID || "").trim();
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4) || 4;
const JUUSH_DIR = process.env.JUUSH_DIR || "/app/juushFiles";
const MAX_OBJECT_BYTES = Number(process.env.MAX_OBJECT_BYTES || 0) || 0;
const RECENT_MINUTES = Number(process.env.RECENT_MINUTES ?? 30);
const SCAN_KEY = (process.env.SCAN_KEY || "").trim();
const POST_KEY = (process.env.POST_KEY || "").trim();
const ONLY_ACTION = (process.env.ONLY_ACTION || "").split(",").map(s => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT || 0) || 0;
const SAMPLE = Number(process.env.SAMPLE || 0) || 0;
const IDS = (process.env.IDS || "").trim();
const BUCKET = process.env.BUCKET || "imagehost-files";
const FOLDER = process.env.FOLDER || "public-prod";

const WRITE_ACTIONS = ["repair-from-disk", "de-frame", "restore-from-spaces"];
const MODES = new Set(["scan", "from-disk", "from-seaweed", "undo", "audit"]);
const EMPTY_SHA = createHash("sha256").digest("hex");

type Doc = { _id: string; mimetype?: string; cdn?: string; artifacts?: { faststart?: string }; uploaddate?: Date };
type ScanItem = {
    k: string;
    S?: number | null;
    raw: C.RawState | "readError";
    sha?: string;
    df?: string;
    n?: number;
    blocks?: number;
    t?: boolean;
    head?: string;
    tail?: string;
    error?: string;
};

type WritePlan = {
    action: string;
    source: () => Promise<Readable>;
    newSize: number;
    newSha: string;
    prevSize: number | null;
    prevSha: string | null;
    prevHeadHex?: string;
    confidence?: "reference" | "plausible";
    captureHeaders?: boolean;
    quarantine?: string;
    spaces?: string;
};

let journal;
let report: Report;
let leaseHolder: string | null = null;
let leaseTimer: ReturnType<typeof setInterval> | null = null;
let leaseLost = false;
let committedThisRun = 0;

const log = (msg: string) => console.log(msg);
const bumpTo = (summary: Record<string, number>, action: string) => {
    summary[action] = (summary[action] || 0) + 1;
};

// ---------------------------------------------------------------- object I/O

const getObject = (key: string, range?: string) =>
    U.minio_client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: range }));

function isMissing(e: unknown): boolean {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
}

function isDenied(e: unknown): boolean {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err?.name === "AccessDenied" || err?.$metadata?.httpStatusCode === 403;
}

/** Reads the first `bytes` of an object. */
async function readHead(key: string, bytes: number): Promise<Buffer> {
    const res = await getObject(key, `bytes=0-${bytes - 1}`);
    const chunks: Buffer[] = [];
    let len = 0;
    for await (const chunk of C.toReadable(res.Body) as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        len += chunk.length;
        if (len >= bytes) break;
    }
    return Buffer.concat(chunks).subarray(0, bytes);
}

/** size + sha256 of a stored object; `null` when it does not exist. */
async function hashObject(key: string): Promise<{ size: number; sha256: string } | null> {
    let res;
    try {
        res = await getObject(key);
    } catch (e) {
        if (isMissing(e)) return null;
        throw e;
    }
    const hash = createHash("sha256");
    let size = 0;
    const src = C.toReadable(res.Body);
    const stop = C.watchdog(src, Number(res.ContentLength) || 0);
    try {
        for await (const chunk of src as AsyncIterable<Buffer>) {
            size += chunk.length;
            hash.update(chunk);
        }
    } finally {
        stop();
    }
    return { size, sha256: hash.digest("hex") };
}

/** Opens an object body with a stall watchdog; the caller must run `stop`. */
async function openSource(key: string): Promise<{ src: Readable; stop: () => void }> {
    const res = await getObject(key);
    const src = C.toReadable(res.Body);
    return { src, stop: C.watchdog(src, Number(res.ContentLength) || 0) };
}

/** A sink that hashes and counts everything written to it. A pipeline's last
 *  element must be a Writable: a Transform with no consumer back-pressures the
 *  whole chain once its readable side buffers 16 KiB. */
function hashingSink(onDone: (bytes: number, sha256: string) => void): Writable {
    const hash = createHash("sha256");
    let bytes = 0;
    return new Writable({
        write(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            hash.update(chunk);
            cb();
        },
        final(cb) {
            onDone(bytes, hash.digest("hex"));
            cb();
        },
    });
}

const discardSink = () => new Writable({ write(_chunk, _enc, cb) { cb(); } });

async function bodyOf(key: string): Promise<Readable> {
    const res = await getObject(key);
    return C.toReadable(res.Body);
}

/** Copies `srcKey` to `destKey`, asserting the exact size and sha256 on the way. */
async function copyVerified(srcKey: string, destKey: string, size: number, sha: string): Promise<void> {
    const guard = new C.Guard(size, sha);
    const settled = pipeline(await bodyOf(srcKey), guard);
    settled.catch(() => {});
    try {
        await putFilerFile(destKey, guard);
        await settled;
    } catch (e) {
        settled.catch(() => {});
        throw e;
    }
}

// ------------------------------------------------------------------- journal

/** Resolves journal records left in `intent` by a crash: commit, abort, or anomaly. */
async function reconcile(summary: Record<string, number>): Promise<void> {
    const pending = await journal.find({ state: "intent" }).toArray();
    for (const rec of pending) {
        const id = String(rec.id);
        const cur = await hashObject(id);
        const base = { k: id, runId: rec.runId };
        if (cur && cur.sha256 === rec.newSha && cur.size === rec.newSize) {
            await journal.updateOne({ _id: rec._id }, { $set: { state: "committed", doneAt: new Date() } });
            if (rec.action === "repair-from-disk") await U.query.index.updateOne({ _id: id }, { $set: { rustfsBackedUp: true } });
            report.item({ ...base, action: "reconciled-commit" });
        } else if ((rec.prevSize === null && !cur) || (cur && cur.sha256 === rec.prevSha)) {
            await journal.updateOne({ _id: rec._id }, { $set: { state: "aborted", doneAt: new Date() } });
            report.item({ ...base, action: "reconciled-aborted" });
        } else {
            await journal.updateOne({ _id: rec._id }, { $set: { state: "anomaly", doneAt: new Date() } });
            // An unresolved write means the storage does not hold what it was given:
            // stop the run (exit 4) instead of continuing to write around it.
            summary.anomaly = (summary.anomaly || 0) + 1;
            report.item({ ...base, action: "reconciled-anomaly", error: "stored bytes match neither the intent nor the previous object" });
        }
    }
}

async function acquireLease(): Promise<void> {
    leaseHolder = `${MODE}:${RUN_ID}`;
    const stale = new Date(Date.now() - 300_000);
    // Upsert so the first run creates the lease; a live lease makes the upsert
    // collide on _id (E11000), which is the "someone else holds it" signal.
    try {
        await journal.updateOne(
            { _id: "lease", $or: [{ heartbeat: { $lt: stale } }, { holder: { $exists: false } }] },
            { $set: { holder: leaseHolder, heartbeat: new Date() } },
            { upsert: true },
        );
    } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
    }
    const cur = await journal.findOne({ _id: "lease" });
    if (cur?.holder !== leaseHolder) {
        console.error(`lease held by ${cur?.holder ?? "unknown"}`);
        process.exit(3);
    }
    leaseTimer = setInterval(() => {
        void journal.updateOne({ _id: "lease", holder: leaseHolder }, { $set: { heartbeat: new Date() } })
            .then((r: { matchedCount: number }) => {
                if (r.matchedCount === 0) leaseLost = true;
            })
            .catch(() => {
                leaseLost = true;
            });
    }, 60_000);
}

async function releaseLease(): Promise<void> {
    clearInterval(leaseTimer);
    leaseTimer = null;
    if (leaseHolder) await journal.deleteOne({ _id: "lease", holder: leaseHolder }).catch(() => {});
    leaseHolder = null;
}

// ------------------------------------------------------------ write protocol

const quarantineKeyFor = (id: string) => `damaged/${id}/${RUN_ID}`;

/**
 * Journal the intent, quarantine the current bytes, write through a Guard, then
 * verify by re-reading. Returns the action name recorded in the report.
 */
async function performWrite(id: string, plan: WritePlan): Promise<string> {
    const key = `${id}|${RUN_ID}`;
    const base = { k: id, action: plan.action, newSize: plan.newSize, newSha: plan.newSha, only: DRY_RUN ? 1 : 0 };
    if (MAX_OBJECT_BYTES > 0 && plan.newSize > MAX_OBJECT_BYTES) return "deferred-too-large";
    if (leaseLost) throw new Error("lease lost");

    if (DRY_RUN) {
        report.item({ ...base, prevSize: plan.prevSize, prevSha: plan.prevSha, confidence: plan.confidence });
        return plan.action;
    }

    await journal.insertOne({
        _id: key,
        id,
        runId: RUN_ID,
        mode: MODE,
        action: plan.action,
        state: "intent",
        confidence: plan.confidence,
        prevSize: plan.prevSize,
        prevSha: plan.prevSha,
        prevHead: plan.prevHeadHex,
        newSize: plan.newSize,
        newSha: plan.newSha,
        quarantine: plan.quarantine,
        spaces: plan.spaces,
        at: new Date(),
    });

    try {
        // Undo restores `prev` from the journal, so it must describe what is actually being
        // replaced. Quarantined writes check this in copyVerified and de-frames through their
        // Guard (the live object is the source); the rest replace an absent or <=32-byte object.
        if (!plan.quarantine && !plan.captureHeaders) {
            const cur = await hashObject(id);
            const same = plan.prevSize === null ? !cur : !!cur && cur.sha256 === plan.prevSha && cur.size === plan.prevSize;
            if (!same) {
                const error = `changed since scan (now ${cur ? `${cur.size} bytes` : "absent"})`;
                await journal.updateOne({ _id: key }, { $set: { state: "aborted", doneAt: new Date(), error } });
                report.item({ ...base, action: "skipped-changed", error });
                return "skipped-changed";
            }
        }

        if (plan.quarantine) {
            await copyVerified(id, plan.quarantine, plan.prevSize as number, plan.prevSha as string);
            const check = await hashObject(plan.quarantine);
            if (!check || check.sha256 !== plan.prevSha || check.size !== plan.prevSize) {
                await journal.updateOne({ _id: key }, { $set: { state: "aborted", doneAt: new Date(), error: "quarantine verify mismatch" } });
                report.item({ ...base, error: "quarantine verify mismatch" });
                return "failed";
            }
        }

        const guard = new C.Guard(plan.newSize, plan.newSha);
        let headersHex: string | undefined;
        const src = await plan.source();
        const settled = plan.captureHeaders
            ? pipeline(src, new C.DeFramer(h => {
                headersHex = h.toString("hex");
            }), guard)
            : pipeline(src, guard);
        settled.catch(() => {});
        try {
            await putFilerFile(id, guard);
            await settled;
        } catch (e) {
            settled.catch(() => {});
            // lib-storage sends a single PUT only after the body ends and completes a multipart
            // upload only after every part succeeded, and the Guard ends its body only once the
            // size and sha256 matched. A body that never ended therefore never reached the store.
            // A fully consumed body followed by an error (e.g. a lost response) is ambiguous.
            if (!guard.readableEnded) {
                await journal.updateOne({ _id: key }, { $set: { state: "aborted", doneAt: new Date(), error: String((e as Error)?.message ?? e) } });
                report.item({ ...base, error: String((e as Error)?.message ?? e) });
                return "failed";
            }
            throw new UnresolvedWrite(e);
        }
        // Before verifying, so a write that reconcile() later finds committed can still be undone.
        if (headersHex) await journal.updateOne({ _id: key }, { $set: { headers: headersHex } });

        let check;
        try {
            check = await hashObject(id);
        } catch (e) {
            throw new UnresolvedWrite(e);
        }
        if (!check || check.sha256 !== plan.newSha || check.size !== plan.newSize) {
            await journal.updateOne({ _id: key }, { $set: { state: "anomaly", doneAt: new Date(), error: "verify mismatch" } });
            report.item({ ...base, error: "verify mismatch" });
            return "anomaly";
        }
        await journal.updateOne({ _id: key }, { $set: { state: "committed", doneAt: new Date() } });
        if (plan.action === "repair-from-disk") {
            await U.query.index.updateOne({ _id: id }, { $set: { rustfsBackedUp: true } });
        }
        committedThisRun++;
        report.item({ ...base, prevSize: plan.prevSize, prevSha: plan.prevSha, confidence: plan.confidence });
        return plan.action;
    } catch (e) {
        if (e instanceof UnresolvedWrite) {
            // The store may hold either version: keep the intent (it blocks further writes to this
            // id) and let reconcile() at the start of the next writing run settle it by reading.
            const error = String((e.cause as Error)?.message ?? e.cause);
            await journal.updateOne({ _id: key }, { $set: { error } }).catch(() => {});
            report.item({ ...base, action: "unresolved", error });
            return "unresolved";
        }
        await journal.updateOne({ _id: key }, { $set: { state: "aborted", doneAt: new Date(), error: String((e as Error)?.message ?? e) } }).catch(() => {});
        report.item({ ...base, error: String((e as Error)?.message ?? e) });
        return "failed";
    }
}

/** A write whose outcome is unknown: the store may hold either the previous or the new bytes. */
class UnresolvedWrite extends Error {
    constructor(cause: unknown) {
        super("unresolved write", { cause });
    }
}

// ------------------------------------------------------------------- loading

async function loadDocs(): Promise<Map<string, Doc>> {
    const docs = await U.query.index
        .find({ mimetype: { $ne: "deleted" } }, { projection: { mimetype: 1, cdn: 1, "artifacts.faststart": 1, uploaddate: 1 } })
        .toArray();
    const map = new Map<string, Doc>();
    for (const d of docs as Doc[]) map.set(d._id, d);
    return map;
}

type ScanData = { items: Map<string, ScanItem>; duplicates: Set<string>; startedAt: string | null };

async function loadScan(key: string): Promise<ScanData> {
    const res = await getObject(key);
    const rl = readline.createInterface({ input: C.toReadable(res.Body), crlfDelay: Infinity });
    const items = new Map<string, ScanItem>();
    const duplicates = new Set<string>();
    let startedAt: string | null = null;
    for await (const line of rl) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.k === "#scan") {
            startedAt = obj.startedAt ?? null;
        } else if (obj.k === "#dup") {
            duplicates.add(obj.h);
        } else if (obj.k && !String(obj.k).startsWith("#") && obj.raw) {
            items.set(obj.k, obj as ScanItem);
        }
    }
    return { items, duplicates, startedAt };
}

const isRecent = (doc: Doc | undefined): boolean =>
    !!doc?.uploaddate && Date.now() - new Date(doc.uploaddate).getTime() < RECENT_MINUTES * 60_000;

const actionAllowed = (action: string): boolean => ONLY_ACTION.length === 0 || ONLY_ACTION.includes(action);

function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

async function retrying<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            if (attempt < tries) await new Promise(r => setTimeout(r, 5000 * attempt));
        }
    }
    throw last;
}

// ---------------------------------------------------------------------- scan

async function scanObject(key: string, size: number, doc: Doc | undefined): Promise<ScanItem> {
    const mime = doc?.mimetype;
    if (size === 0) return { k: key, S: 0, raw: "empty", sha: EMPTY_SHA, head: "" };
    const head = await readHead(key, Math.min(size, C.HEAD_LEN));
    const state = C.rawState(mime, size, head);

    if (size <= C.FRAME_HDR) {
        const small = await hashObject(key);
        return { k: key, S: size, raw: state, sha: small?.sha256, head: head.toString("hex"), tail: head.toString("hex") };
    }

    const rawHash = createHash("sha256");
    let tail = Buffer.alloc(0);
    const meter = new Transform({
        transform(chunk: Buffer, _enc, cb: TransformCallback) {
            rawHash.update(chunk);
            tail = Buffer.concat([tail, chunk.subarray(Math.max(0, chunk.length - 16))]).subarray(-16);
            cb(null, chunk);
        },
    });

    if (state === "framed") {
        let dfBytes = 0;
        let dfSha = "";
        let blocks = 0;
        const deFramer = new C.DeFramer((_h, b) => {
            blocks = b;
        });
        const dfSink = hashingSink((bytes, sha) => {
            dfBytes = bytes;
            dfSha = sha;
        });
        const source = await openSource(key);
        try {
            await pipeline(source.src, meter, deFramer, dfSink);
        } finally {
            source.stop();
        }
        return {
            k: key,
            S: size,
            raw: state,
            sha: rawHash.digest("hex"),
            df: dfSha,
            n: dfBytes,
            blocks,
            t: C.typeMatches(mime, C.contentKind(head.subarray(C.FRAME_HDR))),
            head: head.toString("hex"),
            tail: tail.toString("hex"),
        };
    }

    const source = await openSource(key);
    try {
        await pipeline(source.src, meter, discardSink());
    } finally {
        source.stop();
    }
    return { k: key, S: size, raw: state, sha: rawHash.digest("hex"), head: head.toString("hex"), tail: tail.toString("hex") };
}

async function runScan(): Promise<Record<string, unknown>> {
    const keys = await C.listFlatKeys(U.minio_client, BUCKET);
    const docs = await loadDocs();
    report.line({ k: "#scan", mode: "scan", dryRun: DRY_RUN ? 1 : 0, startedAt: report.startedAt.toISOString(), keys: keys.size });

    const summary: Record<string, number> = {
        clean: 0,
        framed: 0,
        framedTypeMismatch: 0,
        empty: 0,
        junk: 0,
        missing: 0,
        "unknown-magic": 0,
        readError: 0,
        orphans: 0,
        framedBytes: 0,
        duplicateKeys: 0,
        duplicateGroups: 0,
        totalKeys: keys.size,
    };
    const hashCount = new Map<string, number>();
    const entries: { sha?: string; df?: string; raw: string }[] = [];
    let done = 0;

    await C.runPool([...keys.entries()], CONCURRENCY, async ([key, size]) => {
        const doc = docs.get(key);
        if (!doc) summary.orphans++;
        let item: ScanItem;
        try {
            item = await retrying(() => scanObject(key, size, doc));
        } catch (e) {
            summary.readError++;
            report.item({ k: key, action: "readError", error: String((e as Error)?.message ?? e) });
            report.line({ k: key, S: size, raw: "readError", error: String((e as Error)?.message ?? e) });
            return;
        }
        summary[item.raw]++;
        if (item.raw === "framed") {
            summary.framedBytes += item.S || 0;
            if (item.t === false) summary.framedTypeMismatch++;
        }
        report.line(item);
        entries.push({ sha: item.sha, df: item.df, raw: item.raw });
        for (const h of [item.sha, item.df]) if (h) hashCount.set(h, (hashCount.get(h) || 0) + 1);
        if (++done % 500 === 0) report.progress({ scanned: done, total: keys.size });
    });

    for (const [id, doc] of docs) {
        if (keys.has(id)) continue;
        summary.missing++;
        report.line({ k: id, S: null, raw: "missing", mimetype: doc.mimetype });
        entries.push({ raw: "missing" });
    }

    const dupHashes = new Set<string>();
    for (const [h, n] of hashCount) if (n > 1) dupHashes.add(h);
    summary.duplicateGroups = dupHashes.size;
    for (const e of entries) {
        if (e.raw !== "framed") continue;
        if ((e.sha && dupHashes.has(e.sha)) || (e.df && dupHashes.has(e.df))) summary.duplicateKeys++;
    }
    for (const h of dupHashes) report.line({ k: "#dup", h, n: hashCount.get(h) });

    log(`scan: ${JSON.stringify(summary)}`);
    return summary;
}

// ----------------------------------------------------------------- from-disk

async function firstBytesOfFile(filePath: string, bytes: number): Promise<Buffer> {
    // `end` is inclusive, so a zero-byte file would give end -1, which createReadStream rejects.
    if (bytes <= 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    const input = createReadStream(filePath, { start: 0, end: bytes - 1 });
    for await (const chunk of input as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length >= bytes) break;
    }
    return Buffer.concat(chunks).subarray(0, bytes);
}

async function deFramedShaOfFile(filePath: string): Promise<{ size: number; sha256: string; blocks: number }> {
    let size = 0;
    let blocks = 0;
    const deFramer = new C.DeFramer((_h, b) => {
        blocks = b;
    });
    let sha = "";
    await pipeline(createReadStream(filePath), deFramer, hashingSink((bytes, digest) => {
        size = bytes;
        sha = digest;
    }));
    return { size, sha256: sha, blocks };
}

async function runFromDisk(): Promise<Record<string, unknown>> {
    const scan = await loadScan(SCAN_KEY);
    const docs = await loadDocs();
    const summary: Record<string, number> = {};
    await reconcile(summary);

    const committed = new Map<string, string>();
    for (const rec of await journal.find({ state: "committed" }, { projection: { id: 1, newSha: 1, at: 1 } }).sort({ at: 1 }).toArray()) {
        committed.set(String(rec.id), String(rec.newSha));
    }
    const unresolved = new Set<string>();
    for (const rec of await journal.find({ state: { $in: ["intent", "anomaly"] } }, { projection: { id: 1 } }).toArray()) {
        unresolved.add(String(rec.id));
    }

    const names = (await fs.readdir(JUUSH_DIR)).filter(n => !n.startsWith(".") && !n.endsWith(".dl"));
    log(`from-disk: ${names.length} local files in ${JUUSH_DIR}`);

    await C.runPool(names, CONCURRENCY, async id => {
        const doc = docs.get(id);
        if (!doc) return bumpTo(summary, "no-doc");
        if (unresolved.has(id)) return bumpTo(summary, "blocked-unresolved");
        const filePath = path.join(JUUSH_DIR, id);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat || !stat.isFile()) return bumpTo(summary, "local-missing");
        const scanItem = scan.items.get(id);
        // Every document that existed when the scan started has a row (`missing` included), so
        // no row means a newer upload: the scan says nothing about its object, so leave it alone.
        if (!scanItem) return bumpTo(summary, "not-in-scan");
        if (scanItem.raw === "readError") return bumpTo(summary, "unreadable");

        const head = await firstBytesOfFile(filePath, Math.min(stat.size, C.HEAD_LEN));
        const localState = C.rawState(doc.mimetype, stat.size, head);

        if (localState === "clean") {
            const local = await C.sha256HexOfFile(filePath);
            if (committed.get(id) === local.sha256) return bumpTo(summary, "ok");
            if (scanItem?.raw === "clean" && scanItem.sha === local.sha256) return bumpTo(summary, "ok");
            if (RECENT_MINUTES > 0 && Date.now() - stat.mtimeMs < RECENT_MINUTES * 60_000) return bumpTo(summary, "skipped-recent");
            if (!actionAllowed("repair-from-disk")) return bumpTo(summary, "skipped-by-filter");
            // "missing" means there is no object at all; every other state has bytes
            // that undo must be able to put back.
            const absent = scanItem.raw === "missing";
            const prevSize = absent ? null : (scanItem?.S ?? null);
            const prevSha = absent ? null : (scanItem?.sha ?? null);
            const action = await performWrite(id, {
                action: "repair-from-disk",
                source: async () => createReadStream(filePath),
                newSize: local.size,
                newSha: local.sha256,
                prevSize,
                prevSha,
                prevHeadHex: prevSize !== null && prevSize <= C.FRAME_HDR ? scanItem?.head : undefined,
                quarantine: prevSize !== null && prevSha ? quarantineKeyFor(id) : undefined,
            });
            return bumpTo(summary, action);
        }

        if (localState === "framed") {
            const df = await deFramedShaOfFile(filePath);
            const known = committed.get(id) === df.sha256 || (scanItem?.raw === "clean" && scanItem.sha === df.sha256);
            if (!known) return bumpTo(summary, "local-prefixed-unmatched");
            if (!actionAllowed("evict-corrupt-cache")) return bumpTo(summary, "skipped-by-filter");
            if (!DRY_RUN) await fs.unlink(filePath);
            report.item({ k: id, action: "evict-corrupt-cache", bytes: stat.size, blocks: df.blocks, only: DRY_RUN ? 1 : 0 });
            return bumpTo(summary, "evict-corrupt-cache");
        }

        return bumpTo(summary, "local-unknown-format");
    });

    log(`from-disk: ${JSON.stringify(summary)}`);
    return summary;
}

// --------------------------------------------------------------- from-seaweed

/** Hashes the Spaces copy of `id` without keeping it: the independent reference. */
async function spacesReference(id: string): Promise<{ sha256: string; size: number } | "absent" | "denied"> {
    const key = `${FOLDER}/${id}`;
    let size: number;
    try {
        const head = await U.s3_client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        size = Number(head.ContentLength ?? -1);
        if (!(size > 0)) return "absent";
    } catch (e) {
        return isDenied(e) ? "denied" : "absent";
    }
    try {
        const res = await U.s3_client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of C.toReadable(res.Body) as AsyncIterable<Buffer>) {
            bytes += chunk.length;
            hash.update(chunk);
        }
        if (bytes !== size) return "absent";
        return { sha256: hash.digest("hex"), size };
    } catch (e) {
        return isDenied(e) ? "denied" : "absent";
    }
}

/** Downloads a Spaces object to a temp file while hashing it, after validating it. */
async function fetchSpacesCopy(
    id: string,
    mime: string | undefined,
): Promise<{ filePath: string; size: number; sha256: string } | "lost" | "denied" | "bad-magic"> {
    const key = `${FOLDER}/${id}`;
    let head;
    try {
        head = await U.s3_client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (e) {
        return isDenied(e) ? "denied" : "lost";
    }
    const size = Number(head.ContentLength ?? -1);
    if (!(size > 0)) return "lost";
    const allowed = C.allowedKinds(mime);
    const contentType = String(head.ContentType || "");
    if (allowed[0] !== "*" && /^(image|video)\//.test(contentType)) {
        const docFamily = String(mime || "").split("/")[0];
        if (docFamily && contentType.split("/")[0] !== docFamily) return "lost";
    }
    const tmp = path.join(os.tmpdir(), `srr-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let bytes = 0;
    let sha = "";
    const meter = new C.Tap((n, digest) => {
        bytes = n;
        sha = digest;
    });
    try {
        const res = await U.s3_client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        await pipeline(C.toReadable(res.Body), meter, createWriteStream(tmp));
    } catch (e) {
        await fs.unlink(tmp).catch(() => {});
        return isDenied(e) ? "denied" : "lost";
    }
    if (bytes !== size) {
        await fs.unlink(tmp).catch(() => {});
        return "lost";
    }
    if (allowed[0] !== "*") {
        const kind = C.contentKind(await firstBytesOfFile(tmp, C.HEAD_LEN));
        if (kind === "other" || !allowed.includes(kind)) {
            await fs.unlink(tmp).catch(() => {});
            return "bad-magic";
        }
    }
    return { filePath: tmp, size, sha256: sha };
}

function stratified<T extends { blocks?: number }>(items: T[], n: number): T[] {
    if (n <= 0 || items.length <= n) return items;
    const single: T[] = [];
    const mid: T[] = [];
    const big: T[] = [];
    for (const it of items) {
        const b = it.blocks || 1;
        if (b === 1) single.push(it);
        else if (b <= 16) mid.push(it);
        else big.push(it);
    }
    shuffle(big);
    shuffle(mid);
    shuffle(single);
    const wantBig = Math.min(big.length, Math.max(5, Math.floor(n * 0.1)));
    const wantMid = Math.min(mid.length, Math.max(20, Math.floor(n * 0.3)));
    return [...big.slice(0, wantBig), ...mid.slice(0, wantMid), ...single].slice(0, n);
}

/** True when the de-framed tail still holds the format's end marker. */
function endMarkerIntact(headHex: string, tailHex: string): boolean {
    const kind = C.contentKind(Buffer.from(headHex.slice(C.FRAME_HDR * 2), "hex"));
    const tail = Buffer.from(tailHex, "hex");
    switch (kind) {
        case "png":
            // IEND chunk: 4-byte zero length + "IEND" + CRC.
            return tail.length >= 12 && tail.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"));
        case "jpeg":
            return tail.length >= 2 && tail.subarray(-2).equals(Buffer.from("ffd9", "hex"));
        case "gif":
            return tail.length >= 1 && tail.subarray(-1)[0] === 0x3b;
        case "webp":
            return tail.length >= 4 && tail.subarray(-4).equals(Buffer.alloc(4));
        default:
            return true;
    }
}

async function runFromSeaweed(): Promise<Record<string, unknown>> {
    const scan = await loadScan(SCAN_KEY);
    const docs = await loadDocs();
    const summary: Record<string, number> = {};
    await reconcile(summary);

    // A commit made after the scan started makes the scan's row for that id stale (e.g. scan1 →
    // from-disk → from-seaweed): it is done. A commit the scan already saw counts as done only
    // while the scanned bytes are still what was written; otherwise the id is a candidate again.
    const scanStarted = scan.startedAt ? new Date(scan.startedAt).getTime() : Infinity;
    const committedState = new Map<string, { newSha: string; newSize: number; at: number }>();
    for (const rec of await journal.find({ state: "committed" }, { projection: { id: 1, newSha: 1, newSize: 1, at: 1 } }).sort({ at: 1 }).toArray()) {
        committedState.set(String(rec.id), { newSha: String(rec.newSha), newSize: Number(rec.newSize), at: new Date(rec.at).getTime() });
    }
    const blockedIds = new Set<string>();
    for (const rec of await journal.find({ state: { $in: ["intent", "anomaly"] } }, { projection: { id: 1 } }).toArray()) blockedIds.add(String(rec.id));

    type Candidate = { id: string; item: ScanItem; doc: Doc; action: string; blocks?: number };
    const candidates: Candidate[] = [];
    const skipped: Record<string, number> = {};
    const skip = (why: string) => {
        skipped[why] = (skipped[why] || 0) + 1;
    };

    for (const [id, item] of scan.items) {
        const past = committedState.get(id);
        if (past && (past.at >= scanStarted || (item.sha === past.newSha && Number(item.S ?? -1) === past.newSize))) {
            skip("already-committed");
            continue;
        }
        if (blockedIds.has(id)) {
            report.item({ k: id, action: "blocked-unresolved", only: DRY_RUN ? 1 : 0 });
            continue;
        }
        const doc = docs.get(id);
        if (!doc) {
            skip("no-doc");
            continue;
        }
        if (isRecent(doc)) {
            skip("recent");
            continue;
        }
        if (item.raw === "readError") {
            report.item({ k: id, action: "unreadable", error: item.error, only: DRY_RUN ? 1 : 0 });
            continue;
        }
        if (item.raw === "clean") continue;
        if (item.raw === "framed") {
            if (item.n === undefined || !item.df) {
                report.item({ k: id, action: "skipped-suspect", reason: "shape", only: DRY_RUN ? 1 : 0 });
                continue;
            }
            candidates.push({ id, item, doc, action: "de-frame", blocks: item.blocks });
            continue;
        }
        candidates.push({ id, item, doc, action: "restore-from-spaces", blocks: 1 });
    }

    const selected = SAMPLE > 0 ? stratified(candidates.filter(c => c.action === "de-frame"), SAMPLE) : candidates;
    log(`from-seaweed: ${selected.length} candidates (${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(" ") || "none skipped"})`);

    const suspect = (reason: string) => {
        summary[`suspect-${reason}`] = (summary[`suspect-${reason}`] || 0) + 1;
        bumpTo(summary, "skipped-suspect");
    };

    await C.runPool(selected, CONCURRENCY, async cand => {
        const { id, item, doc } = cand;
        const only = { only: DRY_RUN ? 1 : 0 };
        if (LIMIT > 0 && committedThisRun >= LIMIT) {
            report.item({ k: id, action: "skipped-by-limit", ...only });
            return bumpTo(summary, "skipped-by-limit");
        }
        if (!actionAllowed(cand.action)) {
            report.item({ k: id, action: "skipped-by-filter", intended: cand.action, ...only });
            return bumpTo(summary, "skipped-by-filter");
        }

        if (cand.action === "de-frame") {
            const newSize = C.framedPlainLen(Number(item.S)) ?? item.n ?? 0;
            const newSha = String(item.df);
            let confidence: "reference" | "plausible" | null = null;

            if (doc.cdn) {
                const ref = await spacesReference(id);
                if (ref === "denied") {
                    report.item({ k: id, action: "spaces-denied", ...only });
                    return bumpTo(summary, "spaces-denied");
                }
                if (ref !== "absent" && ref.sha256 === newSha && ref.size === newSize) confidence = "reference";
            }
            if (!confidence) {
                if (item.t === false) {
                    report.item({ k: id, action: "skipped-suspect", reason: "type", ...only });
                    return suspect("type");
                }
                if ((item.sha && scan.duplicates.has(item.sha)) || scan.duplicates.has(newSha)) {
                    report.item({ k: id, action: "skipped-suspect", reason: "duplicate", ...only });
                    return suspect("duplicate");
                }
                if (!endMarkerIntact(String(item.head || ""), String(item.tail || ""))) {
                    report.item({ k: id, action: "skipped-suspect", reason: "truncated", ...only });
                    return suspect("truncated");
                }
                confidence = "plausible";
            }

            const action = await performWrite(id, {
                action: "de-frame",
                source: () => bodyOf(id),
                newSize,
                newSha,
                prevSize: Number(item.S),
                prevSha: String(item.sha),
                confidence,
                captureHeaders: true,
            });
            return bumpTo(summary, action);
        }

        // restore-from-spaces
        if (!U.s3_client) {
            report.item({ k: id, action: "lost", reason: "no-spaces-client", ...only });
            return bumpTo(summary, "lost");
        }
        if (doc.artifacts?.faststart) {
            report.item({ k: id, action: "skipped-faststart", ...only });
            return bumpTo(summary, "skipped-faststart");
        }
        const got = await fetchSpacesCopy(id, doc.mimetype);
        if (got === "denied") {
            report.item({ k: id, action: "spaces-denied", ...only });
            return bumpTo(summary, "spaces-denied");
        }
        if (got !== "lost" && got !== "bad-magic") {
            try {
                const prevSize = item.S ?? null;
                const prevSha = item.sha ?? null;
                const action = await performWrite(id, {
                    action: "restore-from-spaces",
                    source: async () => createReadStream(got.filePath),
                    newSize: got.size,
                    newSha: got.sha256,
                    prevSize,
                    prevSha,
                    prevHeadHex: prevSize !== null && prevSize > 0 && prevSize <= C.FRAME_HDR ? item.head : undefined,
                    confidence: "reference",
                    quarantine: item.raw === "unknown-magic" && prevSize !== null && prevSha ? quarantineKeyFor(id) : undefined,
                    spaces: `${FOLDER}/${id}`,
                });
                return bumpTo(summary, action);
            } finally {
                await fs.unlink(got.filePath).catch(() => {});
            }
        }
        const action = got === "bad-magic" && item.raw === "unknown-magic" ? "unrepairable-bad-magic" : "lost";
        report.item({ k: id, action, reason: got, ...only });
        return bumpTo(summary, action);
    });

    for (const [k, v] of Object.entries(skipped)) summary[`skipped-${k}`] = v;
    log(`from-seaweed: ${JSON.stringify(summary)}`);
    return summary;
}

// ---------------------------------------------------------------------- undo

/** Ids of the committed writes listed in a write-run report. */
async function idsFromReport(key: string): Promise<string[]> {
    const res = await getObject(key);
    const rl = readline.createInterface({ input: C.toReadable(res.Body), crlfDelay: Infinity });
    const out: string[] = [];
    for await (const line of rl) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.k && WRITE_ACTIONS.includes(obj.action) && !obj.error) out.push(String(obj.k));
    }
    return out;
}

async function runUndo(): Promise<Record<string, unknown>> {
    const ids = IDS.startsWith("report:") ? await idsFromReport(IDS.slice("report:".length)) : IDS.split(",").map(s => s.trim()).filter(Boolean);
    const summary: Record<string, number> = {};
    log(`undo: ${ids.length} ids`);

    await C.runPool(ids, CONCURRENCY, async id => {
        const only = { only: DRY_RUN ? 1 : 0 };
        const rec = await journal.findOne({ id, state: { $in: ["committed", "unverified"] } }, { sort: { at: -1 } });
        if (!rec) {
            report.item({ k: id, action: "undo-no-record", ...only });
            return bumpTo(summary, "undo-no-record");
        }
        const cur = await hashObject(id);
        if (!cur || cur.sha256 !== rec.newSha || cur.size !== rec.newSize) {
            report.item({ k: id, action: "undo-skipped-modified", ...only });
            return bumpTo(summary, "undo-skipped-modified");
        }
        if (DRY_RUN) {
            report.item({ k: id, action: "undone", prevSize: rec.prevSize, prevSha: rec.prevSha, ...only });
            return bumpTo(summary, "undone");
        }
        try {
            if (rec.headers) {
                const guard = new C.Guard(rec.prevSize, rec.prevSha);
                const settled = pipeline(await bodyOf(id), C.makeReFramer(Buffer.from(String(rec.headers), "hex")), guard);
                settled.catch(() => {});
                await putFilerFile(id, guard);
                await settled;
            } else if (rec.quarantine) {
                await copyVerified(String(rec.quarantine), id, rec.prevSize, rec.prevSha);
            } else if (rec.prevSize === null || rec.prevSize === 0) {
                await U.minio_client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: id }));
                if (await hashObject(id)) throw new Error("delete did not remove the object");
            } else {
                const guard = new C.Guard(rec.prevSize, rec.prevSha);
                const settled = pipeline(Readable.from([Buffer.from(String(rec.prevHead ?? ""), "hex")]), guard);
                settled.catch(() => {});
                await putFilerFile(id, guard);
                await settled;
            }
            const after = await hashObject(id);
            const ok = rec.prevSize === null || rec.prevSize === 0 ? !after : after?.sha256 === rec.prevSha;
            if (!ok) throw new Error("undo verify mismatch");
            await journal.updateOne({ _id: rec._id }, { $set: { state: "undone", undoneAt: new Date() } });
            if (rec.mode === "from-disk") await U.query.index.updateOne({ _id: id }, { $unset: { rustfsBackedUp: "" } });
            report.item({ k: id, action: "undone", runId: rec.runId, prevSize: rec.prevSize });
            return bumpTo(summary, "undone");
        } catch (e) {
            report.item({ k: id, action: "undo-failed", error: String((e as Error)?.message ?? e) });
            return bumpTo(summary, "undo-failed");
        }
    });

    return summary;
}

// --------------------------------------------------------------------- audit

async function runAudit(): Promise<Record<string, unknown>> {
    const pre = await loadScan(SCAN_KEY);
    const post = await loadScan(POST_KEY);
    const docs = await loadDocs();
    const summary: Record<string, number> = { unexplained: 0, journalMismatch: 0, newKeys: 0, removedKeys: 0, changedKeys: 0, readErrors: 0 };

    const explain = new Map<string, { prevSha: string | null; newSha: string }[]>();
    for (const rec of await journal.find({ state: "committed" }).toArray()) {
        const list = explain.get(String(rec.id)) ?? [];
        list.push({ prevSha: rec.prevSha ?? null, newSha: String(rec.newSha) });
        explain.set(String(rec.id), list);
    }
    const preStarted = pre.startedAt ? new Date(pre.startedAt).getTime() : 0;

    for (const k of new Set<string>([...pre.items.keys(), ...post.items.keys()])) {
        const a = pre.items.get(k);
        const b = post.items.get(k);
        if (a?.raw === "readError" || b?.raw === "readError") {
            summary.readErrors++;
            report.item({ k, action: "audit-read-error" });
            continue;
        }
        if (!b) {
            summary.removedKeys++;
            report.item({ k, action: "audit-removed" });
            continue;
        }
        if (!a) {
            summary.newKeys++;
            const doc = docs.get(k);
            const live = !!doc?.uploaddate && new Date(doc.uploaddate).getTime() > preStarted;
            const journaled = (explain.get(k) ?? []).some(r => r.prevSha === null && r.newSha === b.sha);
            if (live || journaled || k.includes(".")) continue;
            summary.unexplained++;
            report.item({ k, action: "audit-unexplained", why: "new key with no journal record" });
            continue;
        }
        if (a.sha === b.sha && a.S === b.S) continue;
        summary.changedKeys++;
        const recs = explain.get(k) ?? [];
        if (recs.some(r => r.prevSha === (a.sha ?? null) && r.newSha === b.sha)) continue;
        if (recs.length > 0) summary.journalMismatch++;
        summary.unexplained++;
        report.item({ k, action: "audit-unexplained", why: `${a.sha} -> ${b.sha}`, recs: recs.length });
    }

    try {
        const mp = await U.minio_client.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, MaxUploads: 50 }));
        summary.staleMultipartUploads = (mp.Uploads || []).filter(u => u.Initiated && Date.now() - new Date(u.Initiated).getTime() > 24 * 3600_000).length;
    } catch (e) {
        summary.staleMultipartUploads = -1;
        log(`audit: multipart listing failed: ${(e as Error).message}`);
    }

    log(`audit: ${JSON.stringify(summary)}`);
    return summary;
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
    if (!MODES.has(MODE)) {
        console.error(`MODE must be one of ${[...MODES].join(", ")} (got "${MODE}")`);
        process.exit(2);
    }
    if (MODE !== "scan" && MODE !== "audit" && !RUN_ID) {
        console.error("RUN_ID is required");
        process.exit(2);
    }
    if (["from-disk", "from-seaweed", "audit"].includes(MODE) && !SCAN_KEY) {
        console.error("SCAN_KEY is required");
        process.exit(2);
    }
    if (MODE === "audit" && !POST_KEY) {
        console.error("POST_KEY is required");
        process.exit(2);
    }
    if (MODE === "undo" && !IDS) {
        console.error("IDS is required");
        process.exit(2);
    }

    report = new Report({ mode: MODE, dryRun: DRY_RUN, runId: RUN_ID });
    log(`seaweed-repair mode=${MODE} run=${RUN_ID || "-"} dryRun=${DRY_RUN ? 1 : 0} bucket=${BUCKET} folder=${FOLDER} concurrency=${CONCURRENCY}`);
    let code = 0;
    try {
        await U.startdb();
        if (!U.minio_client) throw new Error("minio_client not configured (set MINIO_ENDPOINT_URL)");
        journal = U.mongoclient.db("juush").collection("maintenance");
        await journal.createIndex({ runId: 1, state: 1 }).catch(() => {});
        await journal.createIndex({ id: 1, at: -1 }).catch(() => {});
        if (MODE !== "scan" && MODE !== "audit") await acquireLease();

        const summary = MODE === "scan" ? await runScan()
            : MODE === "from-disk" ? await runFromDisk()
            : MODE === "from-seaweed" ? await runFromSeaweed()
            : MODE === "undo" ? await runUndo()
            : await runAudit();

        if (Number(summary.anomaly || 0) > 0) code = 4;
        await report.finish(summary);
    } catch (e) {
        console.error(`FATAL ${(e as Error)?.stack ?? e}`);
        code = 1;
        try {
            await report.finish({ error: String((e as Error)?.message ?? e) });
        } catch (_) {}
    }
    await releaseLease().catch(() => {});
    await U.mongoclient.close().catch(() => {});
    await new Promise(r => setTimeout(r, 250));
    process.exit(code);
}

void main();
