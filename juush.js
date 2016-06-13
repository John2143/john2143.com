"use strict";

var pg = require("pg"); //postgres
var serverConst = require("./const.js");
var fs = require("fs");

const dbconstr = "pg://" +
	serverConst.dbuser +
	":" + serverConst.dbpass +
	"@" + serverConst.dbhost +
	"/juush";

var dbError = function(err, client, done){
	if(err){
		console.log("FATAL ERROR: DB failure.", err);
		if(client) done();
		return true;
	}
	return false;
};

pg.connect(dbconstr, function(err, client, done){
	console.log("CONNECTING TO DB", err)
	done();
});

var juushError = function(res){
	res.writeHead(500, {
		"Content-Type": "text/html",
	});
	res.end("Internal server error.");
};

var randomStr = function(length = 32){
	const str = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	const ran = function(){
		return Math.floor(Math.random() * str.length);
	};
	var final = "";
	for(var i = 0; i < length; i++){
		final += str[ran() % str.length];
	}
	return final;
};

var isStreamRequest = function(req){
	//You will get a referer and range if you are trying to stream an audio/video
	return req.headers.referer && req.headers.range;
};

var serveStreamRequest = function(reqx, filepath){
	const rangeRequestRegex = /bytes=(\d*)-(\d*)/;
	try{
		//statSync fails if filepath does not exist
		var stat = fs.statSync(filepath);
	}catch(e){
		reqx.res.writeHead(400, {});
		reqx.res.end();
		return;
	}

	var range = rangeRequestRegex.exec(reqx.req.headers.range);
	var fullContentLength = stat.size;
	var rangeStart = Number(range[1]);

	if(range[2] === ""){
		var rangeEnd = fullContentLength - 1;
	}else{
		var rangeEnd = Number(range[2]);
	}

	var contentLength = rangeEnd - rangeStart + 1;

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
		"Content-Length": contentLength,
		"Content-Range": "bytes " + rangeStart + "-" + rangeEnd + "/" + fullContentLength,
	});

	var filePipe = fs.createReadStream(filepath, {start: rangeStart, end: rangeEnd});
	reqx.res.on("error", () => filePipe.end());
	filePipe.pipe(reqx.res);
};

var IPEqual = function(a, b){
	return a.split("/")[0] === b.split("/")[0];
};

var getFilename = function(id){
	return __dirname + "/juushFiles/" + id;
};

var setMimeType = function(client, id, newmime, cb){
	fs.unlink(getFilename(id), function(){});
	client.query({
		text: "UPDATE index SET mimetype=$2 WHERE id=$1",
		name: "delete_file",
		values: [id, newmime],
	}, cb);
};

var shouldInline = function(filedata, mime){
	//const inlineTypes = [
		//"txt", "text", "png", "jpg", "jpeg", "html",
		//"webm", "mp4", "mp3", "wav", "vorbis"
	//];
	//Mimetype is supplied by the user, meaning the subset may not exist
	const regex = /(.+)\/?(.+)?/g;
	var regexResult = regex.exec(mime);
	var category = regexResult[1];
	var subset = regexResult[2];

	return category === "video" || category === "audio" ||
		category === "image" || category === "text";
};

var processDownload = function(reqx, client, err, result, done, uploadID, disposition){
	if(result.rowCount == 0){
		reqx.doHTML("This upload does not exist", 404);
		return done();
	}

	var filepath = getFilename(uploadID);
	var data = result.rows[0];

	if(data.mimetype == "deleted"){
		reqx.doHTML("This file has been deleted.", 404);
		return done();
	}else if(data.mimetype.split("/")[0] == "d"){
		reqx.doHTML("This file has been disabled by the uplaoder. It may be re-enabled in the future.");
		return done();
	}else if(data.mimetype == "expired"){
		reqx.doHTML("this file has been automatically deleted.");
		return done();
	}


	try{
		var stat = fs.statSync(filepath);
	}catch(e){
		reqx.doHTML("Internal error: file may have been manually deleted.", 500);
		return done();
	}


	if(disposition === "dl"){
		var codisp = "attachment";
	}else{
		if(shouldInline(stat, data.mimetype)){
			var codisp = "inline";
		}else{
			var codisp = "attachment";
		}
	}

	codisp += '; filename="' + data.filename + '"';

	client.query({
		text: "UPDATE index SET " +
			"downloads=downloads+1, " +
			"lastdownload=now() " +
			"WHERE id=$1",
		name: "download_increment_downloads",
		values: [uploadID],
	}, function(err, result){
		if(err)
			console.log("Error when incrementing download.", err);
		done();
	});

	reqx.res.writeHead(200, {
		"Content-Type": data.mimetype,
		"Content-Disposition": codisp,
		"Content-Length": stat.size,
		"Accept-Ranges": "bytes",
	});

	var stream = fs.createReadStream(filepath);
	stream.pipe(reqx.res);
};

