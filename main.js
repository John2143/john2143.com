//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite
"use strict";

//import
let serverConst;
try{
    serverConst = require("./const.js");
}catch(e){
    console.log("Error: " + e);
    return console.log("You must have a const.js file in order to run this. See serverConst for an example.");
}

const showIP = function(server, reqx){
    server.getExtIP(ip => reqx.doHTML(ip));
};

let redirs = {
    git: "//github.com/John2143658709/",
    teamspeak: "ts3server://john2143.com",
    steam: "//steamcommunity.com/profiles/76561198027378405",
    osu: "//osu.ppy.sh/u/2563776",
    ip: showIP,
    _def: "git",

};
redirs.ts = redirs.teamspeak;

if(serverConst.dbuser){
    const juush = require("./juush.js");
    redirs[""] = juush.download;
    redirs.f = juush.download;
    redirs.uf = juush.upload;
    redirs.nuser = juush.newUser;
    redirs.juush = juush.API;
}

const server = require("./server.js");
const srv = new server({
    redirs: redirs,
    ip: serverConst.IP,
    port: serverConst.PORT,
    httpPort: serverConst.HTTPPORT,
    keys: serverConst.keys,
});
