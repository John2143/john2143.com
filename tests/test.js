describe("const.js", function(){
    it("should define an IP", function(){
        expect(serverConst.IP).to.be.ok;
    });
    it("should define port(s)", function(){
        expect(serverConst.PORT || serverConst.HTTPPORT).to.be.ok;
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
    before(function(){
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

    it("should have a working 404", function(){
        return chai.request("http://localhost:3000").get("/asdf").catch(res => {
            expect(res).to.have.status(404);
        });
    });
    it("should have a working funcredir", function(){
        return chai.request("http://localhost:3000").get("/testfunc").then(res => {
            expect(res).to.have.status(200);
        });
    });
    it("should have a working redir", function(){
        return chai.request("http://localhost:3000").get("/testredir").then(res => {
            expect(res).to.have.status(200);
            expect(res.text).to.eq("xd");
        });
    });
    it("should have a working default", function(){
        return chai.request("http://localhost:3000").get("/").then(res => {
            expect(res).to.have.status(200);
        });
    });

    after(function(){
        serv.stop();
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
        serv.stop();
    });
});
