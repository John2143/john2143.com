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
            expect(res).to.have.status(200);
            expect(res.text).to.be.an.ip;
        });
    });

    it("should be able to make new users", async (function(){
        let users = await ([
            req().get("/nuser/use"),
            req().get("/nuser/user2"),
        ]);

        expect(users[0].body).to.be.ok;
        expect(users[1].body).to.be.ok;

        return pool.query("UPDATE keys SET key=$1", [uploadKey]);
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

    it("should be an admin", function(){
        global.testIsAdmin = true;
        return req().get("/juush/isadmin").then(res => {
            expect(res.text).to.be.eq("true");
        });
    });

    it("should not be an admin", function(){
        global.testIsAdmin = false;
        return req().get("/juush/isadmin").then(res => {
            expect(res.text).to.be.eq("false");
        });
    });

    it("should get 'unknown method' for bad calls", function(){
        return req().get("/juush/zzzzzzzzz").catch(res => {
            expect(res).to.have.status(405);
        });
    });
});


let keys = [];
let file, fileBig, fileEdge, filePic;

describe("Upload/Download", function(){
    describe("should be able to upload some files", function(){
        before(function(){
            file = fs.readFileSync("./tests/uploads/upload.txt");
            fileBig = fs.readFileSync("./tests/uploads/big.txt");
            fileEdge = fs.readFileSync("./tests/uploads/uploadEdge.txt");
            filePic = fs.readFileSync("./tests/uploads/pic.png");
        });
        it("should upload the first as one", function(){
            return req().post("/uf")
                .attach(uploadKey, file, "upload.txt")
                .then(res => keys.push(res.text));
        });
        it("should upload a large one in parts", function(){
            return req().post("/uf")
                .attach(uploadKey, fileBig, "big.txt")
                .then(res => keys.push(res.text));
        });
        it("should upload a weird one", function(){
            return req().post("/uf")
                .attach(uploadKey, fileEdge, "uploadEdge.txt")
                .then(res => keys.push(res.text));
        });
        it("should upload an empty one", function(){
            return req().post("/uf")
                .attach(uploadKey, Buffer.from(""), "big.txt")
                .then(res => keys.push(res.text));
        });
        it("should upload a pic", function(){
            return req().post("/uf")
                .attach(uploadKey, filePic, "pic.png")
                .then(res => keys.push(res.text));
        });
        it("should not upload a bad one", function(){
            return req().post("/uf")
                .field("name", "asef").catch(res => {
                    expect(res).to.have.status(400);
                });
        });
        after(function(){
            keys = keys.map(x => x.split("/").pop().split(".")[0]);
        });
    });

    describe("download and api", function(){
        it("download should equal upload", async (function(){
            return await ([
                req().get("/f/" + keys[0]).then(res => {
                    expect(res.text).to.equal(file.toString());
                }),
                req().get("/f/" + keys[1]).then(res => {
                    expect(res.text).to.equal(fileBig.toString());
                }),
                req().get("/f/" + keys[2]).then(res => {
                    expect(res.text).to.equal(fileEdge.toString());
                }),
                req().get("/f/" + keys[3]).then(res => {
                    expect(res.text).to.equal("");
                }),
                req().get("/f/" + keys[4]).then(res => {
                    expect(res.body.compare(filePic)).to.equal(0);
                }),
                req().get("/f/").catch(res => {
                    expect(res).to.have.status(404);
                }),
            ]);
        }));
        it("should be able to check /info", function(){
            return req().get(`/f/${keys[0]}/info`).then(res => {
                expect(res).to.have.status(200);
            });
        });
        it("should be able to delete", function(){
            return req().get(`/f/${keys[0]}/delete`).then(res => {
                expect(res).to.have.status(200);
            });
        });
        it("should be able to rename", function(){
            return req().get(`/f/${keys[1]}/rename/newname`).then(res => {
                expect(res.text).to.equal("newname.txt");
            });
        });
        it("should be able to rename with extensions", function(){
            return req().get(`/f/${keys[1]}/rename/newname.asdf`).then(res => {
                expect(res.text).to.equal("newname.asdf");
            });
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
            const resource = `/f/${keys[1]}`;
            let contentLen;
            const start = 7, end = 15;
            return req().get(resource).then(res => {
                expect(res).to.have.header("Content-Length");
                contentLen = res.header["content-length"];
                expect(res).to.have.header("Accept-Ranges", "bytes");
                return req().get(resource)
                    .set("Referer", url + resource)
                    .set("Range", `bytes=${start}-`);

            }).then(res => {
                expect(res).to.have.status(206);
                expect(res).to.have.header("Content-Length");
                expect(res).to.have.header("Content-Range",
                    `bytes ${start}-${contentLen-1}/${contentLen}`
                );
                return req().get(resource)
                    .set("Referer", url + resource)
                    .set("Range", `bytes=${start}-${end}`);
            }).then(res => {
                expect(res).to.have.header("Content-Range",
                    `bytes ${start}-${end}/${contentLen}`
                );
                const expected = fileBig.slice(start, end + 1);
                expect(Buffer.from(res.text)).to.deep.equal(expected);
            }).catch(res => {
                throw res;
            });
        });
        it("should accept and work with download dispotision");
    });
});

describe("Account stuff", function(){
    it("should be able to view a users uploads", function(){
        return req().get("/juush/uploads/1").then(res => {
            expect(res).to.be.json;
            const json = res.body;
            expect(json[0]).to.have.property("id");
            expect(json[0]).to.have.property("filename");
            expect(json[0]).to.have.property("mimetype");
            expect(json[0]).to.have.property("downloads");
            expect(json[0]).to.have.property("uploaddate");
        });
    });
    it("should now have a whoami", function(){
        return req().get("/juush/whoami").then(res => {
            expect(res.body).to.have.length(1);
            expect(res.body[0]).to.equal(1);
        });
    });
});

describe("error", function(){
    it("410 when viewing a deleted file", function(){
        return req().get(`/f/${keys[0]}`).catch(res => {
            expect(res).to.have.status(410);
        });
    });
    it("when incrementing download");
    it("404 when viewing missing file", function(){
        return req().get("/f/zzzzzzz").catch(res => {
            expect(res).to.have.status(404);
        });
    });
    it("generic db failure stuff");
    it("should not be able to make new users", async (function(){
        global.testIsAdmin = false;
        return req().get("/nuser/user2").then(function(){
            throw new Error();
        }, function(){
            return true;
        });
    }));
});

});
