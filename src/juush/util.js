"use strict";

import pg from "pg";

//Setup postgres pool
export const pool = new pg.Pool({
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
export const juushError = function(res, err, code){
    res.writeHead(code, {
        "Content-Type": "text/html",
    });
    res.end("Internal server error.");
    serverLog("JuushError!");
    if(err) console.log(err);
};

//This is an error wrapper
export const juushErrorCatch = (res, code = 500) =>
    err => juushError(res, err, code);

//This is used to create a random string as an ID
export const randomStr = function(length = 32){
    const charSet = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    //Random index from charset
    const ran = () => Math.floor(Math.random() * charSet.length);
    let str = "";
    for(let i = 0; i < length; i++){
        str += charSet[ran() % charSet.length];
    }
    return str;
};

export const guessFileExtension = filename => {
    if(!filename) return null;

    let fileExtension = filename.split(".");
    //No extension
    if(fileExtension.length === 1) return null;
    fileExtension = fileExtension[fileExtension.length - 1];
    //extension too long
    if(fileExtension.length > 8) return null;
    return fileExtension;
};

export let isAdmin;
if(global.it){
    global.testIsAdmin = true;
    isAdmin = ip => global.testIsAdmin;
}else{
    isAdmin = ip => ip.indexOf("192.168") >= 0 || ip === "127.0.0.1" || ip === "::1";
}

export const IPEqual = (a, b) => a && b && a.split("/")[0] === b.split("/")[0];
export const getFilename = id => "./juushFiles/" + id;

export const modifiers = {
    hidden: 0x1,
};
