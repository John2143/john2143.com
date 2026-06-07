import { Hono } from "hono";
import { serverLog } from "../logger.js";
import { createHash, randomBytes } from "node:crypto";
import * as serverConst from "../const.js";
import { getProvider } from "./config.js";
import type { OAuthProvider } from "./providers.js";
import { createSession, clearSession } from "./session.js";
import { requireUser } from "./middleware.js";
import { query, randomStr } from "../juush/util.js";
import { createCompatReqx } from "../juush/compat.js";

const auth = new Hono();

// --- PKCE helpers ---
function randomPKCECodeVerifier(): string {
    return randomBytes(32).toString("base64url");
}

async function calculatePKCECodeChallenge(verifier: string): Promise<string> {
    return createHash("sha256").update(verifier).digest("base64url");
}

function randomState(): string {
    return randomBytes(16).toString("hex");
}

// Build redirect_uri dynamically from the request's Host header
function buildRedirectUri(c: any, path: string): string {
    const host = c.req.header("host");
    if (host) {
        const proto = c.req.header("x-forwarded-proto") || "https";
        return `${proto}://${host}${path}`;
    }
    return `${serverConst.AUTH_CALLBACK_BASE}${path}`;
}

// --- Username generation ---
async function generateUniqueUsername(provider: OAuthProvider, userinfo: any): Promise<string> {
    const base = provider.suggestUsername(userinfo).toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const prefixed = `${provider.id}_${base}`;

    const existing = await query.users.findOne({ username: prefixed });
    if (!existing) return prefixed;

    const suffix = randomStr(4);
    return `${prefixed}_${suffix}`;
}

// --- Upsert user ---
async function upsertUser(provider: OAuthProvider, oauthData: Record<string, unknown>): Promise<any> {
    const idValue = oauthData[provider.idField];
    const oauthPath = `oauth.${provider.id}`;
    const idPath = `${oauthPath}.${provider.idField}`;

    const existing = await query.users.findOne({ [idPath]: idValue });

    if (existing) {
        const setFields: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(oauthData)) {
            setFields[`${oauthPath}.${key}`] = val;
        }

        if (provider.id === "pocketid") {
            const adminGroup = serverConst.POCKETID_ADMIN_GROUP;
            const groups: string[] = (oauthData.groups as string[]) || [];
            setFields.is_admin = groups.includes(adminGroup);
        }

        await query.users.updateOne({ _id: existing._id }, { $set: setFields });
        return existing;
    }

    // New user
    const userinfoResponse = await getUserinfo(provider, oauthData);
    const username = await generateUniqueUsername(provider, userinfoResponse || oauthData);

    let is_admin = false;
    if (provider.id === "pocketid") {
        const adminGroup = serverConst.POCKETID_ADMIN_GROUP;
        const groups: string[] = (oauthData.groups as string[]) || [];
        is_admin = groups.includes(adminGroup);
    } else if (provider.id === "discord") {
        const adminIds = serverConst.DISCORD_ADMIN_IDS.split(",").map(s => s.trim()).filter(Boolean);
        is_admin = adminIds.includes(String(oauthData.id));
    }

    const userDoc: any = {
        _id: randomStr(10),
        username,
        primary_provider: provider.id,
        oauth: { [provider.id]: oauthData },
        juush_user_id: await query.counter("keyid"),
        key: randomStr(32),
        display_name: provider.suggestUsername(userinfoResponse || oauthData),
        autohide: false,
        customURL: null,
        disabled: false,
        is_admin,
        created_at: new Date(),
    };

    await query.users.insertOne(userDoc);
    return userDoc;
}

async function getUserinfo(provider: OAuthProvider, oauthData: Record<string, unknown>): Promise<any> {
    return oauthData;
}

// --- GET /auth/login/:provider ---
auth.get("/login/:provider", async (c) => {
    const providerId = c.req.param("provider");
    const provider = getProvider(providerId);

    if (!provider) {
        return c.html(`Unknown provider: ${providerId}`, 404);
    }

    try {
        const code_verifier = randomPKCECodeVerifier();
        const code_challenge = await calculatePKCECodeChallenge(code_verifier);
        const state = randomState();
        const redirect_uri = buildRedirectUri(c, provider.redirect_path);

        let authorizationUrl: string;

        if (provider.type === "oidc" && provider.issuer) {
            const discoveryUrl = `${provider.issuer}/.well-known/openid-configuration`;
            const discoveryResp = await fetch(discoveryUrl);
            if (!discoveryResp.ok) {
                return c.html("OIDC discovery failed", 502);
            }
            const discovery: any = await discoveryResp.json();
            const url = new URL(discovery.authorization_endpoint);
            url.searchParams.set("client_id", provider.client_id);
            url.searchParams.set("redirect_uri", redirect_uri);
            url.searchParams.set("response_type", "code");
            url.searchParams.set("scope", provider.scopes.join(" "));
            url.searchParams.set("state", state);
            url.searchParams.set("code_challenge", code_challenge);
            url.searchParams.set("code_challenge_method", "S256");
            authorizationUrl = url.toString();
        } else {
            const url = new URL(provider.authorization_endpoint!);
            url.searchParams.set("client_id", provider.client_id);
            url.searchParams.set("redirect_uri", redirect_uri);
            url.searchParams.set("response_type", "code");
            url.searchParams.set("scope", provider.scopes.join(" "));
            url.searchParams.set("state", state);
            url.searchParams.set("code_challenge", code_challenge);
            url.searchParams.set("code_challenge_method", "S256");
            authorizationUrl = url.toString();
        }

        await query.oauth_states.insertOne({
            _id: state,
            code_verifier,
            provider: providerId,
            redirect_after: c.req.query("redirect") || "/user",
            redirect_uri,
            created_at: new Date(),
        });

        return c.redirect(authorizationUrl, 302);
    } catch (err: any) {
        serverLog("Auth login error:", err);
        return c.html("Authentication service unavailable. Please try again later.", 502);
    }
});

