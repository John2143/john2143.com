
import util from "../juush/util.js";
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
});
