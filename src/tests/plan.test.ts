import assert from "node:assert/strict";
import { test } from "node:test";
import { planSteps, renderDetails } from "../juush/temporal/plan.js";

const webp = { thumbnail: "imagehost-files/a.thumb.webp" };

test("planSteps: fresh uploads", () => {
    assert.deepEqual(planSteps({ mimetype: "video/x-matroska", filename: "a.mkv" }).steps, ["thumbnail", "preview", "thumbnailCdn", "webVideo", "cdn"]);
    assert.deepEqual(planSteps({ mimetype: "application/octet-stream", filename: "a.mkv" }).steps, ["thumbnail", "preview", "thumbnailCdn", "webVideo", "cdn"]);
    assert.deepEqual(planSteps({ mimetype: "image/gif", filename: "a.gif" }).steps, ["preview", "cdn"]);
    assert.deepEqual(planSteps({ mimetype: "image/png", filename: "a.png" }).steps, ["thumbnail", "preview", "thumbnailCdn", "cdn"]);
    assert.deepEqual(planSteps({ mimetype: "text/plain", filename: "a.txt" }).steps, ["cdn"]);
});

test("planSteps: processed and partial uploads", () => {
    const done = { mimetype: "video/mp4", filename: "a.mp4", cdn: "https://cdn/a", thumb: "https://cdn/a.thumb.webp", preview: "data:", artifacts: { ...webp, faststart: "imagehost-files/a.fast.mp4" } };
    assert.deepEqual(planSteps(done).steps, []);
    assert.deepEqual(planSteps({ ...done, thumb: "https://cdn/x.thumb.jpg" }).steps, ["thumbnailCdn"]);
    assert.deepEqual(planSteps({ ...done, cdn: undefined }).steps, ["cdn"]);
    assert.deepEqual(planSteps({ ...done, artifacts: { thumbnail: "imagehost-files/a.thumb.jpg", faststart: "x" } }).steps, ["thumbnail"]);
});

test("planSteps: deleted and missing", () => {
    const deleted = planSteps({ mimetype: "deleted", filename: "a.mkv" });
    assert.equal(deleted.kind, "deleted");
    assert.deepEqual(deleted.steps, []);
    const missing = planSteps(null);
    assert.equal(missing.kind, "missing");
    assert.deepEqual(missing.steps, []);
});

test("renderDetails", () => {
    const plan = planSteps({ mimetype: "image/png", filename: "a.png" });
    const text = renderDetails("abcd", plan, { thumbnail: "created" });
    assert.ok(text.startsWith("**image** `a.png` image/png\n\n"), text);
    assert.ok(text.includes("- [x] make thumbnail: created"), text);
    assert.ok(text.includes("- [ ] publish to CDN"), text);
    assert.equal(renderDetails("abcd", planSteps(null), {}), "**missing** `abcd`\n\nnothing to do");
});
