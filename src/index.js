//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite
"use strict";

import "./global.js";

const showIP = async function(server, reqx){
    server.getExtIP(ip => reqx.doHTML(ip));
};

let redirs = {
    git: "//github.com/John2143658709/",
    teamspeak: "ts3server://john2143.com",
    steam: "//steamcommunity.com/profiles/76561198027378405",
    osu: "//osu.ppy.sh/u/2563776",
    ip: showIP,
    blank: async (server, reqx) => reqx.res.end(""),
    _def: "git",

};
redirs.ts = redirs.teamspeak;

let initPromise;

/* istanbul ignore else */
if(serverConst.dbstring){
    //have to use commonjs here
    const juush = require("./juush");
    redirs[""] = juush.download;
    redirs.f = juush.download;
    redirs.uf = juush.upload;
    redirs.nuser = juush.newUser;
    redirs.juush = juush.API;
    initPromise = juush.u;
}else{
    initPromise = new Promise.resolve(true);
}

import server from "./server.js";

export let serverInst;
initPromise.then(() => {
    serverInst = new server({
        redirs,
        ip: serverConst.IP,
        port: serverConst.PORT,
        httpPort: serverConst.HTTPPORT,
        keys: serverConst.keys,
    });
});
