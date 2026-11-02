/**
 * Media helpers for the worker: web MP4, WebP thumbnail and the tiny blur-up preview.
 * Only child_process, fs and sharp are imported so tests can load this without
 * Mongo, S3 or Temporal.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import sharp from "sharp";

// libvips sizes its thread pool from host cores (64 on `big`), not the pod's 2-CPU limit.
sharp.concurrency(2);
// Long-running worker: no libvips operation cache.
sharp.cache(false);

export const THUMB_MAX_DIM = 480;
export const PREVIEW_MAX_BYTES = 160;
export const TRANSCODE_MAX_SECONDS = 600;
const PREVIEW_STEPS = [{ dim: 16, quality: 50 }, { dim: 12, quality: 35 }, { dim: 8, quality: 20 }];

export interface MediaProbe {
    videoCodec?: string;
    audioCodec?: string;
    durationSec?: number;
}

export type WebVideoResult = "remux" | "transcode" | "skipped";

const nonEmpty = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.size > 0, () => false);

export async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // Output is not read; "ignore" keeps a chatty stderr from filling a pipe and stalling ffmpeg.
    const proc = spawn("ffmpeg", args, { stdio: "ignore" });
    const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}`));
    });
    proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
    });
    return promise;
}

export async function probeMedia(src: string): Promise<MediaProbe> {
    const { promise, resolve, reject } = Promise.withResolvers<MediaProbe>();
    const proc = spawn("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", src,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => { out += d; });
    const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("ffprobe timed out after 30000 ms"));
    }, 30_000);
    proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
        try {
            const j = JSON.parse(out);
            const streams: { codec_type?: string; codec_name?: string }[] = j.streams ?? [];
            const duration = Number(j.format?.duration);
            resolve({
                videoCodec: streams.find((s) => s.codec_type === "video")?.codec_name,
                audioCodec: streams.find((s) => s.codec_type === "audio")?.codec_name,
                durationSec: Number.isFinite(duration) ? duration : undefined,
            });
        } catch (e) {
            reject(e);
        }
    });
    proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
    });
    return promise;
}

export function isWebSafe(p: MediaProbe): boolean {
    return p.videoCodec === "h264" && (p.audioCodec === undefined || p.audioCodec === "aac" || p.audioCodec === "mp3");
}

// Browser-playable fast-start MP4: a remux for H.264 sources, otherwise an x264
// transcode for clips up to TRANSCODE_MAX_SECONDS. ffmpeg errors propagate.
export async function makeWebVideo(src: string, out: string, probe: MediaProbe): Promise<WebVideoResult> {
    if (!probe.videoCodec) return "skipped";
    if (isWebSafe(probe)) {
        await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
            "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "-y", out], 600_000);
        return "remux";
    }
    if ((probe.durationSec ?? Infinity) > TRANSCODE_MAX_SECONDS) return "skipped";
    // -threads 2 caps x264 at the pod's CPU limit; host-sized threading can exceed the 2 Gi memory limit.
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale='trunc(min(1920,iw)/2)*2':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        "-f", "mp4", "-y", out], 1_200_000);
    return "transcode";
}

// WebP thumbnail, at most THUMB_MAX_DIM on the longest side. Video frames are grabbed
// with ffmpeg (which autorotates) and resized by sharp (which applies EXIF orientation).
export async function makeThumbnail(src: string, out: string, isVideo: boolean): Promise<boolean> {
    let input = src;
    if (isVideo) {
        const frame = `${out}.frame.png`;
        const grab = (seek: string[]) => runFfmpeg(["-hide_banner", "-loglevel", "error", ...seek, "-i", src,
            "-frames:v", "1", "-f", "image2", "-c:v", "png", "-y", frame], 60_000);
        // 1 s in skips black first frames; clips shorter than that fall back to frame 0.
        try { await grab(["-ss", "1"]); } catch { /* retried below */ }
        if (!(await nonEmpty(frame))) await grab([]);
        if (!(await nonEmpty(frame))) return false;
        input = frame;
    }
    // First page only for animated input (sharp default); limitInputPixels (default ~268 MP) rejects huge images.
    await sharp(input, { failOn: "error" })
        .rotate() // apply EXIF orientation
        .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 })
        .toFile(out);
    return nonEmpty(out);
}

// Base64 WebP of at most PREVIEW_MAX_BYTES for the gallery's blur-up placeholder, or null.
export async function makePreview(thumb: string): Promise<string | null> {
    for (const { dim, quality } of PREVIEW_STEPS) {
        const buf = await sharp(thumb)
            .resize({ width: dim, height: dim, fit: "inside" })
            .webp({ quality, effort: 6 })
            .toBuffer();
        if (buf.length <= PREVIEW_MAX_BYTES) return buf.toString("base64");
    }
    return null;
}
