"use strict";

import * as serverConst from "../const.js";
import type { OAuthProvider } from "./providers.js";

// Pocket ID OIDC provider
const pocketid: OAuthProvider = {
    id: "pocketid",
    name: "Pocket ID",
    type: "oidc",
    issuer: serverConst.POCKETID_ISSUER,
    client_id: serverConst.POCKETID_CLIENT_ID,
    client_secret: serverConst.POCKETID_CLIENT_SECRET,
    redirect_uri: `${serverConst.AUTH_CALLBACK_BASE}/auth/callback/pocketid`,
    scopes: ["openid", "profile", "email", "groups"],
    idField: "sub",
    mapUser(userinfo: any) {
        return {
            sub: userinfo.sub,
            email: userinfo.email,
            name: userinfo.name,
            preferred_username: userinfo.preferred_username,
            groups: userinfo.groups || [],
        };
    },
    suggestUsername(userinfo: any) {
        return userinfo.preferred_username
            || userinfo.name
            || "user";
    },
};

// Discord OAuth2 provider (not OIDC-compliant)
const discord: OAuthProvider = {
    id: "discord",
    name: "Discord",
    type: "oauth2",
    authorization_endpoint: "https://discord.com/api/oauth2/authorize",
    token_endpoint: "https://discord.com/api/oauth2/token",
    userinfo_endpoint: "https://discord.com/api/users/@me",
    client_id: serverConst.DISCORD_CLIENT_ID,
    client_secret: serverConst.DISCORD_CLIENT_SECRET,
    redirect_uri: `${serverConst.AUTH_CALLBACK_BASE}/auth/callback/discord`,
    scopes: ["identify", "email"],
    idField: "id",
    mapUser(userinfo: any) {
        return {
            id: userinfo.id,
            username: userinfo.username,
            avatar: userinfo.avatar,
            global_name: userinfo.global_name,
            email: userinfo.email,
        };
    },
    suggestUsername(userinfo: any) {
        return userinfo.global_name
            || userinfo.username
            || "user";
    },
};

export const providers: OAuthProvider[] = [pocketid, discord];

export function getProvider(id: string): OAuthProvider | undefined {
    return providers.find(p => p.id === id);
}
