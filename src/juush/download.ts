
import { createReadStream, createWriteStream, Stats } from "node:fs";
import * as U from "./util.js";
import fs from "node:fs/promises";
import {pipeline} from "node:stream";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

let curDownloading = {};

//You will get a referer and range if you are trying to stream an audio/video
const isStreamRequest = req => req.headers.referer && req.headers.range;

//This will serve a stream request. It does no kind of validation to see
//if the user can actually access that content.
const serveStreamRequest = async function(reqx, uploadID, filepath){
    const rangeRequestRegex = /bytes=(\d*)-(\d*)/;

    let stat;
    try{
        if(curDownloading[uploadID]){
            await curDownloading[uploadID];
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
    const rangeStart = Number(range[1]);
    let rangeEnd;

    if(range[2] === ""){
        rangeEnd = fullContentLength - 1;
    }else{
        rangeEnd = Number(range[2]);
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
        //Ignoring Content-Type to not need a db request
        //Add it back in if this ever requires db stuff
        "Content-Length": contentLength,
        "Content-Range": `bytes ${bytesString}`,
    });

    let f = await fs.open(filepath, "r");
    const filePipe = f.createReadStream({start: rangeStart, end: rangeEnd});
    reqx.res.on("error", () => filePipe.end());
    filePipe.pipe(reqx.res);
};

const setMimeType = async function(id, newmime){
    return await Promise.all([
        U.query.index.updateOne({_id: id}, {$set: {mimetype: newmime}}),
        newmime === "deleted" && fs.unlink(U.getFilename(id)),
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


//const httpsAgent = new https.Agent({
    //rejectUnauthorized: false,
//});

async function makeS3BackupRequest(uploadID: string, s3Client: S3Client, getWriteStream, data) {
    let hoc = new HeadObjectCommand({
        Bucket: process.env.BUCKET,
        Key: uploadID,
    });
    console.log("trying, Key s3 head request", uploadID);

    let s3HeadRequest = await s3Client.send(hoc);

    if(!s3HeadRequest) {
        throw new Error("S3 head request failed");
    }

    if(!data.cdn && s3Client === U.s3_client) {
        let cdn = `https://${process.env.BUCKET}.nyc3.cdn.digitaloceanspaces.com/${process.env.FOLDER}/${uploadID}`;
        //await U.query.index.updateOne({_id: uploadID}, {
            //$set: {cdn},
        //});
        console.log("Want to update CDN set to", cdn);
    }

    let s3Size = s3HeadRequest.ContentLength;
    console.log(s3Size);
    let getObject = new GetObjectCommand({
        Bucket: process.env.BUCKET,
        Key: uploadID,
    });

    let s3GetRequest = await s3Client.send(getObject);

    // Now, write it to file as local cache
    let writeStream = getWriteStream();
    if(!writeStream) {
        return;
    }

    console.log("Writing to local cache", uploadID);

    await s3GetRequest.Body.pipe(writeStream);
    // sleep for 100ms to allow the write to complete
    await new Promise(resolve => setTimeout(resolve, 150));

    console.log("Local cache write complete", uploadID);
}

async function tryGetBackups(uploadID: string, filepath: string, reqx: any, data): Stats {
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
        makeS3BackupRequest(s3UploadId, U.s3_client, getWriteStream, data),
    ];
    if(!data.cdn) {
        promises.push(makeS3BackupRequest(uploadID, U.minio_client, getWriteStream, data));
    }
    await Promise.any(promises);

    let endTime = performance.now();
    let diff = Math.floor(endTime - startTime);
    reqx.extraLog = `Cache miss, +${diff}ms`.yellow;
    curDownloading[uploadID] = null;

    // calculate checksum
    const hash = createHash("sha256");
    const input = createReadStream(filepath);

    input.on("data", chunk => {
        hash.update(chunk);
    });

    let stat = await fs.stat(filepath);

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
            console.log("Asset not found");
            if(curDownloading[uploadID]) {
                console.log("Has curDownloading Entry");
                stat = await curDownloading[uploadID];
            } else {
                console.log("Getting backup result,");
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

    //Stream file from disk directly
    let f = await fs.open(filepath, "r");
    const stream = f.createReadStream();
    stream.pipe(reqx.res);
};

//Returns true if there is an auth error. also handles reqx
const accessCheck = async function(uploadID, reqx){
    const ip = reqx.req.headers["x-forwarded-for"];
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

    if(process.env.IS_HOME) {
        // serve permanant redirect to 2143.me
        reqx.res.writeHead(301, {
            "Location": `https://2143.moe/f/${uploadID}/cdn`,
        });
        reqx.extraLog = "@2143.moe".yellow;
        reqx.res.end();
        return;
    }

    //ignore extension
    uploadID = uploadID.split(".")[0];

    const result = await U.query.index.findOne({_id: uploadID},
        {mimetype: 1, filename: 1, id: 1, cdn: 1}
    );
    if(!result){
        reqx.doHTML("This upload does not exist", 404);
        return;
    }

    //What the user wants to do with the file
    const disposition = reqx.urldata.path[2];
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


    if(isStreamRequest(reqx.req)){
        return serveStreamRequest(reqx, uploadID, U.getFilename(uploadID));
    }

    if(disposition === "delete"){
        if(await accessCheck(uploadID, reqx)) return;

        const __result = await setMimeType(uploadID, "deleted");
        reqx.doHTML("File successfully deleted. It will still appear in your user page.");
    }else if(disposition === "info"){
        const data = await U.query.index.findOne({_id: uploadID});
        if(!data){
            res.writeHead(404, {
                "Content-Type": "text/html"
            });
            res.end("This upload does not exist");
            return;
        }

        const user = await U.query.keys.findOne({_id: data.keyid});

        const res = reqx.res;

        res.writeHead(200, {
            "Content-Type": "text/html",
        });
        res.write("Filename: " + data.filename);
        res.write("<br>Upload date: " + data.uploaddate);
        res.write("<br>Uploaded by: " + user.name);
        res.write("<br>Downloads: " + data.downloads);
        res.write("<br>File Type: " + data.mimetype);
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
