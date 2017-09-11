
import * as util from "../juush/util.js";
import http from "http";
import sinon from "sinon";

describe("Util.js", function(){
    let res = sinon.createStubInstance(http.ServerResponse);

    it("should not crash on error", function(){
        util.juushError(res, "error thing", 500);
        util.juushError(res, undefined, 500);
        util.juushError(res);
        util.juushError();
    });

    it("random string", function(){
        util.randomStr().should.have.length(32);
        util.randomStr(5).should.have.length(5);
    });

    it("guessFileExtension should work", function(){
        util.guessFileExtension("lol.png").should.equal("png");
        util.guessFileExtension(".png").should.equal("png");
        util.guessFileExtension("lol------!@#$%^&*()---431432.asffseg-zzzz.png").should.equal("png");
        expect(util.guessFileExtension("lol.asdfasdfasdf")).to.be.null;
        expect(util.guessFileExtension("lol")).to.be.null;
    });

    describe("ipHasAccess", function(){
        //Database is already initialized, so skip
        it("should throw before setup", function(){
            return util.ipHasAccess("8.8.8.8", 1, null).should.be.rejectedWith(Error, /db init/);
        });

        let ipArray = [
            {ip: "1.2.3.4"},
            {ip: "8.8.8.8"},
        ];
        let shouldHaveKeyID = true;
        let shouldHaveArray = true;
        let queryStub = {
            index: {
                findOne(){
                    return {
                        keyid: shouldHaveKeyID ? 1 : 0,
                    };
                },
                find(){
                    return {
                        sort(){
                            return this;
                        },
                        async toArray(){
                            return shouldHaveArray ? ipArray : [];
                        }
                    };
                },
            }
        };

        it("should not have keyid and fail with nofile", async function(){
            shouldHaveKeyID = false;
            await util.ipHasAccess("8.8.8.8", 1, queryStub).should.eventually.equal("NOFILE");
            shouldHaveKeyID = true;
        });

        it("should not be in the ipArray and fail with nouplaods", async function(){
            shouldHaveArray = false;
            await util.ipHasAccess("8.8.8.8", 1, queryStub).should.eventually.equal("NOUPLOADS");
            shouldHaveArray = true;
        });
        it("should have no access with wrong ip", function(){
            return util.ipHasAccess("7.7.7.7", 1, queryStub).should.eventually.equal("NOACCESS");
        });
        it("should succeed", function(){
            return util.ipHasAccess("8.8.8.8", 1, queryStub).should.be.eventually.false;
        });
    });
});
