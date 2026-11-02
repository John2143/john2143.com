/**
 * Shared helpers for the maintenance scripts (Seaweed scan / repair / audit and
 * the thumbnail backfill).
 *
 * Import rule: this file may only depend on `node:*` and `@aws-sdk/client-s3`,
 * never on `../juush/util.js`, so `src/tests/seaweed-repair.test.ts` can load it
 * without Mongo/S3 credentials in the environment.
 *
 * The damage model it encodes: Seaweed objects were written with a 32-byte
 * header in front of *every* 1 MiB block, so an object of plaintext length `n`
 * occupies `n + 32 * ceil(n / 1048576)` bytes. De-framing drops those headers.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable, Transform, TransformCallback } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

export type RawState = "missing" | "empty" | "junk" | "clean" | "framed" | "unknown-magic";

export const FRAME_BLOCK = 1_048_576;
export const FRAME_HDR = 32;
export const FRAME_SIZE = FRAME_BLOCK + FRAME_HDR; // 1_048_608
// Longest signature check is ts (offset 188) and svg (a regex over 512 bytes).
export const HEAD_LEN = 1056;

function hasHex(buf: Buffer, offset: number, hex: string): boolean {
    const len = hex.length / 2;
    if (buf.length < offset + len) return false;
    return buf.subarray(offset, offset + len).toString("hex") === hex;
}

/** Media family of the bytes at offset 0 of `head`. */
export function contentKind(head: Buffer): string {
    if (!head || head.length < 4) return "other";
    if (hasHex(head, 0, "89504e470d0a1a0a")) return "png";
    if (hasHex(head, 0, "ffd8ff")) return "jpeg";
    if (hasHex(head, 0, "47494638")) return "gif";
    if (hasHex(head, 0, "52494646")) return hasHex(head, 8, "57454250") ? "webp" : "riff";
    if (hasHex(head, 4, "66747970")) return "isobmff";
    if (hasHex(head, 4, "6a502020")) return "jp2";
    for (const box of ["6d6f6f76", "6d646174", "77696465", "66726565", "736b6970", "706e6f74"]) {
        if (hasHex(head, 4, box)) return "mov";
    }
    if (hasHex(head, 0, "1a45dfa3")) return "mkv";
    if (hasHex(head, 0, "464c5601")) return "flv";
    if (hasHex(head, 0, "4f676753")) return "ogg";
    if (hasHex(head, 0, "000001ba")) return "mpegps";
    if (hasHex(head, 0, "424d")) return "bmp";
    if (hasHex(head, 0, "00000100")) return "ico";
    if (hasHex(head, 0, "49492a00") || hasHex(head, 0, "4d4d002a")) return "tiff";
    if (hasHex(head, 0, "49495500")) return "rw2";
    if (hasHex(head, 0, "38425053")) return "psd";
    if (head[0] === 0x47 && head.length > 188 && head[188] === 0x47) return "ts";
    const text = head.subarray(0, 512).toString("latin1");
    if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return "svg";
    return "other";
}

const KIND_TABLE: Record<string, string[]> = {
    "image/png": ["png"],
    "image/jpeg": ["jpeg"],
    "image/gif": ["gif"],
    "image/webp": ["webp", "riff"],
    "image/avif": ["isobmff"],
    "image/tiff": ["tiff"],
    "image/bmp": ["bmp"],
    "image/svg+xml": ["svg"],
    "image/vnd.microsoft.icon": ["ico"],
    "image/jp2": ["jp2"],
    "image/x-panasonic-rw2": ["rw2", "tiff"],
    "image/vnd.adobe.photoshop": ["psd"],
    "video/mp4": ["isobmff"],
    "video/x-m4v": ["isobmff"],
    "video/quicktime": ["mov", "isobmff"],
    "video/webm": ["mkv"],
    "video/x-matroska": ["mkv"],
    "video/x-msvideo": ["riff"],
    "video/x-flv": ["flv"],
    "video/ogg": ["ogg"],
    "video/mpeg": ["mpegps", "ts"],
};

