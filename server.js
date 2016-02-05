var http = require("http");
var fs = require("fs");
sprintf = require("./sprintf.js").sprintf;

var server = function(dat){
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

server.prototype.denyFavicon = function(url, res){
	if (url === "/favicon.ico"){
		res.writeHead(200, {"Content-Type": "image/x-icon"} );
		res.end();
		return true;
	}
	return false;
};

var URL_PARSE_REGEX = /\/([^\/]*)/g;
server.prototype.parseURL = function(url){
	var data = [];
	while(true) {
		var reg = URL_PARSE_REGEX.exec(url)
		if(!reg)
			break;
		data.push(reg[1]);
	}
	if(data[data.length-1] == "") data.pop();
	return data;
};

server.prototype.logConnection = function(req, data){
	console.log(sprintf(
		"%s %s",
		req.connection.remoteAddress,
		data.join("/"))
	);
};

var existFunc = fs.exists || require("path").exists;
server.prototype.parse = function(req, res){
	if(this.denyFavicon(req.url, res))
		return;

	const urldata = this.parseURL(req.url);
	this.logConnection(req, urldata);

	const filepath = __dirname + "/pages" + req.url + ".html";
	var _this = this;
	existFunc(filepath, function(exists){
		if(!exists){
			_this.parse2(req, res, urldata);
		}else{
			fs.readFile(filepath, "utf8", function(err, dat){
				_this.doHTML(res, dat);
			});
		}
	});
};
//server.prototype.serveFile(res, filename){
	//var _this = this;
	//fs.readFile(filepath, "utf8", function(err, dat){
		//_this.doHTML(res, dat);
	//});
//};

server.prototype.parse2 = function(req, res, urldata){
	var dat = urldata[0];
	var redir;

	if(dat){
		redir = this.redirs[dat];
	}else{
		redir = this.redirs[this.redirs._def]; //Default to default action defined by the redirect table
	}

	if(redir){
		if(typeof redir == "function"){
			redir(this, res, urldata, req);
		}else{
			this.doRedirect(res, redir);
		}
	}else{
		this.doHTML(res, "That page wasnt found :(");
	}
}
server.prototype.doRedirect = function(res, redir){
	res.writeHead(302, {
		"Content-Type": "text/html",
		"Location": redir,
	});
	res.end("Redirecting to " + redir);
};

server.prototype.doHTML = function(res, html){
	res.writeHead(200, {
		"Content-Type": "text/html",
	});
	res.end(html);
};

server.prototype.getExtIP = function(callback, doreset){
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
		})
		.setTimeout(2000, function(){
			callback(false);
		});
	} else {
		callback(this.extip);
	}
};

module.exports = server;
