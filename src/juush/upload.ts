
import * as U from "./util.js";
import fs from "node:fs/promises";
import { PutObjectCommand, UploadPartCommand, CreateMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommandOutput, AbortMultipartUploadCommand, UploadPartCommandOutput } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { error } from "node:console";

//Retreives a database client and randomized url that has not been used before
const getURL = async function(){
    try{
        for(let x = 1; ; x++){
            let url = U.randomStr(4);
            const result = await U.query.index.findOne({_id: url});

            if(!result){
                if(x > 5) serverLog(`took ${x} tries to get a url...`.red);
                return url;
            }
        }
    }catch(e){
        serverLog("Error when obtaining new url" + e);
        return null;
    }
};

const parseHeadersFromUpload = function(data, reqHeaders){
    const strData = data.toString("utf8");
    try{
        // reqHeaders = {
        // {
        //     host: '2143.me',
        //     'x-forwarded-for': '123.213.111.222',
        //     connection: 'close',
        //     'content-length': '1602',
        //     'user-agent': 'curl/8.9.1',
        //     accept: '*/*',
        //     'content-type': 'multipart/form-data; boundary=------------------------ouBpDMbKKVIyn3W1VXnOhj'
        // }

        let boundary = "\r\n--" + /boundary=(\S+)/.exec(reqHeaders["content-type"])[1] + "--\r\n";
        boundary = Buffer.from(boundary, "utf8");

        const headers  = /[\s\S]+?\r\n\r\n/     .exec(strData)[0];
        const key      = /name="([A-Za-z0-9]+)"/.exec(headers)[1];
        const filename = /filename="([^"]+)"/   .exec(headers)[1];
        const mimetype = /Content\-Type: (.+)\r/.exec(headers)[1];

        return {
            key,
            filename,
            mimetype,
            boundary,
            headerSize: headers.length,
            contentLength: reqHeaders["content-length"],
        };
    }catch(e){
        return null;
    }

};
// 5 mb
const minChunkSize = 1024 * 1024 * 5;
const normalChunkSize = 1024 * 1024 * Number(process.env.S3_CHUNK_SIZE || 15);
const maxChunkSize = 1024 * 1024 * 100;

// Convert bytes to human readable string like 20.0MB, 1.0GB, 100KB
function humanFileSize(size) {
    size = Number(size);
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return (size / Math.pow(1024, i)).toFixed(1) + ["B", "KB", "MB", "GB", "TB"][i];
}

let numTotalConnections = 0;

export async function uploadToS3(url: string, mimeType: string, numTry: number = 0) {
    let s;
    let key = `${process.env.FOLDER}/${url}`;
    try {
        s = await beginS3Upload(key, mimeType);
        await uploadToS3Inner(url, key, mimeType, s);
    } catch (e) {
        console.error(`===Failed to upload to s3=== : ${key} - ${s?.UploadId}`);
        console.error(e["$response"]);
        // abort the upload
        if(s) {
            try {
                console.error(`Trying abort: ${key} - ${s?.UploadId}`);
                await U.s3_client.send(new AbortMultipartUploadCommand({
                    Bucket: process.env.BUCKET,
                    Key: s.Key,
                    UploadId: s.UploadId,
                }));
                console.error(`Done abort: ${key} - ${s?.UploadId}`);
            } catch (e) {
                console.error(`Failed abort: ${key} - ${s?.UploadId}`, e);
            }
        }

        const maxTries = 3;
        if (numTry < maxTries) {
            console.error(`Retrying : ${key} ${numTry + 1}/${maxTries}`);

            try {
                uploadToS3(url, mimeType, numTry + 1);
            } catch (e) {
                console.error(`Failed retry internal stack: ${key} ${numTry + 1}/${maxTries}`);
            }
        } else {
            console.error("====Failed to upload to s3 after 3 tries====");
            await U.query.index.updateOne({_id: url}, {$set: {
                failedCDN: true,
            }});
        }
    }
}

