const server = require("../main.js");

const url = `http://${serverConst.IP}:${serverConst.PORT}`;
const req = () => chai.request(url);

const uploadKey = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

describe("Database + server", function(){
    it("should have created a server", function(){
        return req().get("/blank");
    });

    it("should have a working ip", function(){
        return req().get("/ip").then(res => {
            res.should.have.status(200);
            res.text.should.be.an.ip;
        });
    });

    it("should be able to make new users", async (function(){
        let users = await ([
            req().get("/nuser/use"),
            req().get("/nuser/user2"),
        ]);

        users[0].body.should.be.ok;
        users[1].body.should.be.ok;

        return pool.query("UPDATE keys SET key=$1", [uploadKey]);
    }));

describe("API", function(){
    it("should not be anyone", function(){
        return req().get("/juush/whoami").then(res => {
            res.should.be.json;
            expect(res.body[0]).to.be.undefined;
        });
    });

    it("should be able to see the users", function(){
        return req().get("/juush/users/").then(res => {
            res.should.be.json;
            const json = res.body;
            json.should.have.property("length", 2);
            json.should.have.deep.property("[0].id");
            json.should.have.deep.property("[0].name");
            json.should.have.deep.property("[0]");
        });
    });

    it("should be able to see userinfo", function(){
        return req().get("/juush/userinfo/1").then(res => {
            res.should.be.json;
            const json = res.body;
            json.should.have.property("name", "use");
            json.should.have.property("downloads");
            json.should.have.property("total");
        });
    });

    it("should be able to delete users", function(){
        return req().get("/juush/deluser/2").then(res => {
            res.should.be.json;
            const json = res.body;
            json.success.should.be.true;
        });
    });

    it("should be an admin", function(){
        global.testIsAdmin = true;
        return req().get("/juush/isadmin")
            .should.eventually.have.property("text")
            .and.to.be.eq("true");
    });

    it("should not be an admin", function(){
        global.testIsAdmin = false;
        return req().get("/juush/isadmin")
            .should.eventually.have.property("text")
            .and.to.be.eq("false");
    });

    it("should get 'unknown method' for bad calls", function(){
        return req().get("/juush/zzzzzzzzz")
            .should.eventually.be.rejected
            .and.have.status(405);
    });
});


let keys = [];
let files;
let filenames;

describe("Upload/Download", function(){
    describe("should be able to upload some files", function(){
        let tests = [
            "should upload the first as one",
            "should upload a large one in parts",
            "should upload a weird one",
            "should upload an empty one",
            "should upload a pic",
        ];
        before(function(){
            files = [
                fs.readFileSync("./tests/uploads/upload.txt"),
                fs.readFileSync("./tests/uploads/big.txt"),
                fs.readFileSync("./tests/uploads/uploadEdge.txt"),
                Buffer.from(""),
                fs.readFileSync("./tests/uploads/pic.png"),
            ];
            filenames = [
                "upload.txt",
                "big.txt",
                "uploadEdge.txt",
                "empty.txt",
                "pic.png",
            ];
        });

        tests.forEach((data, index) => {
            it(data, function(){
                return req().post("/uf")
                    .attach(uploadKey, files[index], filenames[index])
                    .then(res => keys[index] = res.text);
            });
        });

        after(function(){
            keys = keys.map(x => x.split("/").pop().split(".")[0]);
        });
    });

    describe("download and api", function(){
        it("download should equal upload", async (function(){
            let downloads = [];

            for(let x = 0; x < 4; x++){
                downloads.push(
                    req().get("/f/" + keys[x])
                        .should.eventually.have.property("text")
                        .and.deep.equal(files[x].toString())
                );
            }

            downloads.push(
                req().get("/f/" + keys[4])
                    .should.eventually.have.property("body")
                    .and.deep.equal(files[4])
            );

            downloads.push(
                req().get("/f/")
                    .should.eventually.be.rejected
                    .and.have.status(404)
            );

            return await (downloads);
        }));
        it("should be able to check /info", function(){
            return req().get(`/f/${keys[0]}/info`)
                .should.eventually.have.status(200);
        });
        it("should be able to delete", function(){
            return req().get(`/f/${keys[0]}/delete`)
                .should.eventually.have.status(200);
        });
        it("should be able to rename", function(){
            return req().get(`/f/${keys[1]}/rename/newname`)
                .should.eventually.have.property("text")
                .and.to.equal("newname.txt");
        });
        it("should be able to rename with extensions", function(){
            return req().get(`/f/${keys[1]}/rename/newname.asdf`)
                .should.eventually.have.property("text")
                .and.to.equal("newname.asdf");
        });

        let getDLs, ulid;
        before(function(){
            ulid = keys[1];
            getDLs = async (
                id => pool
                    .query("SELECT downloads FROM index WHERE id=$1", [id])
                    .then(res => res.rows[0].downloads)
            );
        });

        it("should increment downloads when downloading a file", async (function(){
            let numDownloads = await (getDLs(ulid));
            let awaits = [];
            const inc = 2;
            for(let x = 0; x < inc; x++){
                awaits.push(
                    req().get("/f/" + ulid)
                );
            }

            await (awaits);

            expect(numDownloads + inc).to.equal(await (getDLs(ulid)));
        }));

        it("should not incrent when accessing /thumb", async (function(){
            let numDownloads = await (getDLs(ulid));
            let awaits = [];
            const inc = 2;
            for(let x = 0; x < inc; x++){
                awaits.push(
                    req().get("/f/" + ulid + "/thumb")
                );
            }

            await (awaits);

            expect(numDownloads).to.equal(await (getDLs(ulid)));
        }));

        it("should accept and work with stream requests", function(){
            const index = 2;
            const resource = `/f/${keys[index]}`;
            let contentLen;
            const start = 9, end = 40;
            return req().get(resource).then(res => {
                res.should.have.header("Content-Length");
                contentLen = res.header["content-length"];
                res.should.have.header("Accept-Ranges", "bytes");

                return req().get(resource)
                    .set("Referer", url + resource)
                    .set("Range", `bytes=${start}-`);
            }).then(res => {
                res.should.have.status(206);
                res.should.have.header("Content-Length");
                res.should.have.header("Content-Range",
                    `bytes ${start}-${contentLen-1}/${contentLen}`
                );

                return req().get(resource)
                    .set("Referer", url + resource)
                    .set("Range", `bytes=${start}-${end}`);
            }).then(res => {
                res.should.have.header("Content-Range",
                    `bytes ${start}-${end}/${contentLen}`
                );

                const expected = files[index].slice(start, end + 1);
                Buffer.from(res.text).should.deep.equal(expected);
            });
        });
        it("should accept and work with download dispotision");
    });
});

describe("Account stuff", function(){
    it("should be able to view a users uploads", function(){
        return req().get("/juush/uploads/1").then(res => {
            res.should.be.json;
            const json = res.body;
            json[0].should.have.property("id");
            json[0].should.have.property("filename");
            json[0].should.have.property("mimetype");
            json[0].should.have.property("downloads");
            json[0].should.have.property("uploaddate");
        });
    });
    it("should now have a whoami", function(){
        return req().get("/juush/whoami").then(res => {
            res.body.should.have.length(1);
            res.body[0].should.equal(1);
        });
    });
});

describe("error", function(){
    it("410 when viewing a deleted file", function(){
        return req().get(`/f/${keys[0]}`).catch(res => {
            res.should.have.status(410);
        });
    });
    it("when incrementing download");
    it("404 when viewing missing file", function(){
        return req().get("/f/zzzzzzz").catch(res => {
            res.should.have.status(404);
        });
    });
    it("generic db failure stuff");
    it("should not be able to make new users", async (function(){
        global.testIsAdmin = false;
        return req().get("/nuser/user2")
            .should.eventually.be.rejected;
    }));
});

});
