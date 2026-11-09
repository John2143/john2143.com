import assert from "node:assert/strict";
import { test } from "node:test";
import { isOriginalDisposition } from "../juush/dispositions.js";

test("original dispositions", () => {
    for (const d of ["orig", "original", "dl"]) assert.equal(isOriginalDisposition(d), true, d);
    for (const d of [undefined, "", "thumb", "cdn", "info", "delete", "rename", "bogus", "constructor", "__proto__", "toString"]) assert.equal(isOriginalDisposition(d as string | undefined), false, String(d));
});
