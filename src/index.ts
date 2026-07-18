// Hono-based server for 2143.me
import { Hono } from "hono";
import type { Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger as honoLogger } from "hono/logger";
import { serverLog } from "./logger.js";
import * as serverConst from "./const.js";
import * as fs from "node:fs/promises";
import authRoutes from "./auth/routes.js";
const RUN_MODE = (process.env.RUN_MODE || "server") as "server" | "worker";

// Prevent crashes from undici ReadableStream double-close race condition.
// @hono/node-server v2.0.4 can call reader.cancel() twice when a client
// disconnects during streaming (both 'close' and 'error' events fire on the
// writable).  This is a known upstream issue:
//   https://github.com/honojs/node-server/issues/233
// Upgrade @hono/node-server once a fix is released; this handler is a safety net.
process.on("uncaughtException", (err) => {
    if (err instanceof TypeError && (err as any).code === "ERR_INVALID_STATE" &&
        err.message?.includes("ReadableStream")) {
        serverLog("Suppressed undici ReadableStream double-close", err.message);
        return;
    }
    serverLog("FATAL uncaughtException", err);
    process.exit(1);
});



// Load favicon in memory (preserve existing behavior)
let favicon: Buffer;
fs.readFile("favicon.ico").then(dat => favicon = dat);

const app = new Hono();

// Health check — no logging (mounted before logger)
app.get("/health", (c) => c.text("OK"));

// Logger middleware (skips /health)
app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
        return await next();
    }
    return honoLogger()(c, next);
});

// String redirects (preserve existing short URLs)
const REDIRECTS: Record<string, string> = {
    git: "//github.com/John2143/",
    teamspeak: "ts3server://john2143.com",
    ts: "ts3server://john2143.com",
    steam: "//steamcommunity.com/profiles/76561198027378405",
    osu: "//osu.ppy.sh/u/2563776",
};

for (const [path, target] of Object.entries(REDIRECTS)) {
    app.get(`/${path}`, (c) => c.redirect(target, 301));
}

// favicon.ico
app.get("/favicon.ico", (c) => {
    if (!favicon) return c.notFound();
    const icon = favicon;
    c.header("Content-Type", "image/x-icon");
    c.header("Content-Length", String(icon.length));
    return c.body(icon as any);
});

// Serve static pages from pages/ directory
app.use("/pages/*", serveStatic({ root: "./" }));

// Short page names: /login → pages/login.html
app.get("/:page{[^.]+}", async (c, next) => {
    const page = c.req.param("page");
    const filepath = `./pages/${page}.html`;
    try {
        await fs.stat(filepath);
        let html = await fs.readFile(filepath, "utf-8");
        html = html.replace(/\{\{HOSTNAME\}\}/g, process.env.HOSTNAME || "2143.me");
        c.header("Content-Type", "text/html");
        return c.body(html);
    } catch {
        return await next();
    }
});

// External IP endpoint
app.get("/ip", async (c) => {
    try {
        const resp = await fetch("https://api.ipify.org");
        const ip = await resp.text();
        return c.html(ip);
    } catch {
        return c.text("0.0.0.0");
    }
});

// Blank endpoint (used by tests)
app.get("/blank", (c) => c.text(""));

// Mount auth routes
app.route("/auth", authRoutes);

// Default not-found → git redirect
app.notFound((c) => c.redirect("//github.com/John2143/", 301));

