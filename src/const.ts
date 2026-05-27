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
