"use strict";

var https = require("https");
var http = require("http");
var fs = require("fs");
var querystring = require("querystring");
var url = require("url");

class request{
	constructor(req, res){
		this.req = req;
		this.res = res;
	}

	denyFavicon(){
		if(this.req.url === "/favicon.ico" || this.req.url === "/apple-touch-icon.png"){
			this.res.writeHead(404, {"Content-Type": "image/x-icon"});
			this.res.end();
			return true;
		}
		return false;
	}

	get urldata(){
		if(!this._urldata){
			this._urldata = url.parse(this.req.url, true);
			//Filter all empty or null parameters
			this._urldata.path = this._urldata.path.split("/");
			let path = this._urldata.path;
			if(!path[path.length - 1]){
				path.pop();
			}
			if(!path[0]){
				path.shift();
			}
		}
		return this._urldata;
	}

	logConnection(){
		console.log(
			Date() + " | " +
			this.req.connection.remoteAddress + " | " +
			this.urldata.path.join("/")
		);
	}

	doRedirect(redir){
		this.res.writeHead(301, {
			"Content-Type": "text/html",
			"Location": redir,
		});
		this.res.end("Redirecting to '" + redir + "'...");
	}

	doHTML(html, code = 200){
		this.res.writeHead(code, {"Content-Type": "text/html"});
		this.res.end(html);
	}

	serveStatic(path, headers = {"Content-Type": "text/html"}, code = 200){
		fs.readFile(path, "utf8", function(err, dat){
			if(err){
				this.doHTML("Failed to serve content", 500);
			}else{
				this.res.writeHead(code, headers);
				this.res.end(dat);
			}
		}.bind(this))
	}
}

class server{
	constructor(dat){
		this.ip = dat.ip || "0.0.0.0";
		this.port = dat.port || 443;
		this.redirs = dat.redirs || {};
		this.extip = null;
        if(this.port === 443){
            console.log("Starting http upgrade server");
            this.serverHTTPUpgrade = http.createServer((req, res) => {
                res.writeHead(301, {"Location": "https://" + req.headers["host"] + req.url});
                res.end();
            });
        }
        try{
            let pathToKeys = "/etc/letsencrypt/live/www.john2143.com/";
            this.server = https.createServer({
                key:  fs.readFileSync(pathToKeys + "privkey.pem"),
                cert: fs.readFileSync(pathToKeys + "cert.pem"),
                ca:   fs.readFileSync(pathToKeys + "fullchain.pem"),
            },(req, res) => {
                this.route(new request(req, res));
            });
        }catch(err){
            console.log("Err starting: " + err);
        }

		try{
			this.server.listen(this.port, this.ip);
            if(this.serverHTTPUpgrade) this.serverHTTPUpgrade.listen(80, this.ip);
		}catch(err){
			console.log("There was an error starting the server. Are you sure you can access that port?");
		}

		this.getExtIP(function(ip){
			console.log("EXTIP is " + String(ip));
		});
	}

	route(reqx){
		if(reqx.denyFavicon()) return;

		reqx.logConnection();

		var filepath = __dirname + "/pages" + reqx.req.url + ".html";
		fs.stat(filepath, function(err, stats){
			if(err){
				var dat = reqx.urldata.path[0];
				var redir;

				if(dat !== undefined){
					redir = this.redirs[dat];
				}else{
					redir = this.redirs[this.redirs._def]; //Default to default action defined by the redirect table
				}

				if(redir){
					if(typeof redir === "function"){
						redir(this, reqx);
					}else{
						reqx.doRedirect(redir);
					}
				}else{
					reqx.serveStatic(__dirname + "/pages/404.html");
				}
			}else{
				//TODO transform into pipe
				reqx.serveStatic(filepath);
			}
		}.bind(this));
	}

	getExtIP(callback, doreset){
		if(doreset || !this.extip){
			https.get({
				host: "myexternalip.com",
				port: 443,
				path: "/raw"
			}, function(r){
				r.setEncoding("utf8");
				r.on("data", function(d){
					this.extip = d;
					callback(this.extip);
				});
			}) .setTimeout(2000, function(){
				callback(false);
			});
		}else{
			callback(this.extip);
		}
	}
}

module.exports = server;
