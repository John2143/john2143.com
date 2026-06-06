import { serverLog } from "../logger.js";

import { startdb, query, whoami, isAdmin, juushErrorCatch, randomStr } from "./util.js";
import { createCompatRes, flushCompatRes, createCompatReqx } from "./compat.js";
import type { Context } from "hono";

import downloadOriginal from "./download.js";
import uploadOriginal from "./upload.js";
import newUserOriginal from "./newuser.js";

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
    // Wait for streaming to finish (pipe may still be flowing)
    await new Promise<void>((resolve) => res.on("finish", resolve));
    return flushCompatRes(c, res);
}

// --- Upload handler ---
export async function handleUpload(c: Context) {
    const res = createCompatRes();
    const reqx = createCompatReqx(c, res);
    try {
        await uploadOriginal(null as any, { ...reqx, res });
    } catch (e: any) {
        juushErrorCatch(res)(e);
    }
    // Wait for streaming to finish
    await new Promise<void>((resolve) => res.on("finish", resolve));
    return flushCompatRes(c, res);
}

// --- NewUser handler ---
export async function handleNewUser(c: Context) {
    const reqx = createCompatReqx(c);
    const res = createCompatRes();

    if (await isAdminCompat(c)) {
        const key = randomStr(32);
        const name = c.req.param("name");
        try {
            await query.keys.insertOne({
                name, key,
                _id: await query.counter("keyid"),
            });
            serverLog("A new user has been created", name, key);
            res.setHeader("Content-Type", "text/plain");
            res.end(key);
        } catch (e: any) {
            juushErrorCatch(res)(e);
        }
    } else {
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end("You cannot make users");
    }
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
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
    const users = await whoami(ip);
    return c.json(users);
}

// /juush/users
export async function handleUsers(c: Context) {
    const users = await query.keys.find({}, { projection: { _id: 1, name: 1 } }).toArray();
    return c.json(users);
}

// /juush/uploads/:userid/:page?
export async function handleUploads(c: Context) {
    const userid = Number(c.req.param("userid"));
    const page = Number(c.req.param("page") || 0);
    const perPage = 25;

    const queryObj: any = { keyid: userid };

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

    // Hidden uploads check
    if (c.req.query("hidden")) {
        const userlist = await whoami(ip);
        const isUserAdmin = await isAdminCompat(c);
        if (!userlist.includes(userid) && !isUserAdmin) {
            return c.text("You cannot see hidden uploads for this user", 403);
        }
    } else {
        queryObj["modifiers.hidden"] = { $exists: false };
    }

    const results = await query.index.find(queryObj, {
        projection: { filename: 1, mimetype: 1, downloads: 1, uploaddate: 1, modifiers: 1 },
    }).sort({ uploaddate: -1 }).skip(page * perPage).limit(perPage).toArray();

    return c.json(results);
}

// /juush/userinfo/:id
export async function handleUserInfo(c: Context) {
    const _id = Number(c.req.param("id"));
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

    try {
        const projection: any = { name: 1, autohide: 1, customURL: 1 };

        if (c.req.query("key")) {
            const isUserAdmin = await isAdminCompat(c);
            if (!isUserAdmin) {
                return c.json({ error: "You may not see user keys" }, 403);
            }
            projection.key = 1;
        }

        const user = await query.keys.findOne({ _id }, { projection });

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
            name: user.name,
            key: (user as any).key,
            customURL: (user as any).customURL,
            autohide: (user as any).autohide,
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
    const result = await query.keys.deleteOne({ _id });
    return c.json({ success: result.deletedCount >= 1 });
}

// /juush/isadmin
export async function handleIsAdmin(c: Context) {
    return c.text("false");
}

// /juush/usersetting/:id/:setting/:value
export async function handleUserSetting(c: Context) {
    const _id = Number(c.req.param("id"));
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

    const userlist = await whoami(ip);
    if (!userlist.includes(_id)) {
        return c.text("You cannot change settings for this user", 403);
    }

    const setting = c.req.param("setting");
    const value = c.req.param("value");

    if (setting === "autohide") {
        const newvalue = value === "true";
        await query.keys.updateOne({ _id }, { $set: { autohide: newvalue } });
        serverLog(`setting changed for ${_id}: '${setting}' = '${newvalue}'`);
        return c.text(`setting changed for ${_id}: '${setting}' = '${newvalue}'`);
    }

    return c.text("unknown option", 405);
}

// Admin check — try OAuth session, fall back to query param
async function isAdminCompat(c: Context): Promise<boolean> {
    // Try OAuth session first
    try {
        const { requireUser } = await import("../auth/middleware.js");
        const reqx = createCompatReqx(c);
        const user = await requireUser(reqx);
        if (user?.is_admin) return true;
    } catch {
        // OAuth not initialized or no session
    }
    // Fall back to query param (legacy)
    return false;
}
