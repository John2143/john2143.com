//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite
"use strict"

//import
var server = require("./server.js");
var serverConst = require("./const.js");
var fs = require("fs");
var pg = require("pg"); //postgres
var juush = require("./juush.js");

var showIP = function(server, reqx){
	server.getExtIP(function(ip){
		reqx.doHTML(ip);
	});
};

var redirs = {
	git: "//github.com/John2143658709/",
	teamspeak: "ts3server://john2143.com",
	steam: "//steamcommunity.com/profiles/76561198027378405",
	osu: "//osu.ppy.sh/u/2563776",
	ip: showIP,
	_def: "git",

	f: juush.download,
	uf: juush.upload,
	nuser: juush.newUser,
	me: juush.userPage,
	juush: juush.API,
};

redirs.ts = redirs.teamspeak;

var srv = new server({
	redirs: redirs,
	ip: serverConst.IP,
	port: serverConst.PORT
});
