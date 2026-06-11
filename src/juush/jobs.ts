/**
 * Job queue for post-upload processing.
 *
 * Dual-mode: RUN_MODE=server processes upload-to-rustfs only.
 *            RUN_MODE=worker processes ffmpeg + backup jobs.
 *
 * Collection: db.jobQueue
 *   { jobType, status, dependsOn, url, mimetype, error, createdAt, updatedAt }
 *
 * Jobs reference the upload by its _id (url). The file itself lives on
 * rustfs (minio) after the server pod uploads it there. The worker pod
 * downloads from rustfs, processes, and uploads results to CDN + rustfs.
 */
import { serverLog } from "../logger.js";
import * as U from "./util.js";
import { uploadToS3, humanFileSize } from "./upload.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable, pipeline } from "node:stream";
import { ObjectId } from "mongodb";

// --- Types ---

export type JobType =
    | "upload-to-rustfs"
    | "ffmpeg-moov-faststart"
    | "ffmpeg-thumbnail"
    | "backup-s3"
    | "upload-artifacts-rustfs"
    | "speech-to-text";

interface JobDoc {
    _id?: ObjectId;
    jobType: JobType;
    status: "queued" | "processing" | "done" | "failed";
    dependsOn: ObjectId[];
    url: string;
    mimetype: string;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
}

const TICK_MS = 5_000;
const S3_MAX_SIZE = 150 * 1024 * 1024;  // 150MB
const THUMB_MAX_SIZE = 500 * 1024 * 1024;  // 500MB
const TEMP_DIR = "/tmp/juush-worker";

// --- Init ---

let jobQueue: ReturnType<typeof U.query.index.collection> | null = null;

export async function initJobQueue() {
    if (!U.query?.index) {
        throw new Error("initJobQueue: database not ready — call startdb() first");
    }
    const db = U.query.index.db;
    jobQueue = db.collection("jobQueue");

    // Ensure indexes
    await jobQueue.createIndex({ status: 1, createdAt: 1 });
    await jobQueue.createIndex({ status: 1, "dependsOn": 1 });

    // Crash recovery: reset stale processing jobs
    const stale = await jobQueue.updateMany(
        { status: "processing" },
        { $set: { status: "queued", updatedAt: new Date() } }
    );
    if (stale.modifiedCount > 0) {
        serverLog(`JobQueue: reset ${stale.modifiedCount} stale processing jobs to queued`);
    }
}

// --- Enqueue ---

