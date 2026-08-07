import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";

const { uploadToFiler, uploadToDOSpaces, markRustfsBackedUp, insertProcessingJobs } =
    proxyActivities<typeof activities>({
        startToCloseTimeout: "10 minutes",
        retry: { maximumAttempts: 5 },
    });

export async function UploadWorkflow(url: string, mimetype: string, fileExtension?: string): Promise<void> {
    // Run both uploads in parallel — they only read the same local file (read-only).
    // DO Spaces first in the array for intent clarity; execution is concurrent.
    // If either fails, the workflow retries both (DO PUT is idempotent for same key+content).
    await Promise.all([
        uploadToDOSpaces(url, mimetype),   // local file → DO Spaces (multipart, heartbeats)
        uploadToFiler(url),                // local file → filer (fast, local network)
    ]);
    await markRustfsBackedUp(url);                       // Mongo: rustfsBackedUp = true
    await insertProcessingJobs(url, mimetype, fileExtension); // Mongo: ffmpeg/backup-artifacts
}
