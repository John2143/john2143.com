require("./global.js");

let chai = global.chai = require("chai");
let expect = global.expect = chai.expect;

chai.use(require("chai-http"));
chai.use(require("chai-as-promised"));

chai.should();

global.serverLog = () => {};

describe("Server tests", function(){
    require("./tests/test.js");
});

if(serverConst.dbuser){
    describe("Database tests", function(){
        require("./tests/initdbtest.js");
        require("./tests/dbtest.js");
    });
}
