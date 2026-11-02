/**
 * Unit tests for src/maintenance/common.ts — the framing model, the signature
 * classifier and the verification transforms. Everything here is pure or local;
 * no Mongo, no S3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
    FRAME_BLOCK,
    FRAME_HDR,
    DeFramer,
    Guard,
    allowedKinds,
    contentKind,
    framedPlainLen,
    makeReFramer,
    rawState,
    typeMatches,
} from "../maintenance/common.js";

const hex = (s: string) => Buffer.from(s, "hex");

const KIND_FIXTURES: [string, Buffer][] = [
    ["png", hex("89504e470d0a1a0a0000000d49484452")],
    ["jpeg", hex("ffd8ffe000104a464946000101")],
    ["gif", hex("474946383961")],
    ["webp", Buffer.concat([hex("52494646"), hex("00000000"), hex("57454250")])],
    ["riff", Buffer.concat([hex("52494646"), hex("00000000"), hex("41564920")])],
    ["isobmff", Buffer.concat([hex("00000018"), hex("66747970"), hex("69736f36")])],
    ["mov", Buffer.concat([hex("00000008"), hex("6d6f6f76")])],
    ["mkv", hex("1a45dfa3a342868101")],
    ["flv", hex("464c56010400000009")],
    ["ogg", hex("4f67675300020000")],
    ["mpegps", hex("000001ba4400040004")],
    ["bmp", hex("424d360000000000")],
    ["ico", hex("0000010001000000")],
    ["tiff", hex("49492a0008000000")],
    ["rw2", hex("49495500c8000000")],
    ["psd", hex("3842505300010000")],
    ["jp2", Buffer.concat([hex("0000000c"), hex("6a502020")])],
    ["ts", Buffer.concat([hex("47"), Buffer.alloc(187, 1), hex("47"), Buffer.alloc(187, 1)])],
    ["svg", Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', "latin1")],
];

test("contentKind matches every supported signature", () => {
    for (const [kind, buf] of KIND_FIXTURES) {
        assert.equal(contentKind(buf), kind, `expected ${kind}`);
    }
    assert.equal(contentKind(Buffer.alloc(64, 0x5a)), "other");
    assert.equal(contentKind(Buffer.alloc(0)), "other");
});

test("allowedKinds and typeMatches", () => {
    assert.deepEqual(allowedKinds("image/png"), ["png"]);
    assert.deepEqual(allowedKinds("video/quicktime"), ["mov", "isobmff"]);
    assert.deepEqual(allowedKinds(undefined), ["*"]);
    assert.deepEqual(allowedKinds("application/zip"), ["*"]);
    assert.equal(typeMatches("image/png", "png"), true);
    assert.equal(typeMatches("image/png", "jpeg"), false);
    assert.equal(typeMatches("application/zip", "jpeg"), true);
});

const HEAD_PAD = 200;

test("rawState classifies every bucket", () => {
    const pngHead = Buffer.concat([hex("89504e470d0a1a0a"), Buffer.alloc(HEAD_PAD)]);
    const framedHead = Buffer.concat([Buffer.alloc(FRAME_HDR, 0x4f), pngHead]);
    const jpegHead = Buffer.concat([hex("ffd8ffe0"), Buffer.alloc(HEAD_PAD)]);

    assert.equal(rawState("image/png", undefined, null), "missing");
    assert.equal(rawState("image/png", 0, null), "empty");
    assert.equal(rawState("image/png", 1, Buffer.alloc(1)), "junk");
    // Anything 32 bytes or smaller is junk regardless of mimetype (the census counts
    // these as junk, and they cannot hold a usable file).
    assert.equal(rawState("text/plain", 5, Buffer.from("hello")), "junk");
    assert.equal(rawState("text/plain", 40, Buffer.from("hello world, this is plain text, 40 b")), "clean");
    assert.equal(rawState("image/svg+xml", 40, Buffer.from("<svg xmlns='x'></svg>")), "clean");
    assert.equal(rawState("image/png", 1000, pngHead), "clean");
    assert.equal(rawState("image/png", 100_000, framedHead), "framed");
    // png bytes under an image/jpeg document: framed, but the type does not match.
    assert.equal(rawState("image/jpeg", 100_000, framedHead), "framed");
    assert.equal(rawState("image/png", 1000, jpegHead), "unknown-magic");
    assert.equal(rawState("image/png", 1000, Buffer.alloc(256, 0x5a)), "unknown-magic");
});

test("framedPlainLen inverts the framing formula", () => {
    assert.equal(framedPlainLen(16_442), 16_410);
    assert.equal(framedPlainLen(1_208_081), 1_208_017); // 1,208,017 + 32*2
    assert.equal(framedPlainLen(4_116_773 + 32 * 4), 4_116_773);
    assert.equal(framedPlainLen(1_048_576), 1_048_544); // one header + 1 MiB - 32
    assert.equal(framedPlainLen(1_048_608), 1_048_576);
    // The image of f() skips 1,048,609..1,048,640: no plaintext maps there.
    assert.equal(framedPlainLen(1_048_620), null);
    assert.equal(framedPlainLen(0), null);
    assert.equal(framedPlainLen(32), null);
    assert.equal(framedPlainLen(33), 1);
    for (const n of [1, 1000, FRAME_BLOCK - 1, FRAME_BLOCK, FRAME_BLOCK + 1, 3_500_000, 9_000_001]) {
        const framed = n + FRAME_HDR * Math.ceil(n / FRAME_BLOCK);
        assert.equal(framedPlainLen(framed), n, `round trip ${n}`);
    }
});

function frame(plain: Buffer): { framed: Buffer; headers: Buffer; blocks: number } {
    const blocks = Math.ceil(plain.length / FRAME_BLOCK);
    const parts: Buffer[] = [];
    const headers: Buffer[] = [];
    for (let b = 0; b < blocks; b++) {
        const hdr = Buffer.alloc(FRAME_HDR, 0x4f);
        headers.push(hdr);
        parts.push(hdr);
        parts.push(plain.subarray(b * FRAME_BLOCK, Math.min((b + 1) * FRAME_BLOCK, plain.length)));
    }
    return { framed: Buffer.concat(parts), headers: Buffer.concat(headers), blocks };
}

/** Feeds `input` through `stream` in awkward chunk sizes and returns the output. */
async function runThrough(stream: Transform, input: Buffer, chunkSize = 777): Promise<Buffer> {
    const out: Buffer[] = [];
    stream.on("data", (c: Buffer) => out.push(c));
    const source = Readable.from((function* chunks() {
        for (let i = 0; i < input.length; i += chunkSize) yield input.subarray(i, i + chunkSize);
    })());
    await pipeline(source, stream);
    return Buffer.concat(out);
}

