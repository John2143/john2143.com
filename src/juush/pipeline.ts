/**
 * Upload pipeline helpers shared by web pods (filer ingest, reconciler, shutdown
 * flush) and worker pods (filer download, ffmpeg).
 *
 * The only queue is Temporal: ProcessUploadWorkflow ingests the file from the disk
 * that holds it (per-volume task queue), then a worker builds the CDN copy and
 * video artifacts. Mongo only records state.
 */
import { serverLog } from "../logger.js";
import * as U from "./util.js";
import { startUploadWorkflow } from "./temporal/client.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const RECONCILE_MS = 60_000;
// An upload's workflow normally starts right after the response; only docs this old
// without a workflow are picked up, so an in-flight start is never duplicated.
const RECONCILE_MIN_AGE_MS = 10 * 60_000;

export function getCdnUrl(url: string): string {
    const folder = process.env.FOLDER || "public-prod";
    const cdnBase = process.env.CDN_BASE || `https://imagehost-files.nyc3.cdn.digitaloceanspaces.com/${folder}`;
    return `${cdnBase}/${url}`;
}

// Streams the local file to the filer. lib-storage buffers 16 MiB parts (2 in
// flight), so RAM stays bounded and files over 5 GB use multipart.
export async function uploadToFiler(url: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const filepath = U.getFilename(url);
    // Mark in-flight; the pruner only evicts files flagged exactly `true`.
    await U.query.index.updateOne(
        { _id: url },
        { $set: { rustfsBackedUp: "uploading" } },
    ).catch(() => {});
    const stream = createReadStream(filepath);
    stream.on("error", () => {}); // the Upload rejects on its own; avoid an uncaught 'error'
    await new Upload({
        client: U.minio_client,
        params: { Bucket: process.env.BUCKET || "imagehost-files", Key: url, Body: stream },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
    }).done();
    await U.query.index.updateOne(
        { _id: url },
        { $set: { rustfsBackedUp: true } },
    );
}

export async function downloadFromMinio(key: string, destPath: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const response = await U.minio_client.send(new GetObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: key,
    }));
    const body = response.Body;
    // Node's HTTP handler returns a Readable; a web stream is wrapped so undici
    // can't double-close it after the pipe completes.
    const source = body instanceof Readable ? body
        : body instanceof ReadableStream ? Readable.fromWeb(body)
        : undefined;
    if (!source) throw new Error("Empty response from minio");
    await pipeline(source, createWriteStream(destPath));
}

export async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // Output is not read; "ignore" keeps a chatty stderr from filling a pipe and stalling ffmpeg.
    const proc = spawn("ffmpeg", args, { stdio: "ignore" });
    const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}`));
    });
    proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
    });
    return promise;
}

// Best-effort PUT of this volume's not-yet-ingested files, used on shutdown so the
// filer has them before the pod (and possibly its disk) goes away.
export async function flushVolume(volumeId: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    const docs: { _id: string }[] = await U.query.index.find(
        { volumeId, rustfsBackedUp: { $ne: true }, mimetype: { $ne: "deleted" } },
        { projection: { _id: 1 } },
    ).limit(200).toArray();
    let stored = 0;
    for (const doc of docs) {
        if (Date.now() > deadline) break;
        try {
            await fs.access(U.getFilename(doc._id));
        } catch {
            continue;
        }
        try {
            await uploadToFiler(doc._id);
            stored++;
        } catch (e) {
            serverLog(`Flush: filer PUT failed for ${doc._id}: ${(e as Error).message}`);
        }
    }
    serverLog(`Flush: stored ${stored} of ${docs.length} pending uploads on volume ${volumeId}`);
}

// Starts workflows for uploads on this volume whose start was missed (Temporal was
// unreachable at upload time, or the pod died between response and start).
export function startIngestReconciler(volumeId: string): void {
    let indexEnsured = false;
    let running = false;
    const tick = async () => {
        if (!indexEnsured) {
            indexEnsured = true;
            try {
                await U.query.index.createIndex(
                    { volumeId: 1, workflowStartedAt: 1 },
                    { partialFilterExpression: { volumeId: { $exists: true } } },
                );
            } catch (e) {
                serverLog(`Reconciler: createIndex failed (continuing without it): ${(e as Error).message}`);
            }
        }
        const docs: { _id: string }[] = await U.query.index.find(
            {
                volumeId,
                workflowStartedAt: { $exists: false },
                mimetype: { $ne: "deleted" },
                storedAt: { $lt: new Date(Date.now() - RECONCILE_MIN_AGE_MS) },
            },
            { projection: { _id: 1 } },
        ).limit(50).toArray();
        for (const doc of docs) {
            const result = await startUploadWorkflow({ url: doc._id, volumeId });
            if (result === "unavailable") return;
            serverLog(`Reconciler: workflow for ${doc._id} ${result}`);
        }
    };
    const run = () => {
        if (running) return;
        running = true;
        tick()
            .catch((e) => serverLog(`Reconciler: tick failed: ${(e as Error).message}`))
            .finally(() => { running = false; });
    };
    run();
    setInterval(run, RECONCILE_MS);
}
