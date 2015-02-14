var http = require("http");
sprintf = require("./sprintf.js").sprintf;

var server = function(dat){
	this.ip = dat.ip || "0.0.0.0";
	this.port = dat.port || 80;
	this.servers = dat.servers || {};
	this.redirs = dat.redirs || {};
	this.extip = null;
	var _this = this;
	this.server = http.createServer(function(req, res){
		_this.parse(req, res);
	});
	this.server.listen(this.port, this.ip);
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
		data.join("|")));
};
server.prototype.parse = function(req, res){
	if(this.denyFavicon(req.url, res))
		return;

	const urldata = this.parseURL(req.url);
	this.logConnection(req, urldata);
	var dat = urldata[0];
	var redir;

	if(dat)
		redir = this.redirs[dat];
	else
		redir = this.redirs[this.redirs._def]; //Default to default action defined by the redirect table

	if(redir){
		if(typeof redir == "function")
			redir(this, res, urldata);
		else
			this.doRedirect(res, redir);
	}else
		this.doHTML(res, "That page wasnt found :(");
};

server.prototype.doRedirect = function(res, redir){
	res.statusCode = 302;
	res.setHeader('Content-Type', 'text/html');
	res.setHeader('Location', redir);
	res.end('Redirecting to '+ redir);
};
server.prototype.doHTML = function(res, html){
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/html");
	res.end(html);
};
server.prototype.getExtIP = function(callback, doreset){
	if(doreset || !this.extip){
		http.get("http://myexternalip.com/raw", function(r){
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
