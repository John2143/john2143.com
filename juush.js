"use strict";

const pg = require("pg");
const Pool = pg.Pool;
const serverConst = require("./const.js");
const fs = require("fs");

//This function is run after every query to make sure the request was
//successful. If it was not, it returns true and destroys the client
const dbError = function(err, client, done){
    if(err){
        console.log("FATAL ERROR: DB failure.", err);
        if(client) done(true);
        return true;
    }
    return false;
};

//Setup postgres pool
const pool = new Pool({
    user: serverConst.dbuser,
    password: serverConst.dbpass,
    host: serverConst.dbhost,
    database: "juush",
    max: 20,
    idleTimeoutMillis: 500,
});

pool.on("error", function(err, client){
    console.log("Error in client", err);
});

//This works with dbError to end a broken session
const juushError = function(res){
    res.writeHead(500, {
        "Content-Type": "text/html",
    });
    res.end("Internal server error.");
    console.log("JuushError!");
};

//This is used to create a random string as an ID
const randomStr = function(length = 32){
    const charSet = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    //Random index from charset
    const ran = () => Math.floor(Math.random() * charSet.length);
    let str = "";
    for(let i = 0; i < length; i++){
        str += charSet[ran() % charSet.length];
    }
    return str;
};

//You will get a referer and range if you are trying to stream an audio/video
const isStreamRequest = req => req.headers.referer && req.headers.range;

