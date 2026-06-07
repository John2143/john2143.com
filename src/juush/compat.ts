// Bridge between Hono Context and the old juush reqx/res API
import type { Context } from "hono";
import { Writable } from "node:stream";
import { Buffer } from "node:buffer";
import { createReadStream, createWriteStream, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface CompatRes extends Writable {
    setHeader(name: string, value: string | number): void;
    writeHead(code: number, headers?: Record<string, string>): void;
    statusCode: number;
    _headers: Record<string, string>;
    _statusCode: number;
    _chunks: Buffer[];
    _responseReady: boolean;
    _spillPath: string | null;
    _spillStream: any | null;
    _totalBytes: number;
}

const MEMORY_LIMIT = 65536; // 64KB — buffer in memory, spill larger to disk

// Create a response adapter. Buffers small responses in memory;
// spills large ones (file downloads) to a temp file for streaming.
export function createCompatRes(): CompatRes {
    const chunks: Buffer[] = [];
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let responseReady = false;
    let spillPath: string | null = null;
    let spillStream: any = null;
    let totalBytes = 0;

    const writable = new Writable({
        write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;

            if (spillStream) {
                spillStream.write(buf, callback);
            } else if (totalBytes > MEMORY_LIMIT) {
                // Spill to disk — flush buffered chunks, then stream remainder
                spillPath = join(tmpdir(), "juush-res-" + randomBytes(8).toString("hex"));
                spillStream = createWriteStream(spillPath);
                spillStream.on("error", () => {});
                // Write buffered chunks to spill file
                const drained = spillStream.write(Buffer.concat(chunks));
                chunks.length = 0; // free memory
                if (drained) {
                    spillStream.write(buf, callback);
                } else {
                    spillStream.once("drain", () => spillStream.write(buf, callback));
                }
            } else {
                chunks.push(buf);
                callback();
            }
        },
        final(callback: (error?: Error | null) => void) {
            responseReady = true;
            if (spillStream) {
                spillStream.end(callback);
            } else {
                callback();
            }
        },
        autoDestroy: true,
    });

    // Prevent Node.js from crashing on stream errors (client disconnect, etc.)
    writable.on("error", (_err: Error) => {
        // Swallow — juush handlers manage their own error reporting
    });

    const res = writable as CompatRes;

    res._headers = headers;
    res._statusCode = statusCode;
    res._chunks = chunks;
    res._responseReady = responseReady;
    res._spillPath = spillPath;
    res._spillStream = spillStream;
    res._totalBytes = totalBytes;
    res.statusCode = 200;

    res.setHeader = function(name: string, value: string | number) {
        res._headers[name.toLowerCase()] = String(value);
    };

    res.writeHead = function(code: number, hdrs?: Record<string, string>) {
        res._statusCode = code;
        res.statusCode = code;
        if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) {
                res._headers[k.toLowerCase()] = v;
            }
        }
    };

    return res;
}

// Flush the compat response to Hono Context.
// Small responses: in-memory Buffer. Large: streamed from disk.
export function flushCompatRes(c: Context, res: CompatRes): Response {
    for (const [name, value] of Object.entries(res._headers)) {
        if (name === "transfer-encoding") continue;
        c.header(name, value);
    }
    c.status(res._statusCode as any);

    const spillPath = (res as CompatRes)._spillPath;

    if (spillPath && existsSync(spillPath)) {
        // Large response — stream from temp file, clean up after
        const stream = createReadStream(spillPath, { autoClose: true });
        stream.on("close", () => {
            try { unlinkSync(spillPath); } catch (_) {}
        });
        stream.on("error", () => {
            try { unlinkSync(spillPath); } catch (_) {}
        });
        // Convert Node.js Readable to Web ReadableStream for Hono
        const webStream = new ReadableStream({
            start(controller) {
                stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
                stream.on("end", () => controller.close());
                stream.on("error", (err: Error) => controller.error(err));
            },
            cancel() {
                stream.destroy();
            },
        });
        return c.body(webStream);
    }

    if (res._chunks.length > 0) {
        const body = Buffer.concat(res._chunks);
        return c.body(body);
    }
    return c.body(null);
}

// Create a compat reqx object from Hono Context
export function createCompatReqx(c: Context, res?: CompatRes) {
    const url = new URL(c.req.url);
    const path = c.req.path.replace(/^\//, "").split("/").filter(Boolean);

    // Parse query string
    const query: Record<string, string> = {};
    url.searchParams.forEach((val, key) => { query[key] = val; });

    // Get IP from x-forwarded-for or socket
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

    // Forward all headers from the Node.js incoming request.
    const reqHeaders: Record<string, string> = {};
    const incoming = (c.env as any)?.incoming;
    if (incoming?.headers) {
        Object.assign(reqHeaders, incoming.headers);
    } else {
        for (const [key, val] of Object.entries(c.req.header() || {})) {
            reqHeaders[key] = val || "";
        }
    }

    // Build a minimal req-like object that juush expects
    const req = {
        socket: { remoteAddress: ip },
        headers: reqHeaders,
        method: c.req.method,
        url: c.req.url,
    };

    const doHTML = (html: string, code = 200) => {
        if (res) {
            res.writeHead(code, { "Content-Type": "text/html" });
            res.end(html);
        }
    };

    return { req, urldata: { path, query }, doHTML };
}