/** `["*"]` means "no signature to compare against" — never call such an object damaged. */
export function allowedKinds(mime: string | undefined): string[] {
    if (!mime) return ["*"];
    return KIND_TABLE[mime] || ["*"];
}

export function typeMatches(mime: string | undefined, kind: string): boolean {
    const allowed = allowedKinds(mime);
    return allowed[0] === "*" || allowed.includes(kind);
}

export function rawState(mime: string | undefined, size: number | undefined, head: Buffer | null): RawState {
    if (size === undefined) return "missing";
    if (size === 0) return "empty";
    if (size <= FRAME_HDR) return "junk";
    const allowed = allowedKinds(mime);
    if (allowed[0] === "*") return "clean";
    if (head) {
        const atZero = contentKind(head);
        if (atZero !== "other" && allowed.includes(atZero)) return "clean";
        if (head.length >= FRAME_HDR + 64) {
            const atFrame = contentKind(head.subarray(FRAME_HDR));
            // Deliberately independent of the mimetype: an object holding a different
            // format is still framed; the mimetype only decides whether de-framing the
            // content may be written.
            if (atFrame !== "other") return "framed";
        }
    }
    return "unknown-magic";
}

/**
 * Inverse of `f(n) = n + 32 * ceil(n / FRAME_BLOCK)`, which is strictly
 * increasing, so the first consistent `n` is unique. `null` when the size cannot
 * be a framed object.
 */
export function framedPlainLen(size: number): number | null {
    if (!Number.isFinite(size) || size <= FRAME_HDR) return null;
    for (let b = 1; FRAME_HDR * b < size; b++) {
        const n = size - FRAME_HDR * b;
        if (n > 0 && Math.ceil(n / FRAME_BLOCK) === b) return n;
    }
    return null;
}

/** Drops FRAME_HDR bytes at every FRAME_SIZE boundary; reports the removed headers. */
export class DeFramer extends Transform {
    headers: Buffer[] = [];
    blocks = 0;
    outBytes = 0;
    blockPos = 0;
    private onHeaders?: (headers: Buffer, blocks: number) => void;

    constructor(onHeaders?: (headers: Buffer, blocks: number) => void) {
        super({ highWaterMark: FRAME_SIZE });
        this.onHeaders = onHeaders;
    }

    _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
        const parts: Buffer[] = [];
        let i = 0;
        while (i < chunk.length) {
            const bp = this.blockPos;
            if (bp < FRAME_HDR) {
                const take = Math.min(FRAME_HDR - bp, chunk.length - i);
                this.headers.push(Buffer.from(chunk.subarray(i, i + take)));
                if (bp + take === FRAME_HDR) this.blocks++;
                i += take;
                this.blockPos = bp + take;
            } else {
                const take = Math.min(FRAME_SIZE - bp, chunk.length - i);
                parts.push(chunk.subarray(i, i + take));
                this.outBytes += take;
                i += take;
                this.blockPos = (bp + take) % FRAME_SIZE;
            }
        }
        cb(null, parts.length === 1 ? parts[0] : Buffer.concat(parts));
    }

    _flush(cb: TransformCallback): void {
        if (this.onHeaders) this.onHeaders(Buffer.concat(this.headers), this.blocks);
        cb();
    }
}

/** Inverse of DeFramer: re-inserts header k in front of plaintext block k. */
export function makeReFramer(headers: Buffer): Transform {
    const headerCount = Math.floor(headers.length / FRAME_HDR);
    let blockIndex = 0;
    let blockFill = 0;
    return new Transform({
        highWaterMark: FRAME_SIZE,
        transform(chunk: Buffer, _enc, cb) {
            const parts: Buffer[] = [];
            let i = 0;
            while (i < chunk.length) {
                if (blockFill === 0) {
                    if (blockIndex >= headerCount) {
                        cb(new Error(`re-framer: no header left for block ${blockIndex}`));
                        return;
                    }
                    parts.push(headers.subarray(blockIndex * FRAME_HDR, (blockIndex + 1) * FRAME_HDR));
                    blockIndex++;
                }
                const take = Math.min(FRAME_BLOCK - blockFill, chunk.length - i);
                parts.push(chunk.subarray(i, i + take));
                i += take;
                blockFill = (blockFill + take) % FRAME_BLOCK;
            }
            cb(null, parts.length === 1 ? parts[0] : Buffer.concat(parts));
        },
    });
}