export async function beginS3Upload(key: string, mimeType: string): Promise<CreateMultipartUploadCommandOutput> {
    return await U.s3_client.send(new CreateMultipartUploadCommand({
        Bucket: process.env.BUCKET,
        Key: key,
        ContentType: mimeType,
        ACL: "public-read",
    }));
}

interface UploadPartParams {
    contentLength: number;
    body: any;
    uploadId: string;
    partNumber: number;
}

export async function uploadPart(key: string, partParams: UploadPartParams, numTry: number = 0): Promise<UploadPartCommandOutput>{
    try {
        console.log(`uploading part ${partParams.partNumber}`);
        let uploadCommand = U.s3_client.send(new UploadPartCommand({
            Bucket: process.env.BUCKET,
            Key: key,
            ContentLength: partParams.contentLength,
            Body: partParams.body,
            UploadId: partParams.uploadId,
            PartNumber: partParams.partNumber,
        }));

        //10 second timeout
        const secs = Number(process.env.S3_CHUNK_TIMEOUT || 45);
        let too;
        let timeout = new Promise((resolve, reject) => {
            too = setTimeout(() => {
                console.log(`Timeout: ${partParams.partNumber} on ${key}`);
                resolve("timeout");
            }, secs * 1000);
        });

        // Wait for either to finish
        let res = await Promise.any([uploadCommand, timeout]);
        if (res === "timeout") {
            console.log(`Timeout: ${partParams.partNumber} on ${key}`);
            throw new Error("Timeout");
        }
        clearInterval(too);
        console.log(`Uploaded part ${partParams.partNumber} to ${key}`);
        //console.log(res);
        // Must be the upload command
        return await res;
    } catch (e) {
        console.error(`Failed to upload part ${partParams.partNumber} to ${key}`);
        console.log(e);
        console.log(e["$metadata"]);
        console.error(e["$response"]);

        const maxTries = 3;
        if (numTry < maxTries) {
            //console.error(`Retrying part ${partParams.partNumber} to ${key} try ${numTry + 1}/${maxTries}`);

            try {
                // sleep for a timeout with backoff
                //await new Promise(r => setTimeout(r, 2000));
                return await uploadPart(key, partParams, numTry + 1);
            } catch (e) {
                console.error(`Failed retry internal stack: part ${partParams.partNumber} to ${key} try ${numTry + 1}/${maxTries}`);
            }
        } else {
            console.error(`====Failed to upload part ${partParams.partNumber} to ${key} after ${maxTries} tries====`);
            throw new Error(`Failed to upload part ${partParams.partNumber} to ${key} after ${maxTries} tries`);
        }
    }
}

let pendingQueue = [];

function runNextInQueue() {
    if (pendingQueue.length > 0) {
        console.log(`Running next in queue: ${pendingQueue.length} pending`);
        let next = pendingQueue.shift();
        if (next && typeof next === "function") {
            next();
        }
    }
}

setInterval(() => {
    runNextInQueue();
}, 10_000);

