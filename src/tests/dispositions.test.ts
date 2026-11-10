import assert from "node:assert/strict";
import { test } from "node:test";
import { contentDisposition, isInlineSafe, isMutationVerb, isOriginalDisposition } from "../juush/dispositions.js";

test("original dispositions", () => {
    for (const d of ["orig", "original", "dl"]) assert.equal(isOriginalDisposition(d), true, d);
    for (const d of [undefined, "", "thumb", "cdn", "info", "delete", "rename", "bogus", "constructor", "__proto__", "toString"]) assert.equal(isOriginalDisposition(d as string | undefined), false, String(d));
});

test("inline-safe types", () => {
    for (const m of ["image/png", "IMAGE/PNG; charset=x", "video/x-matroska", "audio/mpeg", "text/plain;charset=utf-8", "application/pdf"]) assert.equal(isInlineSafe(m), true, m);
    for (const m of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/octet-stream", "", undefined, "constructor"]) assert.equal(isInlineSafe(m), false, String(m));
});

test("content-disposition", () => {
    assert.equal(contentDisposition("attachment", 'a"b\\c.txt'), `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`);
    const cyrillic = contentDisposition("inline", "клип.mp4");
    assert.ok(cyrillic.startsWith("inline; "), cyrillic);
    assert.ok(cyrillic.includes(`filename="____.mp4"`), cyrillic);
    assert.ok(cyrillic.includes("filename*=UTF-8''%D0%BA%D0%BB%D0%B8%D0%BF.mp4"), cyrillic);
    assert.equal(contentDisposition("inline", "it's (1)*.png"), `inline; filename="it's (1)*.png"; filename*=UTF-8''it%27s%20%281%29%2A.png`);
    assert.equal(contentDisposition("inline", undefined), "inline");
});

test("mutation verbs", () => {
    for (const d of ["delete", "rename", "hide", "unhide", "reprocess"]) assert.equal(isMutationVerb(d), true, d);
    for (const d of ["orig", "info", "constructor", "__proto__", undefined]) assert.equal(isMutationVerb(d), false, String(d));
});
