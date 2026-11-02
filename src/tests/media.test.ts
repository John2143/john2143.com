/**
 * Media helpers against real ffmpeg + sharp — run with `npm test`. The suite is
 * skipped when ffmpeg is not installed; the worker image always has it.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { makePreview, makeThumbnail, makeWebVideo, probeMedia, PREVIEW_MAX_BYTES } from "../juush/media.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function ffmpeg(args: string[]): void {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${r.stderr}`);
}

function videoCodec(file: string): string {
    const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
        "-of", "csv=p=0", file], { encoding: "utf8" });
    return r.stdout.trim();
}

// Fast-start: the moov atom sits in the first 64 KB, ahead of any mdat.
async function moovFirst(file: string): Promise<boolean> {
    const fh = await fs.open(file, "r");
    try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(65536), 0, 65536, 0);
        const head = buffer.subarray(0, bytesRead);
        const moov = head.indexOf("moov");
        const mdat = head.indexOf("mdat");
        return moov >= 0 && (mdat < 0 || moov < mdat);
    } finally {
        await fh.close();
    }
}

describe("media", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
    let dir: string;
    const f = (name: string) => path.join(dir, name);

    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-test-"));
        // format=rgba inside the graph: otherwise the source renders opaque and only the output gains an alpha channel.
        ffmpeg(["-f", "lavfi", "-i", "color=c=red@0.5:s=1200x800,format=rgba", "-frames:v", "1", f("alpha.png")]);
        ffmpeg(["-f", "lavfi", "-i", "testsrc=s=1200x800", "-frames:v", "1", f("photo.png")]);
        ffmpeg(["-f", "lavfi", "-i", "testsrc=s=300x200", "-frames:v", "1", f("small.png")]);
        const av = ["-f", "lavfi", "-i", "testsrc=d=3:s=640x360:r=25", "-f", "lavfi", "-i", "sine=d=3"];
        ffmpeg([...av, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f("h264.mov")]);
        ffmpeg([...av, "-c:v", "mpeg4", "-c:a", "mp2", "-shortest", f("mpeg4.avi")]);
        ffmpeg(["-f", "lavfi", "-i", "testsrc=d=0.5:s=320x240:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("short.mp4")]);
        await sharp({ create: { width: 300, height: 200, channels: 3, background: "#f00" } })
            .jpeg().withMetadata({ orientation: 6 }).toFile(f("rot.jpg"));
    });

    after(async () => {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
    });

    it("makes a 480px WebP thumbnail that keeps alpha", async () => {
        assert.equal(await makeThumbnail(f("alpha.png"), f("alpha.webp"), false), true);
        const m = await sharp(f("alpha.webp")).metadata();
        assert.equal(m.format, "webp");
        assert.equal(m.width, 480);
        assert.equal(m.height, 320);
        assert.equal(m.hasAlpha, true);
    });

    it("never enlarges a small image", async () => {
        assert.equal(await makeThumbnail(f("small.png"), f("small.webp"), false), true);
        const m = await sharp(f("small.webp")).metadata();
        assert.equal(m.width, 300);
        assert.equal(m.height, 200);
    });

    it("applies EXIF orientation", async () => {
        assert.equal(await makeThumbnail(f("rot.jpg"), f("rot.webp"), false), true);
        const m = await sharp(f("rot.webp")).metadata();
        assert.equal(m.width, 200);
        assert.equal(m.height, 300);
    });

    it("makes a preview of at most PREVIEW_MAX_BYTES", async () => {
        assert.equal(await makeThumbnail(f("photo.png"), f("photo.webp"), false), true);
        const preview = await makePreview(f("photo.webp"));
        assert.equal(typeof preview, "string");
        const bytes = Buffer.from(preview, "base64");
        assert.ok(bytes.length <= PREVIEW_MAX_BYTES, `${bytes.length} bytes`);
        assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF");

        await makeThumbnail(f("alpha.png"), f("alpha2.webp"), false);
        const alpha = await makePreview(f("alpha2.webp"));
        assert.ok(alpha === null || Buffer.from(alpha, "base64").length <= PREVIEW_MAX_BYTES);
    });

    it("remuxes H.264 to a fast-start MP4", async () => {
        const probe = await probeMedia(f("h264.mov"));
        assert.equal(probe.videoCodec, "h264");
        assert.equal(probe.audioCodec, "aac");
        assert.ok(probe.durationSec > 2 && probe.durationSec < 4, `duration ${probe.durationSec}`);
        assert.equal(await makeWebVideo(f("h264.mov"), f("h264.fast.mp4"), probe), "remux");
        assert.equal(videoCodec(f("h264.fast.mp4")), "h264");
        assert.equal(await moovFirst(f("h264.fast.mp4")), true);
    });

    it("transcodes MPEG-4 Part 2 to a fast-start H.264 MP4", async () => {
        const probe = await probeMedia(f("mpeg4.avi"));
        assert.equal(probe.videoCodec, "mpeg4");
        assert.equal(await makeWebVideo(f("mpeg4.avi"), f("mpeg4.fast.mp4"), probe), "transcode");
        assert.equal(videoCodec(f("mpeg4.fast.mp4")), "h264");
        assert.equal(await moovFirst(f("mpeg4.fast.mp4")), true);
    });

    it("thumbnails a clip shorter than the 1 s seek", async () => {
        assert.equal(await makeThumbnail(f("short.mp4"), f("short.webp"), true), true);
        const m = await sharp(f("short.webp")).metadata();
        assert.equal(m.format, "webp");
        assert.equal(m.width, 320);
    });

    it("skips long non-web video and inputs without a video stream", async () => {
        assert.equal(await makeWebVideo(f("mpeg4.avi"), f("long.mp4"), { videoCodec: "mpeg4", durationSec: 601 }), "skipped");
        assert.equal(await makeWebVideo(f("mpeg4.avi"), f("none.mp4"), {}), "skipped");
        await assert.rejects(fs.stat(f("long.mp4")));
        await assert.rejects(fs.stat(f("none.mp4")));
    });
});