/** Passes bytes through while asserting the exact length and SHA-256 of the whole body. */
export class Guard extends Transform {
    private hash = createHash("sha256");
    private seen = 0;

    constructor(private expectSize: number, private expectSha256: string) {
        super();
    }

    _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
        this.seen += chunk.length;
        if (this.seen > this.expectSize) {
            cb(new Error(`guard: body longer than expected ${this.expectSize} bytes`));
            return;
        }
        this.hash.update(chunk);
        cb(null, chunk);
    }

    _flush(cb: TransformCallback): void {
        if (this.seen !== this.expectSize) {
            cb(new Error(`guard: body is ${this.seen} bytes, expected ${this.expectSize}`));
            return;
        }
        const got = this.hash.digest("hex");
        if (got !== this.expectSha256) {
            cb(new Error(`guard: sha256 ${got} != expected ${this.expectSha256}`));
            return;
        }
        cb();
    }
}

/** sha256 + length of everything passing through; reports once on flush. */
export class Tap extends Transform {
    private hash = createHash("sha256");
    private seen = 0;

    constructor(private onDone: (bytes: number, sha256: string) => void) {
        super();
    }

    _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
        this.seen += chunk.length;
        this.hash.update(chunk);
        cb(null, chunk);
    }

    _flush(cb: TransformCallback): void {
        this.onDone(this.seen, this.hash.digest("hex"));
        cb();
    }
}

/** Flat keys of the bucket (no "/" in the name) with their sizes, from ListObjectsV2. */
export async function listFlatKeys(client: S3Client, bucket: string): Promise<Map<string, number>> {
    const keys = new Map<string, number>();
    let token: string | undefined;
    do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: token }));
        for (const obj of res.Contents || []) {
            if (!obj.Key || obj.Key.includes("/")) continue;
            keys.set(obj.Key, obj.Size || 0);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

/** Node Readable for an SDK body: a Node stream, a web stream, or a hard error. */
export function toReadable(body: unknown): Readable {
    if (body instanceof Readable) return body;
    if (body && typeof body === "object" && "getReader" in body && typeof body.getReader === "function") {
        // Narrowed above to an object exposing getReader: the undici/WHATWG stream type.
        return Readable.fromWeb(body as WebReadableStream);
    }
    throw new Error("Empty body");
}

export async function sha256HexOfFile(path: string): Promise<{ size: number; sha256: string }> {
    const hash = createHash("sha256");
    let size = 0;
    await new Promise<void>((resolve, reject) => {
        const input = createReadStream(path);
        input.on("error", reject);
        input.on("data", (chunk: Buffer) => {
            size += chunk.length;
            hash.update(chunk);
        });
        input.on("end", () => resolve());
    });
    return { size, sha256: hash.digest("hex") };
}

/** Destroys a stream that stalls: at least 300 s, or its size at 5 MB/s. */
export function watchdog(stream: Readable, bytes: number): () => void {
    const ms = Math.max(300_000, Math.ceil((bytes || 0) / (5 * 1024 * 1024)) * 1000 + 60_000);
    const timer = setTimeout(() => stream.destroy(new Error(`watchdog: no progress in ${ms} ms`)), ms);
    stream.once("close", () => clearTimeout(timer));
    return () => clearTimeout(timer);
}

/** Runs `fn` over `items` with a fixed number of workers; `fn` owns its errors. */
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            await fn(items[index], index);
        }
    });
    await Promise.all(workers);
}
