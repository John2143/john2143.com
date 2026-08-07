import { Context } from "@temporalio/activity";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import * as U from "../util.js";

export async function uploadToFiler(url: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const filepath = U.getFilename(url);
    const stream = createReadStream(filepath);
    stream.on("error", () => {}); // prevent uncaught exception on ENOENT
    await U.minio_client.send(new PutObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: url,
        Body: stream,
    }));
}

export async function uploadToDOSpaces(url: string, mimetype: string): Promise<void> {
    const filepath = U.getFilename(url);
    const st = await stat(filepath);
    if (st.size > 150 * 1024 * 1024) throw new Error(`File too large: ${url} (${st.size} bytes)`);

    const doKey = `${process.env.FOLDER || "public-prod"}/${url}`;
    const bucket = process.env.BUCKET || "imagehost-files";

    // Create multipart upload
    const mpu = await U.s3_client.send(new CreateMultipartUploadCommand({
        Bucket: bucket, Key: doKey, ACL: "public-read", ContentType: mimetype,
    }));

    try {
        // Read file and upload parts
        const chunkSize = 1024 * 1024 * Number(process.env.S3_CHUNK_SIZE || 15);
        const fd = await open(filepath, "r");
        const parts: { PartNumber: number; ETag: string }[] = [];
        let partNumber = 1;
        let offset = 0;

        // Heartbeat every part so Temporal knows the activity is alive
        while (offset < st.size) {
            const end = Math.min(offset + chunkSize, st.size);
            const buf = Buffer.alloc(end - offset);
            await fd.read(buf, 0, buf.length, offset);
            const resp = await U.s3_client.send(new UploadPartCommand({
                Bucket: bucket, Key: doKey, UploadId: mpu.UploadId,
                PartNumber: partNumber, Body: buf,
            }));
            parts.push({ PartNumber: partNumber, ETag: resp.ETag! });
            Context.current().heartbeat({ partNumber, totalParts: Math.ceil(st.size / chunkSize) });
            offset = end;
            partNumber++;
        }
        await fd.close();

        // Complete
        await U.s3_client.send(new CompleteMultipartUploadCommand({
            Bucket: bucket, Key: doKey, UploadId: mpu.UploadId,
            MultipartUpload: { Parts: parts },
        }));
    } catch (e) {
        // Abort the leaked multipart upload on failure (Temporal will retry the activity)
        await U.s3_client.send(new AbortMultipartUploadCommand({
            Bucket: bucket, Key: doKey, UploadId: mpu.UploadId,
        })).catch(() => {});
        throw e;
    }
}

export async function markRustfsBackedUp(url: string): Promise<void> {
    if (!U.query?.index) throw new Error("Database not ready");
    await U.query.index.updateOne(
        { _id: url },
        { $set: { rustfsBackedUp: true } },
    );
}

import { insertProcessingJobs as _insertProcessingJobs } from "../jobs.js";
export async function insertProcessingJobs(url: string, mimetype: string, fileExtension?: string): Promise<void> {
    await _insertProcessingJobs(url, mimetype, fileExtension);
}
