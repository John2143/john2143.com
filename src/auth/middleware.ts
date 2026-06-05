"use strict";

import { validateSession } from "./session.js";
import { query } from "../juush/util.js";


// Extract user from cookie or Authorization header
export async function requireUser(reqx: any): Promise<any | null> {
    // Try Authorization header first
    const authHeader = reqx.req.headers["authorization"];
    let token: string | null = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7);
    } else {
        // Fall back to cookie
        token = reqx.getCookie("session_token");
    }

    if (!token) return null;

    const userId = await validateSession(token);
    if (!userId) return null;

    const user = await query.users.findOne({ _id: userId });
    if (!user || user.disabled) return null;

    return user;
}
