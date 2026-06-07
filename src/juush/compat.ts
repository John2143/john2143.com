// Bridge between Hono Context and the old juush reqx/res API
import type { Context } from "hono";
import { Writable } from "node:stream";
import { Buffer } from "node:buffer";
import { stream } from "hono/streaming";

export interface CompatRes extends Writable {
    setHeader(name: string, value: string | number): void;
    writeHead(code: number, headers?: Record<string, string>): void;
    statusCode: number;
    _headers: Record<string, string>;
    _statusCode: number;
    _chunks: Buffer[];
    _responseReady: boolean;
    _streamWriter: any; // Hono stream writer for direct streaming (no buffering)
}

// Create a response adapter. If a Hono Context is provided, large responses
// will be streamed directly instead of buffered in memory.
export function createCompatRes(c?: Context): CompatRes {
    const chunks: Buffer[] = [];
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let responseReady = false;
    let streamWriter: any = null;

    // If Hono context available, prepare a streaming writer for large responses
    if (c) {
        streamWriter = (() => {
            let writer: any = null;
            let writerReady: Promise<void>;
            let writerResolve: () => void;
            writerReady = new Promise<void>(r => { writerResolve = r; });

            // Start the Hono stream — this runs async, writer is available after first yield
            const streamPromise = stream(c, async (w) => {
                writer = w;
                writerResolve();
                // Keep the stream open until the response finishes
                await new Promise<void>(r => {
                    (w as any)._onClose = r;
                });
            });

            return {
                write: async (chunk: Buffer) => {
                    await writerReady;
                    await writer.write(chunk);
                },
                close: async () => {
                    await writerReady;
                    // writer.close() is called when we're done
                    if ((writer as any)?._onClose) (writer as any)._onClose();
                },
            };
        })();
    }

    const writable = new Writable({
        write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void) {
            if (streamWriter) {
                // Stream directly — don't buffer
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                streamWriter.write(buf).then(() => callback()).catch(callback);
            } else {
                if (Buffer.isBuffer(chunk)) {
                    chunks.push(chunk);
                } else {
                    chunks.push(Buffer.from(chunk));
                }
                callback();
            }
        },
        final(callback: (error?: Error | null) => void) {
            responseReady = true;
            if (streamWriter) {
                streamWriter.close().then(() => callback()).catch(callback);
            } else {
                callback();
            }
        },
        autoDestroy: true,
    });

    const res = writable as CompatRes;

    res._headers = headers;
    res._statusCode = statusCode;
    res._chunks = chunks;
    res._responseReady = responseReady;
    res._streamWriter = streamWriter;
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
// If streaming was used, the response was already sent — just finalize.
export function flushCompatRes(c: Context, res: CompatRes): Response {
    for (const [name, value] of Object.entries(res._headers)) {
        if (name === "transfer-encoding") continue;
        c.header(name, value);
    }
    c.status(res._statusCode as any);

    if (res._streamWriter) {
        // Streamed response — headers and body already sent via Hono stream()
        return c.body(null);
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
    // @hono/node-server's req.raw.headers is a minimal object (only
    // get/set), not a Web Headers. The real IncomingMessage is on
    // c.env.incoming with the standard Node.js headers dict.
    const reqHeaders: Record<string, string> = {};
    const incoming = (c.env as any)?.incoming;
    if (incoming?.headers) {
        Object.assign(reqHeaders, incoming.headers);
    } else {
        // Fallback: pull individual headers from Hono context
        for (const [key, val] of Object.entries(c.req.header() || {})) {
            reqHeaders[key] = val || "";
        }
    }

    // Build a minimal req-like object that juush expects
    const req = {
        socket: {
            remoteAddress: ip,
        },
        headers: reqHeaders,
        method: c.req.method,
        url: c.req.url,
    };

    // Add missing request class methods that juush handlers rely on
    const doHTML = (html: string, code = 200) => {
        if (res) {
            res.writeHead(code, { "Content-Type": "text/html" });
            res.end(html);
        }
    };

    return { req, urldata: { path, query }, doHTML };
}
