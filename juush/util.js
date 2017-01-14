"use strict";

const pg = require("pg");
const Pool = pg.Pool;

//Setup postgres pool
let pool = exports.pool = new Pool({
    user: serverConst.dbuser,
    password: serverConst.dbpass,
    host: serverConst.dbhost,
    port: serverConst.dbport,
    database: "juush",
    max: 20,
    idleTimeoutMillis: 500,
});

if(global.it) global.pool = pool;

pool.on("error", function(err, client){
    serverLog("Error in client", err);
});

//This works with dbError to end a broken session
exports.juushError = function(res, err, code){
    res.writeHead(code, {
        "Content-Type": "text/html",
    });
    res.end("Internal server error.");
    serverLog("JuushError!");
    if(err) serverLog(err);
};

//This is an error wrapper
exports.juushErrorCatch = (res, code = 500) => err => exports.juushError(res, err, code);

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

exports.isAdmin = ip => ip.indexOf("192.168") >= 0 || ip === "127.0.0.1" || ip === "::1";

exports.IPEqual = (a, b) => a.split("/")[0] === b.split("/")[0];
exports.getFilename = id => "./juushFiles/" + id;
