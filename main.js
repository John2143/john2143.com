//Node server for john2143.com
// its pretty bloated but its more organized than it used to be
// pending full rewrite

//import
var server = require("./server.js");
var serverConst = require("./const.js");

var retport = function(server, res, a){
	server.doRedirect(res, "http://john2143.com:" + (a || 80))
};
var wtfskippy = function(server, res, a){
	server.doHTML("yes " + (a || "skippy") + " why are you so useless");
};
var showIP = function(server, res){
	server.getExtIP(function(ip){
		server.doHTML(res, ip);
	});
};
const chunks = [
	"<div><b>",
	":</b> ",
	"</div>"
];
var listServers = function(server, res, data){
	var html = [];
	var ind;
	for(var i in servers){
		ind = 0;
		html.push(chunks[ind++]);
		html.push(i);
		html.push(chunks[ind++]);
		html.push(servers[i]);
		html.push(chunks[ind++]);
	}
	server.doHTML(res, html.join(''));
};

var juush = function(server, res, url){
	if(url[1]){
		server.doHTML(res,"AAAAAA" + url[1]);
	}else{
		server.doHTML(res,"JJJJJJ");
	}
};

//consts
var servers = {
	source: 27015,
	source2: 27016,
	gen: 7777,
	gen2: 7778,
	mc: 25555,
	mc2: 25556,
	web: 80,
	web2: 8000,
	web3: 8080,
};
var redirs = {
	git: "https://github.com/John2143658709/",
	server: "ts3server://uk-voice2.fragnet.net:9992",
	johnhud: "https://github.com/John2143658709/johnhud/archive/master.zip",
	ip: showIP,
	p: retport,
	minecraft: function(server, res) {server.doRedirect(res, "youriphere:yourporthere");},
	_def: "git",
	list: listServers,
	name: wtfskippy,
	juush: juush,
};

var srv = new server({
	servers: servers,
	redirs: redirs,
	ip: serverConst.IP,
	port: serverConst.PORT
});
