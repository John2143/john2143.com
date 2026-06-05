declare var serverLog: (...args: any[]) => void;
"use strict";

import { createHash, randomBytes } from "node:crypto";
import * as serverConst from "../const.js";
import { getProvider } from "./config.js";
import type { OAuthProvider } from "./providers.js";
import { createSession, clearSession } from "./session.js";
import { requireUser } from "./middleware.js";
import { query, randomStr } from "../juush/util.js";

// PKCE helpers
function randomPKCECodeVerifier(): string {
    return randomBytes(32).toString("base64url");
}

async function calculatePKCECodeChallenge(verifier: string): Promise<string> {
    return createHash("sha256").update(verifier).digest("base64url");
}

function randomState(): string {
    return randomBytes(16).toString("hex");
}
// Helper: generate username with uniqueness check
async function generateUniqueUsername(provider: OAuthProvider, userinfo: any): Promise<string> {
    const base = provider.suggestUsername(userinfo).toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const prefixed = `${provider.id}_${base}`;

    // Check if taken
    const existing = await query.users.findOne({ username: prefixed });
    if (!existing) return prefixed;

    // Append random suffix
    const suffix = randomStr(4);
    return `${prefixed}_${suffix}`;
}

// Helper: create or update user from OAuth callback
async function upsertUser(provider: OAuthProvider, oauthData: Record<string, unknown>): Promise<any> {
    const idValue = oauthData[provider.idField];
    const oauthPath = `oauth.${provider.id}`;
    const idPath = `${oauthPath}.${provider.idField}`;

    // Check if this OAuth identity already exists
    const existing = await query.users.findOne({ [idPath]: idValue });

    if (existing) {
        // Update provider data (avatar, email, groups may have changed)
        const setFields: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(oauthData)) {
            setFields[`${oauthPath}.${key}`] = val;
        }

        // Re-check admin status on each login
        if (provider.id === "pocketid") {
            const adminGroup = serverConst.POCKETID_ADMIN_GROUP;
            const groups: string[] = (oauthData.groups as string[]) || [];
            setFields.is_admin = groups.includes(adminGroup);
        }

        await query.users.updateOne({ _id: existing._id }, { $set: setFields });
        return existing;
    }

    // Create new user
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
        oauth: {
            [provider.id]: oauthData,
        },
        juush_user_id: null,
        disabled: false,
        is_admin,
        created_at: new Date(),
    };

    await query.users.insertOne(userDoc);
    return userDoc;
}

// Fetch userinfo — for OIDC use the already-fetched claims; for OAuth2 fetch separately
async function getUserinfo(provider: OAuthProvider, oauthData: Record<string, unknown>): Promise<any> {
    // For OIDC, the claims are already in oauthData from the ID token / userinfo endpoint
    // For OAuth2 (Discord), we may need a separate call — handled in callback
    return oauthData;
}

// GET /auth/login/:provider
export function login(providerId: string) {
    return async function(_server: any, reqx: any) {
        const provider = getProvider(providerId);
        if (!provider) {
            reqx.doHTML(`Unknown provider: ${providerId}`, 404);
            return;
        }

        try {
            let authorizationUrl: string;
            let state: string;
            let code_verifier: string;

            code_verifier = randomPKCECodeVerifier();
            const code_challenge = await calculatePKCECodeChallenge(code_verifier);
            state = randomState();

            if (provider.type === "oidc" && provider.issuer) {
                // OIDC: fetch discovery document, build authorization URL
                const discoveryUrl = `${provider.issuer}/.well-known/openid-configuration`;
                const discoveryResp = await fetch(discoveryUrl);
                if (!discoveryResp.ok) {
                    reqx.doHTML("OIDC discovery failed", 502);
                    return;
                }
                const discovery = await discoveryResp.json();
                const url = new URL(discovery.authorization_endpoint);
                url.searchParams.set("client_id", provider.client_id);
                url.searchParams.set("redirect_uri", provider.redirect_uri);
                url.searchParams.set("response_type", "code");
                url.searchParams.set("scope", provider.scopes.join(" "));
                url.searchParams.set("state", state);
                url.searchParams.set("code_challenge", code_challenge);
                url.searchParams.set("code_challenge_method", "S256");
                authorizationUrl = url.toString();
            } else {
                // Plain OAuth2 (Discord): manual URL construction
                const url = new URL(provider.authorization_endpoint!);
                url.searchParams.set("client_id", provider.client_id);
                url.searchParams.set("redirect_uri", provider.redirect_uri);
                url.searchParams.set("response_type", "code");
                url.searchParams.set("scope", provider.scopes.join(" "));
                url.searchParams.set("state", state);
                url.searchParams.set("code_challenge", code_challenge);
                url.searchParams.set("code_challenge_method", "S256");

                authorizationUrl = url.toString();
            }

            // Store state
            await query.oauth_states.insertOne({
                _id: state,
                code_verifier,
                provider: providerId,
                redirect_after: reqx.urldata.query.redirect || "/",
                created_at: new Date(),
            });

            reqx.doRedirect(authorizationUrl);
        } catch (err: any) {
            serverLog("Auth login error:", err);
            reqx.doHTML("Authentication service unavailable. Please try again later.", 502);
        }
    };
}

