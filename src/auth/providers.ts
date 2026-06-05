"use strict";

export interface OAuthProvider {
    id: string;
    name: string;
    type: "oidc" | "oauth2";
    issuer?: string;                      // OIDC discovery URL
    authorization_endpoint?: string;      // manual (for Discord)
    token_endpoint?: string;
    userinfo_endpoint?: string;
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    scopes: string[];
    // Maps provider userinfo → the oauth.<id> sub-document
    mapUser: (userinfo: any) => Record<string, unknown>;
    // Which field in the mapped object is the unique ID
    idField: string;                      // "sub" for pocketid, "id" for discord
    // Extract a suggested username from the userinfo
    suggestUsername: (userinfo: any) => string;
}
