/**
 * Queries for the web pods' reconcilers. No imports, so the unit tests can load it
 * without util.ts's MongoClient.
 */

// How often a reconciler looks for work.
export const RECONCILE_MS = 60_000;
// An upload's workflow normally starts right after the response; only docs this old
// without a workflow are picked up, so an in-flight start is never duplicated.
export const RECONCILE_MIN_AGE_MS = 10 * 60_000;
// A purge (or an ingest) whose start is older than this without finishing is retried.
export const WORKFLOW_RETRY_AFTER_MS = 60 * 60_000;

/**
 * Uploads on this volume that still need an ingest workflow:
 *  - stored, never started (Temporal was unreachable, or the pod died first), or
 *  - marked as being ingested but stuck, e.g. the filer was down and the workflow
 *    failed. A closed failed workflow restarts under Temporal's default id-reuse
 *    policy, so the same workflow id is correct.
 */
export function ingestRetryQuery(volumeId: string, now: number) {
    return {
        volumeId,
        mimetype: { $ne: "deleted" },
        $or: [
            {
                workflowStartedAt: { $exists: false },
                storedAt: { $lt: new Date(now - RECONCILE_MIN_AGE_MS) },
            },
            {
                rustfsBackedUp: "uploading",
                workflowStartedAt: { $lt: new Date(now - WORKFLOW_RETRY_AFTER_MS) },
                // Marked when the local copy is gone; retrying cannot help, and clearing
                // this field brings the row back if the file is restored.
                ingestFailed: { $exists: false },
            },
        ],
    };
}

// Deleted uploads whose purge has not run, or whose start is stale enough to retry.
export function deleteRetryQuery(now: number) {
    return {
        mimetype: "deleted",
        deletedAt: { $lt: new Date(now - RECONCILE_MIN_AGE_MS) },
        purgedAt: { $exists: false },
        $or: [
            { deleteWorkflowStartedAt: { $exists: false } },
            { deleteWorkflowStartedAt: { $lt: new Date(now - WORKFLOW_RETRY_AFTER_MS) } },
        ],
    };
}