// GET /auth/callback/:provider
export function callback(providerId: string) {
    return async function(_server: any, reqx: any) {
        const provider = getProvider(providerId);
        if (!provider) {
            reqx.doHTML(`Unknown provider: ${providerId}`, 404);
            return;
        }

        // Don't log sensitive query params
        reqx.shouldLog = false;

        const { code, state, error: oauthError, error_description } = reqx.urldata.query;

        if (oauthError) {
            const msg = error_description || oauthError;
            reqx.doRedirect(`/auth-error?error=${encodeURIComponent("OAuth error: " + msg)}`);
            return;
        }

        if (!code || !state) {
            reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Missing code or state parameter")}`);
            return;
        }

        try {
            // Validate state
            const stateDoc = await query.oauth_states.findOne({ _id: state });
            if (!stateDoc) {
                reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Invalid or expired state")}`);
                return;
            }

            // Clean up state immediately
            await query.oauth_states.deleteOne({ _id: state });

            const redirectAfter = stateDoc.redirect_after || "/";

            let claims: any;

            if (provider.type === "oidc" && provider.issuer) {
                // OIDC: fetch discovery doc, exchange code, fetch userinfo
                const discoveryUrl = `${provider.issuer}/.well-known/openid-configuration`;
                const discoveryResp = await fetch(discoveryUrl);
                if (!discoveryResp.ok) throw new Error("OIDC discovery failed");
                const discovery = await discoveryResp.json();

                // Exchange code for tokens
                const tokenResponse = await fetch(discovery.token_endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code,
                        redirect_uri: provider.redirect_uri,
                        client_id: provider.client_id,
                        client_secret: provider.client_secret,
                        code_verifier: stateDoc.code_verifier,
                    }).toString(),
                });

                if (!tokenResponse.ok) {
                    const errText = await tokenResponse.text();
                    serverLog("OIDC token exchange failed:", errText);
                    reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Token exchange failed")}`);
                    return;
                }

                const tokenData = await tokenResponse.json();

                // Fetch userinfo
                const userResponse = await fetch(discovery.userinfo_endpoint, {
                    headers: { "Authorization": `Bearer ${tokenData.access_token}` },
                });

                if (!userResponse.ok) {
                    reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Failed to fetch user info")}`);
                    return;
                }

                claims = await userResponse.json();
            } else {
                // Plain OAuth2: manual token exchange
                const tokenResponse = await fetch(provider.token_endpoint!, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                        client_id: provider.client_id,
                        client_secret: provider.client_secret,
                        grant_type: "authorization_code",
                        code,
                        redirect_uri: provider.redirect_uri,
                        code_verifier: stateDoc.code_verifier,
                    }).toString(),
                });

                if (!tokenResponse.ok) {
                    const errText = await tokenResponse.text();
                    serverLog("Token exchange failed:", errText);
                    reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Token exchange failed")}`);
                    return;
                }

                const tokenData = await tokenResponse.json();

                // Fetch userinfo
                const userResponse = await fetch(provider.userinfo_endpoint!, {
                    headers: {
                        "Authorization": `Bearer ${tokenData.access_token}`,
                    },
                });

                if (!userResponse.ok) {
                    reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Failed to fetch user info")}`);
                    return;
                }

                claims = await userResponse.json();
            }

            // Map claims to oauth data
            const oauthData = provider.mapUser(claims);

            // Upsert user
            const user = await upsertUser(provider, oauthData);

            if (user.disabled) {
                reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Account disabled")}`);
                return;
            }

            // Create session
            const sessionToken = await createSession(user._id);

            // Set cookie and redirect
            reqx.doRedirectWithCookie(redirectAfter, {
                name: "session_token",
                value: sessionToken,
                httpOnly: true,
                sameSite: "Lax",
                secure: true,
                path: "/",
                maxAge: 24 * 60 * 60, // 24 hours
            });
        } catch (err: any) {
            serverLog("Auth callback error:", err);
            reqx.doRedirect(`/auth-error?error=${encodeURIComponent("Authentication failed: " + (err.message || "Unknown error"))}`);
        }
    };
}

// GET /auth/logout
export async function logout(_server: any, reqx: any) {
    const token = reqx.getCookie("session_token");
    if (token) {
        await clearSession(token);
    }

    // Clear cookie
    reqx.clearCookie("session_token");
    reqx.doRedirect("/");
}

// GET /auth/me
export async function me(_server: any, reqx: any) {
    const user = await requireUser(reqx);

    if (!user) {
        reqx.res.writeHead(401, { "Content-Type": "application/json" });
        reqx.res.end(JSON.stringify({ error: "Not authenticated" }));
        return;
    }

    reqx.res.writeHead(200, { "Content-Type": "application/json" });
    reqx.res.end(JSON.stringify({
        _id: user._id,
        username: user.username,
        primary_provider: user.primary_provider,
        is_admin: user.is_admin,
        juush_user_id: user.juush_user_id,
    }));
}
