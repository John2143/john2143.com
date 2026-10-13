/**
 * Activities registered by worker pods on the `john2143-com` task queue. Each one
 * works from the filer copy in its own temp dir, so no state crosses activities
 * or pods.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { Context } from "@temporalio/activity";
import { HeadObjectCommand, NotFound, PutObjectCommand } from "@aws-sdk/client-s3";
import * as U from "../util.js";
import { downloadFromMinio, getCdnUrl, runFfmpeg } from "../pipeline.js";
import { uploadToS3 } from "../upload.js";

const CDN_MAX_SIZE = 150 * 1024 * 1024;
const THUMB_MAX_SIZE = 500 * 1024 * 1024;

export async function isOnFiler(url: string): Promise<boolean> {
    try {
        await U.minio_client.send(new HeadObjectCommand({
            Bucket: process.env.BUCKET || "imagehost-files",
            Key: url,
        }));
        return true;
    } catch (e) {
        if (e instanceof NotFound) return false;
        throw e;
    }
}

export async function markIngestStatus(url: string, status: "stalled" | "lost"): Promise<void> {
    await U.query.index.updateOne({ _id: url }, { $set: { ingestStatus: status } });
}

// CDN copy (<= 150 MB) plus video artifacts: faststart MP4 and a JPEG thumbnail.
export async function processUpload(url: string): Promise<"done" | "skipped"> {
    const doc: { mimetype?: string; filename?: string } | null = await U.query.index.findOne(
        { _id: url },
        { projection: { mimetype: 1, filename: 1 } },
    );
    if (!doc || doc.mimetype === "deleted") return "skipped";
    await U.query.index.updateOne({ _id: url }, { $unset: { ingestStatus: "" } });

    const bucket = process.env.BUCKET || "imagehost-files";
    const tmp = await fs.mkdtemp("/tmp/juush-");
    const ctx = Context.current();
    const heartbeat = setInterval(() => ctx.heartbeat(), 30_000);
    try {
        const src = path.join(tmp, url);
        await downloadFromMinio(url, src);
        const size = (await fs.stat(src)).size;

        const ext = U.guessFileExtension(doc.filename);
        const isMP4 = doc.mimetype === "video/mp4" || ext?.toLowerCase() === "mp4";
        const isVideo = doc.mimetype?.startsWith("video/") === true;

        const fast = `${src}.fast.mp4`;
        if (isMP4) {
            await runFfmpeg(["-i", src, "-c", "copy", "-movflags", "faststart", "-y", fast], 120_000)
                .catch((e) => console.log(`processUpload: faststart failed for ${url}: ${(e as Error).message}`));
        }
        const thumb = `${src}.thumb.jpg`;
        if (isVideo && size <= THUMB_MAX_SIZE) {
            await runFfmpeg(["-i", src, "-ss", "00:00:01", "-vframes", "1", "-q:v", "5", "-y", thumb], 60_000)
                .catch((e) => console.log(`processUpload: thumbnail failed for ${url}: ${(e as Error).message}`));
        }
        const hasFast = await fs.access(fast).then(() => true, () => false);
        const hasThumb = await fs.access(thumb).then(() => true, () => false);

        const cdnSrc = hasFast ? fast : src;
        if ((await fs.stat(cdnSrc)).size <= CDN_MAX_SIZE) {
            // Throws after its own retries; Temporal then retries the activity.
            await uploadToS3(url, doc.mimetype || "application/octet-stream", 0, cdnSrc);
            await U.query.index.updateOne({ _id: url }, { $set: { cdn: getCdnUrl(url) }, $unset: { failedCDN: "" } });
        } else {
            await U.query.index.updateOne({ _id: url }, { $set: { failedCDN: true } });
        }

        const artifacts: Record<string, string> = {};
        if (hasFast) {
            const fastKey = `${url}.fast.mp4`;
            await U.minio_client.send(new PutObjectCommand({ Bucket: bucket, Key: fastKey, Body: createReadStream(fast) }));
            artifacts.faststart = `${bucket}/${fastKey}`;
        }
        if (hasThumb) {
            const thumbKey = `${url}.thumb.jpg`;
            await U.minio_client.send(new PutObjectCommand({ Bucket: bucket, Key: thumbKey, Body: createReadStream(thumb) }));
            artifacts.thumbnail = `${bucket}/${thumbKey}`;
            // The CDN serves the thumbnail too.
            await U.s3_client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `${process.env.FOLDER || "public-prod"}/${thumbKey}`,
                Body: createReadStream(thumb),
                ACL: "public-read",
                ContentType: "image/jpeg",
            }));
            await U.query.index.updateOne({ _id: url }, { $set: { thumb: getCdnUrl(thumbKey) } });
        }
        if (Object.keys(artifacts).length > 0) {
            await U.query.index.updateOne({ _id: url }, { $set: { artifacts } });
        }
        return "done";
    } finally {
        clearInterval(heartbeat);
        await fs.rm(tmp, { recursive: true, force: true });
    }
}