// Register juush routes BEFORE serve() — Hono locks its matcher on first fetch
if (serverConst.dbstring) {
    const juush = await import("./juush/index.js");
    const juushMerge = await import("./juush/merge.js");
    const { isDbReady } = await import("./juush/util.js");

    // Guard: return 503 until DB is connected (non-blocking startdb below)
    const requireDb = (c: Context) => {
        if (!isDbReady()) {
            return c.text("DB not ready", 503);
        }
        return null;
    };

    const juushAPI = new Hono();

    // Admin session check for merge endpoints
    const requireMergeAdmin = async (c: any) => {
        try {
            const { requireUser } = await import("./auth/middleware.js");
            const { createCompatReqx } = await import("./juush/compat.js");
            const user = await requireUser(createCompatReqx(c));
            if (!user) return c.json({ error: "Not authenticated" }, 401);
            if (!user.is_admin) return c.json({ error: "You must be an admin" }, 403);
            return null;
        } catch {
            return c.json({ error: "Not authenticated" }, 401);
        }
    };

    juushAPI.get("/whoami", async (c) => requireDb(c) || juush.handleWhoami(c));
    juushAPI.get("/users", async (c) => requireDb(c) || juush.handleUsers(c));
    juushAPI.get("/uploads/:userid/:page?", async (c) => requireDb(c) || juush.handleUploads(c));
    juushAPI.get("/userinfo/:id", async (c) => requireDb(c) || juush.handleUserInfo(c));
    juushAPI.get("/deluser/:id", async (c) => requireDb(c) || juush.handleDelUser(c));
    juushAPI.get("/isadmin", async (c) => requireDb(c) || juush.handleIsAdmin(c));
    juushAPI.get("/usersetting/:id/:setting/:value", async (c) => requireDb(c) || juush.handleUserSetting(c));
    juushAPI.get("/mykey", async (c) => requireDb(c) || juush.handleMyKey(c));
    // Admin merge panel routes
    juushAPI.get("/merge/search", async (c) => {
        const auth = requireDb(c) || await requireMergeAdmin(c);
        if (auth) return auth;
        const { query } = await import("./juush/util.js");
        return c.json(await juushMerge.handleMergeSearch(query.users, c.req.query("q") || ""));
    });
    juushAPI.get("/merge/preview/:id1/:id2", async (c) => {
        const auth = requireDb(c) || await requireMergeAdmin(c);
        if (auth) return auth;
        const { query } = await import("./juush/util.js");
        return c.json(await juushMerge.handleMergePreview(query.users, c.req.param("id1"), c.req.param("id2")));
    });
    juushAPI.post("/merge/apply", async (c) => {
        const auth = requireDb(c) || await requireMergeAdmin(c);
        if (auth) return auth;
        const { query } = await import("./juush/util.js");
        const body = await c.req.json();
        return c.json(await juushMerge.handleMergeApply(query.users, query.index, body.targetId, body.sourceId, body.fieldChoices));
    });
    app.route("/juush", juushAPI);

    // Download routes
    app.get("/f/:id{.*}", async (c) => requireDb(c) || juush.handleDownload(c));
    app.get("/:name{[^/]+}/:filename", async (c) => requireDb(c) || juush.handleDownload(c));

    // Reprocess existing upload (auth-gated)
    app.post("/f/:id/reprocess", async (c) => requireDb(c) || juush.handleReprocess(c));


    // Upload — accepts GET, POST, PUT (juush client uses PUT)
    app.get("/uf", async (c) => requireDb(c) || juush.handleUpload(c));
    app.post("/uf", async (c) => requireDb(c) || juush.handleUpload(c));
    app.put("/uf", async (c) => requireDb(c) || juush.handleUpload(c));

    // Connect to DB in background (non-blocking for health probe)
    juush.startdb().then(() => {
        serverLog("Juush DB ready, routes active");
        // Start the disk cache pruner (periodic scoring-based cleanup)
        import("./juush/prune.js").then(m => m.startPruner()).catch(e =>
            serverLog("Failed to start pruner", e)
        );
        // Start job queue processor — server handles upload-to-rustfs, worker handles ffmpeg/backup
        import("./juush/jobs.js").then(async m => {
            await m.initJobQueue();
            if (RUN_MODE !== "worker") {
                m.startQueueProcessor("server");
            }
            if (RUN_MODE !== "server") {
                m.startQueueProcessor("worker");
            }
        }).catch(e =>
            serverLog("Failed to start job queue", e)
        );
        // Start Temporal worker (non-blocking, falls through to Mongo queue if unavailable)
        import("./juush/temporal/client.js").then(m => m.connectTemporal()).then(() => {
            if (RUN_MODE !== "server") {
                return import("./juush/temporal/worker.js").then(m => m.startTemporalWorker());
            }
        }).catch(() => {});
    }).catch((e: any) => {
        serverLog("Failed to start juush DB", e);
    });
}

// Start HTTP server immediately — health check responds before DB connects
const port = Number(serverConst.HTTPPORT) || 3000;
serverLog(`Starting http server on ${port}`);
serve({
    fetch: app.fetch,
    port,
    hostname: serverConst.IP || "0.0.0.0",
});