export async function enqueueJobs(
    url: string,
    mimetype: string,
    fileExtension?: string
): Promise<void> {
    if (!jobQueue) throw new Error("jobQueue not initialized");

    const isVideo = mimetype?.startsWith("video/");
    const isMP4 = mimetype === "video/mp4" || fileExtension?.toLowerCase() === "mp4";

    // Always enqueue upload-to-rustfs first
    const uploadJob = await jobQueue.insertOne({
        jobType: "upload-to-rustfs",
        status: "queued",
        dependsOn: [],
        url,
        mimetype,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
    serverLog(`JobQueue: enqueued upload-to-rustfs for ${url}`);

    // Processing jobs are inserted AFTER upload-to-rustfs completes.
    // We pre-insert nothing here — handleUploadToRustFS inserts them.
}

export async function insertProcessingJobs(
    url: string,
    mimetype: string,
    fileExtension?: string
): Promise<void> {
    if (!jobQueue) throw new Error("jobQueue not initialized");

    const isVideo = mimetype?.startsWith("video/");
    const isMP4 = mimetype === "video/mp4" || fileExtension?.toLowerCase() === "mp4";

    const jobs: Omit<JobDoc, "_id">[] = [];

    if (isMP4) {
        const faststartId = new ObjectId();
        const thumbnailId = new ObjectId();

        jobs.push({
            jobType: "ffmpeg-moov-faststart",
            status: "queued",
            dependsOn: [],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
            _id: faststartId,
        } as any);

        jobs.push({
            jobType: "ffmpeg-thumbnail",
            status: "queued",
            dependsOn: [],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
            _id: thumbnailId,
        } as any);

        jobs.push({
            jobType: "backup-s3",
            status: "queued",
            dependsOn: [faststartId],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        jobs.push({
            jobType: "upload-artifacts-rustfs",
            status: "queued",
            dependsOn: [faststartId, thumbnailId],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    } else if (isVideo) {
        // Non-MP4 video: only thumbnail + backups (no faststart for webm etc.)
        const thumbnailId = new ObjectId();
        jobs.push({
            jobType: "ffmpeg-thumbnail",
            status: "queued",
            dependsOn: [],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
            _id: thumbnailId,
        } as any);

        jobs.push({
            jobType: "backup-s3",
            status: "queued",
            dependsOn: [],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        jobs.push({
            jobType: "upload-artifacts-rustfs",
            status: "queued",
            dependsOn: [thumbnailId],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    } else {
        // Non-video: just backups
        jobs.push({
            jobType: "backup-s3",
            status: "queued",
            dependsOn: [],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        jobs.push({
            jobType: "upload-artifacts-rustfs",
            status: "queued",
            dependsOn: [],
            url, mimetype,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }

    if (jobs.length > 0) {
        await jobQueue.insertMany(jobs as any);
        serverLog(`JobQueue: inserted ${jobs.length} processing jobs for ${url}`);
    }
}

// --- Dependency resolution ---

async function findReadyJobs(): Promise<JobDoc[]> {
    if (!jobQueue) return [];

    const queued = await jobQueue.find({ status: "queued" })
        .sort({ createdAt: 1 })
        .toArray() as unknown as JobDoc[];

    const ready: JobDoc[] = [];
    for (const job of queued) {
        if (!job.dependsOn || job.dependsOn.length === 0) {
            ready.push(job);
            continue;
        }
        const deps = await jobQueue.find({
            _id: { $in: job.dependsOn }
        }).toArray() as unknown as JobDoc[];

        const allResolved = deps.every(d =>
            d.status === "done" || d.status === "failed"
        );
        if (allResolved) ready.push(job);
    }
    return ready;
}

// --- Claim ---

async function claimJob(job: JobDoc): Promise<JobDoc | null> {
    if (!jobQueue || !job._id) return null;
    const result = await jobQueue.findOneAndUpdate(
        { _id: job._id, status: "queued" },
        { $set: { status: "processing", updatedAt: new Date() } },
        { returnDocument: "after" }
    ) as unknown as JobDoc | null;
    return result;
}

async function completeJob(job: JobDoc): Promise<void> {
    if (!jobQueue || !job._id) return;
    await jobQueue.updateOne(
        { _id: job._id },
        { $set: { status: "done", updatedAt: new Date() } }
    );
}

async function failJob(job: JobDoc, error: string): Promise<void> {
    if (!jobQueue || !job._id) return;
    await jobQueue.updateOne(
        { _id: job._id },
        { $set: { status: "failed", error, updatedAt: new Date() } }
    );
}

// --- Queue processor ---

let processorTimer: ReturnType<typeof setInterval> | null = null;

export function startQueueProcessor(mode: "server" | "worker") {
    if (processorTimer) return;
    serverLog(`JobQueue: starting processor in ${mode} mode`);

    processorTimer = setInterval(async () => {
        try {
            const ready = await findReadyJobs();
            if (ready.length === 0) return;

            for (const job of ready) {
                // Server mode: only upload-to-rustfs
                if (mode === "server" && job.jobType !== "upload-to-rustfs") continue;
                // Worker mode: everything except upload-to-rustfs
                if (mode === "worker" && job.jobType === "upload-to-rustfs") continue;

                const claimed = await claimJob(job);
                if (!claimed) continue; // lost race

                try {
                    switch (claimed.jobType) {
                        case "upload-to-rustfs":
                            await handleUploadToRustFS(claimed);
                            break;
                        case "ffmpeg-moov-faststart":
                            await handleFaststart(claimed);
                            break;
                        case "ffmpeg-thumbnail":
                            await handleThumbnail(claimed);
                            break;
                        case "backup-s3":
                            await handleS3Backup(claimed);
                            break;
                        case "upload-artifacts-rustfs":
                            await handleUploadArtifacts(claimed);
                            break;
                    }
                    await completeJob(claimed);
                } catch (e: any) {
                    serverLog(`JobQueue: job ${claimed.jobType}/${claimed.url} failed: ${e.message}`);
                    await failJob(claimed, e.message);
                }
                break; // one job per tick
            }
        } catch (e: any) {
            serverLog(`JobQueue: processor tick error: ${e.message}`);
        }
    }, TICK_MS);
}

export function stopQueueProcessor() {
    if (processorTimer) {
        clearInterval(processorTimer);
        processorTimer = null;
    }
}

// --- Handlers ---

async function downloadFromMinio(key: string, destPath: string): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const cmd = new (await import("@aws-sdk/client-s3")).GetObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: key,
    });
    const response = await U.minio_client.send(cmd);
    const body = response.Body;
    if (!body) throw new Error("Empty response from minio");

    await fs.mkdir(TEMP_DIR, { recursive: true });
    const file = await fs.open(destPath, "w");
    // Wrap S3 response body with Readable.fromWeb to prevent undici from
    // double-closing the underlying ReadableStream after pipe completes.
    const nodeBody = (body as any)?.getReader
        ? Readable.fromWeb(body as any)
        : (body as import("node:stream").Readable);
    await new Promise<void>((resolve, reject) => {
        const writeStream = file.createWriteStream();
        pipeline(nodeBody, writeStream, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
    await file.close();
}

async function handleUploadToRustFS(job: JobDoc): Promise<void> {
    if (!U.minio_client) throw new Error("minio_client not configured");
    const filepath = U.getFilename(job.url);

    serverLog(`JobQueue: uploading ${job.url} to rustfs`);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await U.minio_client.send(new PutObjectCommand({
        Bucket: process.env.BUCKET || "imagehost-files",
        Key: job.url,
        Body: createReadStream(filepath),
    }));

    // Mark backed up
    await U.query.index.updateOne(
        { _id: job.url },
        { $set: { rustfsBackedUp: true } }
    );

    // Guess file extension for processing jobs
    const data = await U.query.index.findOne(
        { _id: job.url },
        { projection: { filename: 1 } }
    );
    const fileExtension = U.guessFileExtension(data?.filename || "");

    // Insert processing jobs for the worker
    await insertProcessingJobs(job.url, job.mimetype, fileExtension);
}

async function handleFaststart(job: JobDoc): Promise<void> {
    const srcPath = `${TEMP_DIR}/${job.url}`;
    const outPath = `${srcPath}.fast.mp4`;

    serverLog(`JobQueue: faststart ${job.url}`);
    await downloadFromMinio(job.url, srcPath);

    await new Promise<void>((resolve, reject) => {
        const proc = spawn("ffmpeg", [
            "-i", srcPath,
            "-c", "copy",
            "-movflags", "faststart",
            "-y", outPath,
        ], { stdio: "pipe" });
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error("Faststart timed out"));
        }, 120_000);
        proc.on("close", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`));
        });
        proc.on("error", reject);
    });

    // Keep the faststarted file in TEMP_DIR for downstream jobs
    serverLog(`JobQueue: faststart done ${job.url}`);
}

async function handleThumbnail(job: JobDoc): Promise<void> {
    const srcPath = `${TEMP_DIR}/${job.url}`;
    const thumbPath = `${TEMP_DIR}/${job.url}.thumb.jpg`;

    serverLog(`JobQueue: thumbnail ${job.url}`);

    // Check size before downloading
    if (U.minio_client) {
        const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
        try {
            const head = await U.minio_client.send(new HeadObjectCommand({
                Bucket: process.env.BUCKET || "imagehost-files",
                Key: job.url,
            }));
            if (head.ContentLength && head.ContentLength > THUMB_MAX_SIZE) {
                serverLog(`JobQueue: thumbnail skip (${humanFileSize(head.ContentLength)} > ${humanFileSize(THUMB_MAX_SIZE)})`);
                return; // skip, mark done anyway
            }
        } catch {
            // If we can't head the object, try downloading anyway
        }
    }

    await downloadFromMinio(job.url, srcPath);

    await new Promise<void>((resolve, reject) => {
        const proc = spawn("ffmpeg", [
            "-i", srcPath,
            "-ss", "00:00:01",
            "-vframes", "1",
            "-q:v", "5",
            "-y", thumbPath,
        ], { stdio: "pipe" });
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error("Thumbnail timed out"));
        }, 60_000);
        proc.on("close", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`));
        });
        proc.on("error", reject);
    });

    // Clean up source, keep thumbnail
    await fs.unlink(srcPath).catch(() => {});
    serverLog(`JobQueue: thumbnail done ${job.url}`);
}

async function handleS3Backup(job: JobDoc): Promise<void> {
    if (!U.s3_client) {
        serverLog(`JobQueue: S3 backup skip (no s3_client) ${job.url}`);
        return;
    }

    // Use faststarted file if available, otherwise download original from minio
    const fastPath = `${TEMP_DIR}/${job.url}.fast.mp4`;
    let uploadPath: string;
    try {
        await fs.access(fastPath);
        uploadPath = fastPath;
        serverLog(`JobQueue: S3 backup using faststarted file ${job.url}`);
    } catch {
        // Faststarted file not available, download original
        const srcPath = `${TEMP_DIR}/${job.url}`;
        await downloadFromMinio(job.url, srcPath);
        uploadPath = srcPath;
        serverLog(`JobQueue: S3 backup using original file ${job.url}`);
    }

    await uploadToS3(job.url, job.mimetype, 0, uploadPath);

    // Set CDN URL on the index document
    const folder = process.env.FOLDER || "public-prod";
    const cdnBase = process.env.CDN_BASE || `https://imagehost-files.nyc3.cdn.digitaloceanspaces.com/${folder}`;
    const cdnUrl = `${cdnBase}/${job.url}`;

    await U.query.index.updateOne(
        { _id: job.url },
        { $set: { cdn: cdnUrl } }
    );

    // Clean up
    await fs.unlink(uploadPath).catch(() => {});
    serverLog(`JobQueue: S3 backup done ${job.url} → ${cdnUrl}`);
}

async function handleUploadArtifacts(job: JobDoc): Promise<void> {
    if (!U.minio_client) {
        serverLog(`JobQueue: artifact upload skip (no minio_client) ${job.url}`);
        return;
    }

    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const bucket = process.env.BUCKET || "imagehost-files";
    const artifacts: Record<string, string> = {};

    // Upload faststarted file if it exists
    const fastPath = `${TEMP_DIR}/${job.url}.fast.mp4`;
    try {
        await fs.access(fastPath);
        const fastKey = `${job.url}.fast.mp4`;
        await U.minio_client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: fastKey,
            Body: createReadStream(fastPath),
        }));
        artifacts.faststart = `${bucket}/${fastKey}`;
        serverLog(`JobQueue: uploaded artifact ${fastKey}`);
        await fs.unlink(fastPath).catch(() => {});
    } catch {
        // No faststart file — that's fine
    }

    // Upload thumbnail if it exists
    const thumbPath = `${TEMP_DIR}/${job.url}.thumb.jpg`;
    try {
        await fs.access(thumbPath);
        const thumbKey = `${job.url}.thumb.jpg`;
        await U.minio_client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: thumbKey,
            Body: createReadStream(thumbPath),
        }));
        artifacts.thumbnail = `${bucket}/${thumbKey}`;

        // Also upload thumbnail to S3 Spaces so CDN can serve it
        const folder = process.env.FOLDER || "public-prod";
        if (U.s3_client) {
            await U.s3_client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `${folder}/${job.url}.thumb.jpg`,
                Body: createReadStream(thumbPath),
                ACL: "public-read",
                ContentType: "image/jpeg",
            }));
        }

        // Also set the CDN thumb URL
        const cdnBase = process.env.CDN_BASE || `https://imagehost-files.nyc3.cdn.digitaloceanspaces.com/${folder}`;
        await U.query.index.updateOne(
            { _id: job.url },
            { $set: { thumb: `${cdnBase}/${job.url}.thumb.jpg` } }
        );

        serverLog(`JobQueue: uploaded artifact ${thumbKey}`);
        await fs.unlink(thumbPath).catch(() => {});
    } catch {
        // No thumbnail — that's fine
    }

    if (Object.keys(artifacts).length > 0) {
        await U.query.index.updateOne(
            { _id: job.url },
            { $set: { artifacts } }
        );
    }

    // Final cleanup
    await fs.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
    serverLog(`JobQueue: artifacts done ${job.url}`);
}

