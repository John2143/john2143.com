//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite

//import
var server = require("./server.js"),
	serverConst = require("./const.js"),
	users = require("./users.js").users,
	fs = require("fs"),
	querystring = require("querystring"),
	sprintf = require("./sprintf").sprintf,
	crypto = require("crypto");

var usersalt,
	redirs;
if(fs.existsSync("./salt")){
	usersalt = fs.readFileSync("./salt");
}else{
	var v = "";
	for(var i = 0; i < 5; i++)
		v += Math.random().toString().substring(2);
	usersalt = Number(v).toString(36).toUpperCase().substring(4, 19);
	fs.writeFileSync("./salt", usersalt);
}
console.log("User salt is currently " + usersalt);

var userspass = {};
for(var name in users){
	userspass[name] = crypto.createHmac("md5", usersalt).update(name).digest("hex");
	console.log("User " + name + " has password '" + userspass[name] + "'");
}

var loadJSPage = function(name){
	if(!redirs[name]){
		console.log("Loading " + name);
		redirs[name] = require("./pages/" + name).req;
	}else{
		console.log("Tried to overload js");
	}
}
var unloadJSPage = function(name){
	redirs[name] = undefined;
}
var retport = function(server, res, a){
	server.doRedirect(res, "http://john2143.com:" + (a || 80))
};
var showIP = function(server, res){
	server.getExtIP(function(ip){
		server.doHTML(res, ip);
	});
};
var createAnchor = function(page){
	return '<a href="/' + page + '">/' + page + '</a>';
};
var createPermPage = function(server, res, req, pagename, power, info, allow, code){
	if(power & 2){
		if(!fs.existsSync(pagename) || (power & 4)){
			console.log(sprintf(
				"%s is creating a permanant page at '/%s' from ip %s",
				allow,
				info.pagename,
				req.connection.remoteAddress
			));
			fs.writeFile(pagename, code, function(){
				server.doHTML(res, "Saved and hosted to " + createAnchor(info.pagename));
			});
			if(info.codeType == 1)
				loadJSPage(info.pagename);
		}else{
			server.doHTML(res, "You (" + allow + ") do not have the power to overwrite pages");
		}
	}else{
		server.doHTML(res, "You (" + allow + ") do not have the power to create permanant pages");
	}
}
var createTempPage = function(server, res, req, pagename, power, info, allow, code){
	if(power & 1){
		if(!server.bonuspages[info.name] || (power & 4)){
			console.log(sprintf(
				"%s is creating a temporary page at '/%s' from ip %s",
				allow,
				info.pagename,
				req.connection.remoteAddress
			));
			server.bonuspages[info.pagename] = code;
			server.doHTML(res, "Temp page created at " + createAnchor(info.pagename));
		}else{
			server.doHTML(res, "You (" + allow + ") do not have the power to overwrite pages");
		}
	}else{
		server.doHTML(res, "You (" + allow + ") do not have the power to create temporary pages");
	}
}
var addPage = function(server, res, data, req, method){
	if (method == 'POST'){
        var chunk = '';
        req.on('data', function(newChunk) {
            chunk += newChunk;
        });
        req.on('end', function() {
			var info = querystring.parse(chunk);
			var allow = false;
			if(data[1] === "dump")
				console.log(info);
			for(var name in users) {
				if (userspass[name] == info.password) {
					allow = name;
					break;
				}
			}
			if(allow){
				var code = "Created by " + allow;
				if(info.codeType == 0)
					code = "<!--" + code + "-->";
				else if(info.codeType == 1)
					code = "/*" + code + "*/";
				code += info.code;

				var power = users[name];
				var pagename = "./pages/" + info.pagename + (
						(info.codeType == 0 && ".html") ||
						(info.codeType == 1 && ".js") ||
						".txt"
					);
				if(info.type === "perm"){
					createPermPage(server, res, req, pagename, power, info, allow, code);
				}else if(info.type === "temp"){
					createTempPage(server, res, req, pagename, power, info, allow, code);
				}else if(info.type === "dele"){
					if(power & 4){
						if(fs.existsSync(pagename)){
							fs.rename(pagename, pagename + ".old");
							server.doHTML(res, "Page /" + info.pagename + " deleted");
							if(info.codeType == 1)
								unloadJSPage(info.pagename);
						}else{
							server.doHTML(res, "That page does not exist (" + info.pagename + ")");
						}
					}else{
						server.doHTML(res, "You (" + allow + ") do not have the power to delete pages");
					}
				}else if(info.type === "pund"){
					//you can overwrite current pages with this but there doesnt seem to be a soultion thats easy
					if(fs.existsSync(pagename + ".old")){
						createPermPage(server, res, req, pagename, power, info, allow, fs.readFileSync(pagename + ".old"));
						fs.unlinkSync(pagename + ".old");
					}
				}else if(info.type === "tund"){
					//if a perm page exists with this name then this wont be able to work
					//could overwrite a temp page but thats not really a problem
					//also do not unlink like in pund
					if(fs.existsSync(pagename + ".old"))
						createTempPage(server, res, req, pagename, power, info, allow, fs.readFileSync(pagename + ".old"));
				}
			}else{
				console.log(sprintf(
					"Access denied to password '%s' from %s",
					info.password,
					req.connection.remoteAddress
				));
				server.doHTML(res, "Access denied");
			}
        });
	}else{
		server.doHTML(res, "GET pages are currently disabled");
    }
};
redirs = {
	git: "https://github.com/John2143658709/",
	server: "ts3server://uk-voice2.fragnet.net:9992",
	ts3: "ts3server://john2143.com/",
	johnhud: "https://github.com/John2143658709/johnhud/archive/master.zip",
	ip: showIP,
	p: retport,
	_def: "git",
	doAddPage: addPage,
};

var pagesDirectory = fs.readdirSync("pages/");
for(var i = 0; i < pagesDirectory.length; i++){
	var page = /(.+)\.js$/.exec(pagesDirectory[i]);
	if(page)
		loadJSPage(page[1]);
}

var srv = new server({
	redirs: redirs,
	ip: serverConst.IP,
	port: serverConst.PORT
});
