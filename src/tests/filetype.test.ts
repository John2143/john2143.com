import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUpload, guessFileExtension } from "../juush/filetype.js";

test("classifyUpload", () => {
    assert.equal(classifyUpload("application/octet-stream", "a.mkv"), "video");
    assert.equal(classifyUpload(undefined, "a.MOV"), "video");
    assert.equal(classifyUpload("image/gif", "a.gif"), "gif");
    assert.equal(classifyUpload("application/octet-stream", "a.gif"), "gif");
    assert.equal(classifyUpload("image/svg+xml", "a.svg"), "image");
    assert.equal(classifyUpload("image/png", "noext"), "image");
    assert.equal(classifyUpload("text/plain", "a.txt"), "other");
    assert.equal(classifyUpload("text/plain", "constructor"), "other");
});

test("guessFileExtension", () => {
    assert.equal(guessFileExtension("a.tar.gz"), "gz");
    assert.equal(guessFileExtension("noext"), null);
    assert.equal(guessFileExtension("a.verylongext"), null);
    assert.equal(guessFileExtension(undefined), null);
});