export async function uploadToS3Inner(url: string, key: string, mimeType: string, currentMultipartUpload: CreateMultipartUploadCommandOutput) {
    const filepath = U.getFilename(url);
    let st = await fs.stat(filepath);
    let size = st.size;

    let chunkSize = normalChunkSize;
    let numParts = Math.ceil(size / chunkSize);
    while(numParts > 15){
        chunkSize *= 2;
        numParts = Math.ceil(size / chunkSize);
    }
    console.log(`Starting multipart upload for ${url} with ${numParts} parts. ${numTotalConnections} connections active at start. Chunksize ${humanFileSize(chunkSize)}`);
    let proms = [];

    let currentPart = 1;
    let numLocalConnections = 0;
    let doneParts = Array(numParts).fill(false);
    for(let i = 0; i < size; i += chunkSize) {
        let p = {
            start: i,
            end: Math.min(i + chunkSize, size),
        };
        let currentChunk = createReadStream(filepath, p);
        let contentLength = Math.min(chunkSize, size - i);

        let uc = {
            contentLength,
            body: currentChunk,
            uploadId: currentMultipartUpload.UploadId,
            partNumber: currentPart,
        };

        while(numTotalConnections > 1 && numLocalConnections > 1) {
            await new Promise(r => pendingQueue.push(r));
        }

        //console.log(uc);
        numTotalConnections++;
        numLocalConnections++;
        console.log(`multipart_part for ${url} (nc ${numTotalConnections}): ${currentPart}/${numParts}: ${p.start}-${p.end} (${humanFileSize(contentLength)})`);
        let part = currentPart;
        let res_a = uploadPart(key, uc).then(res => {
            doneParts[part - 1] = true;
            numTotalConnections--;
            numLocalConnections--;
            runNextInQueue();
            return res;
        }).catch(e => {
            numTotalConnections--;
            numLocalConnections--;
            runNextInQueue();
            console.log(`multipart_part_failed for ${url} ${part}/${numParts}`);
            throw e;
        });

        proms.push(async () => {
            let res = await res_a;

            //make a string like (XXXXXXXX.XX..........) consisting of doneParts values
            let doneStr = doneParts.map(d => d ? "X" : ".").join("");
            console.log(`multipart_part_done for ${url}: ${res.ETag} ${part}/${numParts}: ${doneStr}`);
            return {
                ETag: JSON.parse(res.ETag),
                PartNumber: part,
            };
        });

        currentPart++;
    }

    let parts = await Promise.all(proms.map(p => p())).catch(failed => {
        console.error("Failed parts: ", failed);
        for(let p of proms) {
            if(p.abort && typeof p.abort === "function") {
                p.abort();
            }
        }
        // TODO: is this double counting?
        numTotalConnections -= numLocalConnections;
        throw new Error("Failed parts");
    });
    // sleep for 500ms
    await new Promise(r => setTimeout(r, 500));
    // sort into completed and failed
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    //console.log(`Multipart upload for ${url} done`);
    // We are done: finish the upload
    // try up to 3 times:
    let res2;

    console.log(`All parts are done! ${parts.length} parts for ${url}`);
    for(let i = 0; i < 3; i++) {
        try {
            res2 = await U.s3_client.send(new CompleteMultipartUploadCommand({
                Bucket: process.env.BUCKET,
                Key: key,
                UploadId: currentMultipartUpload.UploadId,
                MultipartUpload: {
                    Parts: parts,
                }
            }));
            break;
        } catch (e) {
            if(i == 2) {
                console.error("Failed to complete multipart upload", e);
                throw e;
            }
            //console.error(e["$response"]);
        }
    }
    // res2 => {
    //   '$metadata': {
    //     httpStatusCode: 200,
    //     requestId: 'tx000007c48809e86c8110a-0066fb427c-148abbdc-nyc3d',
    //     extendedRequestId: undefined,
    //     cfId: undefined,
    //     attempts: 1,
    //     totalRetryDelay: 0
    //   },
    //   Bucket: 'imagehost-files',
    //   ETag: '0bb64710e6054c644f1ee581734ca2f4-1',
    //   Key: 'public-prod/YTUS',
    //   Location: 'nyc3.digitaloceanspaces.com/imagehost-files/public-prod/YTUS'
    // }

    // https://nyc3.digitaloceanspaces.com/imagehost-files/dev/ABCD
    let baseLocation = `https://${res2.Location}`;
    // https://imagehost-files.nyc3.cdn.digitaloceanspaces.com/dev/ABCD
    let locationStart = /[^.+]+/.exec(res2.Location)[0];
    let cdn = `https://${res2.Bucket}.${locationStart}.cdn.digitaloceanspaces.com/${key}`;
    U.query.index.updateOne({_id: url}, {$set: {
        cdn,
    }}).then(() => {
        console.log(`Updated CDN link for ${url} to ${cdn}`);
    });
}

//TODO
//The exucution order could in theory be changed to connect to the database only
//  after the connection is established by not waiting for the client and such

