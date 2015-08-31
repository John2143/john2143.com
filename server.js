var http = require("http");
var fs = require("fs");
var sprintf = require("./sprintf.js").sprintf;

var server = function(dat){
	this.ip = dat.ip || "0.0.0.0";
	this.port = dat.port || 80;
	this.redirs = dat.redirs || {};
	this.extip = null;
	this.bonuspages = {};
	var _this = this;
	this.server = http.createServer(function(req, res){
		_this.parse(req, res);
	});
	this.server.listen(this.port, this.ip);
	this.getExtIP(function(ip){
		console.log("EXTIP is " + String(ip));
	});
}

server.prototype.denyFavicon = function(url, res){
	if (url === '/favicon.ico'){
		res.writeHead(200, {'Content-Type': 'image/x-icon'} );
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
	if(data[data.length-1] == "")
		data.pop();
	return data;
};
server.prototype.logConnection = function(req, data){
	console.log(sprintf(
		"%s %s",
		req.connection.remoteAddress,
		data.join("/")));
};
var existFunc = fs.exists || require("path").exists;
server.prototype.parse = function(req, res){
	if(this.denyFavicon(req.url, res))
		return;
	const urldata = this.parseURL(req.url);
	const filepath = __dirname + "/pages" + req.url;
	this.logConnection(req, urldata);
	if(req.method == "GET"){
		if(fs.existsSync(filepath + ".html"))
			this.doHTML(res, fs.readFileSync(filepath + ".html"));
		else
			this.parse2(req, res, urldata);
	}else if(req.method == "POST"){
		if(this.redirs[urldata[0]])
			this.redirs[urldata[0]](this, res, urldata, req, "POST");
		else
			this.doHTML(res, "This page may not be posted to or does not exist");
	}else{
		this.doHTML(res, "Unsupported request method");
	}
};

server.prototype.redirParse = function(res, redir, urldata, req){
	if(typeof redir == "function")
		redir(this, res, urldata, req, "GET");
	else
		this.doRedirect(res, redir);
}
server.prototype.parse2 = function(req, res, urldata){
	var dat = urldata[0];

	if(!dat)
		this.redirParse(res, this.redirs[this.redirs._def], urldata, req);
	else{
		if(this.redirs[dat])
			this.redirParse(res, this.redirs[dat], urldata, req);
		else if(this.bonuspages[dat]) //Dont need to worry about html pages
			this.doHTML(res, this.bonuspages[dat]);
		else
			this.doHTML(res, "That page wasnt found :(");
	}
}
server.prototype.doRedirect = function(res, redir){
	res.statusCode = 302;
	res.setHeader('Content-Type', 'text/html');
	res.setHeader('Location', redir);
	res.end('Redirecting to ' + redir);
};
server.prototype.doHTML = function(res, html){
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/html");
	res.end(html);
};
server.prototype.getExtIP = function(callback, doreset){
	if(doreset || !this.extip){
		http.get({
			host: "myexternalip.com",
			port: 80,
			path: "/raw"
		}, function(r){
			r.setEncoding('utf8');
			r.on('data', function(d){
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
