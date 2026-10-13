import { proxyActivities, sleep, workflowInfo, ActivityFailure, ApplicationFailure, TimeoutFailure } from "@temporalio/workflow";
import type * as worker from "./activities.js";
import type * as ingest from "./ingest-activities.js";

export interface UploadInput { url: string; volumeId?: string }

const { processUpload } = proxyActivities<typeof worker>({
    startToCloseTimeout: "30 minutes", heartbeatTimeout: "2 minutes",
    retry: { initialInterval: "30 seconds", backoffCoefficient: 2, maximumInterval: "10 minutes", maximumAttempts: 5 },
});
const { isOnFiler, markIngestStatus } = proxyActivities<typeof worker>({
    startToCloseTimeout: "1 minute", retry: { maximumAttempts: 10 },
});
// Same name as volume.ts ingestTaskQueue(); not imported because workflow code can't load node:fs.
const ingestFor = (volumeId: string) => proxyActivities<typeof ingest>({
    taskQueue: `john2143-com-ingest-${volumeId}`,
    scheduleToStartTimeout: "30 minutes", startToCloseTimeout: "30 minutes", heartbeatTimeout: "2 minutes",
    retry: { initialInterval: "30 seconds", backoffCoefficient: 2, maximumInterval: "15 minutes", nonRetryableErrorTypes: ["LocalFileMissing"] },
}).ingestToFiler;

const GIVE_UP_MS = 7 * 24 * 3600 * 1000;

// The ingest activity can only run on the pod whose disk holds the file. If that
// pod is gone, keep checking hourly (it may come back) until the filer has the file
// or the give-up deadline passes.
async function ensureOnFiler(url: string, volumeId: string): Promise<void> {
    const deadline = workflowInfo().startTime.getTime() + GIVE_UP_MS;
    for (;;) {
        try { await ingestFor(volumeId)(url); return; }
        catch (err) {
            // scheduleToStart timeouts are never retried by the server, hence this loop.
            const stalled = err instanceof ActivityFailure && err.cause instanceof TimeoutFailure && err.cause.timeoutType === "SCHEDULE_TO_START";
            const missing = err instanceof ActivityFailure && err.cause instanceof ApplicationFailure && err.cause.type === "LocalFileMissing";
            if (!stalled && !missing) throw err;
            if (await isOnFiler(url)) return;
            if (missing || Date.now() > deadline) {
                await markIngestStatus(url, "lost");
                throw ApplicationFailure.nonRetryable(`upload ${url} is on no disk and not on the filer`, "UploadLost");
            }
            await markIngestStatus(url, "stalled");
            await sleep("1 hour");
        }
    }
}

export async function ProcessUploadWorkflow(input: UploadInput): Promise<void> {
    if (input.volumeId) await ensureOnFiler(input.url, input.volumeId);
    await processUpload(input.url);
}

// Started by web pods still on the previous image during the rollout window (positional args),
// and usable from the temporal CLI. Those pods only start it after a successful filer PUT.
export async function UploadWorkflow(url: string): Promise<void> {
    await processUpload(url);
}
