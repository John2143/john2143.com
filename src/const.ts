export const IP = process.env.IP || "0.0.0.0";
export const HTTPPORT = process.env.PORT || 3000;

export const dbstring = process.env.DB || "mongodb://admin:pass@mongo/";
//exports.dbstring = "mongodb://localhost/";
//exports.dbstring = "mongodb://127.0.0.1:9876/juush";
// Host header → returned URL mapping (server-level, per-domain config)
export const juushHostMap: Record<string, { url: string; no_f: boolean }> = {
    "up.brick.gay":  { url: "i.brick.gay",  no_f: true },
    "m.ewan.green":  { url: "m.ewan.green", no_f: true },
};

// OAuth provider configuration
export const AUTH_CALLBACK_BASE = process.env.AUTH_CALLBACK_BASE || "https://2143.me";
export const POCKETID_ISSUER = process.env.POCKETID_ISSUER || "https://au.2143.me";
export const POCKETID_CLIENT_ID = process.env.POCKETID_CLIENT_ID || "";
export const POCKETID_CLIENT_SECRET = process.env.POCKETID_CLIENT_SECRET || "";
export const POCKETID_ADMIN_GROUP = process.env.POCKETID_ADMIN_GROUP || "admin";
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
export const DISCORD_ADMIN_IDS = process.env.DISCORD_ADMIN_IDS || "";
