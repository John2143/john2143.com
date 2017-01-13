"use strict";

const pg = require("pg");
const Pool = pg.Pool;
const serverConst = require("./../const.js");
const fs = require("fs");

//This function is run after every query to make sure the request was
//successful. If it was not, it returns true and destroys the client
exports.dbError = function(err, client, done){
    if(err){
        console.log("FATAL ERROR: DB failure.", err);
        if(client) done(true);
        return true;
    }
    return false;
};

//Setup postgres pool
let pool = exports.pool = new Pool({
    user: serverConst.dbuser,
    password: serverConst.dbpass,
    host: serverConst.dbhost,
    database: "juush",
    max: 20,
    idleTimeoutMillis: 500,
});

pool.on("error", function(err, client){
    console.log("Error in client", err);
});

//This works with dbError to end a broken session
exports.juushError = function(res){
    res.writeHead(500, {
        "Content-Type": "text/html",
    });
    res.end("Internal server error.");
    console.log("JuushError!");
};

//This is used to create a random string as an ID
exports.randomStr = function(length = 32){
    const charSet = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    //Random index from charset
    const ran = () => Math.floor(Math.random() * charSet.length);
    let str = "";
    for(let i = 0; i < length; i++){
        str += charSet[ran() % charSet.length];
    }
    return str;
};

exports.guessFileExtension = function(filename){
    let fileExtension = filename.split(".");
    //No extension
    if(fileExtension.length === 1) return null;
    fileExtension = fileExtension[fileExtension.length - 1];
    //extension too long
    if(fileExtension.length > 8) return null;
    return fileExtension;
};

exports.isAdmin = ip => ip.indexOf("192.168") >= 0 || ip === "127.0.0.1";

exports.IPEqual = (a, b) => a.split("/")[0] === b.split("/")[0];
exports.getFilename = id => "./juushFiles/" + id;
