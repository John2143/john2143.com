// Hono-based server for 2143.me
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger as honoLogger } from "hono/logger";
import { serverLog } from "./logger.js";
import * as serverConst from "./const.js";
import * as fs from "node:fs/promises";
import authRoutes from "./auth/routes.js";

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

// Mount juush routes after DB connection
if (serverConst.dbstring) {
    try {
        const juush = await import("./juush/index.js");
        await juush.startdb();
        serverLog("Creating juush");

        // Juush API — MUST be before generic download catch-all
        const juushAPI = new Hono();
        juushAPI.get("/whoami", (c) => juush.handleWhoami(c));
        juushAPI.get("/users", (c) => juush.handleUsers(c));
        juushAPI.get("/uploads/:userid/:page?", (c) => juush.handleUploads(c));
        juushAPI.get("/userinfo/:id", (c) => juush.handleUserInfo(c));
        juushAPI.get("/deluser/:id", (c) => juush.handleDelUser(c));
        juushAPI.get("/isadmin", (c) => juush.handleIsAdmin(c));
        juushAPI.get("/usersetting/:id/:setting/:value", (c) => juush.handleUserSetting(c));
        app.route("/juush", juushAPI);

        // Download routes
        app.get("/f/:id{.*}", async (c) => juush.handleDownload(c));
        app.get("/:name{[^/]+}/:filename", async (c) => juush.handleDownload(c));

        // Upload — accepts GET, POST, PUT (juush client uses PUT)
        app.get("/uf", async (c) => juush.handleUpload(c));
        app.post("/uf", async (c) => juush.handleUpload(c));
        app.put("/uf", async (c) => juush.handleUpload(c));
    } catch (e) {
        serverLog("Failed to start juush (DB not available?)", e);
    }
}

// Start HTTP server — all routes must be registered FIRST
const port = Number(serverConst.HTTPPORT) || 3000;
serverLog(`Starting http server on ${port}`);
serve({
    fetch: app.fetch,
    port,
    hostname: serverConst.IP || "0.0.0.0",
});