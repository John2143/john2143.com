/**
 * Activities registered by worker pods on the `john2143-com` task queue. Each one
 * re-reads its upload, works from the filer copy in its own temp dir, and records
 * its result only while the upload is not deleted, so retries and deletes are safe
 * at any point. worker.ts registers every export as an activity: helpers stay
 * unexported.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { DeleteObjectCommand, HeadObjectCommand, NotFound, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import * as U from "../util.js";
import { downloadFromMinio, getCdnUrl, putFilerFile } from "../pipeline.js";
import { makePreview, makeThumbnail, makeWebVideo, probeMedia, type WebVideoResult } from "../media.js";
import { uploadToS3 } from "../upload.js";
import { classifyUpload } from "../filetype.js";
import { planSteps, type PlanDoc, type UploadPlan } from "./plan.js";

const CDN_MAX_SIZE = 150 * 1024 * 1024;
const BUCKET = process.env.BUCKET || "imagehost-files";
const FOLDER = process.env.FOLDER || "public-prod";

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

const DOC_PROJECTION = { mimetype: 1, filename: 1, cdn: 1, thumb: 1, preview: 1, artifacts: 1 };

async function loadDoc(url: string): Promise<(PlanDoc & { _id: string }) | null> {
    return await U.query.index.findOne({ _id: url }, { projection: DOC_PROJECTION });
}

// The upload, or null when it is missing or deleted.
async function liveDoc(url: string): Promise<(PlanDoc & { _id: string }) | null> {
    const doc = await loadDoc(url);
    return doc && doc.mimetype !== "deleted" ? doc : null;
}

// Fresh temp dir + 30 s heartbeat, both cleaned up on every path.
async function inTempDir<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
    const tmp = await fs.mkdtemp("/tmp/juush-");
    const ctx = Context.current();
    const heartbeat = setInterval(() => ctx.heartbeat(), 30_000);
    try {
        return await fn(tmp);
    } finally {
        clearInterval(heartbeat);
        await fs.rm(tmp, { recursive: true, force: true });
    }
}

// Records an artifact unless the upload was deleted meanwhile. false = the caller must remove what it just wrote.
async function recordUnlessDeleted(url: string, update: object): Promise<boolean> {
    const r = await U.query.index.updateOne({ _id: url, mimetype: { $ne: "deleted" } }, update);
    return r.matchedCount === 1;
}

// Deletes each key, then HEADs it; throws if it is still there (Temporal retries).
// One DeleteObject per key on purpose: since AWS SDK JS v3.729, DeleteObjects sends a
// CRC32 checksum instead of Content-MD5, which S3-compatible stores have rejected with
// MissingContentMD5 (aws/aws-sdk-js-v3#6819, #6920).
async function deleteKeys(client: S3Client, keys: string[]): Promise<string[]> {
    for (const Key of keys) {
        await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
        try {
            await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
        } catch (e) {
            if (e instanceof NotFound || (e as any)?.$metadata?.httpStatusCode === 404) continue;
            throw e;
        }
        throw new Error(`${Key} still present after delete`);
    }
    return keys;
}

const unique = (keys: (string | null | undefined | false)[]): string[] => [...new Set(keys.filter((k): k is string => !!k))];

// --- Upload processing: one activity per step, in the order planSteps lists them ---

export async function planUpload(url: string): Promise<UploadPlan> {
    const doc = await loadDoc(url);
    if (doc && doc.mimetype !== "deleted") await U.query.index.updateOne({ _id: url }, { $unset: { ingestStatus: "" } });
    return planSteps(doc);
}

// WebP thumbnail on the filer (artifacts.thumbnail). A failed ffmpeg/sharp run is non-fatal.
export async function createThumbnail(url: string): Promise<"created" | "already" | "failed" | "deleted"> {
    const doc = await liveDoc(url);
    if (!doc) return "deleted";
    if (doc.artifacts?.thumbnail?.endsWith(".thumb.webp")) return "already";
    const thumbKey = `${url}.thumb.webp`;
    return inTempDir(async (tmp) => {
        const src = path.join(tmp, url), thumb = `${src}.thumb.webp`;
        await downloadFromMinio(url, src);
        let made = false;
        try {
            made = await makeThumbnail(src, thumb, classifyUpload(doc.mimetype, doc.filename) === "video");
        } catch (e) {
            console.log(`createThumbnail: failed for ${url}: ${(e as Error).message}`);
            return "failed";
        }
        if (!made) {
            console.log(`createThumbnail: failed for ${url}: no frame or empty output`);
            return "failed";
        }
        await putFilerFile(thumbKey, thumb, "image/webp");
        if (await recordUnlessDeleted(url, { $set: { "artifacts.thumbnail": `${BUCKET}/${thumbKey}` } })) return "created";
        await deleteKeys(U.minio_client, [thumbKey]);
        return "deleted";
    });
}

// Tiny blur-up preview in Mongo, made from the filer thumbnail, or (GIFs, failed
// thumbnails) from a local thumbnail of the original.
export async function createPreview(url: string): Promise<"created" | "already" | "failed" | "deleted"> {
    const doc = await liveDoc(url);
    if (!doc) return "deleted";
    if (doc.preview) return "already";
    return inTempDir(async (tmp) => {
        const thumb = path.join(tmp, `${url}.thumb`);
        if (doc.artifacts?.thumbnail) {
            await downloadFromMinio(U.artifactKey(doc.artifacts.thumbnail), thumb);
        } else {
            const src = path.join(tmp, url);
            await downloadFromMinio(url, src);
            const made = await makeThumbnail(src, thumb, classifyUpload(doc.mimetype, doc.filename) === "video").catch((e) => {
                console.log(`createPreview: thumbnail failed for ${url}: ${e.message}`);
                return false;
            });
            if (!made) return "failed";
        }
        const preview = await makePreview(thumb).catch((e) => {
            console.log(`createPreview: failed for ${url}: ${e.message}`);
            return null;
        });
        if (!preview) return "failed";
        return await recordUnlessDeleted(url, { $set: { preview } }) ? "created" : "deleted";
    });
}

export async function publishThumbnailToCdn(url: string): Promise<"published" | "already" | "no-thumbnail" | "deleted"> {
    const doc = await liveDoc(url);
    if (!doc) return "deleted";
    if (doc.thumb?.endsWith(".thumb.webp")) return "already";
    // A legacy JPEG artifact is not published under the .webp key.
    if (!doc.artifacts?.thumbnail?.endsWith(".thumb.webp")) return "no-thumbnail";
    const thumbKey = `${url}.thumb.webp`;
    return inTempDir(async (tmp) => {
        const thumb = path.join(tmp, thumbKey);
        await downloadFromMinio(U.artifactKey(doc.artifacts.thumbnail), thumb);
        await U.s3_client.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: `${FOLDER}/${thumbKey}`,
            Body: createReadStream(thumb),
            ACL: "public-read",
            ContentType: "image/webp",
        }));
        if (await recordUnlessDeleted(url, { $set: { thumb: getCdnUrl(thumbKey) } })) return "published";
        await deleteKeys(U.s3_client, [`${FOLDER}/${thumbKey}`]);
        return "deleted";
    });
}

// Browser-playable MP4 on the filer (artifacts.faststart). ffmpeg failure is non-fatal.
export async function createWebVideo(url: string): Promise<WebVideoResult | "already" | "failed" | "deleted"> {
    const doc = await liveDoc(url);
    if (!doc) return "deleted";
    if (doc.artifacts?.faststart) return "already";
    const webKey = `${url}.fast.mp4`;
    return inTempDir(async (tmp) => {
        const src = path.join(tmp, url), web = `${src}.fast.mp4`;
        await downloadFromMinio(url, src);
        let how: WebVideoResult;
        try {
            how = await makeWebVideo(src, web, await probeMedia(src));
        } catch (e) {
            console.log(`createWebVideo: failed for ${url}: ${(e as Error).message}`);
            return "failed";
        }
        console.log(`createWebVideo: ${url}: ${how}`);
        if (how === "skipped") return how;
        await putFilerFile(webKey, web, "video/mp4");
        if (await recordUnlessDeleted(url, { $set: { "artifacts.faststart": `${BUCKET}/${webKey}` } })) return how;
        await deleteKeys(U.minio_client, [webKey]);
        return "deleted";
    });
}

// The CDN copy: the web MP4 when one exists, else the original; at most CDN_MAX_SIZE.
// Filer errors throw (Temporal retries) rather than publishing the original in place
// of the web copy.
export async function publishToCdn(url: string): Promise<"published-web" | "published-original" | "too-large" | "already" | "deleted"> {
    const doc = await liveDoc(url);
    if (!doc) return "deleted";
    if (doc.cdn) return "already";
    const web = doc.artifacts?.faststart;
    const sourceKey = web ? U.artifactKey(web) : url;
    const mime = web ? "video/mp4" : doc.mimetype || "application/octet-stream";
    // HEAD first, so a multi-GB original is never downloaded only to be found too large.
    const head = await U.minio_client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
    if ((head.ContentLength ?? 0) > CDN_MAX_SIZE) {
        await recordUnlessDeleted(url, { $set: { failedCDN: true } });
        return "too-large";
    }
    return inTempDir(async (tmp) => {
        const src = path.join(tmp, path.basename(sourceKey));
        await downloadFromMinio(sourceKey, src);
        await uploadToS3(url, mime, 0, src);
        if (await recordUnlessDeleted(url, { $set: { cdn: getCdnUrl(url) }, $unset: { failedCDN: "" } })) {
            return web ? "published-web" : "published-original";
        }
        await deleteKeys(U.s3_client, [`${FOLDER}/${url}`]);
        return "deleted";
    });
}

// --- Purge of a deleted upload (DeleteUploadWorkflow) ---

// A purge never runs against a live upload.
async function loadTombstone(url: string): Promise<PlanDoc> {
    const doc: PlanDoc | null = await U.query.index.findOne({ _id: url }, { projection: { mimetype: 1, cdn: 1, thumb: 1, artifacts: 1 } });
    if (!doc || doc.mimetype !== "deleted") throw ApplicationFailure.nonRetryable(`upload ${url} is not deleted`, "NotDeleted");
    return doc;
}

// The Spaces object key behind one of our CDN URLs, or null for anything else.
function spacesKeyFromUrl(u: string | undefined): string | null {
    if (!u) return null;
    try {
        const { hostname, pathname } = new URL(u);
        if (!hostname.startsWith(`${BUCKET}.`) || !hostname.endsWith(".digitaloceanspaces.com")) return null;
        return decodeURIComponent(pathname.slice(1));
    } catch {
        return null;
    }
}

export async function deleteFromCdn(url: string): Promise<string[]> {
    const doc = await loadTombstone(url);
    const keys = unique([
        `${FOLDER}/${url}`, `${FOLDER}/${url}.thumb.webp`, `${FOLDER}/${url}.thumb.jpg`,
        spacesKeyFromUrl(doc.cdn), spacesKeyFromUrl(doc.thumb),
    ]);
    await deleteKeys(U.s3_client, keys);
    await U.query.index.updateOne({ _id: url }, { $unset: { cdn: "", thumb: "", failedCDN: "" } });
    return keys;
}

export async function deleteFromFiler(url: string): Promise<string[]> {
    const doc = await loadTombstone(url);
    const keys = unique([
        url, `${url}.fast.mp4`, `${url}.thumb.webp`, `${url}.thumb.jpg`,
        doc.artifacts?.faststart && U.artifactKey(doc.artifacts.faststart),
        doc.artifacts?.thumbnail && U.artifactKey(doc.artifacts.thumbnail),
    ]);
    await deleteKeys(U.minio_client, keys);
    await U.query.index.updateOne({ _id: url }, { $unset: { artifacts: "", rustfsBackedUp: "" } });
    return keys;
}

export async function markPurged(url: string): Promise<void> {
    await U.query.index.updateOne(
        { _id: url, mimetype: "deleted" },
        { $set: { purgedAt: new Date() }, $unset: { preview: "", ingestStatus: "" } },
    );
}
