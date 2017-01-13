
const U = require("./util.js");
const fs = require("fs");
//
//Retreives a database client and randomized url that has not been used before
const getDatabaseConnectionAndURL = function(callback){
    U.pool.connect(function(err, client, done){
        if(U.dbError(err, client, done)) return callback(true);

        //Each url is random characters
        const newURL = () => U.randomStr(4);

        const urlExists = url => {
            client.query({
                text: "SELECT 1 FROM index WHERE id=$1",
                name: "check_dl",
                values: [url],
            }, function(err, result){
                if(U.dbError(err, client, done)) return callback(true);
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

module.exports = function(server, reqx){
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

        const filepath = U.getFilename(url);
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
            U.pool.query({
                text: "DELETE FROM index WHERE id=$1",
                name: "upload_download_error_remove_entry",
                values: [url],
            }, function(err, result){
                if(U.dbError(err, client, done)){
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
            let fileExtension = U.guessFileExtension(headers.filename);

            //Construct return link
            let path = server.isHTTPS ? "https" : "http";
            if(server.ip === "localhost"){
                path += "://localhost:" + server.port + "/f/";
            }else{
                path += "://john2143.com/f/";
            }
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
                    if(U.dbError(err, client, done)) return error();
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
                            if(U.dbError(err, client, done)) return error();
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
