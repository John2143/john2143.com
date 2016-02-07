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
}

/*
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

const inlineTypes = [
	"txt", "text", "png", "jpg", "jpeg", "html",
	"webm", "mp4", "mp3", "wav", "vorbis"
];

var juushDownload = function(server, res, urldata, req){
	var requestURL = urldata[1];
	var disposition = urldata[2];
	var filepath = __dirname + "/juushFiles/" + requestURL;

	//You will get a referer and range if you are trying to stream an audio/video
	if(req.headers.referer && req.headers.range){
		try{
			var stat = fs.statSync(filepath);
		}catch(e){
			res.writeHead(400, {});
			res.end();
			return;
		}

		var fullContentLength = stat.size;
		var rangeRequestRegex = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
		var rangeStart = Number(rangeRequestRegex[1]);

		if(rangeRequestRegex[2] === ""){
			var rangeEnd = fullContentLength - 1;
		}else{
			var rangeEnd = Number(rangeRequestRegex[2]);
		}

		var contentLength = rangeEnd - rangeStart + 1;

		if(contentLength <= 0 || rangeStart >= fullContentLength || rangeEnd >= fullContentLength){
			res.writeHead(416, {});
			res.end();
			return;
		}

		res.writeHead(206, {
			"Content-Length": contentLength,
			"Content-Range": "bytes " + rangeStart + "-" + rangeEnd + "/" + fullContentLength,
		});

		var filePipe = fs.createReadStream(filepath, {start: rangeStart, end: rangeEnd});
		res.on("error", function(){filePipe.end();});
		filePipe.pipe(res);

		return;
	};
	pg.connect(dbconstr, function(err, client, done){
		if(dbError(err, client, done)) return juushError(res);
		client.query({
			//TODO only check ip when trying to delete
			text: "SELECT mimetype, ip, filename FROM index WHERE id=$1",
			name: "download_check_dl",
			values: [requestURL],
		}, function(err, result){
			if(dbError(err, client, done)) return juushError(res);
			if(result.rowCount == 0){
				done();
				res.writeHead(404, {
					"Content-Type": "text/html"
				});
				res.end("The file could not be found.");
			}else{
				var data = result.rows[0];
				if(data.mimetype == "deleted"){
					done();
					res.writeHead(404, {
						"Content-Type": "text/html"
					});
					res.end("This file has been deleted.");
				}else if(data.mimetype.split("/")[0] == "d"){
					done();
					res.writeHead(200, {
						"Content-Type": "text/html"
					});
					res.end("This file has been disabled by the uplaoder. It may be re-enabled in the future.");
				}else if(data.mimetype == "expired"){
					done();
					res.writeHead(200, {
						"Content-Type": "text/html"
					});
					res.end("this file has been automatically deleted.");
				}else{
					if(disposition == "delete"){
						if(data.ip.split("/")[0] == req.connection.remoteAddress){
							fs.unlink(filepath, function(){});
							client.query({
								text: "UPDATE index SET mimetype='deleted' WHERE id=$1",
								name: "delete_file",
								values: [requestURL],
							}, function(err, result){
								if(err){
									juushError(res);
								}else{
									res.writeHead(200, {
										"Content-Type": "text/html"
									});
									res.end("File successfully deleted. It will still appear in your user page.");
								}
								done();
							});
						}else{
							done();
							res.writeHead(401, {
								"Content-Type": "text/html"
							});
							res.end("You do not have access to delete this file.");
						}
					}else{
						//fs.statSync() throws an error, this will pass the error
						fs.stat(filepath, function(err, stat){
							if(err) return juushError(res);
							var type = data.filename.split(".").pop().toLowerCase();
							var download = "attachment; filename=\"" + data.filename + '"';
							var codisp = "inline; filename=\"" + data.filename + '"';
							if(disposition){
								if(disposition == "inline" || disposition == "i" ||
									disposition == "nodl"){
									//keep inline default
								}else{
									codisp = download;
								}
							}else if(inlineTypes.indexOf(type) == -1){
								codisp = download;
							}

							client.query({
								text: "UPDATE index SET " +
									"downloads=downloads+1, " +
									"lastdownload=now() " +
									"WHERE id=$1",
								name: "download_increment_downloads",
								values: [requestURL],
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
							res.on("error", function(){stream.end();});
							stream.pipe(res);
						});
					}
				}
			}
		});
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

//This appears at the end of every post request with 22x being a hex hash
const match = new Buffer("\r\n----------------------xxxxxxxxxxxxxxx--\r\n");

//TODO
//The exucution order could in theory be changed to connect to the database only
//  after the connection is established by not waiting for the client and such

var juushUpload = function(server, res, urldata, req){
	getDatabaseConnectionAndURL(function(err, url, client, done){
		if(err) return true;

		var filepath = __dirname + "/juushFiles/" + url;
		var wstream = fs.createWriteStream(filepath, {
			flags: "w",
			encoding: "binary",
		});

		var isError = false;
		var error = function(){
			isError = true;
			wstream.end();
			fs.unlink(filepath, function(){});
			client.query({
				text: "DELETE FROM index WHERE id=$1",
				name: "upload_download_error_remove_entry",
				values: [url],
			}, function(err, result){
				if(dbError(err, client, done)) return error();
				done();
			});
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
			//TODO move to req end?
			res.end("http://john2143.com/f/" + url);
			done();
		});

		var headersReceived = false;

		req.on("data", function(data){
			//This whole function sucks
			if(isError) return;
			var write = data;
			if(!headersReceived){
				headersReceived = true;
				var headers = data.toString().split("\r\n\r\n", 1)[0];
				write = new Buffer(data.length - (headers.length + 4));
				data.copy(write, 0, (headers.length + 4));
				var spl1 = /Content\-Disposition: form\-data; name="([A-Za-z0-9]+)"; filename="([^"]+)"/.exec(headers);
				var spl2 = /Content\-Type: (.+)/.exec(headers);
				var key = spl1[1];
				var filename = spl1[2];
				var mimetype = spl2[1];

				client.query({
					text: "SELECT id FROM keys WHERE key=$1",
					name: "upload_check_key",
					values: [key],
				}, function(err, result){
					if(dbError(err, client, done)) return error();
					if(result.rowCount == 0){
						done();
						res.writeHead(401, {
							"Content-Type": "text/html"
						});
						res.end("You must supply a valid key in order to upload. Your key may be disabled or invalid.");
					}else{
						//TODO move this to finish?
						//File transfer may fail
						client.query({
							text: "INSERT INTO index(id, uploaddate, ip, filename, mimetype, keyid)" +
								"VALUES($1, now(), $2, $3, $4, $5)",
							name: "upload_insert_download",
							values: [url, req.connection.remoteAddress, filename, mimetype, result.rows[0].id],
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
				values: [urldata[1], newKey],
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
	var page = urldata[1];
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
	if(urldata[1] == "db"){
		pg.connect(dbconstr, function(err, client, done){
			if(dbError(err, client, done)) return juushError(res);
			if(urldata[2] == "uploads"){
				client.query({
					text: "SELECT id, filename, mimetype, downloads FROM index WHERE keyid = $1 LIMIT 50 OFFSET $2",
					name: "api_get_uploads",
					values: [urldata[3], (urldata[4] || 0) * 50],
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

var srv = new server({
	redirs: redirs,
	ip: serverConst.IP,
	port: serverConst.PORT
});
