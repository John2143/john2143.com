import assert from "node:assert/strict";
import { test } from "node:test";
import { RECONCILE_MIN_AGE_MS, WORKFLOW_RETRY_AFTER_MS, deleteRetryQuery, ingestRetryQuery } from "../juush/reconcile.js";

const now = Date.UTC(2026, 10, 10, 12, 0, 0);

test("ingestRetryQuery: missed start and stuck ingest", () => {
    const q = ingestRetryQuery("vol1", now);
    assert.equal(q.volumeId, "vol1");
    assert.equal(q.mimetype.$ne, "deleted");
    const [missed, stuck] = q.$or;
    // A start that never happened is picked up only once the upload is old enough.
    assert.equal(missed.workflowStartedAt.$exists, false);
    assert.equal(missed.storedAt.$lt.getTime(), now - RECONCILE_MIN_AGE_MS);
    // A stuck ingest is retried only after an hour, and never once it is marked failed.
    assert.equal(stuck.rustfsBackedUp, "uploading");
    assert.equal(stuck.workflowStartedAt.$lt.getTime(), now - WORKFLOW_RETRY_AFTER_MS);
    assert.equal(stuck.ingestFailed.$exists, false);
    assert.equal(WORKFLOW_RETRY_AFTER_MS, 60 * 60_000);
});

test("deleteRetryQuery: unpurged tombstones", () => {
    const q = deleteRetryQuery(now);
    assert.equal(q.mimetype, "deleted");
    assert.equal(q.deletedAt.$lt.getTime(), now - RECONCILE_MIN_AGE_MS);
    assert.equal(q.purgedAt.$exists, false);
    assert.equal(q.$or[0].deleteWorkflowStartedAt.$exists, false);
    assert.equal(q.$or[1].deleteWorkflowStartedAt.$lt.getTime(), now - WORKFLOW_RETRY_AFTER_MS);
});
