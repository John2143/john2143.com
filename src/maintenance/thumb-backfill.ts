/**
 * Backfills WebP thumbnails and blur previews for existing image uploads.
 *
 * Images only: no video thumbnails, no web MP4, no CDN re-upload of originals.
 * `processUpload` cannot be reused because it interleaves those steps, so this
 * walks the index itself and writes exactly the same artifacts and fields:
 *   <id>.thumb.webp   -> Seaweed (image/webp) and Spaces (public-read)
 *   artifacts.thumbnail = "<bucket>/<id>.thumb.webp"
 *   thumb             = CDN URL, only when the Spaces copy exists
 *   preview           = base64 WebP for the blur-up placeholder (GIFs: preview only)
 *
 * Lifecycle field `thumbBackfill` on the document:
 *   startedAt -> doneAt (with `preview: true|false`), or failedAt + error.
 * Because `startedAt` survives a kill, the next start marks every leftover as
 * failed; `RETRY_CRASHED=1` clears those first so they are picked up again.
 *
 * Environment
 *   DRY_RUN            "1" prints candidate counts by mimetype and exits
 *   THUMB_CONCURRENCY  default 2
 *   RETRY_CRASHED      "1" re-queue documents left `failedAt: crashed or killed`
 *   DB, MINIO_*, S3_*, BUCKET, FOLDER as in the web pods
 *
 * Manifest: scripts/maintenance/thumb-backfill.job.yaml.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import * as U from "../juush/util.js";
import { downloadFromMinio, getCdnUrl, putFilerFile } from "../juush/pipeline.js";
import { makePreview, makeThumbnail } from "../juush/media.js";
import { Report } from "./report.js";

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const CONCURRENCY = Number(process.env.THUMB_CONCURRENCY || 2) || 2;
const RETRY_CRASHED = process.env.RETRY_CRASHED === "1" || process.env.RETRY_CRASHED === "true";
const BUCKET = process.env.BUCKET || "imagehost-files";
const FOLDER = process.env.FOLDER || "public-prod";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/tiff", "image/svg+xml"];
const CRASH_ERROR = "crashed or killed during processing";

type Doc = { _id: string; mimetype?: string; thumb?: string; preview?: string };

const report = new Report({ mode: "thumb-backfill", dryRun: DRY_RUN });

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

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            await fn(items[index]);
        }
    });
    await Promise.all(workers);
}

async function candidates(): Promise<Doc[]> {
    return U.query.index.find(
        {
            mimetype: { $in: IMAGE_MIMES },
            thumbBackfill: { $exists: false },
            $or: [
                { preview: { $exists: false } },
                { mimetype: { $ne: "image/gif" }, thumb: { $not: /\.thumb\.webp$/ } },
            ],
        },
        { projection: { mimetype: 1, thumb: 1, preview: 1 } },
    ).sort({ uploaddate: -1 }).toArray() as Promise<Doc[]>;
}

async function processOne(doc: Doc, summary: Record<string, number>): Promise<void> {
    const id = doc._id;
    const mime = doc.mimetype || "";
    const needThumb = mime !== "image/gif" && !doc.thumb?.endsWith(".thumb.webp");
    const needPreview = !doc.preview;
    const thumbKey = `${id}.thumb.webp`;

    await U.query.index.updateOne({ _id: id }, { $set: { thumbBackfill: { startedAt: new Date() } } });
    const tmp = await fs.mkdtemp("/tmp/thumbfill-");
    const src = `${tmp}/${id}`;
    const thumbPath = `${src}.thumb.webp`;
    try {
        await retrying(() => downloadFromMinio(id, src));

        const hasThumb = await makeThumbnail(src, thumbPath, false);
        if (!hasThumb) throw new Error("no thumbnail produced");

        if (needThumb) {
            await retrying(() => putFilerFile(thumbKey, thumbPath, "image/webp"));
        }

        let spacesOk = false;
        if (needThumb && U.s3_client) {
            try {
                await retrying(() => U.s3_client.send(new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: `${FOLDER}/${thumbKey}`,
                    Body: createReadStream(thumbPath),
                    ACL: "public-read",
                    ContentType: "image/webp",
                })));
                spacesOk = true;
            } catch (e) {
                summary.spacesFailed = (summary.spacesFailed || 0) + 1;
                console.log(`thumb-backfill: Spaces upload failed for ${id}: ${(e as Error).message}`);
            }
        }

        let preview: string | null = null;
        if (needPreview) preview = await makePreview(thumbPath).catch(() => null);

        await U.query.index.updateOne({ _id: id }, {
            $set: {
                ...(needThumb ? { "artifacts.thumbnail": `${BUCKET}/${thumbKey}` } : {}),
                ...(needThumb && spacesOk ? { thumb: getCdnUrl(thumbKey) } : {}),
                ...(preview ? { preview } : {}),
                thumbBackfill: { doneAt: new Date(), preview: !!preview },
            },
        });
        summary.done = (summary.done || 0) + 1;
        report.item({ k: id, action: "done", thumb: needThumb ? 1 : 0, spaces: spacesOk ? 1 : 0, preview: preview ? 1 : 0 });
    } catch (e) {
        const error = String((e as Error)?.message ?? e).slice(0, 300);
        await U.query.index.updateOne({ _id: id }, { $set: { thumbBackfill: { failedAt: new Date(), error } } });
        summary.failed = (summary.failed || 0) + 1;
        report.item({ k: id, action: "failed", error });
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}

async function main(): Promise<void> {
    let code = 0;
    try {
        await U.startdb();

        if (RETRY_CRASHED) {
            const cleared = await U.query.index.updateMany({ "thumbBackfill.error": CRASH_ERROR }, { $unset: { thumbBackfill: "" } });
            console.log(`thumb-backfill: re-queued ${cleared.modifiedCount} crashed documents`);
        }
        const crashed = await U.query.index.updateMany(
            { "thumbBackfill.startedAt": { $exists: true } },
            { $set: { thumbBackfill: { failedAt: new Date(), error: CRASH_ERROR } } },
        );
        if (crashed.modifiedCount > 0) console.log(`thumb-backfill: marked ${crashed.modifiedCount} interrupted documents as failed`);

        const docs = await candidates();
        const byMime: Record<string, number> = {};
        let needThumb = 0;
        let needPreview = 0;
        for (const d of docs) {
            byMime[d.mimetype || "?"] = (byMime[d.mimetype || "?"] || 0) + 1;
            if (d.mimetype !== "image/gif" && !d.thumb?.endsWith(".thumb.webp")) needThumb++;
            if (!d.preview) needPreview++;
        }
        console.log(`thumb-backfill: ${docs.length} candidates ${JSON.stringify(byMime)} needThumb=${needThumb} needPreview=${needPreview}`);

        if (DRY_RUN) {
            await report.finish({ candidates: docs.length, byMime, needThumb, needPreview });
            await U.mongoclient.close();
            process.exit(0);
        }

        const summary: Record<string, number> = {};
        let done = 0;
        await runPool(docs, CONCURRENCY, async doc => {
            await processOne(doc, summary);
            if (++done % 500 === 0) report.progress({ processed: done, total: docs.length });
        });

        summary.total = docs.length;
        await report.finish(summary);
    } catch (e) {
        console.error(`FATAL ${(e as Error)?.stack ?? e}`);
        code = 1;
        try {
            await report.finish({ error: String((e as Error)?.message ?? e) });
        } catch (_) {}
    }
    await U.mongoclient.close().catch(() => {});
    await new Promise(r => setTimeout(r, 250));
    process.exit(code);
}

void main();
