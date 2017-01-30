import https from "https";
import http  from "http";
import url   from "url";

let favicon = "";

try{
    favicon = fs.readFileSync("favicon.ico");
}catch(e){
    //NOOP
}

class request{
    constructor(req, res){
        this.req = req;
        this.res = res;
        this.shouldLog = !global.it;
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

            //Ignore query string
            if(path[0]) path[path.length - 1] = path[path.length - 1].split("?")[0];
        }
        return this._urldata;
    }

    noLog(){
        this.shouldLog = false;
    }

    logConnection(){
        if(!this.shouldLog) return;
        serverLog(
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
        fs.readFile(path, "utf8", (err, dat) => {
            if(err){
                this.doHTML("Failed to serve content", 500);
            }else{
                this.res.writeHead(code, headers);
                this.res.end(dat);
            }
        });
    }
}

export default class server{
    constructor(dat){
        this.ip = dat.ip || "0.0.0.0";
        this.isHTTPS = dat.port && dat.httpPort && dat.port != dat.httpPort;
        this.port = dat.port || dat.httpPort;
        this.httpPort = dat.httpPort || dat.port;
        this.redirs = dat.redirs || {};
        this.extip = null;

        if(this.isHTTPS){
            serverLog("Starting http upgrade server: port " + this.httpPort + " -> " + this.port);
            this.serverHTTPUpgrade = http.createServer((req, res) => {
                res.writeHead(301, {"Location": "https://" + req.headers.host + ":" + this.port + req.url});
                res.end();
            });
        }
        try{
            const sfunc = (req, res) => this.route(new request(req, res));
            if(this.isHTTPS){
                serverLog("Starting https server on " + this.port);
                this.server = https.createServer(dat.keys, sfunc);
            }else{
                serverLog("Starting http server on " + this.port);
                this.server = http.createServer(sfunc);
            }
        }catch(err){
            serverLog("Err starting: " + err);
            return;
        }

        try{
            this.server.listen(this.port, this.ip);
            if(this.serverHTTPUpgrade) this.serverHTTPUpgrade.listen(dat.httpPort, this.ip);
        }catch(err){
            serverLog("There was an error starting the server. Are you sure you can access that port?");
        }

        if(!global.it) this.getExtIP(ip => serverLog("EXTIP is " + String(ip)));
    }

    stop(){
        this.server.close();
        if(this.serverHTTPUpgrade) this.serverHTTPUpgrade.close();
        serverLog("Server stopping");
    }

    route(reqx){
        if(reqx.denyFavicon()) return;

        const filepath = "./pages/" + reqx.urldata.path.join("/") + ".html";
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
                    reqx.serveStatic("./pages/404.html", null, 404);
                }
            }else{
                //TODO transform into pipe
                reqx.serveStatic(filepath);
            }
            reqx.logConnection();
        }.bind(this));
    }

    getExtIP(callback, doreset){
        if(doreset || !this.extip){
            (this.isHTTPS ? https : http).get({
                host: "api.ipify.org",
                port: this.isHTTPS ? 443 : 80,
            }, r => {
                r.setEncoding("utf8");
                r.on("data", d => {
                    this.extip = d;
                    callback(this.extip);
                });
            }).setTimeout(1000, () => {
                this.extip = "0.0.0.0";
                callback(this.extip);
            }).on("error", err => {
                serverLog("Failed to get external IP");
                this.extip = "0.0.0.0";
                callback(this.extip);
            });
        }else{
            callback(this.extip);
        }
    }
}
