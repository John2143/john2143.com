import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnfurlBot, renderEmbedHtml } from "../juush/embed.js";

test("isUnfurlBot", () => {
    assert.equal(isUnfurlBot("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"), true);
    assert.equal(isUnfurlBot("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"), true);
    assert.equal(isUnfurlBot("Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0"), false);
    assert.equal(isUnfurlBot(undefined), false);
    assert.equal(isUnfurlBot(""), false);
});

test("renderEmbedHtml escapes every value", () => {
    const html = renderEmbedHtml({ siteName: "john2143.com", title: `<x>"`, description: "a & b" });
    assert.ok(html.includes("&lt;x&gt;&quot;"), html);
    assert.ok(!html.includes("<x>"), html);
    assert.ok(html.includes("a &amp; b"), html);
    assert.ok(!html.includes("og:image"), html);
    assert.ok(!html.includes("og:type"), html);
});

test("renderEmbedHtml video player", () => {
    const html = renderEmbedHtml({
        siteName: "john2143.com", title: "clip.mkv", image: "https://cdn.example/x.thumb.webp",
        video: { url: "https://cdn.example/x", type: "video/mp4" },
    });
    assert.ok(html.includes(`<meta property="og:type" content="video.other">`), html);
    assert.ok(html.includes(`<meta property="og:video" content="https://cdn.example/x">`), html);
    assert.ok(html.includes(`<meta property="og:video:type" content="video/mp4">`), html);
    assert.ok(html.includes(`<meta property="og:image" content="https://cdn.example/x.thumb.webp">`), html);
    assert.ok(!html.includes("twitter:card"), html);
});

test("renderEmbedHtml image card", () => {
    const html = renderEmbedHtml({ siteName: "john2143.com", title: "doc.pdf", image: "https://john2143.com/f/abcd/thumb" });
    assert.ok(html.includes(`<meta property="og:image" content="https://john2143.com/f/abcd/thumb">`), html);
    assert.ok(html.includes(`<meta name="twitter:card" content="summary_large_image">`), html);
    assert.ok(!html.includes("og:video"), html);
});
