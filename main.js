//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite

//import
var server = require("./server.js");
var serverConst = require("./const.js");
var fs = require("fs");
var pg = require("pg"); //postgres

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

var showIP = function(server, res){
	server.getExtIP(function(ip){
		server.doHTML(res, ip);
	});
};

var juushError = function(res){
	res.writeHead(500, {
		"Content-Type": "text/html",
	});
	res.end("Internal server error.");
};

var randomStr = function(length){
	var str = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	var ran = function(){
		return Math.floor(Math.random() * str.length);
	};
	var final = "";
	for(var i = 0; i < (length || 32); i++){
		final += str[ran() % str.length];
	}
	return final;
};

/* DATABASE INFO
juush=> \d keys
Table "public.keys"
Column |         Type          |                     Modifiers
-------+-----------------------+---------------------------------------------------
id     | integer               | not null default nextval('keys_id_seq'::regclass)
key    | character(32)         |
name   | character varying(32) |
Indexes:
	"keys_pkey" PRIMARY KEY, btree (id)
Referenced by:
	TABLE "index" CONSTRAINT "index_keyid_fkey" FOREIGN KEY (keyid) REFERENCES keys(id)

juush=> \d index
				Table "public.index"
   Column    |            Type             |     Modifiers
 ------------+-----------------------------+--------------------
id           | character varying(8)        | not null
uploaddate   | timestamp without time zone |
ip           | cidr                        |
filename     | character varying(64)       |
mimetype     | character varying(127)      |
keyid        | integer                     |
downloads    | integer                     | not null default 0
lastdownload | timestamp without time zone |

Indexes:
	"index_pkey" PRIMARY KEY, btree (id)
Foreign-key constraints:
	"index_keyid_fkey" FOREIGN KEY (keyid) REFERENCES keys(id)
*/

var isStreamRequest = function(req){
	//You will get a referer and range if you are trying to stream an audio/video
	return req.headers.referer && req.headers.range;
};

var serveStreamRequest = function(res, req, filepath){
	const rangeRequestRegex = /bytes=(\d*)-(\d*)/;
	try{
		//statSync fails if filepath does not exist
		var stat = fs.statSync(filepath);
	}catch(e){
		res.writeHead(400, {});
		res.end();
		return;
	}

	var range = rangeRequestRegex.exec(req.headers.range);
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
		res.writeHead(416, {}); //Cannot deliver range
		res.end();
		return;
	}

	res.writeHead(206, { //Partial content
		//Ignoring Content-Type to not need a db request
		"Content-Length": contentLength,
		"Content-Range": "bytes " + rangeStart + "-" + rangeEnd + "/" + fullContentLength,
	});

	var filePipe = fs.createReadStream(filepath, {start: rangeStart, end: rangeEnd});
	res.on("error", function(){filePipe.end();});
	filePipe.pipe(res);
}

var IPEqual = function(a, b){
	return a.split("/")[0] === b.split("/")[0];
}

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
	const regex = /(.+)\/(.+)/g;
	var regexResult = regex.exec(mime);
	var category = regexResult[1];
	var subset = regexResult[2];

	return category === "video" || category === "audio" ||
		category === "image" || category === "text";
};

