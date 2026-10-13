/**
 * Identity of the disk volume that holds ./juushFiles.
 *
 * Every upload is ingested to the filer by the pod whose disk has the file, so the
 * ingest activity runs on a task queue named after this volume, not after the pod.
 * The id lives on the volume itself and survives pod restarts and rescheduling.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";

const ID_PATH = "./juushFiles/.volume-id";
const ID_RE = /^[0-9a-f]{12}$/;

let pending: Promise<string> | undefined;

async function load(): Promise<string> {
    let existing: string | undefined;
    try {
        existing = (await fs.readFile(ID_PATH, "utf8")).trim();
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (existing !== undefined) {
        // Never regenerate: a new id would orphan every pending ingest for this disk.
        if (!ID_RE.test(existing)) throw new Error("invalid ./juushFiles/.volume-id");
        return existing;
    }
    const id = crypto.randomBytes(6).toString("hex");
    await fs.writeFile(`${ID_PATH}.tmp`, id);
    await fs.rename(`${ID_PATH}.tmp`, ID_PATH);
    return id;
}

export async function getVolumeId(): Promise<string> {
    return pending ??= load();
}

export const ingestTaskQueue = (volumeId: string) => `john2143-com-ingest-${volumeId}`;
