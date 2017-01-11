const chai = require("chai");
const expect = chai.expect;
chai.use(require("chai-http"));
const fs = require("fs");

let serverConst;

describe("const.js", function(){
    try{
        serverConst = require("../const.js");
    }catch(e){
        serverConst = require("../exampleConst.js");
    }
    it("should define an IP", function(){
        expect(serverConst.IP).to.be.ok;
    });
    it("should define port(s)", function(){
        expect(serverConst.PORT || serverConst.httpPort).to.be.ok;
    });
});

const redirs = {
    "testredir": "//localhost:3000/testfunc",
    "testfunc": (server, reqx) => {
        reqx.doHTML("xd");
    },
    _def: "testredir",
};

const server = require("../server.js");
describe("HTTP Server", function(){
    let serv;

    it("should work", function(){
        serv = new server({
            ip: "localhost",
            port: 3000,
            redirs,
        });
        expect(serv).to.be.ok;
        expect(serv.ip).to.be.ok;
        expect(serv.port).to.eq(3000);
        expect(serv.httpPort).to.eq(3000);
        expect(serv.isHTTPS).to.not.be.true;
    });

    let testsLeft = 4;

    it("should have a working 404", function(done){
        chai.request("http://localhost:3000").get("/asdf").end(function(err, res){
            expect(res).to.have.status(404);
            done();
            if(!--testsLeft) serv.stop();
        });
    });
    it("should have a working funcredir", function(done){
        chai.request("http://localhost:3000").get("/testfunc").end(function(err, res){
            expect(res).to.have.status(200);
            done();
            if(!--testsLeft) serv.stop();
        });
    });
    it("should have a working redir", function(done){
        chai.request("http://localhost:3000").get("/testredir").end(function(err, res){
            expect(res).to.have.status(200);
            expect(res.text).to.eq("xd");
            done();
            if(!--testsLeft) serv.stop();
        });
    });
    it("should have a working default", function(done){
        chai.request("http://localhost:3000").get("/").end(function(err, res){
            expect(res).to.have.status(200);
            done();
            if(!--testsLeft) serv.stop();
        });
    });
});

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
describe("HTTPS Server", function(){
    let serv;

    it("should work", function(){
        serv = new server({
            ip: "localhost",
            httpPort: 3000,
            port: 4000,
            keys: {
                key:  fs.readFileSync("./tests/testCerts/server.key"),
                cert: fs.readFileSync("./tests/testCerts/server.crt"),
            },
            redirs
        });

        expect(serv).to.be.ok;
        expect(serv.ip).to.be.ok;
        expect(serv.port).to.eq(4000);
        expect(serv.httpPort).to.eq(3000);
        expect(serv.isHTTPS).to.be.true;
        expect(serv.redirs).to.not.have.property("juush");
    });

    let testsLeft = 2;

    it("should allow connections to the https server", function(done){
        chai.request("https://localhost:4000").get("/").end(function(err, res){
            expect(err).to.be.not.null;
            done();
            if(!--testsLeft) serv.stop();
        });
    });

    it("should redirect to https", function(done){
        chai.request("http://localhost:3000").get("/").end(function(err, res){
            expect(err).to.be.not.null;
            done();
            if(!--testsLeft) serv.stop();
        });
    });
});
