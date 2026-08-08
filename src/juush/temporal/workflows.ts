import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";

const { uploadToDOSpaces, insertProcessingJobs } =
    proxyActivities<typeof activities>({
        startToCloseTimeout: "10 minutes",
        retry: { maximumAttempts: 5 },
    });

export async function UploadWorkflow(url: string, mimetype: string, fileExtension?: string): Promise<void> {
    // Stateless: download from central filer → put on CDN (≤150 MB only).
    // The filer already has the file — the web pod did an inline PUT at ingest
    // (the durable first hop).
    await uploadToDOSpaces(url, mimetype);
    // Schedule ffmpeg / thumbnail / artifact jobs via the Mongo queue.
    // (backup-s3 is idempotent — skips when cdn is already set by the activity above.)
    await insertProcessingJobs(url, mimetype, fileExtension);
}
