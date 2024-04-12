
import * as U from "./util.js";

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
        let boundary = "\r\n--" + /boundary=(\S+)/.exec(reqHeaders["content-type"])[1] + "--\r\n";
        boundary = Buffer.from(boundary, "utf8");

        const headers  = /[\s\S]+?\r\n\r\n/     .exec(strData)[0];
        const key      = /name="([A-Za-z0-9]+)"/.exec(headers)[1];
        const filename = /filename="([^"]+)"/   .exec(headers)[1];
        const mimetype = /Content-Type: (.+)\r/.exec(headers)[1];

        return {
            key,
            filename,
            mimetype,
            boundary,
            headerSize: headers.length,
        };
    }catch(e){
        return null;
    }

};

//TODO
//The exucution order could in theory be changed to connect to the database only
//  after the connection is established by not waiting for the client and such

export default async function(server, reqx){
    const url = await getURL();

    //Any connection will timeout after 30 seconds of inactivity.
    let timeoutID = null;

    //Refresh timer
    const fTimeout = () => {
        clearTimeout(timeoutID);
        timeoutID = setTimeout(() => error("Timeout error"), 20000);
        //serverLog("added timeout", timeoutID);
    };

    const filepath = U.getFilename(url);
    const wstream = fs.createWriteStream(filepath, {
        flags: "w",
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
    const error = function(errt = "Generic error", errc = 500){
        reqx.extraLog = url.green;
        returnPromise.resolve();

        serverLog("Upload error for " + url.green, ":", errt.red);

        //Flag error to prevent some kind of data race
        isError = true;
        clearTimeout(timeoutID);

        if(!wstream.finished) wstream.end();
        if(!reqx.res.finished){
            reqx.res.writeHead(errc, {});
            reqx.res.end(errt);
        }

        //Delete file
        fs.unlinkAsync(filepath).catch(err => {
            serverLog("Failed to unlink upload!", err);
        });

        //Delete entry (May or may not exist)
        U.query.index.removeOne({_id: url}).catch(err => {
            serverLog("Upload failure delete failure!", err);
        });
    };

    const errorCatch = (err) => error(err);

    wstream.on("error", function(err){
        error("Writestream failed (server error): " + err, 500);
    });

    let customURL;

    //File is ready to be downloaded
    wstream.on("finish", async function(){
        if(isError) return;
        if(!headers) return error("Bad headers", 400);

        //Try to guess a file extension (for posting to reddit and stuff)
        let fileExtension = U.guessFileExtension(headers.filename);

        await returnPromise.promise;
        if(!customURL) return error("no url to give ??? (probably internal error");

        //Construct return link
        let path;
        path = server.isHTTPS ? "https" : "http";
        path += "://";
        path += customURL;
        path += "/f/";
        path += url;

        if(fileExtension) path += "." + fileExtension;

        reqx.res.end(path);
    });

    //Arbirary
    const maxHeaderBufferSize = 32000;
    let headerBuffer = null;

    reqx.req.on("error", function(){
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

            //Check the uploaders key (Sharex passes this as 'name="xxxx"')
            const ip = reqx.req.headers["x-real-ip"];
            U.query.keys.findOne({key: headers.key}).then(item => {
                if(!item) {
                    error("You must supply a valid key in order to upload.");
                    return;
                }

                reqx.extraLog = url.green + " " + String(item.name).blue;
                returnPromise.resolve();

                customURL = item.customURL || "john2143.com";

                let modifiers = {};
                if(item.autohide){
                    modifiers.hidden = true;
                }

                return U.query.index.insert({
                    _id: url, uploaddate: new Date(), ip,
                    filename: headers.filename || "upload.bin",
                    mimetype: headers.mimetype || "application/octet-stream",
                    keyid: item._id,
                    modifiers,
                    downloads: 0,
                });
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

        if(slice){
            //Only write the portion of the buffer
            let write2 = Buffer.allocUnsafe(diff);
            write.copy(write2, 0, 0, diff);
            wstream.write(write2);
        }else{
            wstream.write(write);
        }

    });

    return returnPromise.promise;
}
