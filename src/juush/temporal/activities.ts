import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import * as U from "../util.js";

export async function checkFileOnDisk(url: string): Promise<void> {
    const filepath = U.getFilename(url);
    await fs.access(filepath);
}

export async function downloadFromS3IfMissing(url: string, _mimetype: string): Promise<void> {
    const filepath = U.getFilename(url);
    try {
        await fs.access(filepath);
        return; // file exists, skip download
    } catch {
        // file missing, download from S3
    }

    if (!U.s3_client) throw new Error("s3_client not configured");

    const cmd = new GetObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: url,
    });
    const response = await U.s3_client.send(cmd);

    if (!response.Body) throw new Error(`Empty body for ${url}`);

    const tmpPath = filepath + ".tmp";
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(tmpPath));
    await fs.rename(tmpPath, filepath);
}

export async function uploadToSeaweedFS(url: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const filepath = U.getFilename(url);

    const stream = createReadStream(filepath);
    stream.on("error", () => {});

    await U.minio_client.send(new PutObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: url,
        Body: stream,
    }));
}

export async function markRustfsBackedUp(url: string): Promise<void> {
    if (!U.query?.index) throw new Error("Database not ready");
    await U.query.index.updateOne(
        { _id: url },
        { $set: { rustfsBackedUp: true } },
    );
}