test("DeFramer removes every block header and reports them", async () => {
    const plain = randomBytes(3_500_000); // 4 blocks
    const { framed, headers, blocks } = frame(plain);
    let gotHeaders: Buffer = Buffer.alloc(0);
    let gotBlocks = 0;
    const deFramer = new DeFramer((h, b) => {
        gotHeaders = h;
        gotBlocks = b;
    });
    const out = await runThrough(deFramer, framed);
    assert.equal(blocks, 4);
    assert.equal(out.length, plain.length);
    assert.equal(createHash("sha256").update(out).digest("hex"), createHash("sha256").update(plain).digest("hex"));
    assert.equal(gotBlocks, 4);
    assert.deepEqual(gotHeaders, headers);
    assert.equal(deFramer.outBytes, plain.length);
});

test("DeFramer handles a single block and a partial last block", async () => {
    for (const size of [1, 1000, FRAME_BLOCK, FRAME_BLOCK + 1, 2_500_000]) {
        const plain = randomBytes(size);
        const { framed } = frame(plain);
        const out = await runThrough(new DeFramer(), framed, 4096);
        assert.equal(out.length, plain.length, `size ${size}`);
        assert.equal(createHash("sha256").update(out).digest("hex"), createHash("sha256").update(plain).digest("hex"));
    }
});

test("makeReFramer restores the framed bytes exactly", async () => {
    const plain = randomBytes(2_500_000); // 3 blocks
    const { framed, headers } = frame(plain);
    const out = await runThrough(makeReFramer(headers), plain, 100_003);
    assert.equal(out.length, framed.length);
    assert.equal(createHash("sha256").update(out).digest("hex"), createHash("sha256").update(framed).digest("hex"));
});

test("makeReFramer fails when the body is longer than its headers allow", async () => {
    const plain = randomBytes(2_500_000);
    const { headers } = frame(plain);
    await assert.rejects(runThrough(makeReFramer(headers), randomBytes(4_000_000), 1_000_000), /no header left/);
});

test("Guard accepts an exact body and rejects short, long and wrong-hash bodies", async () => {
    const body = randomBytes(300_000);
    const sha = createHash("sha256").update(body).digest("hex");

    const ok = await runThrough(new Guard(body.length, sha), body, 65_536);
    assert.equal(ok.length, body.length);

    await assert.rejects(runThrough(new Guard(body.length + 1, sha), body), /expected/);
    await assert.rejects(runThrough(new Guard(body.length, sha), Buffer.concat([body, Buffer.from("x")])), /longer than expected/);
    await assert.rejects(runThrough(new Guard(body.length, "00".repeat(32)), body), /sha256/);
});
