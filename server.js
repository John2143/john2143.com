"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const querystring = require("querystring");
const url = require("url");

const favicon = fs.readFileSync("favicon.ico");

class request{
    constructor(req, res){
        this.req = req;
        this.res = res;
    }

    denyFavicon(){
        if(this.req.url === "/favicon.ico" || this.req.url === "/apple-touch-icon.png"){
            this.res.writeHead(200, {
                "Content-Type": "image/x-icon",
                "Content-Length": favicon.length,
            });
            this.res.end(favicon);
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
        this.isHTTPS = !!dat.port;
        this.port = dat.port || dat.httpPort;
        this.httpPort = dat.httpPort;
        this.redirs = dat.redirs || {};
        this.extip = null;
        if(this.isHTTPS && this.port != this.httpPort){
            console.log("Starting http upgrade server: port " + this.httpPort + " -> " + this.port);
            this.serverHTTPUpgrade = http.createServer((req, res) => {
                res.writeHead(301, {"Location": "https://" + req.headers["host"] + ":" + this.port + req.url});
                res.end();
            });
        }
        try{
            if(this.isHTTPS){
                console.log("Starting https server on " + this.port);
                let pathToKeys = "/etc/letsencrypt/live/www.john2143.com/";
                this.server = https.createServer({
                    key:  fs.readFileSync(pathToKeys + "privkey.pem"),
                    cert: fs.readFileSync(pathToKeys + "fullchain.pem"),
                    ca:   fs.readFileSync(pathToKeys + "chain.pem"),
                },(req, res) => {
                    this.route(new request(req, res));
                });
            }else{
                console.log("Starting http server on " + this.port);
                this.server = http.createServer((req, res) => {
                    this.route(new request(req, res));
                });
            }
        }catch(err){
            console.log("Err starting: " + err);
        }

        try{
            this.server.listen(this.port, this.ip);
            if(this.serverHTTPUpgrade) this.serverHTTPUpgrade.listen(dat.httpPort || 80, this.ip);
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

        const filepath = __dirname + "/pages" + reqx.req.url + ".html";
        fs.stat(filepath, function(err, stats){
            if(err){
                const dat = reqx.urldata.path[0];

                let redir;
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