// --- GET /auth/callback/:provider ---
auth.get("/callback/:provider", async (c) => {
    const providerId = c.req.param("provider");
    const provider = getProvider(providerId);

    if (!provider) {
        return c.html(`Unknown provider: ${providerId}`, 404);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const oauthError = c.req.query("error");
    const error_description = c.req.query("error_description");

    if (oauthError) {
        const msg = error_description || oauthError;
        return c.redirect(`/auth-error?error=${encodeURIComponent("OAuth error: " + msg)}`);
    }

    if (!code || !state) {
        return c.redirect(`/auth-error?error=${encodeURIComponent("Missing code or state parameter")}`);
    }

    try {
        const stateDoc = await query.oauth_states.findOne({ _id: state });
        if (!stateDoc) {
            return c.redirect(`/auth-error?error=${encodeURIComponent("Invalid or expired state")}`);
        }

        await query.oauth_states.deleteOne({ _id: state });

        const redirectAfter = stateDoc.redirect_after || "/user";
        let claims: any;

        if (provider.type === "oidc" && provider.issuer) {
            const discoveryUrl = `${provider.issuer}/.well-known/openid-configuration`;
            const discoveryResp = await fetch(discoveryUrl);
            if (!discoveryResp.ok) throw new Error("OIDC discovery failed");
            const discovery: any = await discoveryResp.json();

            const tokenResponse = await fetch(discovery.token_endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: stateDoc.redirect_uri,
                    client_id: provider.client_id,
                    client_secret: provider.client_secret,
                    code_verifier: stateDoc.code_verifier,
                }).toString(),
            });

            if (!tokenResponse.ok) {
                const errText = await tokenResponse.text();
                serverLog("OIDC token exchange failed:", errText);
                return c.redirect(`/auth-error?error=${encodeURIComponent("Token exchange failed")}`);
            }

            const tokenData: any = await tokenResponse.json();

            const userResponse = await fetch(discovery.userinfo_endpoint, {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` },
            });

            if (!userResponse.ok) {
                return c.redirect(`/auth-error?error=${encodeURIComponent("Failed to fetch user info")}`);
            }

            claims = await userResponse.json();
        } else {
            const tokenResponse = await fetch(provider.token_endpoint!, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: provider.client_id,
                    client_secret: provider.client_secret,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: stateDoc.redirect_uri,
                    code_verifier: stateDoc.code_verifier,
                }).toString(),
            });

            if (!tokenResponse.ok) {
                const errText = await tokenResponse.text();
                serverLog("Token exchange failed:", errText);
                return c.redirect(`/auth-error?error=${encodeURIComponent("Token exchange failed")}`);
            }

            const tokenData: any = await tokenResponse.json();

            const userResponse = await fetch(provider.userinfo_endpoint!, {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` },
            });

            if (!userResponse.ok) {
                return c.redirect(`/auth-error?error=${encodeURIComponent("Failed to fetch user info")}`);
            }

            claims = await userResponse.json();
        }

        const oauthData = provider.mapUser(claims);
        const user = await upsertUser(provider, oauthData);

        if (user.disabled) {
            return c.redirect(`/auth-error?error=${encodeURIComponent("Account disabled")}`);
        }

        const sessionToken = await createSession(user._id);

        // Set session cookie
        const cookieValue = [
            `session_token=${sessionToken}`,
            "HttpOnly",
            "SameSite=Lax",
            "Secure",
            "Path=/",
            "Max-Age=86400",
        ].join("; ");

        c.header("Set-Cookie", cookieValue);
        return c.redirect(redirectAfter, 302);
    } catch (err: any) {
        serverLog("Auth callback error:", err);
        return c.redirect(`/auth-error?error=${encodeURIComponent("Authentication failed: " + (err.message || "Unknown error"))}`);
    }
});

// --- GET /auth/logout ---
auth.get("/logout", async (c) => {
    const reqx = createCompatReqx(c);
    const token = getCookieFromHeader(c.req.header("cookie"), "session_token");
    if (token) {
        await clearSession(token);
    }

    c.header("Set-Cookie", "session_token=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0");
    return c.redirect("/", 302);
});

// --- GET /auth/me ---
auth.get("/me", async (c) => {
    const reqx = createCompatReqx(c);
    const user = await requireUser(reqx);

    if (!user) {
        return c.json({ error: "Not authenticated" }, 401);
    }

    return c.json({
        _id: user._id,
        username: user.username,
        display_name: user.display_name,
        primary_provider: user.primary_provider,
        is_admin: user.is_admin,
        juush_user_id: user.juush_user_id,
    });
});

// Helper: extract cookie value from cookie header
function getCookieFromHeader(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}

export default auth;
