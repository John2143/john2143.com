/**
 * Activities registered only by web pods, on the task queue of the disk volume
 * they mount (`john2143-com-ingest-<volumeId>`). Only the pod whose disk holds an
 * upload can run its ingest, which is what makes DO + home race-safe.
 */
import fs from "node:fs/promises";
import { ApplicationFailure, Context } from "@temporalio/activity";
import * as U from "../util.js";
import { uploadToFiler } from "../pipeline.js";

export async function ingestToFiler(url: string): Promise<"stored" | "already" | "deleted"> {
    const doc: { rustfsBackedUp?: unknown; mimetype?: string } | null = await U.query.index.findOne(
        { _id: url },
        { projection: { rustfsBackedUp: 1, mimetype: 1 } },
    );
    if (doc?.mimetype === "deleted") return "deleted";
    if (doc?.rustfsBackedUp === true) return "already";
    const onDisk = await fs.access(U.getFilename(url)).then(() => true, () => false);
    if (!doc || !onDisk) {
        throw ApplicationFailure.nonRetryable(`local file missing for ${url}`, "LocalFileMissing");
    }

    const ctx = Context.current();
    const heartbeat = setInterval(() => ctx.heartbeat(), 30_000);
    try {
        await uploadToFiler(url);
    } finally {
        clearInterval(heartbeat);
    }
    return "stored";
}
