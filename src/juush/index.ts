import { serverLog } from "../logger.js";

import { Readable } from "node:stream";
import { startdb, query, whoami, juushErrorCatch, randomStr } from "./util.js";
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
        const pump = () => {
            reader.read().then(({ done, value }) => {
                if (done) {
                    bodyStream.push(null);
                } else {
                    bodyStream.push(Buffer.from(value));
                    pump();
                }
            }).catch((e) => bodyStream.destroy(e));
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
        { juush_user_id: { $ne: null }, display_name: { $exists: true } },
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
        projection: { filename: 1, mimetype: 1, downloads: 1, uploaddate: 1, modifiers: 1 },
    }).sort({ uploaddate: -1 }).skip(page * perPage).limit(perPage).toArray();

    return c.json(results);
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

// /juush/usersetting/:id/:setting/:value
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

// Admin check — OAuth session (with test mode support)
async function isAdminCompat(c: Context): Promise<boolean> {
    if ((globalThis as any).testIsAdmin !== undefined) return (globalThis as any).testIsAdmin;
    try {
        const { requireUser } = await import("../auth/middleware.js");
        const reqx = createCompatReqx(c);
        const user = await requireUser(reqx);
        return user?.is_admin === true;
    } catch {
        return false;
    }
}
