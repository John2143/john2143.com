
import * as U from "./util.js";

//You will get a referer and range if you are trying to stream an audio/video
const isStreamRequest = req => req.headers.referer && req.headers.range;

//This will serve a stream request. It does no kind of validation to see
//if the user can actually access that content.
const serveStreamRequest = async function(reqx, filepath){
    const rangeRequestRegex = /bytes=(\d*)-(\d*)/;
    let stat;

    try{
        //statSync fails if filepath does not exist
        stat = fs.statSync(filepath);
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
        "Content-Range": "bytes " + rangeStart + "-" + rangeEnd + "/" + fullContentLength,
    });

    const filePipe = fs.createReadStream(filepath, {start: rangeStart, end: rangeEnd});
    reqx.res.on("error", () => filePipe.end());
    filePipe.pipe(reqx.res);
};

fs.unlinkAsync = function(path){
    return new Promise(function(resolve, reject){
        fs.unlink(path, function(err){
            if(err) reject();
            resolve();
        });
    });
};

const setMimeType = async function(id, newmime){
    return await Promise.all([
        U.pool.query({
            text: "UPDATE index SET mimetype=$2 WHERE id=$1",
            name: "delete_file",
            values: [id, newmime],
        }),
        newmime === "deleted" && fs.unlinkAsync(U.getFilename(id)),
    ]);
};

const shouldInline = function(filedata, mime){
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

const processDownload = function(reqx, result, disposition){
    if(result.rowCount === 0){
        reqx.doHTML("This upload does not exist", 404);
        return;
    }

    const data = result.rows[0];
    const uploadID = data.id;
    const filepath = U.getFilename(uploadID);

    if(data.mimetype === "deleted"){
        reqx.doHTML("This file has been deleted.", 410);
        return;
    }else if(data.mimetype.split("/")[0] === "d"){
        reqx.doHTML("This file has been disabled by the uplaoder. It may be re-enabled in the future.");
        return;
    }else if(data.mimetype === "expired"){
        reqx.doHTML("this file has been automatically deleted.");
        return;
    }

    //Try to get file details
    let stat;
    try{
        stat = fs.statSync(filepath);
    }catch(e){
        reqx.doHTML("Internal error: file may have been manually deleted.", 500);
        serverLog(e);
        return;
    }

    //Do the database call to increment downloads
    let incDL = true;
    //What to do with the content:
    //  inline, attachment (download)
    let codisp = "inline";

    //dl for download
    if(disposition === "dl"){
        codisp = "attachment";
    //thumbnail
    }else if(disposition === "thumb"){
        incDL = false;
    }else{
        //Guess what should be done
        if(shouldInline(stat, data.mimetype)){
            //NOOP
        }else{
            codisp = "attachment";
        }
    }

    //Send filename with content-disposition
    codisp += '; filename="' + data.filename + '"';

    if(incDL){
        U.pool.query({
            text: "UPDATE index SET " +
                "downloads=downloads+1, " +
                "lastdownload=now() " +
                "WHERE id=$1",
            name: "download_increment_downloads",
            values: [uploadID],
        }).catch(err => {
            serverLog("Error when incrementing download. " + uploadID, err);
        });
    }

    reqx.res.writeHead(200, {
        "Content-Type": data.mimetype,
        "Content-Disposition": codisp,
        "Content-Length": stat.size,
        "Cache-Control": "max-age=300",
        "Accept-Ranges": "bytes",
    });

    //Stream file from disk directly
    const stream = fs.createReadStream(filepath);
    stream.pipe(reqx.res);
};

const ipHasAccess = async (ip, uploadID) => {
    const result = await U.pool.query({
        text: "SELECT ip FROM index WHERE keyid=(SELECT keyid FROM index WHERE id=$1) GROUP BY ip ORDER BY max(uploaddate)",
        name: "delete_check",
        values: [uploadID],
    });

    if(result.rowCount === 0){
        return "NOFILE";
    }

    for(let x of result.rows){
        if(U.IPEqual(x.ip, ip)){
            return true;
        }
    }
    return "NOACCESS";
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
        const canDo = await ipHasAccess(reqx.req.connection.remoteAddress, uploadID);
        if(canDo === "NOFILE"){
            reqx.doHTML("That file does not exist", 404);
            return;
        }

        if(canDo === "NOACCESS"){
            reqx.doHTML("You do not have access to delete this file.", 401);
            return;
        }

        setMimeType(uploadID, "deleted").then(result => {
            reqx.doHTML("File successfully deleted. It will still appear in your user page.");
        });
    }else if(disposition === "info"){
        const result = await U.pool.query({
            text: "SELECT mimetype, filename, uploaddate, keyid, downloads, lastdownload, name, index.id " +
            "FROM index INNER JOIN keys ON index.keyid=keys.id WHERE index.id=$1",
            name: "upload_info",
            values: [uploadID],
        });

        const res = reqx.res;
        if(result.rowCount === 0){
            res.writeHead(404, {
                "Content-Type": "text/html"
            });
            res.end("This upload does not exist");
            return;
        }

        const data = result.rows[0];

        res.writeHead(200, {
            "Content-Type": "text/html",
        });
        res.write("Filename: " + data.filename);
        res.write("<br>Uploa date: " + data.uploaddate);
        res.write("<br>Uploaded by: " + data.name);
        res.write("<br>Downloads: " + data.downloads);
        res.write("<br>File Type: " + data.mimetype);
        res.end();
    }else if(disposition === "rename"){
        const [canDo, result] = await Promise.all([
            ipHasAccess(reqx.req.connection.remoteAddress, uploadID),
            U.pool.query({
                text: "SELECT filename FROM index WHERE id=$1 ",
                name: "upload_info",
                values: [uploadID],
            }),
        ]);

        if(canDo === "NOFILE"){
            reqx.doHTML("That file does not exist", 404);
            return;
        }

        if(canDo === "NOACCESS"){
            reqx.doHTML("You do not have access to rename this file.", 401);
            return;
        }

        const data = result.rows[0];

        const oldName = data.filename;
        const newName = decodeURI(reqx.urldata.path[3]);
        const oldFileExt = U.guessFileExtension(oldName);
        const newFileExt = U.guessFileExtension(newName);

        let name = newName;

        if(!newFileExt && oldFileExt){
            name += "." + oldFileExt;
        }

        await U.pool.query({
            text: "UPDATE index SET filename=$2 WHERE id=$1",
            name: "rename_file",
            values: [uploadID, name],
        });

        reqx.res.end(name);
    }else{
        let result = await U.pool.query({
            text: "SELECT mimetype, filename, id FROM index WHERE id=$1",
            name: "download_check_dl",
            values: [uploadID],
        });
        processDownload(reqx, result, disposition);
    }
};

export default async function(server, reqx){
    try{
        await (download(server, reqx));
    }catch(e){
        U.juushError(reqx.res, e, 500);
    }
};
