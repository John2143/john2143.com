global.async = require("asyncawait/async");
global.await = require("asyncawait/await");
global.Promise = require("Bluebird");
global.fs = require("fs");
global.serverLog = console.log;

try{
    global.serverConst = require("./const.js");
}catch(e){
    console.log("Error: " + e);
    return console.log("You must have a const.js file in order to run this. See serverConst for an example.");
}
