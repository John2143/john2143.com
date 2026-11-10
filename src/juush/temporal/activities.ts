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
import { downloadFromMinio, getCdnUrl, putFilerFile } from "../pipeline.js";
import { makePreview, makeThumbnail, makeWebVideo, probeMedia } from "../media.js";
import { uploadToS3 } from "../upload.js";
import { guessFileExtension } from "../filetype.js";

const CDN_MAX_SIZE = 150 * 1024 * 1024;
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "3gp"]);
// Formats sharp's prebuilt libvips reads. Other image/* types (HEIC, BMP) fail
// thumbnailing (logged, non-fatal) and fall back to the full image.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "tif", "tiff", "svg"]);

interface UploadDoc {
    mimetype?: string;
    filename?: string;
    cdn?: string;
    thumb?: string;
    preview?: string;
    artifacts?: { faststart?: string; thumbnail?: string };
}

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

// NAS artifacts first (web MP4 for video, WebP thumbnail, plus the tiny preview in
// Mongo), then the CDN copies (the web MP4 or original <= 150 MB, and the thumbnail).
// Every step is skipped when its Mongo field is already set, so a retry only redoes
// what failed.
export async function processUpload(url: string): Promise<"done" | "skipped"> {
    const doc: UploadDoc | null = await U.query.index.findOne(
        { _id: url },
        { projection: { mimetype: 1, filename: 1, cdn: 1, thumb: 1, preview: 1, artifacts: 1 } },
    );
    if (!doc || doc.mimetype === "deleted") return "skipped";
    await U.query.index.updateOne({ _id: url }, { $unset: { ingestStatus: "" } });

    const mime = doc.mimetype || "application/octet-stream";
    const ext = (guessFileExtension(doc.filename) ?? "").toLowerCase();
    const isVideo = mime.startsWith("video/") || VIDEO_EXTS.has(ext);
    const isImage = !isVideo && (mime.startsWith("image/") || IMAGE_EXTS.has(ext));
    const isGif = isImage && (mime === "image/gif" || ext === "gif");
    const needWeb = isVideo && !doc.artifacts?.faststart;
    const needThumb = (isVideo || (isImage && !isGif)) && !doc.thumb?.endsWith(".thumb.webp"); // legacy .thumb.jpg gets regenerated
    const needPreview = (isVideo || isImage) && !doc.preview;
    const needCdn = !doc.cdn;
    if (!needWeb && !needThumb && !needPreview && !needCdn) return "done";

    const bucket = process.env.BUCKET || "imagehost-files";
    const folder = process.env.FOLDER || "public-prod";
    const tmp = await fs.mkdtemp("/tmp/juush-");
    const ctx = Context.current();
    const heartbeat = setInterval(() => ctx.heartbeat(), 30_000);
    try {
        const src = path.join(tmp, url);
        await downloadFromMinio(url, src);

        // (a) web MP4 -> NAS. ffmpeg failure is non-fatal; NAS/Mongo failures throw (Temporal retries).
        const web = `${src}.fast.mp4`, webKey = `${url}.fast.mp4`;
        let hasWeb = false;
        if (needWeb) {
            let how = "skipped";
            try {
                how = await makeWebVideo(src, web, await probeMedia(src));
            } catch (e) {
                console.log(`processUpload: web copy failed for ${url}: ${(e as Error).message}`);
            }
            console.log(`processUpload: web copy for ${url}: ${how}`);
            if (how !== "skipped") {
                await putFilerFile(webKey, web, "video/mp4");
                await U.query.index.updateOne({ _id: url }, { $set: { "artifacts.faststart": `${bucket}/${webKey}` } });
                hasWeb = true;
            }
        } else if (needCdn && doc.artifacts?.faststart) {
            // Retry after the NAS step: the CDN copy must still be the web MP4.
            hasWeb = await downloadFromMinio(U.artifactKey(doc.artifacts.faststart), web).then(() => true, (e) => {
                console.log(`processUpload: web copy fetch failed for ${url}: ${e.message}`);
                return false;
            });
        }

        // (b) thumbnail -> NAS, preview -> Mongo. GIFs keep their animated original as
        // thumbnail; the local thumb only feeds the preview.
        const thumb = `${src}.thumb.webp`, thumbKey = `${url}.thumb.webp`;
        let hasThumb = false;
        if (needThumb || needPreview) {
            try {
                hasThumb = await makeThumbnail(src, thumb, isVideo);
            } catch (e) {
                console.log(`processUpload: thumbnail failed for ${url}: ${(e as Error).message}`);
            }
        }
        if (hasThumb && needThumb) {
            await putFilerFile(thumbKey, thumb, "image/webp");
            await U.query.index.updateOne({ _id: url }, { $set: { "artifacts.thumbnail": `${bucket}/${thumbKey}` } });
        }
        if (hasThumb && needPreview) {
            const preview = await makePreview(thumb).catch((e) => {
                console.log(`processUpload: preview failed for ${url}: ${e.message}`);
                return null;
            });
            if (preview) await U.query.index.updateOne({ _id: url }, { $set: { preview } });
        }

        // (c) CDN (Spaces). Throws after its own retries; Temporal retries the activity
        // and the NAS steps above are skipped.
        if (needCdn) {
            const cdnSrc = hasWeb ? web : src;
            if ((await fs.stat(cdnSrc)).size <= CDN_MAX_SIZE) {
                await uploadToS3(url, hasWeb ? "video/mp4" : mime, 0, cdnSrc);
                await U.query.index.updateOne({ _id: url }, { $set: { cdn: getCdnUrl(url) }, $unset: { failedCDN: "" } });
            } else {
                await U.query.index.updateOne({ _id: url }, { $set: { failedCDN: true } });
            }
        }
        if (hasThumb && needThumb) {
            await U.s3_client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `${folder}/${thumbKey}`,
                Body: createReadStream(thumb),
                ACL: "public-read",
                ContentType: "image/webp",
            }));
            await U.query.index.updateOne({ _id: url }, { $set: { thumb: getCdnUrl(thumbKey) } });
        }
        return "done";
    } finally {
        clearInterval(heartbeat);
        await fs.rm(tmp, { recursive: true, force: true });
    }
}