//This will serve a stream request. It does no kind of validation to see
//if the user can actually access that content.
const serveStreamRequest = function(reqx, filepath){
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

const IPEqual = (a, b) => a.split("/")[0] === b.split("/")[0];
const getFilename = id => __dirname + "/juushFiles/" + id;

const setMimeType = function(client, id, newmime, cb){
    fs.unlink(getFilename(id), function(){});
    client.query({
        text: "UPDATE index SET mimetype=$2 WHERE id=$1",
        name: "delete_file",
        values: [id, newmime],
    }, cb);
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

const processDownload = function(reqx, client, err, result, done, uploadID, disposition){
    if(result.rowCount === 0){
        reqx.doHTML("This upload does not exist", 404);
        return done();
    }

    const filepath = getFilename(uploadID);
    const data = result.rows[0];

    if(data.mimetype === "deleted"){
        reqx.doHTML("This file has been deleted.", 404);
        return done();
    }else if(data.mimetype.split("/")[0] === "d"){
        reqx.doHTML("This file has been disabled by the uplaoder. It may be re-enabled in the future.");
        return done();
    }else if(data.mimetype === "expired"){
        reqx.doHTML("this file has been automatically deleted.");
        return done();
    }

    //Try to get file details
    let stat;
    try{
        stat = fs.statSync(filepath);
    }catch(e){
        reqx.doHTML("Internal error: file may have been manually deleted.", 500);
        return done();
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
        client.query({
            text: "UPDATE index SET " +
                "downloads=downloads+1, " +
                "lastdownload=now() " +
                "WHERE id=$1",
            name: "download_increment_downloads",
            values: [uploadID],
        }, function(err, result){
            if(err) console.log("Error when incrementing download. " + uploadID, err);
        });
    }
    done();

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

const juushUploadInfo = function(client, uploadID, cb){
    client.query({
        //TODO only check ip when trying to delete
        text: "SELECT mimetype, filename, uploaddate, keyid, downloads, lastdownload, name " +
        "FROM index INNER JOIN keys ON index.keyid=keys.id WHERE index.id=$1",
        name: "upload_info",
        values: [uploadID],
    }, cb);
};

const processInfoReq = function(res, result){
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
    res.write("<br>Upload date: " + data.uploaddate);
    res.write("<br>Uploaded by: " + data.name);
    res.write("<br>Downloads: " + data.downloads);
    res.write("<br>File Type: " + data.mimetype);
    res.end();
};

const juushDownload = function(server, reqx){
    let uploadID = reqx.urldata.path[1];
    if(!uploadID || uploadID === "") return juushError(reqx.res);
    //ignore extension
    uploadID = uploadID.split(".")[0];

    //What the user wants to do with the file
    const disposition = reqx.urldata.path[2];

    if(isStreamRequest(reqx.req)){
        return serveStreamRequest(reqx, getFilename(uploadID));
    }

    pool.connect(function(err, client, done){
        if(dbError(err, client, done)) return juushError(reqx.res);
        if(disposition === "delete"){
            client.query({
                text: "SELECT ip FROM index WHERE id=$1",
                name: "delete_check_ip",
                values: [uploadID],
            }, function(err, result){
                if(dbError(err, client, done)) return juushError(reqx.res);

                if(result.rowCount === 0){
                    reqx.doHTML("File does not exist", 404);
                    return done();
                }

                const data = result.rows[0];

                //TODO better user system
                if(!IPEqual(data.ip, reqx.req.connection.remoteAddress)){
                    reqx.doHTML("You do not have access to delete this file.", 401);
                    return done();
                }

                setMimeType(client, uploadID, "deleted", function(err, result){
                    if(dbError(err, client, done)) return juushError(reqx.res);
                    reqx.doHTML("File successfully deleted. It will still appear in your user page.");
                });
                done();
            });
        }else if(disposition === "info"){
            juushUploadInfo(client, uploadID, function(err, result){
                if(dbError(err, client, done)) return juushError(reqx.res);
                processInfoReq(reqx.res, result);
            });
            done();
        }else{
            client.query({
                text: "SELECT mimetype, filename FROM index WHERE id=$1",
                name: "download_check_dl",
                values: [uploadID],
            }, function(err, result){
                if(dbError(err, client, done)) return juushError(reqx.res);
                //very no bueno
                processDownload(reqx, client, err, result, done, uploadID, disposition);
            });
        }
    });
};

//Retreives a database client and randomized url that has not been used before
const getDatabaseConnectionAndURL = function(callback){
    pool.connect(function(err, client, done){
        if(dbError(err, client, done)) return callback(true);

        //Each url is random characters
        const newURL = () => randomStr(4);

        const urlExists = url => {
            client.query({
                text: "SELECT 1 FROM index WHERE id=$1",
                name: "check_dl",
                values: [url],
            }, function(err, result){
                if(dbError(err, client, done)) return callback(true);
                if(result.rowCount === 0){
                    callback(false, url, client, done);
                }else{
                    return urlExists(newURL());
                }
            });
        };

        //Loop through urls until we find a new one
        urlExists(newURL());
    });
};

const parseHeadersFromUpload = function(data, reqHeaders){
    const strData = data.toString("utf8");
    try{
        let boundary = "\r\n--" + /boundary=(\S+)/.exec(reqHeaders["content-type"])[1] + "--\r\n";
        boundary = Buffer.from(boundary, "utf8");

        const headers =  /[\s\S]+?\r\n\r\n/     .exec(strData)[0];
        const key =      /name="([A-Za-z0-9]+)"/.exec(headers)[1];
        const filename = /filename="([^"]+)"/   .exec(headers)[1];
        const mimetype = /Content\-Type: (.+)\r/.exec(headers)[1];

        return {
            key,
            filename,
            mimetype,
            boundary,
            headerSize: headers.length,
        };
    }catch(e){
        //console.log("==============================================start");
        //console.log("==============================================start");
        //console.log("==============================================start");
        //console.log("invalid headers received", e);
        //console.log("==============================================DATA START");
        //console.log(strData);
        //console.log("==============================================DATA END;BOUNDARY START");
        //console.log(boundary);
        //console.log("==============================================BOUNDARY END;reqHeaders START");
        //console.log(reqHeaders);
        //console.log("==============================================finish");
        //console.log("==============================================finish");
        //console.log("==============================================finish");
        return null;
    }

};

//TODO
//The exucution order could in theory be changed to connect to the database only
//  after the connection is established by not waiting for the client and such

var juushUpload = function(server, reqx){
    getDatabaseConnectionAndURL(function(err, url, client, done){
        if(err) return true;
        console.log("File will appear at " + url);

        //Any connection will timeout after 30 seconds of inactivity.
        let timeoutID = null;

        //Refresh timer
        const fTimeout = () => {
            clearTimeout(timeoutID);
            timeoutID = setTimeout(() => error("Timeout error"), 20000);
            //console.log("added timeout", timeoutID);
        };

        const filepath = getFilename(url);
        const wstream = fs.createWriteStream(filepath, {
            flags: "w",
            encoding: "binary",
        });

        //Genertic error function to safely abort a broken connection
        let isError = false;
        const error = function(errt = "Generic error", errc = 500){
            console.log("Upload error for " + url, ":", errt);

            //Flag error to prevent some kind of data race
            isError = true;
            clearTimeout(timeoutID);

            if(!wstream.finished) wstream.end();
            if(!reqx.res.finished){
                reqx.res.writeHead(errc, {});
                reqx.res.end(errt);
            }

            //Delete file
            fs.unlink(filepath, function(){});
            //Delete entry (May or may not exist)
            pool.query({
                text: "DELETE FROM index WHERE id=$1",
                name: "upload_download_error_remove_entry",
                values: [url],
            }, function(err, result){
                if(dbError(err, client, done)){
                    console.log("Upload failure delete failure!");
                }
            });
        };

        wstream.addListener("error", function(err){
            error("Writestream failed (server error): " + err, 500);
        });

        //This is used to store the headers sent by the client
        let headers = null;

        wstream.on("finish", function(){
            if(isError) return;

            //Try to guess a file extension (for posting to reddit and stuff)
            let fileExtension = null;
            try{
                fileExtension = headers.filename.split(".");
                fileExtension = fileExtension[fileExtension.length - 1];
                if(fileExtension.length > 8) throw "";
            }catch(e){
                fileExtension = null;
            }

            //Construct return link
            let path = server.isHTTPS ? "https" : "http";
            path += "://john2143.com/f/";
            path += url;
            if(fileExtension) path += "." + fileExtension;

            reqx.res.end(path);
        });

        //Arbirary
        const maxHeaderBufferSize = 32000;
        let headerBuffer = "";

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
                headerBuffer += data;
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

                //At this point the headers will be complete and in the headers
                //object
                //headerSize will include the \r\n\r\n so anything not headers
                //will be file data
                //
                //We dont want to write the header to file, so copy everything
                //after header to file
                write = Buffer.allocUnsafe(headerBuffer.length - headers.headerSize);
                for(let i = headers.headerSize; i < headerBuffer.length; i++){
                    write[i - headers.headerSize] = headerBuffer.charCodeAt(i);
                }
                //console.log(headers, write);

                //Check the uploaders key (Sharex passes this as 'name="xxxx"')
                client.query({
                    text: "SELECT id FROM keys WHERE key=$1",
                    name: "upload_check_key",
                    values: [headers.key],
                }, function(err, result){
                    if(dbError(err, client, done)) return error();
                    if(result.rowCount === 0){
                        error("You must supply a valid key in order to upload.");
                    }else{
                        //Add info to database now, no reason to wait
                        client.query({
                            text: "INSERT INTO index(id, uploaddate, ip, filename, mimetype, keyid)" +
                                  "VALUES($1, now(), $2, $3, $4, $5)",
                            name: "upload_insert_download",
                            values: [url, reqx.req.connection.remoteAddress, headers.filename, headers.mimetype, result.rows[0].id],
                        }, function(err, result){
                            if(dbError(err, client, done)) return error();
                        });
                    }

                    done();
                });
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

            if(slice){
                //Only write the portion of the buffer
                let write2 = Buffer.allocUnsafe(diff);
                write.copy(write2, 0, 0, diff);
                wstream.write(write2);
            }else{
                wstream.write(write);
            }
        });

        reqx.req.on("error", function(){
            error("Upload error.");
        });

        reqx.req.on("end", function(){
            if(isError) return;
            clearTimeout(timeoutID);
            wstream.end();
        });
    });
};

