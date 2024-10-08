import https from "https";
import http  from "http";
import url   from "url";
import fs    from "node:fs/promises";
import "colors";

let favicon: Buffer;
fs.readFile("favicon.ico").then(dat => favicon = dat);;

class request{
    constructor(req, res){
        this.req = req;
        this.res = res;
        //this.shouldLog = !global.it;
        this.shouldLog = true;
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

    logConnection(){
        if(!this.shouldLog) return;

        const dateString = (dt = new Date()) => {
            const abvr = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const lead0 = num => num < 10 ? "0" + num : num;

            return abvr[dt.getMonth()] + " "
                + lead0(dt.getDate()) + " "
                + dt.getFullYear() + " "
                + lead0(dt.getHours()) + ":"
                + lead0(dt.getMinutes()) + ":"
                + lead0(dt.getSeconds());
        };

        const padLeft = (str, size = 15) => {
            str = String(str);
            let pad = size - str.length;
            if(pad < 0) return str;
            return Array(pad + 1).join(" ") + str;
        };

        const ip = this.req.headers["x-forwarded-for"];

        const path = this.urldata.path.join("/");

        const code = this.res.statusCode;
        let codestr = String(code);

        if(code == 206){
            codestr = codestr.blue;
        }else if(code >= 200 && code < 300){
            codestr = codestr.green;
        }else{
            codestr = codestr.red;
        }

        let line = `${dateString()} | ${padLeft(ip).blue} | ${codestr} ${path}`;
        if(this.extraLog){
            line += " " + this.extraLog;
        }

        if(Object.keys(this.urldata.query).length !== 0){
            line += " " + JSON.stringify(this.urldata.query).blue;
        }

        serverLog(line);
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

    async serveStatic(path, headers = {"Content-Type": "text/html"}, code = 200){
        return fs.readFile(path, "utf8").then(dat => {
            this.res.writeHead(code, headers);
            this.res.end(dat);
        }).catch(/* istanbul ignore next */ _err => {
            this.doHTML("Failed to serve content: " + JSON.stringify({path, headers, code}), 500);
        });
    }

    serveFunc(f, server){
        return f(server, this);
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
            const sfunc = async (req, res) => {
                let connection = new request(req, res);
                await this.route(connection);
                connection.logConnection();
            };

            if(this.isHTTPS){
                serverLog("Starting https server on " + this.port);
                this.server = https.createServer(dat.keys, sfunc);
            }else{
                serverLog("Starting http server on " + this.port);
                this.server = http.createServer(sfunc);
            }
        }catch(err){
            /* istanbul ignore next */
            serverLog("Err starting: " + err);
            /* istanbul ignore next */
            return;
        }

        try{
            this.server.listen(this.port, this.ip);
            if(this.serverHTTPUpgrade) this.serverHTTPUpgrade.listen(dat.httpPort, this.ip);
        }catch(err){
            /* istanbul ignore next */
            serverLog("There was an error starting the server. Are you sure you can access that port?");
            /* istanbul ignore next */
            return;
        }

        this.getExtIP().then(ip => serverLog("EXTIP is " + ip.blue));

        this.shortPages = {};
        this.getPagesDirectory().then(map => this.shortPages = map);
    }

    //get a list of files so that they can be served without the .html ext
    async getPagesDirectory(){
        let htmlPages = (await fs.readdir("./pages"))
            .filter(x => x.endsWith(".html"));
        let map = {};
        for(let page of htmlPages){
            let short = /(.+)\.html/.exec(page)[1];
            map[short] = page;
        }
        return map;
    }

    stop(){
        this.server.close();
        if(this.serverHTTPUpgrade) this.serverHTTPUpgrade.close();
        serverLog("Server stopping");
    }

    async route(reqx){
        if(reqx.denyFavicon()) return;

        const dat = reqx.urldata.path[0];

        //Try to serve with no extension
        if(this.shortPages[dat]){
            return await reqx.serveStatic("./pages/" + this.shortPages[dat]);
        }

        let redir;
        if(dat !== undefined){
            redir = this.redirs[dat];
        }else{
            redir = this.redirs[this.redirs._def]; //Default to default action defined by the redirect table
        }

        if(!redir){
            //Try to serve a static page from pages
            //Can this reach files below the base directory using ..? should test this
            const filepath = "./pages/" + reqx.urldata.path.join("/");
            try{
                await fs.stat(filepath);
                await reqx.serveStatic(filepath);
            }catch(e){
                await reqx.serveStatic("./pages/404.html", null, 404);
            }
        }else if(typeof redir === "function"){
            try{
                //wrapping in a promise works on promies and non promises alike
                await Promise.resolve(reqx.serveFunc(redir, this));
            }catch(err){
                serverLog(err);
                reqx.res.statusCode = 500;
                reqx.res.end();
            }
        }else{
            reqx.doRedirect(redir);
        }
    }

    async getExtIP(doreset = false){
        if(!doreset && this.extip) return this.extip;

        const lib = this.isHTTPS ? https : http;
        const get = data => new Promise((resolve, reject) => {
            lib.get(data, r => {
                r.setEncoding("utf8");
                r.on("data", resolve);
            }).setTimeout(1000, reject).on("error", reject);
        });

        try{
            return this.extip = await get({
                host: "api.ipify.org",
                port: this.isHTTPS ? 443 : 80,
            });
        }catch(e){
            serverLog("Failed to get external IP", e);
            return this.extip = "0.0.0.0";
        }
    }
}
