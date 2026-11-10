import { serverLog } from "../logger.js";

import { Readable } from "node:stream";
import fs from "node:fs/promises";
import { startdb, query, whoami, juushErrorCatch, randomStr, getFilename, setModifier } from "./util.js";
import { guessFileExtension } from "./filetype.js";
import { startDeleteWorkflow, startUploadWorkflow } from "./temporal/client.js";

import { createCompatRes, flushCompatRes, createCompatReqx } from "./compat.js";
import type { Context } from "hono";

import downloadOriginal from "./download.js";
import uploadOriginal from "./upload.js";

export { startdb };

// --- Download handler ---
export async function handleDownload(c: Context) {
    const res = createCompatRes();
    const reqx = createCompatReqx(c, res);
    try {
        await downloadOriginal(null as any, { ...reqx, res });
    } catch (e: any) {
        juushErrorCatch(res)(e);
    }
    return flushCompatRes(c, res);
}

// --- Upload handler ---
export async function handleUpload(c: Context) {
    const res = createCompatRes();
    const reqx = createCompatReqx(c, res);
    // Create a clean Node.js Readable from Hono's web body stream.
    // Using c.env.incoming directly causes racing error events after
    // the upload completes (client disconnect triggers socket error).
    const bodyStream = new Readable({ read() {} });
    // Blend compat req headers onto the Readable — upload handler
    // accesses reqx.req.headers for content-type parsing and host URLs
    Object.assign(bodyStream, reqx.req);
    const webBody = c.req.raw.body;
    if (webBody) {
        const reader = webBody.getReader();
        let cancelled = false;
        const pump = () => {
            reader.read().then(({ done, value }) => {
                if (done) {
                    bodyStream.push(null);
                } else {
                    bodyStream.push(Buffer.from(value));
                    pump();
                }
            }).catch((e) => {
                if (cancelled) return;
                cancelled = true;
                // Cancel the reader to release the undici-backed stream cleanly.
                // Without this, undici may double-close the ReadableStream when
                // the client disconnects mid-upload.
                reader.cancel().catch(() => {});
                bodyStream.destroy(e);
            });
        };
        pump();
    } else {
        bodyStream.push(null);
    }
    try {
        await uploadOriginal(null as any, { ...reqx, req: bodyStream, res });
    } catch (e: any) {
        juushErrorCatch(res)(e);
    }
    // Wait for streaming to finish
    await new Promise<void>((resolve) => res.on("finish", resolve));
    return flushCompatRes(c, res);
}



// --- Juush API handlers (rewritten for Hono) ---

interface UploadEntry {
    _id: string;
    filename: string;
    mimetype: string;
    downloads: number;
    uploaddate: Date;
    modifiers?: { hidden?: boolean };
}

// /juush/whoami
export async function handleWhoami(c: Context) {
    const users = await whoami(c);
    return c.json(users);
}

// /juush/users
export async function handleUsers(c: Context) {
    const users = await query.users.find(
        { juush_user_id: { $ne: null }, display_name: { $exists: true }, disabled: { $ne: true } },
        { projection: { juush_user_id: 1, display_name: 1 } }
    ).toArray();
    return c.json(users.map(u => ({ _id: u.juush_user_id, name: u.display_name })));
}

