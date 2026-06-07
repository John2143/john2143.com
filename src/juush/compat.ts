// Bridge between Hono Context and the old juush reqx/res API
import type { Context } from "hono";
import { Writable } from "node:stream";
import { Buffer } from "node:buffer";

export interface CompatRes extends Writable {
    setHeader(name: string, value: string | number): void;
    writeHead(code: number, headers?: Record<string, string>): void;
    statusCode: number;
    _headers: Record<string, string>;
    _statusCode: number;
    _chunks: Buffer[];
    _responseReady: boolean;
}

// Create a response adapter that collects output via stream piping and can be flushed to Hono Context
export function createCompatRes(): CompatRes {
    const chunks: Buffer[] = [];
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let responseReady = false;

    const writable = new Writable({
        write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void) {
            if (Buffer.isBuffer(chunk)) {
                chunks.push(chunk);
            } else {
                chunks.push(Buffer.from(chunk));
            }
            callback();
        },
        final(callback: (error?: Error | null) => void) {
            responseReady = true;
            callback();
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

// Flush the compat response to Hono Context
export function flushCompatRes(c: Context, res: CompatRes): Response {
    for (const [name, value] of Object.entries(res._headers)) {
        // Don't set transfer-encoding: chunked — Hono handles this
        if (name === "transfer-encoding") continue;
        c.header(name, value);
    }
    c.status(res._statusCode as any);

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
