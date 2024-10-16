
import { Stats } from "node:fs";
import * as U from "./util.js";
import fs from "node:fs/promises";
import {pipeline} from "node:stream";


//You will get a referer and range if you are trying to stream an audio/video
const isStreamRequest = req => req.headers.referer && req.headers.range;

//This will serve a stream request. It does no kind of validation to see
//if the user can actually access that content.
const serveStreamRequest = async function(reqx, filepath){
    const rangeRequestRegex = /bytes=(\d*)-(\d*)/;
    let stat;

    try{
        //statSync fails if filepath does not exist
        stat = await fs.stat(filepath);
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

let curDownloading = {};

async function getFromBackup(uploadID: string, filepath: string) {
    if(process.env.IS_HOME) {
        throw new Error("Cannot download from backup in home mode");
    }
    if(curDownloading[uploadID]) {
        let res = await curDownloading[uploadID];
        return [res, 1];
    }

    let response = await fetch(
        // TODO: change to home-endpoint
        `https://2143.me/f/${uploadID}.cache`,
        //{
            //agent: httpsAgent,
        //}
    );

    if(!response.ok) {
        throw new Error(`upstream HTTP error! status: ${response.status}`);
    }

    let p = new Promise((resolve, reject) => {
        let stream = response.body;

        if(!stream) {
            reject(new Error("Response body is undefined"));
        }

        // Now, write it to file as local cache
        let file = require("fs").createWriteStream(filepath);
        // Pipe the response to the file
        pipeline(stream!, file, err => {
            if(err) {
                reject(err);
            } else {
                fs.stat(filepath)
                    .then(resolve)
                    .catch(reject);
            }
        });
    });

    curDownloading[uploadID] = p;
    let res = await p;
    return [res, 0];
}

const processDownload = async function(reqx, data, disposition){
    const uploadID = data._id;
    const filepath = U.getFilename(uploadID);

    let fff = await U.query.index.findOne({_id: uploadID});
    if(fff.cdn && disposition == "cdn") {
        // Modify extraLog
        reqx.extraLog = "CDN redirect".yellow;

        // Permanent redirect = 301
        // Temp redirect = 302
        reqx.res.writeHead(302, {
            "Location": fff.cdn,
        });
        reqx.res.end();
        return ;
    }

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
            let startTime = performance.now();
            let [s, isDup] = await getFromBackup(uploadID, filepath);
            stat = s;
            let endTime = performance.now();
            let diff = Math.floor(endTime - startTime);
            reqx.extraLog = `Cache miss, +${diff}ms`.yellow;
            if(isDup){
                reqx.extraLog += " (duplicate request)";
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

    //ignore extension
    uploadID = uploadID.split(".")[0];

    //What the user wants to do with the file
    const disposition = reqx.urldata.path[2];

    if(isStreamRequest(reqx.req)){
        return serveStreamRequest(reqx, U.getFilename(uploadID));
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
        const result = await U.query.index.findOne({_id: uploadID},
            {mimetype: 1, filename: 1, id: 1}
        );
        if(!result){
            reqx.doHTML("This upload does not exist", 404);
            return;
        }
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
