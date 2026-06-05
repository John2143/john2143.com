//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite
"use strict";

import "./global.js";
import * as authRoutes from "./auth/routes.js";

const showIP = async function(server, reqx){
    const ip = await server.getExtIP();
    reqx.doHTML(ip);
};

let redirs = {
    git: "//github.com/John2143/",
    teamspeak: "ts3server://john2143.com",
    steam: "//steamcommunity.com/profiles/76561198027378405",
    osu: "//osu.ppy.sh/u/2563776",
    ip: showIP,
    blank: (server, reqx) => {
        reqx.res.end("");
    },
    health: (server, reqx) => {
        reqx.shouldLog = false;
        reqx.res.end("OK");
    },
    _def: "git",

};
redirs.ts = redirs.teamspeak;

import server from "./server.js";

async function m(){
    /* istanbul ignore else */
    if(serverConst.dbstring){
        //have to use commonjs here
        const juush = require("./juush");
        redirs[""] = juush.download;
        redirs.f = juush.download;
        redirs.uf = juush.upload;
        redirs.nuser = juush.newUser;
        redirs.juush = juush.API;
        await juush.startdb();

        // OAuth auth dispatcher (server routes by path[0] only)
        redirs.auth = async function(server: any, reqx: any) {
            const sub = reqx.urldata.path[1];
            const provider = reqx.urldata.path[2];
            switch (sub) {
                case "login":
                    return authRoutes.login(provider)(server, reqx);
                case "callback":
                    return authRoutes.callback(provider)(server, reqx);
                case "logout":
                    return authRoutes.logout(server, reqx);
                case "me":
                    return authRoutes.me(server, reqx);
                default:
                    reqx.res.writeHead(404, { "Content-Type": "text/plain" });
                    reqx.res.end("Unknown auth route");
            }
        };
    }

    let srv = new server({
        redirs,
        ip: serverConst.IP,
        port: serverConst.PORT,
        httpPort: serverConst.HTTPPORT,
        keys: serverConst.keys,
    });

    return srv;
}

export default m();