// --- Reprocess ---

export async function enqueueReprocess(url: string, mimetype: string, fileExtension?: string): Promise<void> {
    if (!jobQueue) throw new Error("jobQueue not initialized");

    // Check if upload-to-rustfs already done
    const uploadJob = await jobQueue.findOne({
        url,
        jobType: "upload-to-rustfs",
    });

    if (uploadJob && (uploadJob as any).status === "done") {
        // Reset all post-upload jobs to queued so they re-run from scratch
        await jobQueue.updateMany(
            { url, jobType: { $ne: "upload-to-rustfs" }, status: { $in: ["done", "failed"] } },
            { $set: { status: "queued", error: null as any, updatedAt: new Date() } }
        );
        // If no processing jobs exist, insert fresh ones
        const existing = await jobQueue.find({
            url,
            jobType: { $ne: "upload-to-rustfs" },
        }).toArray();
        if (existing.length === 0) {
            await insertProcessingJobs(url, mimetype, fileExtension);
        }
    } else {
        // Upload-to-rustfs not done yet (or failed) — re-enqueue from scratch
        if (uploadJob) {
            await jobQueue.updateOne(
                { _id: uploadJob._id },
                { $set: { status: "queued", error: null as any, updatedAt: new Date() } }
            );
        } else {
            await enqueueJobs(url, mimetype, fileExtension);
        }
    }

    serverLog(`JobQueue: reprocess enqueued for ${url}`);
}