var juushUploadInfo = function(client, uploadID, cb){
	client.query({
		//TODO only check ip when trying to delete
		text: "SELECT mimetype, filename, uploaddate, keyid, downloads, lastdownload, name " +
		"FROM index INNER JOIN keys ON index.keyid=keys.id WHERE index.id=$1",
		name: "upload_info",
		values: [uploadID],
	}, cb);
};

var processInfoReq = function(res, result){
	if(result.rowCount === 0){
		res.writeHead(404, {
			"Content-Type": "text/html"
		});
		res.end("This upload does not exist");
		return;
	}

	var data = result.rows[0];

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

var juushDownload = function(server, reqx){
	var uploadID = reqx.urldata.path[1];
	if(!uploadID || uploadID === "") return juushError(reqx.res);
	//ignore extension
	uploadID = uploadID.split(".")[0];

	var disposition = reqx.urldata.path[2];

	if(isStreamRequest(reqx.req)){
		return serveStreamRequest(reqx, getFilename(uploadID));
	};

	pg.connect(dbconstr, function(err, client, done){
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

				var data = result.rows[0];

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

var getDatabaseConnectionAndURL = function(callback){
	pg.connect(dbconstr, function(err, client, done){
		if(dbError(err, client, done)) return callback(true);

		var newURL = function(){return randomStr(5)};
		var urlExists = function(url){
			client.query({
				text: "SELECT 1 FROM index WHERE id=$1",
				name: "check_dl",
				values: [url],
			}, function(err, result){
				if(dbError(err, client, done)) return callback(true);
				if(result.rowCount == 0){
					callback(false, url, client, done);
				}else{
					return urlExists(newURL());
				}
			});
		};
		urlExists(newURL());
	});
};

var parseHeadersFromUpload = function(data, reqHeaders){
	data = data.toString("utf8");
	try{
		var headers = /[\s\S]+?\r\n\r\n/.exec(data)[0];
		var key = /name="([A-Za-z0-9]+)"/.exec(headers)[1];
		var filename = /filename="([^"]+)"/.exec(headers)[1];
		var mimetype = /Content\-Type: (.+)\r/.exec(headers)[1];
		var boundary = "--" + /boundary=(\S+)/.exec(reqHeaders["content-type"])[1] + "--";
		boundary = Buffer.from(boundary, "utf8");
	}catch(e){
		console.log("invalid headers received", e);
		// console.log("DATA START");
		// console.log(data);
		// console.log("DATA END");
		return null;
	}

	return {
		key,
		filename,
		mimetype,
		boundary,
		headerSize: headers.length,
	};
};

//TODO
//The exucution order could in theory be changed to connect to the database only
//  after the connection is established by not waiting for the client and such

var juushUpload = function(server, reqx){
	getDatabaseConnectionAndURL(function(err, url, client, done){
		if(err) return true;
		console.log("File will appear at " + url);

		let timeoutID;
		let fTimeout = function(){
			clearTimeout(timeoutID);
			timeoutID = setTimeout(function(){error("Timeout error")}, 20000);
			//console.log("added timeout", timeoutID);
		};

		let filepath = getFilename(url);
		let wstream = fs.createWriteStream(filepath, {
			flags: "w",
			encoding: "binary",
		});

		let isError = false;
		let error = function(errt = "Generic error", errc = 400){
			console.log("Upload error for " + url, ":", errt);
			isError = true;
			clearTimeout(timeoutID);
			if(!wstream.finished) wstream.end();
			if(!reqx.res.finished){
				reqx.res.writeHead(errc, {});
				reqx.res.end(errt);
			}
			fs.unlink(filepath, function(){});
			client.query({
				text: "DELETE FROM index WHERE id=$1",
				name: "upload_download_error_remove_entry",
				values: [url],
			}, function(err, result){
				//if(dbError(err, client, done)) return error();
			});
			done();
		};


		wstream.addListener("error", function(){
			error("Writestream failed (server error)");
		});

		wstream.on("finish", function(){
			if(isError) return;
			//console.log("done, timeout", timeoutID);
			//TODO move to req end?
			reqx.res.end("http://john2143.com/f/" + url);
			done();
		});

		let headersReceived = false;
		let headers = false;

		fTimeout();
		reqx.req.on("data", function(data){
			//This whole function sucks
			if(isError) return;
			fTimeout();

			let write = data;
			let headers;
			if(!headers){
				headers = parseHeadersFromUpload(data, reqx.req.headers);
				if(!headers){
					return error("Invalid headers");
				}

				let write = Buffer.allocUnsafe(data.length - (headers.headerSize));
				data.copy(write, 0, (headers.headerSize));

				client.query({
					text: "SELECT id FROM keys WHERE key=$1",
					name: "upload_check_key",
					values: [headers.key],
				}, function(err, result){
					if(dbError(err, client, done)) return error();
					if(result.rowCount == 0){
						error("You must supply a valid key in order to upload.");
					}else{
						client.query({
							text: "INSERT INTO index(id, uploaddate, ip, filename, mimetype, keyid)" +
								"VALUES($1, now(), $2, $3, $4, $5)",
							name: "upload_insert_download",
							values: [url, reqx.req.connection.remoteAddress, headers.filename, headers.mimetype, result.rows[0].id],
						}, function(err, result){
							if(dbError(err, client, done)) return error();
						});
					}
				});
			}

			let boundary = headers.boundary;
			let lenw = write.length;
			let lenm = boundary.length;
			let diff = lenw - lenm;
			let slice = true;
			for(let i = 0; i < lenm; i++){
				if(write[diff + i] != boundary[i]){
					slice = false;
					break;
				}
			}
			if(slice){
				let write2 = Buffer.allocUnsafe(diff);
				write.copy(write2, 0, 0, diff)
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

var juushNewUser = function(server, reqx){
	var {res, urldata, req} = reqx;
	if(req.connection.remoteAddress.indexOf("192.168") >= 0 || req.connection.remoteAddress === "127.0.0.1"){
		pg.connect(dbconstr, function(err, client, done){
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

var juushUserPage = function(server, reqx){
	var {res, urldata, req} = reqx;
	var page = urldata.path[1];
	var userIP = req.connection.remoteAddress;
	pg.connect(dbconstr, function(err, client, done){
		if(dbError(err, client, done)) return juushError(res);
		client.query({
			text: "SELECT * FROM keys WHERE $1 = ANY (ips)",
			name: "is_active_user",
			values: [userIP],
		}, function(err, result){
			if(dbError(err, client, done)) return juushError(res);
			res.writeHead(200, {
				"Content-Type": "text/html"
			});
			res.end(newKey);
		});
	});
};

var juushAPI = function(server, reqx){
	var {res, urldata, req} = reqx;
	if(urldata.path[1] == "db"){
		pg.connect(dbconstr, function(err, client, done){
			if(dbError(err, client, done)) return juushError(res);
			//Usage:
			// john2143.com/juush/db/uploads/<userid>/[page]
			if(urldata.path[2] == "uploads"){
				client.query({
					text: "SELECT id, filename, mimetype, downloads FROM index WHERE keyid = $1 LIMIT 50 OFFSET $2",
					name: "api_get_uploads",
					values: [urldata.path[3], (urldata.path[4] || 0) * 50],
				}, function(err, result){
					if(dbError(err, client, done)) return juushError(res);
					res.writeHead(200, {
						"Content-Type": "text/html"
					});
					res.end(JSON.stringify(result.rows));
					done();
				});
			}else{
				done();
			}
		});
	}
};

module.exports = {
	API: juushAPI,
	download: juushDownload,
	upload: juushUpload,
	newUser: juushNewUser,
	userPage: juushUserPage,
}
