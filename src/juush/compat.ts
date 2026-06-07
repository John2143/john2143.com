// Bridge between Hono Context and the old juush reqx/res API
import type { Context } from "hono";
import { Writable, PassThrough } from "node:stream";
import { Buffer } from "node:buffer";

export interface CompatRes extends Writable {
    setHeader(name: string, value: string | number): void;
    writeHead(code: number, headers?: Record<string, string>): void;
    statusCode: number;
    _headers: Record<string, string>;
    _statusCode: number;
    _passthrough: PassThrough;
}

// Create a response adapter that streams directly through a PassThrough.
// Headers are captured via writeHead/setHeader and flushed to Hono.
// Body bytes flow: file → passthrough → c.body(passthrough) → Hono → socket.
// PassThrough's internal buffer (64KB highWaterMark) applies backpressure,
// preventing unbounded memory growth.
export function createCompatRes(): CompatRes {
    const passthrough = new PassThrough();
    const headers: Record<string, string> = {};
    let statusCode = 200;

    const writable = new Writable({
        write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void) {
            passthrough.write(chunk, callback);
        },
        final(callback: (error?: Error | null) => void) {
            passthrough.end(callback);
        },
        autoDestroy: true,
    });

    // Prevent Node.js from crashing on stream errors (client disconnect, etc.)
    writable.on("error", (_err: Error) => {
        // Swallow — juush handlers manage their own error reporting
    });
    passthrough.on("error", (_err: Error) => {
        // Client disconnect during streaming — safe to ignore
    });

    const res = writable as CompatRes;

    res._headers = headers;
    res._statusCode = statusCode;
    res._passthrough = passthrough;
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
// Returns a streaming Response — the PassThrough is piped directly by Hono.
// Node.js stream backpressure ensures only 64KB is ever buffered.
export function flushCompatRes(c: Context, res: CompatRes): Response {
    for (const [name, value] of Object.entries(res._headers)) {
        if (name === "transfer-encoding") continue;
        c.header(name, value);
    }
    c.status(res._statusCode as any);

    return c.body(res._passthrough as any);
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
