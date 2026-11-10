/**
 * Upload pipeline helpers shared by web pods (filer ingest, reconciler, shutdown
 * flush) and worker pods (filer download, artifact PUTs).
 *
 * The only queue is Temporal: ProcessUploadWorkflow ingests the file from the disk
 * that holds it (per-volume task queue), then a worker builds the CDN copy and
 * video artifacts. Mongo only records state.
 */
import { serverLog } from "../logger.js";
import * as U from "./util.js";
import { startDeleteWorkflow, startUploadWorkflow } from "./temporal/client.js";
import { RECONCILE_MS, deleteRetryQuery, ingestRetryQuery } from "./reconcile.js";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export function getCdnUrl(url: string): string {
    const folder = process.env.FOLDER || "public-prod";
    const cdnBase = process.env.CDN_BASE || `https://imagehost-files.nyc3.cdn.digitaloceanspaces.com/${folder}`;
    return `${cdnBase}/${url}`;
}

// Streams to the filer: either a local file path or a caller-owned Readable.
// lib-storage buffers 16 MiB parts (2 in flight), so RAM stays bounded and files
// over 5 GB use multipart.
export async function putFilerFile(key: string, body: string | Readable, contentType?: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    let stream: Readable;
    if (typeof body === "string") {
        stream = createReadStream(body);
        stream.on("error", () => {}); // the Upload rejects on its own; avoid an uncaught 'error'
    } else {
        // The caller owns this stream's errors (lib-storage rejects on them).
        stream = body;
    }
    await new Upload({
        client: U.minio_client,
        params: { Bucket: process.env.BUCKET || "imagehost-files", Key: key, Body: stream, ContentType: contentType },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
    }).done();
}

// Puts the upload on the filer and records `rustfsBackedUp` for the pruner. An
// upload deleted meanwhile loses its filer copy again, so a late PUT cannot
// resurrect a purged original.
export async function uploadToFiler(url: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const filepath = U.getFilename(url);
    // Mark in-flight; the pruner only evicts files flagged exactly `true`.
    await U.query.index.updateOne(
        { _id: url, mimetype: { $ne: "deleted" } },
        { $set: { rustfsBackedUp: "uploading" } },
    ).catch(() => {});
    await putFilerFile(url, filepath);
    const r = await U.query.index.updateOne(
        { _id: url, mimetype: { $ne: "deleted" } },
        { $set: { rustfsBackedUp: true } },
    );
    if (r.matchedCount === 0) {
        await U.minio_client.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET || "imagehost-files", Key: url }));
    }
}

export async function downloadFromMinio(key: string, destPath: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const response = await U.minio_client.send(new GetObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: key,
    }));
    const body = response.Body;
    // Node's HTTP handler returns a Readable; a web stream is wrapped so undici
    // can't double-close it after the pipe completes.
    const source = body instanceof Readable ? body
        : body instanceof ReadableStream ? Readable.fromWeb(body)
        : undefined;
    if (!source) throw new Error("Empty response from minio");
    await pipeline(source, createWriteStream(destPath));
}

// Best-effort PUT of this volume's not-yet-ingested files, used on shutdown so the
// filer has them before the pod (and possibly its disk) goes away.
export async function flushVolume(volumeId: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    const docs: { _id: string }[] = await U.query.index.find(
        { volumeId, rustfsBackedUp: { $ne: true }, mimetype: { $ne: "deleted" } },
        { projection: { _id: 1 } },
    ).limit(200).toArray();
    let stored = 0;
    for (const doc of docs) {
        if (Date.now() > deadline) break;
        try {
            await fs.access(U.getFilename(doc._id));
        } catch {
            continue;
        }
        try {
            await uploadToFiler(doc._id);
            stored++;
        } catch (e) {
            serverLog(`Flush: filer PUT failed for ${doc._id}: ${(e as Error).message}`);
        }
    }
    serverLog(`Flush: stored ${stored} of ${docs.length} pending uploads on volume ${volumeId}`);
}

// Starts workflows for uploads this volume still holds: ones whose start was missed
// (Temporal unreachable at upload time, or the pod died between response and start)
// and ones stuck mid-ingest after a failed workflow (e.g. the filer was down).
export function startIngestReconciler(volumeId: string): void {
    let indexEnsured = false;
    let running = false;
    const tick = async () => {
        if (!indexEnsured) {
            indexEnsured = true;
            try {
                await U.query.index.createIndex(
                    { volumeId: 1, workflowStartedAt: 1 },
                    { partialFilterExpression: { volumeId: { $exists: true } } },
                );
            } catch (e) {
                serverLog(`Reconciler: createIndex failed (continuing without it): ${(e as Error).message}`);
            }
        }
        const docs: { _id: string; rustfsBackedUp?: unknown }[] = await U.query.index.find(
            ingestRetryQuery(volumeId, Date.now()),
            { projection: { _id: 1, rustfsBackedUp: 1 } },
        ).limit(50).toArray();
        for (const doc of docs) {
            // The activity ingests from this volume's disk, so a missing file cannot be
            // recovered by retrying. Record that instead of looping forever.
            try {
                await fs.access(U.getFilename(doc._id));
            } catch {
                if (doc.rustfsBackedUp === "uploading") {
                    await U.query.index.updateOne({ _id: doc._id }, { $set: { ingestFailed: "local-copy-missing" } });
                    serverLog(`Reconciler: no local copy of ${doc._id} (volume ${volumeId}); marked ingestFailed`);
                }
                continue;
            }
            const result = await startUploadWorkflow({ url: doc._id, volumeId });
            if (result === "unavailable") return;
            serverLog(`Reconciler: workflow for ${doc._id} ${result}`);
        }
    };
    const run = () => {
        if (running) return;
        running = true;
        tick()
            .catch((e) => serverLog(`Reconciler: tick failed: ${(e as Error).message}`))
            .finally(() => { running = false; });
    };
    run();
    setInterval(run, RECONCILE_MS);
}

// Starts DeleteUploadWorkflow for deleted uploads whose purge has not run. A start
// older than an hour without purgedAt is retried (e.g. a transient S3 error failed
// the workflow). Every web pod runs this; the workflow id dedupes them.
export function startDeleteReconciler(): void {
    let indexEnsured = false;
    let running = false;
    const tick = async () => {
        if (!indexEnsured) {
            indexEnsured = true;
            try {
                await U.query.index.createIndex(
                    { deletedAt: 1 },
                    { partialFilterExpression: { deletedAt: { $exists: true } } },
                );
            } catch (e) {
                serverLog(`Delete reconciler: createIndex failed (continuing without it): ${(e as Error).message}`);
            }
        }
        const docs: { _id: string }[] = await U.query.index.find(
            deleteRetryQuery(Date.now()),
            { projection: { _id: 1 } },
        ).limit(50).toArray();
        for (const doc of docs) {
            const result = await startDeleteWorkflow(doc._id);
            if (result === "unavailable") return;
            serverLog(`Delete reconciler: workflow for ${doc._id} ${result}`);
        }
    };
    const run = () => {
        if (running) return;
        running = true;
        tick()
            .catch((e) => serverLog(`Delete reconciler: tick failed: ${(e as Error).message}`))
            .finally(() => { running = false; });
    };
    run();
    setInterval(run, RECONCILE_MS);
}
