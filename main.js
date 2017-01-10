//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite
"use strict";

//import
const server = require("./server.js");
const serverConst = require("./const.js");
const fs = require("fs");
const pg = require("pg"); //postgres
const juush = require("./juush.js");

const showIP = function(server, reqx){
    server.getExtIP(ip => reqx.doHTML(ip));
};

const redirs = {
    git: "//github.com/John2143658709/",
    teamspeak: "ts3server://john2143.com",
    steam: "//steamcommunity.com/profiles/76561198027378405",
    osu: "//osu.ppy.sh/u/2563776",
    ip: showIP,
    _def: "git",

    "": juush.download,
    f: juush.download,
    uf: juush.upload,
    nuser: juush.newUser,
    juush: juush.API,
};

redirs.ts = redirs.teamspeak;

const srv = new server({
    redirs: redirs,
    ip: serverConst.IP,
    port: serverConst.PORT,
    httpPort: serverConst.HTTPPORT,
});
