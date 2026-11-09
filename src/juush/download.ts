import { serverLog } from "../logger.js";

import { createReadStream, createWriteStream, Stats } from "node:fs";
import * as U from "./util.js";
import fs from "node:fs/promises";
import { pipeline, Readable } from "node:stream";
import type { Writable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { humanFileSize } from "./upload.js";
import { isOriginalDisposition } from "./dispositions.js";

let curDownloading = {};

//A Range header indicates a streaming request — serves 206 Partial Content
const isStreamRequest = req => !!req.headers.range;

//This will serve a stream request. It does no kind of validation to see
//if the user can actually access that content.
const serveStreamRequest = async function(reqx, uploadID, filepath, data){
    const rangeRequestRegex = /bytes=(\d*)-(\d*)/;

    let stat;
    try{
        if(curDownloading[uploadID]){
            console.log("Waiting for download to finish... ", uploadID);
            await curDownloading[uploadID];
            stat = await fs.stat(filepath);
        } else {
            //statSync fails if filepath does not exist
            stat = await fs.stat(filepath);
        }
    }catch(e){
        reqx.res.writeHead(400, {});
        reqx.res.end();
        return;
    }


    const range = rangeRequestRegex.exec(reqx.req.headers.range || "");
    const fullContentLength = stat.size;
    let rangeStart: number;
    let rangeEnd: number;

    if (range[1] === "" && range[2] !== "") {
        // suffix range e.g. bytes=-500 → last 500 bytes
        rangeEnd = fullContentLength - 1;
        rangeStart = fullContentLength - Number(range[2]);
    } else {
        rangeStart = Number(range[1]);
        rangeEnd = range[2] === "" ? fullContentLength - 1 : Number(range[2]);
    }


    const bytesString = `${rangeStart}-${rangeEnd}/${fullContentLength}`;
    reqx.extraLog = bytesString.green;

    const contentLength = rangeEnd - rangeStart + 1;

    if(contentLength <= 0 ||
        rangeStart >= fullContentLength ||
        rangeEnd >= fullContentLength
    ){
        reqx.res.writeHead(416, {}); //Cannot deliver range
        reqx.res.end();
        return;
    }

    reqx.res.writeHead(206, { //Partial content
        "Content-Type": data?.mimetype || "application/octet-stream",
        "Content-Disposition": "inline" + (data?.filename ? `; filename="${data.filename}"` : ""),
        "Content-Length": contentLength,
        "Content-Range": `bytes ${bytesString}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "max-age=300",
    });

    if(reqx.req.method === "HEAD"){
        reqx.res.end();
        return;
    }

    let f = await fs.open(filepath, "r");
    const filePipe = f.createReadStream({start: rangeStart, end: rangeEnd});
    filePipe.on("error", () => { try { filePipe.destroy(); } catch (_) {} });
    filePipe.on("close", () => { void f.close().catch(() => {}); });
    pipeline(filePipe, reqx.res, () => {});
};

const setMimeType = async function(id, newmime){
    return await Promise.all([
        U.query.index.updateOne({_id: id}, {$set: {mimetype: newmime}}),
        // The file here is only a cache: it may never have been fetched on this pod, or may have
        // been evicted. A missing file must not turn an otherwise successful delete into a 500.
        newmime === "deleted" && fs.unlink(U.getFilename(id)).catch(() => {}),
    ]);
};

const shouldInline = function(__filedata, __mime){
    //const inlineTypes = [
        //"txt", "text", "png", "jpg", "jpeg", "html",
        //"webm", "mp4", "mp3", "wav", "vorbis"
    //];
    //Mimetype is supplied by the user, meaning the subset may not exist

    //const regex = /(.+)\/?(.+)?/g;
    //var regexResult = regex.exec(mime);
    //var category = regexResult[1];
    //var subset = regexResult[2];

    //return category === "video" || category === "audio" ||
        //category === "image" || category === "text";

    //just let the browser decide
    return true;
};

// Streams an object from the filer (web MP4, thumbnail). The filer is reached only
// through MINIO_ENDPOINT_URL (in-cluster at home, the WireGuard proxy on DO);
// clients are never redirected to it. Returns false when nothing was written, so
// the caller can fall back.
const serveFilerObject = async function(reqx, key: string, contentType: string, disposition: string): Promise<boolean> {
    const Bucket = process.env.BUCKET || "imagehost-files";
    const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Accept-Ranges": "bytes",
        "Cache-Control": "max-age=300",
    };
    // Hono runs GET handlers for HEAD and discards the body unread: never open one.
    if(reqx.req.method === "HEAD"){
        try {
            const head = await U.minio_client.send(new HeadObjectCommand({ Bucket, Key: key }));
            reqx.res.writeHead(200, { ...headers, "Content-Length": String(head.ContentLength) });
            reqx.res.end();
            return true;
        } catch(e) {
            serverLog(`Filer HEAD ${key} failed: ${e.name}`);
            return false;
        }
    }
    const range = reqx.req.headers.range || undefined;
    let obj;
    try {
        obj = await U.minio_client.send(new GetObjectCommand({ Bucket, Key: key, Range: range }));
    } catch(e) {
        if(range && (e.name === "InvalidRange" || e.$metadata?.httpStatusCode === 416)){
            reqx.res.writeHead(416, {});
            reqx.res.end();
            return true;
        }
        serverLog(`Filer GET ${key} failed: ${e.name}`);
        return false;
    }
    if(!obj.Body) return false;
    const body = obj.Body instanceof Readable ? obj.Body : Readable.fromWeb(obj.Body);
    if(obj.ContentLength !== undefined) headers["Content-Length"] = String(obj.ContentLength);
    if(obj.ContentRange) headers["Content-Range"] = obj.ContentRange;
    reqx.res.writeHead(obj.ContentRange ? 206 : 200, headers);
    // pipeline destroys the S3 body when the client aborts.
    pipeline(body, reqx.res, () => {});
    return true;
};


//const httpsAgent = new https.Agent({
    //rejectUnauthorized: false,
//});

async function makeS3BackupRequest(uploadID: string, s3Client: S3Client, getWriteStream, data) {
    console.log(`Making S3 backup request for ${uploadID}`);
    let getObject = new GetObjectCommand({
        Bucket: process.env.BUCKET,
        Key: uploadID,
    });

    let s3GetRequestPromise = s3Client.send(getObject);

    return new Promise((resolve, reject) => {
        // An async executor's rejection is unobservable and reaches
        // index.ts's uncaughtException handler (process.exit(1)). A repair or an
        // aborted client can truncate the body, so funnel every failure into reject.
        void (async () => {
            let writeStream: Writable | null = null;
            let tryTimeout: ReturnType<typeof setTimeout> | undefined;
            try {
                tryTimeout = setTimeout(() => {
                    console.log(`S3 get request timed out for ${uploadID}`);
                    reject("S3 get request timed out");
                }, 10000);

                const s3GetRequest = await s3GetRequestPromise.catch(reject);

                clearTimeout(tryTimeout);

                if(!s3GetRequest) {
                    console.log(`Not found in ${uploadID}`);
                    return reject("S3 get request failed");
                }

                const s3Size = s3GetRequest.ContentLength;

                // Now, write it to file as local cache
                writeStream = getWriteStream();
                if(!writeStream) {
                    console.log(`Write stream already claimed for ${uploadID}`);
                    return resolve(null);
                }

                console.log(`Writing to local cache : ${uploadID} ${humanFileSize(s3Size)}`);
                // Use pipeline with Readable.fromWeb to properly handle lifecycle
                // of the S3 response body. Raw .pipe() can cause undici to
                // double-close the underlying ReadableStream on cleanup.
                const body = s3GetRequest.Body as any;
                const nodeBody = body?.getReader
                    ? Readable.fromWeb(body)
                    : (body as import("node:stream").Readable);
                await new Promise<void>((resolve, reject) => {
                    pipeline(nodeBody, writeStream, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                // sleep for 10ms to allow the write to complete
                await new Promise(resolve => setTimeout(resolve, 10));

                console.log("Local cache write complete", uploadID);
                resolve(null);
            } catch(e) {
                clearTimeout(tryTimeout);
                try { writeStream?.destroy(); } catch(_) {}
                reject(e);
            }
        })();
    });
}

async function tryGetBackups(uploadID: string, filepath: string, reqx: any, data: any): Promise<Stats> {
    let origFilepath = filepath;
    filepath = filepath + ".dl";
    let curWriteStream = createWriteStream(filepath);
    // only allow one person to claim a file handle
    let getWriteStream = () => {
        let ws = curWriteStream;
        curWriteStream = null;
        return ws;
    };
    let s3UploadId = `${process.env.FOLDER}/${uploadID}`;

    let startTime = performance.now();
    let promises = [
        //makeS3BackupRequest(s3UploadId, U.s3_client, getWriteStream, data),
        makeS3BackupRequest(uploadID, U.minio_client, getWriteStream, data),
    ];
    try {
        await Promise.any(promises).finally(() => {
            curDownloading[uploadID] = null;
        });

        let endTime = performance.now();
        let diff = Math.floor(endTime - startTime);
        reqx.extraLog = `Cache miss, +${diff}ms`.yellow;

        console.log(`Renaming ${filepath} to ${origFilepath}`);

        // Move it to the non-dl file
        await fs.rename(filepath, origFilepath);
    } catch (e) {
        // Backup failed — clean up orphaned .dl file
        try { await fs.unlink(filepath); } catch (_) {}
        throw e;
    }

    // calculate checksum
    // https://john2143.com:9000
    const hash = createHash("sha256");
    const input = createReadStream(origFilepath);
    input.on("error", () => {});

    input.on("data", chunk => {
        hash.update(chunk);
    });

    let stat = await fs.stat(origFilepath);

    return new Promise(resolve => {
        input.on("end", () => {
            const checksum = hash.digest("hex");
            console.log(checksum);

            resolve(stat);
        });
    });
}

const processDownload = async function(reqx, data, disposition){
    const uploadID = data._id;
    const filepath = U.getFilename(uploadID);

    if(data.mimetype === "deleted"){
        reqx.doHTML("This file has been deleted.", 410);
        return;
    }

    //Try to get file details
    let stat: Stats;
    try{
        stat = await fs.stat(filepath);
    }catch(e){
        try {
            if(curDownloading[uploadID]) {
                console.log("Asset not found: Has curDownloading Entry");
                stat = await curDownloading[uploadID];
            } else {
                console.log("Asset not found: Getting backup result,");
                let prom = tryGetBackups(uploadID, filepath, reqx, data);
                curDownloading[uploadID] = prom;
                stat = await prom;
            }
        } catch(e) {
            stat = null;
        }
    }

    if (!stat) {
        reqx.doHTML("This file does not exist", 404);
        return;
    }



    //Do the database call to increment downloads
    let incDL = true;

    // CDN redirect: if we have a CDN copy, redirect browsers to it.
    // Skip for explicit original requests (orig, original, dl) and thumbnails.
    if(data.cdn && !isOriginalDisposition(disposition) && disposition !== "thumb" && disposition !== "cdn"){
        reqx.extraLog = "CDN serve".yellow;
        U.query.index.updateOne({_id: uploadID}, {
            $inc: {downloads: 1},
            $set: {lastdownload: new Date()},
        }).catch(() => {});
        reqx.res.writeHead(302, { "Location": data.cdn });
        reqx.res.end();
        return;
    }
    //What to do with the content:
    //  inline, attachment (download)
    let codisp = "inline";

    let skipresponse = false;

    //dl for download
    if(disposition === "dl"){
        codisp = "attachment";
    //thumbnail
    }else if(disposition === "thumb"){
        incDL = false;
    }else{
        //Guess what should be done
        /* istanbul ignore else */
        if(shouldInline(stat, data.mimetype)){
            //NOOP
        }else{
            codisp = "attachment";
        }
    }
    //Send filename with content-disposition
    codisp += '; filename="' + data.filename + '"';

    if(incDL){
        U.query.index.updateOne({_id: uploadID}, {
            $inc: {downloads: 1},
            $set: {lastdownload: new Date()},
        }).catch(err => {
            serverLog("Error when incrementing download. " + uploadID, err);
        });
    }

    if(skipresponse) {
        return;
    }

    reqx.res.writeHead(200, {
        "Content-Type": data.mimetype,
        "Content-Disposition": codisp,
        "Content-Length": stat.size,
        "Cache-Control": "max-age=300",
        "Accept-Ranges": "bytes",
    });

    if(reqx.req.method === "HEAD"){
        reqx.res.end();
        return;
    }

    //Stream file from disk directly
    let f = await fs.open(filepath, "r");
    const stream = f.createReadStream();
    stream.on("error", () => { try { stream.destroy(); } catch (_) {} });
    stream.on("close", () => { void f.close().catch(() => {}); });
    pipeline(stream, reqx.res, () => {});
};

// Thumbnail: the CDN WebP, else the filer copy, else (images only) the image itself.
// Other types without a thumbnail get a 1x1 GIF instead of the full file.
const serveThumb = async function(reqx, data){
    if(data.mimetype === "deleted"){
        reqx.doHTML("This file has been deleted.", 410);
        return;
    }
    if(data.thumb){
        reqx.extraLog = "CDN thumb".yellow;
        reqx.res.writeHead(302, { "Location": data.thumb });
        reqx.res.end();
        return;
    }
    if(data.artifacts?.thumbnail){
        const key = U.artifactKey(data.artifacts.thumbnail);
        if(await serveFilerObject(reqx, key, key.endsWith(".webp") ? "image/webp" : "image/jpeg", "inline")){
            reqx.extraLog = "filer thumb".yellow;
            return;
        }
    }
    if(data.mimetype?.startsWith("image/")){
        if(data.cdn){
            reqx.extraLog = "CDN thumb".yellow;
            reqx.res.writeHead(302, { "Location": data.cdn });
            reqx.res.end();
            return;
        }
        return processDownload(reqx, data, "thumb");
    }
    reqx.extraLog = "thumb skip".yellow;
    reqx.res.writeHead(200, { "Content-Type": "image/gif" });
    // 1x1 transparent GIF — works everywhere, Hono-safe
    reqx.res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
};

//Returns true if there is an auth error. also handles reqx
const accessCheck = async function(uploadID, reqx){
    const ip = reqx.req.socket.remoteAddress;
    const canDo = await U.ipHasAccess(ip, uploadID);

    if(canDo === "NOFILE"){
        reqx.doHTML("That file does not exist", 404);
        return true;
    }else if(canDo === "NOACCESS"){
        reqx.doHTML("You do not have access to rename this file.", 401);
        return true;
    }else if(canDo){
        reqx.doHTML("AccessError: E" + canDo, 407);
        return true;
    }
};

const download = async function(server, reqx){
    let uploadID = reqx.urldata.path[1];
    if(!uploadID || uploadID === ""){
        reqx.res.statusCode = 404;
        reqx.res.end("No file supplied");
        return;
    }

    //ignore extension
    uploadID = uploadID.split(".")[0];

    const result = await U.query.index.findOne({_id: uploadID},
        { projection: { mimetype: 1, filename: 1, cdn: 1, thumb: 1, artifacts: 1 } }
    );
    if(!result){
        reqx.doHTML("This upload does not exist", 404);
        return;
    }

    //What the user wants to do with the file
    const disposition = reqx.urldata.path[2];
    const wantsOriginal = isOriginalDisposition(disposition);
    if(disposition === "thumb") return serveThumb(reqx, result);

    if(result.cdn && disposition == "cdn") {
        // Modify extraLog
        reqx.extraLog = "CDN redirect".yellow;

        await U.query.index.updateOne({_id: uploadID}, {
            $inc: {downloads: 1},
            $set: {lastdownload: new Date()},
        })

        // Permanent redirect = 301
        // Temp redirect = 302
        reqx.res.writeHead(302, {
            "Location": result.cdn,
        });
        reqx.res.end();
        return ;
    }

    // No CDN copy (over 150 MB): serve the web MP4 from the filer; the original stays on /orig and /dl.
    if(!result.cdn && result.artifacts?.faststart && result.mimetype !== "deleted" && (disposition === undefined || disposition === "cdn")){
        if(await serveFilerObject(reqx, U.artifactKey(result.artifacts.faststart), "video/mp4", `inline; filename="${result.filename}"`)){
            reqx.extraLog = "filer web".yellow;
            const range = reqx.req.headers.range;
            if(!range || range.startsWith("bytes=0-")){
                U.query.index.updateOne({_id: uploadID}, {
                    $inc: {downloads: 1},
                    $set: {lastdownload: new Date()},
                }).catch(() => {});
            }
            return;
        }
    }


    if(isStreamRequest(reqx.req)){
        if(result.mimetype === "deleted"){
            reqx.doHTML("This file has been deleted.", 410);
            return;
        }
        // Same CDN preference as processDownload: browsers range-request the CDN copy.
        if(result.cdn && !wantsOriginal){
            reqx.extraLog = "CDN serve".yellow;
            U.query.index.updateOne({_id: uploadID}, {
                $inc: {downloads: 1},
                $set: {lastdownload: new Date()},
            }).catch(() => {});
            reqx.res.writeHead(302, { "Location": result.cdn });
            reqx.res.end();
            return;
        }
        // Not cached on this pod's disk (e.g. a fresh pod, or i.john2143.com at home): fill from the filer first.
        const filepath = U.getFilename(uploadID);
        const cached = await fs.access(filepath).then(() => true, () => false);
        if(!cached){
            try {
                curDownloading[uploadID] ??= tryGetBackups(uploadID, filepath, reqx, result);
                await curDownloading[uploadID];
            } catch(e) {
                reqx.doHTML("This file does not exist", 404);
                return;
            }
        }
        return serveStreamRequest(reqx, uploadID, filepath, result);
    }

    if(disposition === "delete"){
        if(await accessCheck(uploadID, reqx)) return;

        const __result = await setMimeType(uploadID, "deleted");
        reqx.doHTML("File successfully deleted. It will still appear in your user page.");
    }else if(disposition === "info"){
        const res = reqx.res;
        const data = await U.query.index.findOne({_id: uploadID});
        if(!data){
            res.writeHead(404, {
                "Content-Type": "text/html"
            });
            res.end("This upload does not exist");
            return;
        }

        const user = await U.query.users.findOne({juush_user_id: data.keyid});
        const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

        res.writeHead(200, {
            "Content-Type": "text/html",
        });
        res.write("Filename: " + esc(data.filename));
        res.write("<br>Upload date: " + data.uploaddate);
        res.write("<br>Uploaded by: " + esc(user.display_name));
        res.write("<br>Downloads: " + data.downloads);
        res.write("<br>File Type: " + esc(data.mimetype));
        res.end();
    }else if(disposition === "rename"){
        if(await accessCheck(uploadID, reqx)) return;

        const oldName = (await U.query.index.findOne({_id: uploadID}, {filename: 1})).filename;
        const newName = decodeURI(reqx.urldata.path[3]);
        const oldFileExt = U.guessFileExtension(oldName);
        const newFileExt = U.guessFileExtension(newName);

        let name = newName;

        if(!newFileExt && oldFileExt){
            name += "." + oldFileExt;
        }

        await U.query.index.updateOne({_id: uploadID}, {$set: {filename: name}});

        reqx.res.end(name);
    }else if(disposition === "hide"){
        if(await accessCheck(uploadID, reqx)) return;

        await U.setModifier(uploadID, "hidden", true);
        reqx.res.end("hidden");
    }else if(disposition === "unhide"){
        if(await accessCheck(uploadID, reqx)) return;

        await U.setModifier(uploadID, "hidden", undefined);
        reqx.res.end("unhidden");
    }else{
        await processDownload(reqx, result, disposition);
    }
};

export default async function(server, reqx){
    try{
        await download(server, reqx);
    }catch(e){
        U.juushError(reqx.res, e, 500);
    }
}