//Create new user
const juushNewUser = function(server, reqx){
    const {res, urldata, req} = reqx;
    //Only people on the same network as the server can create users
    if(req.connection.remoteAddress.indexOf("192.168") >= 0 ||
       req.connection.remoteAddress === "127.0.0.1"
    ){
        pool.connect(function(err, client, done){
            if(dbError(err, client, done)) return;
            var newKey = randomStr(32);
            client.query({
                text: "INSERT INTO keys(name, key) VALUES ($1, $2)",
                name: "new_user",
                values: [reqx.urldata.path[1], newKey],
            }, function(err, result){
                if(dbError(err, client, done)) return;
                res.writeHead(200, {
                    "Content-Type": "text/html"
                });
                res.end(newKey);
            });
        });
    }else{
        res.writeHead(401, {
            "Content-Type": "text/html"
        });
        res.end("You cannot make users");
    }
};

const juushAPI = function(server, reqx){
    const {res, urldata, req} = reqx;
    if(urldata.path[1] === "db"){
        //Mabye verify the request first? otherwise they could just spin up db
        //instances
        pool.connect(function(err, client, done){
            if(dbError(err, client, done)) return juushError(res);
            // /juush/db/uploads/<userid>/[page]/
            // lists some number of uploads from a user, with an optional offset
            if(urldata.path[2] === "uploads"){
                const perPage = 25;
                client.query({
                    text: "SELECT id, filename, mimetype, downloads, uploaddate " +
                          "FROM index WHERE keyid = $1 ORDER BY uploaddate " +
                          "DESC LIMIT $3 OFFSET $2",
                    name: "api_get_uploads",
                    values: [urldata.path[3], (urldata.path[4] || 0) * perPage, perPage],
                }, function(err, result){
                    if(dbError(err, client, done)) return juushError(res);
                    res.end(JSON.stringify(result.rows));
                });
            // /juush/db/users/
            // Return all juush users
            }else if(urldata.path[2] === "users"){
                client.query({
                    text: "SELECT id, name FROM keys;",
                    name: "api_get_uers",
                }, function(err, result){
                    if(dbError(err, client, done)) return juushError(res);
                    res.end(JSON.stringify(result.rows));
                });
            // /juush/db/userinfo/<userid>
            // Give info about a user.
            }else if(urldata.path[2] === "userinfo"){
                let ret = {};
                let rtot = -2;

                const sendResult = () => res.end(JSON.stringify(ret));
                const sendNone = () => res.end("{}");

                client.query({
                    text: "SELECT name FROM keys WHERE id = $1;",
                    name: "api_get_info1",
                    values: [urldata.path[3]],
                }, function(err, result){
                    if(dbError(err, client, done)) return juushError(res);
                    if(!result.rows[0]) return sendNone();
                    ret.name = result.rows[0].name;
                    if(!++rtot) sendResult();
                });
                client.query({
                    text: "SELECT SUM(downloads), COUNT(*) FROM index WHERE keyid = $1;",
                    name: "api_get_info2",
                    values: [urldata.path[3]],
                }, function(err, result){
                    if(dbError(err, client, done)) return juushError(res);
                    let r = result.rows[0];
                    if(!r) return sendNone();
                    ret.downloads = r.sum;
                    ret.total = r.count;
                    if(!++rtot) sendResult();
                });
            }else{
                res.end("Unknown endpoint");
            }
            done();
        });
    }else{
        res.end("Unknown method");
    }
};

module.exports = {
    API: juushAPI,
    download: juushDownload,
    upload: juushUpload,
    newUser: juushNewUser,
};
