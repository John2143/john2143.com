// Patch @hono/node-server writeFromReadableStreamDefaultReader to prevent
// "ReadableStream is already closed" crash on client disconnect.
// Upstream: https://github.com/honojs/node-server/issues/233
//
// Removes once @hono/node-server ships the fix.

const fs = require("node:fs");
const path = require("node:path");

const base = path.join(__dirname, "..", "node_modules", "@hono", "node-server", "dist");

const OLD = `function writeFromReadableStreamDefaultReader(reader, writable, currentReadPromise) {
\tconst cancel = (error) => {
\t\treader.cancel(error).catch(() => {});
\t};`;

const NEW = `function writeFromReadableStreamDefaultReader(reader, writable, currentReadPromise) {
\tlet cancelled = false;
\tconst cancel = (error) => {
\t\tif (cancelled) return;
\t\tcancelled = true;
\t\treader.cancel(error).catch(() => {});
\t};`;

for (const file of ["index.mjs", "index.cjs"]) {
    const filepath = path.join(base, file);
    if (!fs.existsSync(filepath)) {
        console.warn(`patch-hono-node-server: ${file} not found, skipping`);
        continue;
    }
    let content = fs.readFileSync(filepath, "utf8");
    if (content.includes("let cancelled = false")) {
        console.log(`patch-hono-node-server: ${file} already patched`);
        continue;
    }
    if (!content.includes(OLD)) {
        console.warn(`patch-hono-node-server: ${file} pattern not found, may need update`);
        continue;
    }
    content = content.replace(OLD, NEW);
    fs.writeFileSync(filepath, content, "utf8");
    console.log(`patch-hono-node-server: ${file} patched successfully`);
}
