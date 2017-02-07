global.Promise = require("bluebird");
global.fs = Promise.promisifyAll(require("fs"));
global.serverLog = console.log;

try{
    global.serverConst = require("./const.js");
}catch(e){
    /* istanbul ignore next */
    console.log("Error: " + e);
    /* istanbul ignore next */
    console.log("You must have a const.js file in order to run this. See serverConst for an example.");
}
