const server = require("../main.js");

const url = `http://${serverConst.IP}:${serverConst.PORT}`;
const req = () => chai.request(url);

describe("Database + server", function(){
    it("should have created a server", function(){
        return req().get("/blank");
    });

    it("should be able to make new users", async (function(){
        let users = await ([
            req().get("/nuser/use"),
            req().get("/nuser/user2"),
        ]);

        expect(users[0].body).to.be.ok;
        expect(users[1].body).to.be.ok;

        return pool.query("UPDATE keys SET key='ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'");
    }));

describe("API", function(){
    it("should not be anyone", function(){
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

    it("should be able to see userinfo", function(){
        return req().get("/juush/userinfo/1").then(res => {
            expect(res).to.be.json;
            const json = res.body;
            expect(json).to.have.property("name");
            expect(json).to.have.property("downloads");
            expect(json).to.have.property("total");
        });
    });

    it("should be able to delete users", function(){
        return req().get("/juush/deluser/2").then(res => {
            expect(res).to.be.json;
            const json = res.body;
            expect(json.success).to.be.true;
        });
    });

    it("should be an admin");
    it("should get 'unknown method' for bad calls");
});


describe("Upload/Download", function(){
    describe("should be able to upload 3 files", function(){
        it("should upload the first as one");
        it("should upload the first in parts");
        it("should upload the an empty file");
        it("should upload the one with missing headers and fail");
    });
    describe("download and api", function(){
        it("should be able to download a file");
        it("should be able to check /info");
        it("should be able to delete");
        it("should get a 410 when viewied a deleted file");
        it("should be able to rename");
        it("should be able to rename with extensions");
        it("should check the renamed file's name against the parameters");
        it("should increment downloads when downloading a file");
        it("should not incrent when accessing /thumb");
    });
});

describe("Account stuff", function(){
    it("should be able to view a users uploads");
    it("should now have a whoami");
});

});