export default async function(server, reqx){
    const url = await getURL();

    if(process.env.IS_HOME) {
        // serve permanant redirect to 2143.me
        reqx.res.writeHead(301, {
            "Location": `https://2143.me/uf`,
        });
    }

    //Any connection will timeout after 30 seconds of inactivity.
    let timeoutID = null;

    //Refresh timer
    const fTimeout = () => {
        clearTimeout(timeoutID);
        timeoutID = setTimeout(() => error("Timeout error"), 20000);
        //serverLog("added timeout", timeoutID);
    };

    const filepath = U.getFilename(url) + ".dl";
    let f = await fs.open(filepath, "w");
    const wstream = f.createWriteStream({
        encoding: "binary",
    });

    //This is used to store the headers sent by the client
    let headers = null;

    //Construct a promise in order to properly log the output from uploading
    const returnPromise = {};
    returnPromise.promise = new Promise((resolve, reject) => {
        returnPromise.resolve = resolve;
        returnPromise.reject = reject;
    });

    //Genertic error function to safely abort a broken connection
    let isError = false;
    let hasErrored = false;
    const error = async function(errt = "Generic error", errc = 500){
        if(hasErrored) return;
        hasErrored = true;

        reqx.extraLog = url.green;
        returnPromise.resolve();

        serverLog("Upload error for " + url.green, ":", errt.red);

        //Flag error to prevent some kind of data race
        isError = true;
        clearTimeout(timeoutID);

        if(!wstream.finished) wstream.end();
        if(!reqx.res.finished){
            try{
                reqx.res.writeHead(errc, {});
                reqx.res.end(errt);
            } catch(e){
                // We don't care if the client gets this message, really
            }
        }

        //Delete file
        await fs.unlink(filepath).catch(err => {
            serverLog("Failed to unlink upload!", err);
        });

        //Delete entry (May or may not exist)
        U.query.index.deleteOne({_id: url}).catch(err => {
            serverLog("Upload failure delete failure!", err);
        });
    };

    const errorCatch = (err) => error(err);

    wstream.on("error", function(err){
        error("Writestream failed (server error): " + err, 500);
    });

    let customURL;
    let customURLSettings = null;

    //File is ready to be downloaded
    wstream.on("finish", async function(){
        if(isError) return;
        if(!headers) return error("Bad headers", 400);

        let st = await fs.stat(filepath);
        let size = st.size;
        if (Math.abs(size - (headers.contentLength - headers.headersSize)) > 10) {
            error(`Size mismatch for header Content-Length (${ headers.contentLength }) and body size (${size - headers.headersSize}) is too large (> approx boundary x2)`, 400);
            return;
        }

        //Move the .dl file to the correct location
        await fs.rename(filepath, U.getFilename(url));

        //Try to guess a file extension (for posting to reddit and stuff)
        let fileExtension = U.guessFileExtension(headers.filename);

        await returnPromise.promise;
        if(!customURL) return error("no url to give ??? (probably internal error");

        //Construct return link
        let path;
        path = customURL.includes("localhost") ? "http" : "https";
        path += "://";
        path += customURL;
        if(customURLSettings?.no_f) {
            path += "/";
        } else {
            path += "/f/";
        }
        path += url;

        if(fileExtension) path += "." + fileExtension;

        reqx.res.end(path);

        if(U.s3_client) {
            // async
            await new Promise(r => setTimeout(r, 2000));
            uploadToS3(url, headers.mimetype);
        }
    });

    //Arbirary
    const maxHeaderBufferSize = 32000;
    let headerBuffer = null;

    reqx.req.on("error", function(e){
        error(e);
        error("Upload error.");
    });

    reqx.req.on("end", function(){
        if(isError) return;
        clearTimeout(timeoutID);
        wstream.end();
    });

    fTimeout();
    reqx.req.on("data", function(data){
        //This whole function sucks
        if(isError) return;
        //Restart timeout function
        fTimeout();

        //By default data will be a buffer
        let write = data;

        //Try to construct headers if not completed
        if(!headers){
            if(headerBuffer){
                headerBuffer = Buffer.concat([headerBuffer, data]);
            }else{
                headerBuffer = data;
            }

            headers = parseHeadersFromUpload(headerBuffer, reqx.req.headers);

            //If the headers could not be constructed append them to the
            //buffer and try again next time
            //If the buffer is too long, send error
            if(!headers){
                if(headerBuffer.length + data.length >= maxHeaderBufferSize + 1){
                    return error("Invalid headers");
                }
                return;
            }
            //if(!headers.filename) return error("Header: No filename"         , 400);
            if(!headers.key) return error("Header: No key (form 'name')"     , 400);
            //if(!headers.mimetype) return error("Header: No mime"             , 400);
            if(!headers.boundary) return error("Header: No boundary"         , 400);
            if(!headers.headerSize) return error("Header: No headersize (?)" , 400);

            //At this point the headers will be complete and in the headers
            //object
            //headerSize will include the \r\n\r\n so anything not headers
            //will be file data
            //
            //We dont want to write the header to file, so copy everything
            //after header to file
            write = headerBuffer.slice(headers.headerSize);

            //console.log("Completed header parsing");
            //Check the uploaders key (Sharex passes this as 'name="xxxx"')
            //console.log(headers);
            const ip = reqx.req.headers["x-forwarded-for"];
            U.query.keys.findOne({key: headers.key}).then(item => {
                if(!item) {
                    error("You must supply a valid key in order to upload.");
                    return;
                }

                // headers = {
                //     key: '...',
                //     filename: '2024y-09m-22d_05h-25m-52s_.png',
                //     mimetype: 'image/png',
                //     boundary: <Buffer ...>,
                //     headerSize: 193
                // }
                //console.log(reqx.req.headers);
                reqx.extraLog = url.green + " " + String(item.name).blue + " " + String(humanFileSize(headers.contentLength)).blue;
                returnPromise.resolve();

                if(!item.customURL || item.customURL === "host") {
                    // Set this to the input header host
                    customURL = reqx.req.headers.host;
                } else if(item.customURL === "host-no-f") {
                    customURL = `i.${reqx.req.headers.host}`;
                    customURLSettings = { no_f: true };
                } else if(item.customURL === "host-no-i-f" || item.customURL === "host-no-f-i") {
                    customURL = reqx.req.headers.host;
                    customURLSettings = { no_f: true };
                } else {
                    customURL = item.customURL;
                }

                let modifiers = {};
                if(item.autohide){
                    modifiers.hidden = true;
                }
                // console.log("Attempting to insert new upload into database");
                // console.log(url, item._id, U.query, U.query.index);
                //
                let mongoData = {
                    _id: url, uploaddate: new Date(), ip,
                    filename: headers.filename || "upload.bin",
                    mimetype: headers.mimetype || "application/octet-stream",
                    keyid: item._id,
                    modifiers,
                    downloads: 0,
                };

                return Promise.allSettled([U.query.index.insertOne(mongoData)]);
            }).catch(errorCatch);
        }

        //Boundry is always at the end of the data file
        let boundary = headers.boundary;
        let lenw = write.length;
        let lenm = boundary.length;
        //The length of the data segment will either be this length (diff)
        //or lenw
        let diff = lenw - lenm;
        //If slice is true then it means the boundry was found at the end
        //of the data segment, else all the data should be written
        let slice = true;
        for(let i = 0; i < lenm; i++){
            //Compare the data to the boundry char by char
            if(write[diff + i] != boundary[i]){
                slice = false;
                break;
            }
        }

        let curData = write;
        let curDataLen = 0;
        if(slice){
            //Only write the portion of the buffer up to the boundary
            let write2 = Buffer.allocUnsafe(diff);
            write.copy(write2, 0, 0, diff);

            curData = write2;
            curDataLen = diff;
        }else{
            curData = write;
            curDataLen = lenw;
        }
        wstream.write(curData);

        if (slice) {
            wstream.end();
        }
    });

    return returnPromise.promise;
}