// /juush/uploads/:userid/:page?
export async function handleUploads(c: Context) {
    const userid = Number(c.req.param("userid"));
    const page = Number(c.req.param("page") || 0);
    const perPage = 25;

    const queryObj: any = { keyid: userid };

    // Hidden uploads check
    if (c.req.query("hidden")) {
        const userlist = await whoami(c);
        const isUserAdmin = await isAdminCompat(c);
        if (!userlist.includes(userid) && !isUserAdmin) {
            return c.text("You cannot see hidden uploads for this user", 403);
        }
    } else {
        queryObj["modifiers.hidden"] = { $exists: false };
    }

    const results = await query.index.find(queryObj, {
        projection: { filename: 1, mimetype: 1, downloads: 1, uploaddate: 1, modifiers: 1, preview: 1, cdn: 1, thumb: 1, artifacts: 1 },
    }).sort({ uploaddate: -1 }).skip(page * perPage).limit(perPage).toArray();

    // Only the flags the gallery needs leave the server; the CDN URLs and the
    // artifacts storage keys (bucket/key) stay internal. For a video the CDN copy
    // is the web MP4 whenever a remux succeeded; if ffmpeg could not remux it is
    // the original, which the same link still serves.
    return c.json(results.map(({ cdn, thumb, artifacts, ...rest }) => ({
        ...rest,
        hasWeb: rest.mimetype !== "deleted" && Boolean(artifacts?.faststart || (cdn && String(rest.mimetype || "").startsWith("video/"))),
        hasThumb: rest.mimetype !== "deleted" && Boolean(thumb || artifacts?.thumbnail),
    })));
}

// /juush/userinfo/:id
export async function handleUserInfo(c: Context) {
    const _id = Number(c.req.param("id"));

    try {
        const projection: any = { display_name: 1, autohide: 1, customURL: 1 };

        if (c.req.query("key")) {
            const isUserAdmin = await isAdminCompat(c);
            if (!isUserAdmin) {
                return c.json({ error: "You may not see user keys" }, 403);
            }
            projection.key = 1;
        }

        const user = await query.users.findOne({ juush_user_id: _id }, { projection });

        if (!user) {
            return c.json({ error: `User ${_id} not found` });
        }

        const stats = await query.index.aggregate([])
            .match({ keyid: _id })
            .group({
                _id: "mem",
                total: { $sum: "$downloads" },
                count: { $sum: 1 },
            })
            .next() || ({} as any);

        return c.json({
            name: user.display_name,
            key: user.key,
            customURL: user.customURL,
            autohide: user.autohide,
            downloads: stats.total || 0,
            total: stats.count || 0,
        });
    } catch (e: any) {
        serverLog("Failed: ", e);
        return c.json({ error: e.message }, 500);
    }
}

// /juush/deluser/:id
export async function handleDelUser(c: Context) {
    const isUserAdmin = await isAdminCompat(c);
    if (!isUserAdmin) {
        return c.text("You cannot delete users", 401);
    }

    const _id = Number(c.req.param("id"));
    const result = await query.users.deleteOne({ juush_user_id: _id });
    return c.json({ success: result.deletedCount >= 1 });
}

// /juush/isadmin
export async function handleIsAdmin(c: Context) {
    try {
        const { requireUser } = await import("../auth/middleware.js");
        const user = await requireUser(createCompatReqx(c));
        return c.text(user?.is_admin ? "true" : "false");
    } catch {
        return c.text("false");
    }
}

// /juush/mykey
export async function handleMyKey(c: Context) {
    try {
        const { requireUser } = await import("../auth/middleware.js");
        const user = await requireUser(createCompatReqx(c));
        if (!user) {
            return c.json({ error: "Not authenticated" }, 401);
        }
        return c.json({ key: user.key || null });
    } catch (e: any) {
        serverLog("Failed mykey: ", e);
        return c.json({ error: e.message }, 500);
    }
}

export async function handleUserSetting(c: Context) {
    const _id = Number(c.req.param("id"));

    const userlist = await whoami(c);
    if (!userlist.includes(_id)) {
        return c.text("You cannot change settings for this user", 403);
    }

    const setting = c.req.param("setting");
    const value = c.req.param("value");

    if (setting === "autohide") {
        const newvalue = value === "true";
        await query.users.updateOne({ juush_user_id: _id }, { $set: { autohide: newvalue } });
        serverLog(`setting changed for ${_id}: '${setting}' = '${newvalue}'`);
        return c.text(`setting changed for ${_id}: '${setting}' = '${newvalue}'`);
    }

    return c.text("unknown option", 405);
}

// Admin check — OAuth session
async function isAdminCompat(c: Context): Promise<boolean> {
    try {
        const { requireUser } = await import("../auth/middleware.js");
        const reqx = createCompatReqx(c);
        const user = await requireUser(reqx);
        return user?.is_admin === true;
    } catch {
        return false;
    }
}

