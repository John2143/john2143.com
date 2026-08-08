import { unlink } from "node:fs/promises";
import * as U from "../util.js";
import { downloadFromMinio, getCdnUrl, insertProcessingJobs as _insertProcessingJobs } from "../jobs.js";
import { uploadToS3 } from "../upload.js";

// --- Activities (stateless — all I/O goes through the central filer) ---

export async function uploadToDOSpaces(url: string, mimetype: string): Promise<void> {
    if (!U.s3_client) throw new Error("s3_client not configured");
    if (!U.minio_client) throw new Error("minio_client not configured");
    const tempPath = `/tmp/juush-worker/${url}.spaces-src`;
    await downloadFromMinio(url, tempPath);
    try {
        // uploadToS3 has retries and the ≤150MB cap.  Huge files (>150MB)
        // are caught below and skipped — they never touch Spaces (design constraint).
        await uploadToS3(url, mimetype, 0, tempPath);
        const cdnUrl = getCdnUrl(url);
        await U.query.index.updateOne({ _id: url }, { $set: { cdn: cdnUrl } });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`uploadToDOSpaces: CDN upload failed for ${url}: ${msg}`);
        // Don't fail the whole workflow — processing jobs should still schedule.
    } finally {
        await unlink(tempPath).catch(() => {});
    }
}

export async function insertProcessingJobs(url: string, mimetype: string, fileExtension?: string): Promise<void> {
    await _insertProcessingJobs(url, mimetype, fileExtension);
}
