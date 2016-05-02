"use strict";

var http = require("http");
var fs = require("fs");
var querystring = require("querystring");
var url = require("url");

class server{
	constructor(dat){
		this.ip = dat.ip || "0.0.0.0";
		this.port = dat.port || 80;
		this.redirs = dat.redirs || {};
		this.extip = null;
		var _this = this;
		this.server = http.createServer(function(req, res){
			_this.parse(req, res);
		});
		try{
			this.server.listen(this.port, this.ip);
		}catch(err){
			console.log("There was an error starting the server. Are you sure you can access that port?");
		}
		this.getExtIP(function(ip){
			console.log("EXTIP is " + String(ip));
		});
	}
	static denyFavicon(url, res){
		if (url === "/favicon.ico"){
			res.writeHead(200, {"Content-Type": "image/x-icon"} );
			res.end();
			return true;
		}
		return false;
	}
	static parseURL(reqstr){
		var parsed = url.parse(reqstr, true);
		parsed.path = parsed.path.split("/").filter((x) => x);
		return parsed;
	}
	static logConnection(req, data){
		console.log(
			Date() + " | " +
			req.connection.remoteAddress + " | " +
			data.path.join("/")
		);
	}
	static parse(req, res){
		const existFunc = fs.exists || require("path").exists;
		if(this.denyFavicon(req.url, res))
			return;

		const urldata = this.parseURL(req.url);
		this.logConnection(req, urldata);

		const filepath = __dirname + "/pages" + req.url + ".html";
		existFunc(filepath, function(exists){
			if(!exists){
				var dat = urldata.path[0];
				var redir;

				if(dat){
					redir = this.redirs[dat];
				}else{
					redir = this.redirs[this.redirs._def]; //Default to default action defined by the redirect table
				}

				if(redir){
					if(typeof redir === "function"){
						redir(this, res, urldata, req);
					}else{
						this.doRedirect(res, redir);
					}
				}else{
					this.doHTML(res, "That page wasnt found :(");
				}
			}else{
				fs.readFile(filepath, "utf8", function(err, dat){
					this.doHTML(res, dat);
				});
			}
		}.bind(this));
	}
	static doRedirect(res, redir){
		res.writeHead(302, {
			"Content-Type": "text/html",
			"Location": redir,
		});
		res.end("Redirecting to " + redir);
	}
	static doHTML(res, html){
		res.writeHead(200, {
			"Content-Type": "text/html",
		});
		res.end(html);
	}
	static getExtIP(callback, doreset){
		if(doreset || !this.extip){
			http.get({
				host: "myexternalip.com",
				port: 80,
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
