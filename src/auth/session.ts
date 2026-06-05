"use strict";

import { createHash, randomBytes } from "node:crypto";
import { query } from "../juush/util.js";

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

// Generate a new session token and store its hash
export async function createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const now = new Date();

    await query.sessions.insertOne({
        _id: tokenHash,
        user_id: userId,
        created_at: now,
        expires_at: new Date(now.getTime() + SESSION_DURATION_MS),
    });

    return token;
}

// Validate a plaintext token — returns userId or null
export async function validateSession(token: string): Promise<string | null> {
    if (!token) return null;

    const tokenHash = hashToken(token);
    const session = await query.sessions.findOne({ _id: tokenHash });

    if (!session) return null;

    // Check expiry
    if (new Date(session.expires_at) < new Date()) {
        await query.sessions.deleteOne({ _id: tokenHash });
        return null;
    }

    return session.user_id;
}

// Clear a session from DB
export async function clearSession(token: string): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    await query.sessions.deleteOne({ _id: tokenHash });
}
