// Bridge between Hono Context and the old juush reqx/res API
import type { Context } from "hono";

export interface CompatRes {
    setHeader(name: string, value: string | number): void;
    writeHead(code: number, headers?: Record<string, string>): void;
    end(data?: any): void;
    statusCode: number;
    _headers: Record<string, string>;
    _statusCode: number;
    _body: any;
    _done: boolean;
}

// Create a response adapter that collects output and can be flushed to Hono Context
export function createCompatRes(): CompatRes {
    const res: CompatRes = {
        _headers: {},
        _statusCode: 200,
        _body: null,
        _done: false,
        statusCode: 200,

        setHeader(name: string, value: string | number) {
            res._headers[name.toLowerCase()] = String(value);
        },

        writeHead(code: number, headers?: Record<string, string>) {
            res._statusCode = code;
            res.statusCode = code;
            if (headers) {
                for (const [k, v] of Object.entries(headers)) {
                    res._headers[k.toLowerCase()] = v;
                }
            }
        },

        end(data?: any) {
            if (res._done) return;
            res._done = true;
            if (data !== undefined && data !== null) {
                res._body = data;
            }
        },
    };
    return res;
}

// Flush the compat response to Hono Context
export function flushCompatRes(c: Context, res: CompatRes): Response {
    for (const [name, value] of Object.entries(res._headers)) {
        c.header(name, value);
    }
    c.status(res._statusCode as any);
    return c.body(res._body);
}

// Create a compat reqx object from Hono Context
export function createCompatReqx(c: Context) {
    const url = new URL(c.req.url);
    const path = c.req.path.replace(/^\//, "").split("/").filter(Boolean);

    // Parse query string
    const query: Record<string, string> = {};
    url.searchParams.forEach((val, key) => { query[key] = val; });

    // Get IP from x-forwarded-for or socket
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

    // Build a minimal req-like object that juush expects
    const req = {
        socket: {
            remoteAddress: ip,
        },
        headers: {
            host: c.req.header("host") || "",
            referer: c.req.header("referer") || "",
            range: c.req.header("range") || "",
            cookie: c.req.header("cookie") || "",
            "x-forwarded-for": c.req.header("x-forwarded-for") || "",
            "x-forwarded-proto": c.req.header("x-forwarded-proto") || "https",
        },
        method: c.req.method,
        url: c.req.url,
    };

    return { req, urldata: { path, query } };
}