// --- Upload mutations (POST /f/:id/{delete,rename,hide,unhide,reprocess}) ---

interface MutableUpload { _id: string; keyid?: number; mimetype?: string; filename?: string; volumeId?: string }

// Owner (session user whose juush_user_id is the upload's keyid) or admin. Cookie-authenticated
// requests must come from this origin; Bearer session tokens cannot be sent cross-site.
async function authorizeUploadMutation(c: Context): Promise<{ doc: MutableUpload; user: any } | Response> {
    const doc = await query.index.findOne(
        { _id: c.req.param("id") },
        { projection: { keyid: 1, mimetype: 1, filename: 1, volumeId: 1 } },
    ) as MutableUpload | null;
    if (!doc) return c.text("Not found", 404);

    const { requireUser } = await import("../auth/middleware.js");
    const user = await requireUser(createCompatReqx(c));
    if (!user) return c.text("Not authenticated", 401);
    // A user without a juush id must not match an upload without a keyid.
    const isOwner = user.juush_user_id != null && user.juush_user_id === doc.keyid;
    if (!isOwner && user.is_admin !== true) return c.text("Forbidden", 403);

    if (!(c.req.header("authorization") || "").startsWith("Bearer ")) {
        let sameOrigin = false;
        try {
            const origin = c.req.header("origin");
            sameOrigin = !!origin && new URL(origin).host === c.req.header("host");
        } catch { /* unparseable Origin */ }
        if (!sameOrigin) return c.text("Cross-origin request rejected", 403);
    }
    return { doc, user };
}

export async function handleUploadAction(c: Context, action: "delete" | "rename" | "hide" | "unhide") {
    const auth = await authorizeUploadMutation(c);
    if (auth instanceof Response) return auth;
    const { doc, user } = auth;

    if (action === "delete") {
        if (doc.mimetype !== "deleted") {
            await query.index.updateOne(
                { _id: doc._id, mimetype: { $ne: "deleted" } },
                { $set: { mimetype: "deleted", deletedAt: new Date(), deletedBy: user._id } },
            );
        }
        // This pod's cached copy; the pruner sweeps the other pods.
        await fs.unlink(getFilename(doc._id)).catch(() => {});
        // A repeated delete just re-requests the purge; "unavailable" is left to the reconciler.
        const purge = await startDeleteWorkflow(doc._id);
        return c.json({ status: "deleted", purge });
    }
    if (doc.mimetype === "deleted") return c.text("This file has been deleted.", 410);

    if (action === "hide" || action === "unhide") {
        await setModifier(doc._id, "hidden", action === "hide" ? true : undefined);
        return c.text(action === "hide" ? "hidden" : "unhidden");
    }

    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 255 || /[\u0000-\u001f\u007f\/\\]/.test(name)) return c.text("Invalid name", 400);
    // A new name without an extension keeps the old one.
    const oldExt = guessFileExtension(doc.filename);
    const filename = !guessFileExtension(name) && oldExt ? `${name}.${oldExt}` : name;
    await query.index.updateOne({ _id: doc._id }, { $set: { filename } });
    return c.text(filename);
}

// --- Reprocess handler ---
export async function handleReprocess(c: Context) {
    const auth = await authorizeUploadMutation(c);
    if (auth instanceof Response) return auth;
    const data = auth.doc;
    const id = data._id;
    if (data.mimetype === "deleted") return c.text("This file has been deleted.", 410);

    await query.index.updateOne(
        { _id: id },
        { $unset: { cdn: "", thumb: "", preview: "", failedCDN: "", artifacts: "", ingestStatus: "" } },
    );
    // volumeId set: the doc may not be on the filer yet, so ingest runs first.
    const result = await startUploadWorkflow({ url: id, volumeId: data.volumeId }, `reprocess-${id}`);
    if (result === "exists") return c.text("already processing", 409);
    if (result === "unavailable") return c.text("temporal unavailable", 503);
    return c.text("queued");
}
