import { validateSession } from "./session.js";
import { query } from "../juush/util.js";

// Extract user from cookie or Authorization header
// Works with both old reqx objects and Hono context wrappers
export async function requireUser(reqx: any): Promise<any | null> {
    let token: string | null = null;

    // Try Authorization header first
    const authHeader = reqx.req.headers?.["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7);
    } else {
        // Fall back to cookie
        token = getCookieCompat(reqx, "session_token");
    }

    if (!token) return null;

    const userId = await validateSession(token);
    if (!userId) return null;

    const user = await query.users.findOne({ _id: userId });
    if (!user || user.disabled) return null;

    return user;
}

// Helper: extract cookie from reqx or Hono context
function getCookieCompat(reqx: any, name: string): string | null {
    // Hono Context
    if (reqx.req?.header && typeof reqx.req.header === "function") {
        const cookie = reqx.req.header("cookie");
        if (!cookie) return null;
        const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : null;
    }
    // Old reqx (has getCookie method)
    if (typeof reqx.getCookie === "function") {
        return reqx.getCookie(name);
    }
    // Fallback: parse from headers
    const cookieHeader = reqx.req?.headers?.cookie || reqx.req?.headers?.Cookie || "";
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}
