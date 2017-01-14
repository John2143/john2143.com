const server = require("../main.js");

const url = `http://${serverConst.IP}:${serverConst.PORT}`;
const req = () => chai.request(url);

describe("Database + server", function(){
    it("should have created a server", function(){
        return req().get("/blank");
    });

    it("should be able to make new users", function(){
        return req().get("/nuser/use").then(res => {
            expect(res.body).to.be.ok;
        }).then(function(){
            return req().get("/nuser/user2");
        }).then(res => {
            expect(res.body).to.be.ok;
        }).then(function(){
            return pool.query("UPDATE keys SET key='ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'");
        });
    });

    it("not be anyone", function(){
        return req().get("/juush/whoami").then(res => {
            expect(res).to.be.json;
            expect(res.body[0]).to.be.undefined;
        });
    });

    it("should be able to see the users", function(){
        return req().get("/juush/users/").then(res => {
            expect(res).to.be.json;
            const json = res.body;
            expect(json).to.have.property("length", 2);
            expect(json).to.have.deep.property("[0].id");
            expect(json).to.have.deep.property("[0].name");
            expect(json).to.have.deep.property("[0]");
        });
    });
});