var processDownload = function(req, res, client, err, result, done, uploadID, disposition){
	if(result.rowCount == 0){
		res.writeHead(404, {
			"Content-Type": "text/html"
		});
		res.end("This upload does not exist");
		return done();
	}

	var filepath = getFilename(uploadID);
	var data = result.rows[0];

	if(data.mimetype == "deleted"){
		done();
		res.writeHead(404, {
			"Content-Type": "text/html"
		});
		res.end("This file has been deleted.");
		return done();
	}else if(data.mimetype.split("/")[0] == "d"){
		done();
		res.writeHead(200, {
			"Content-Type": "text/html"
		});
		res.end("This file has been disabled by the uplaoder. It may be re-enabled in the future.");
		return done();
	}else if(data.mimetype == "expired"){
		res.writeHead(200, {
			"Content-Type": "text/html"
		});
		res.end("this file has been automatically deleted.");
		return done();
	}


	try{
		var stat = fs.statSync(filepath);
	}catch(e){
		res.writeHead(500, {
			"Content-Type": "text/html"
		});
		res.end("Internal error: file may have been manually deleted.");
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

	res.writeHead(200, {
		"Content-Type": data.mimetype,
		"Content-Disposition": codisp,
		"Content-Length": stat.size,
		"Accept-Ranges": "bytes",
	});

	var stream = fs.createReadStream(filepath);
	stream.pipe(res);
};

var getFilename = function(id){
	return __dirname + "/juushFiles/" + id;
};

pg.connect(dbconstr, function(err, client, done){
	console.log("CONNECTING TO DB", err)
	done();
});

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

var juushDownload = function(server, res, urldata, req){
	var uploadID = urldata.path[1];
	uploadID = uploadID.split(".")[0];
	var disposition = urldata.path[2];

	if(isStreamRequest(req)){
		return serveStreamRequest(res, req, getFilename(uploadID));
	};

	pg.connect(dbconstr, function(err, client, done){
		if(dbError(err, client, done)) return juushError(res);
		if(disposition === "delete"){
			client.query({
				text: "SELECT ip FROM index WHERE id=$1",
				name: "delete_check_ip",
				values: [uploadID],
			}, function(err, result){
				if(dbError(err, client, done)) return juushError(res);

				if(result.rowCount === 0){
					res.writeHead(404, {
						"Content-Type": "text/html"
					});
					res.end("File does not exist");
					return done();
				}

				var data = result.rows[0];

				if(!IPEqual(data.ip, req.connection.remoteAddress)){
					res.writeHead(401, {
						"Content-Type": "text/html"
					});
					res.end("You do not have access to delete this file.");
					return done();
				}

				setMimeType(client, uploadID, "deleted", function(err, result){
					if(dbError(err, client, done)) return juushError(res);
					res.writeHead(200, {
						"Content-Type": "text/html"
					});
					res.end("File successfully deleted. It will still appear in your user page.");
				});
				done();
			});
		}else if(disposition === "info"){
			juushUploadInfo(client, uploadID, function(err, result){
				if(dbError(err, client, done)) return juushError(res);
				processInfoReq(res, result);
			});
			done();
		}else{
			client.query({
				text: "SELECT mimetype, filename FROM index WHERE id=$1",
				name: "download_check_dl",
				values: [uploadID],
			}, function(err, result){
				if(dbError(err, client, done)) return juushError(res);
				processDownload(req, res, client, err, result, done, uploadID, disposition);
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

var parseHeadersFromUpload = function(data){
	var headers = /[\s\S]+?\r\n\r\n/.exec(data)[0];

	try{
		var key = /name="([A-Za-z0-9]+)"/.exec(headers)[1];
		var filename = /filename="([^"]+)"/.exec(headers)[1];
		var mimetype = /Content\-Type: (.+)\r/.exec(headers)[1];
	}catch(e){
		console.log("invalid headers received", e);
		return null;
	}
	//console.log(headers);

	return {
		key: key,
		filename: filename,
		mimetype: mimetype,
		headerSize: headers.length,
	};
};

//This appears at the end of every post request with 22x being a hex hash
const match = new Buffer("\r\n----------------------xxxxxxxxxxxxxxx--\r\n");

//TODO
//The exucution order could in theory be changed to connect to the database only
//  after the connection is established by not waiting for the client and such

var juushUpload = function(server, res, urldata, req){
	getDatabaseConnectionAndURL(function(err, url, client, done){
		if(err) return true;
		console.log("File will appear at " + url);

		var timeoutID;
		var fTimeout = function(){
			if(timeoutID){
				//console.log("timout remvoed", timeoutID);
				clearTimeout(timeoutID);
			}
			timeoutID = setTimeout(error, 20000);
			//console.log("added timeout", timeoutID);
		};

		var filepath = getFilename(url);
		var wstream = fs.createWriteStream(filepath, {
			flags: "w",
			encoding: "binary",
		});

		var isError = false;
		var error = function(){
			console.log("Upload error for " + url);
			isError = true;
			if(!wstream.finished) wstream.end();
			if(!res.finished) res.end();
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

		var errorServe = function(){
			res.writeHead(500, {
				"Content-Type": "text/html"
			});
			res.end("Internal server error.");
		};

		wstream.addListener("error", function(){
			error();
			errorServe();
		});

		wstream.on("finish", function(){
			if(isError) return;
			clearTimeout(timeoutID);
			//console.log("done, timeout", timeoutID);
			//TODO move to req end?
			res.end("http://john2143.com/f/" + url);
			done();
		});

		var headersReceived = false;

		fTimeout();
		req.on("data", function(data){
			//This whole function sucks
			if(isError) return;
			fTimeout();

			var write = data;
			if(!headersReceived){
				headersReceived = true;

				var headers = parseHeadersFromUpload(data);

				if(!headers){
					return error(); //Invalid headers
				}

				var write = new Buffer(data.length - (headers.headerSize));
				data.copy(write, 0, (headers.headerSize));

				client.query({
					text: "SELECT id FROM keys WHERE key=$1",
					name: "upload_check_key",
					values: [headers.key],
				}, function(err, result){
					if(dbError(err, client, done)) return error();
					if(result.rowCount == 0){
						done();
						res.writeHead(401, {
							"Content-Type": "text/html"
						});
						res.end("You must supply a valid key in order to upload. Your key may be disabled or invalid.");
						error();
					}else{
						client.query({
							text: "INSERT INTO index(id, uploaddate, ip, filename, mimetype, keyid)" +
								"VALUES($1, now(), $2, $3, $4, $5)",
							name: "upload_insert_download",
							values: [url, req.connection.remoteAddress, headers.filename, headers.mimetype, result.rows[0].id],
						}, function(err, result){
							if(dbError(err, client, done)) return error();
						});
					}
				});
			}

			var lenw = write.length;
			var lenm = match.length;
			var diff = lenw - lenm;
			//0xA = \n, 0xD = \r, 120 == x
			var slice = true;
			for(var i = 0; i < lenm; i++){
				if(match[i] != 120 && write[diff + i] != match[i]){
					slice = false;
					break;
				}
			}
			if(slice){
				var write2 = new Buffer(diff);
				write.copy(write2, 0, 0, diff)
				wstream.write(write2);
			}else{
				wstream.write(write);
			}
		});

		req.on("error", function(){
			error();
			errorServe();
		});

		req.on("end", function(){
			if(isError) return;
			wstream.end();
		});
	});
};

var juushNewUser = function(server, res, urldata, req){
	if(req.connection.remoteAddress.indexOf("192.168") >= 0){
		pg.connect(dbconstr, function(err, client, done){
			if(dbError(err, client, done)) return;
			var newKey = randomStr(32);
			client.query({
				text: "INSERT INTO keys(name, key) VALUES ($1, $2)",
				name: "new_user",
				values: [urldata.path[1], newKey],
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

var juushUserPage = function(server, res, urldata, req){
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

var juushAPI = function(server, res, urldata, req){
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

var redirs = {
	git: "//github.com/John2143658709/",
	teamspeak: "ts3server://john2143.com",
	steam: "//steamcommunity.com/profiles/76561198027378405",
	osu: "//osu.ppy.sh/u/2563776",
	ip: showIP,
	_def: "git",

	f: juushDownload,
	uf: juushUpload,
	nuser: juushNewUser,
	me: juushUserPage,
	juush: juushAPI,
};

redirs.ts = redirs.teamspeak;

var srv = new server({
	redirs: redirs,
	ip: serverConst.IP,
	port: serverConst.PORT
});
