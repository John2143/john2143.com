global.Promise = require("bluebird");
global.fs = require("fs");
global.serverLog = console.log;

try{
    global.serverConst = require("./const.js");
}catch(e){
    console.log("Error: " + e);
    console.log("You must have a const.js file in order to run this. See serverConst for an example.");
}
