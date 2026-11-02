/**
 * Upload multipart parsing — run with `npm test`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bodySizeMismatch, createBodyTrimmer, parseHeadersFromUpload } from "../juush/multipart.js";

const BOUNDARY = "------------------------ouBpDMbKKVIyn3W1VXnOhj";
const PART_HEADER = `--${BOUNDARY}\r\n`
    + "Content-Disposition: form-data; name=\"KEY123\"; filename=\"ü.png\"\r\n"
    + "Content-Type: image/png\r\n\r\n";
const CLOSE = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8");

const reqHeaders = (contentType: string, contentLength?: number) => ({
    "content-type": contentType,
    "content-length": contentLength === undefined ? undefined : String(contentLength),
});

describe("parseHeadersFromUpload", () => {
    it("measures headerSize in bytes, not characters", () => {
        const body = Buffer.concat([Buffer.from(PART_HEADER, "utf8"), Buffer.from("file bytes")]);
        const h = parseHeadersFromUpload(body, reqHeaders(`multipart/form-data; boundary=${BOUNDARY}`, 1234));
        assert.ok(h);
        assert.equal(h.key, "KEY123");
        assert.equal(h.filename, "ü.png");
        assert.equal(h.mimetype, "image/png");
        assert.equal(h.headerSize, Buffer.byteLength(PART_HEADER));
        assert.ok(h.headerSize > PART_HEADER.length);
        assert.equal(h.contentLength, 1234);
        assert.ok(h.boundary.equals(CLOSE));
    });

    it("accepts the RFC-quoted boundary form", () => {
        const body = Buffer.from(PART_HEADER, "utf8");
        const plain = parseHeadersFromUpload(body, reqHeaders(`multipart/form-data; boundary=${BOUNDARY}`));
        const quoted = parseHeadersFromUpload(body, reqHeaders(`multipart/form-data; boundary="${BOUNDARY}"`));
        assert.ok(plain && quoted);
        assert.ok(quoted.boundary.equals(plain.boundary));
        assert.equal(quoted.contentLength, undefined);
    });

    it("returns null until the part header is complete", () => {
        const partial = Buffer.from(PART_HEADER.slice(0, 40), "utf8");
        assert.equal(parseHeadersFromUpload(partial, reqHeaders(`multipart/form-data; boundary=${BOUNDARY}`)), null);
    });
});

describe("createBodyTrimmer", () => {
    const feed = (input: Buffer, chunkSize: number): Buffer => {
        const trimmer = createBodyTrimmer(CLOSE);
        const out: Buffer[] = [];
        for (let i = 0; i < input.length; i += chunkSize) {
            out.push(trimmer.push(input.subarray(i, i + chunkSize)));
        }
        out.push(trimmer.finish());
        return Buffer.concat(out);
    };

    it("strips the closing boundary for every chunk size, including boundary.length - 1", () => {
        const file = randomBytes(1000);
        const body = Buffer.concat([file, CLOSE]);
        for (let size = 1; size <= CLOSE.length + 2; size++) {
            assert.ok(feed(body, size).equals(file), `chunk size ${size}`);
        }
        assert.ok(feed(body, body.length).equals(file), "single chunk");
    });

    it("passes a body without the closing boundary through unchanged", () => {
        const body = randomBytes(1000);
        for (const size of [1, CLOSE.length - 1, CLOSE.length, 7, 1000]) {
            assert.ok(feed(body, size).equals(body), `chunk size ${size}`);
        }
    });
});

describe("bodySizeMismatch", () => {
    const fileSize = 1000;
    const headerSize = Buffer.byteLength(PART_HEADER);
    const exact = headerSize + fileSize + CLOSE.length;
    const parse = (contentLength?: number) =>
        parseHeadersFromUpload(Buffer.from(PART_HEADER, "utf8"), reqHeaders(`multipart/form-data; boundary=${BOUNDARY}`, contentLength));

    it("accepts the exact size", () => {
        assert.equal(bodySizeMismatch(parse(exact), fileSize), null);
    });

    it("rejects a size one byte off", () => {
        assert.equal(typeof bodySizeMismatch(parse(exact), fileSize - 1), "string");
        assert.equal(typeof bodySizeMismatch(parse(exact), fileSize + 1), "string");
    });

    it("skips the check without Content-Length", () => {
        assert.equal(bodySizeMismatch(parse(undefined), fileSize), null);
    });
});
