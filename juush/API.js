
const U = require("./util.js");

//Returns rows as json
const genericAPIResult = (client, done, res) => (err, result) => {
    if(U.dbError(err, client, done)) return U.juushError(res);
    res.end(JSON.stringify(result.rows));
};

//If rows only have one field, then use this so that the json is a array instead
const genericAPIListResult = (client, done, res) => field => (err, result) => {
    if(U.dbError(err, client, done)) return U.juushError(res);
    let data = result.rows.map(x => x[field]);
    res.end(JSON.stringify(data));
};

//Returns true on success, false if it failed
const genericAPIOperationResult = (client, done, res) => (err, result) => {
    if(U.dbError(err, client, done)) return U.juushError(res);
    res.end(result.rowCount >= 1 ? "true" : "false");
};

//
module.exports = function(server, reqx){
    const {res, urldata, req} = reqx;
    if(urldata.path[1] === "db"){
        //Mabye verify the request first? otherwise they could just spin up db
        //instances
        U.pool.connect(function(err, client, done){
            if(U.dbError(err, client, done)) return U.juushError(res);
            // /juush/db/uploads/<userid>/[page]/
            // lists some number of uploads from a user, with an optional offset
            if(urldata.path[2] === "uploads"){
                const perPage = 25;
                client.query({
                    text: "SELECT id, filename, mimetype, downloads, uploaddate " +
                          "FROM index WHERE keyid = $1 ORDER BY uploaddate " +
                          "DESC LIMIT $3 OFFSET $2",
                    name: "api_get_uploads",
                    values: [urldata.path[3], (urldata.path[4] || 0) * perPage, perPage],
                }, genericAPIResult(client, done, res));
            // /juush/db/users/
            // Return all juush users
            }else if(urldata.path[2] === "users"){
                client.query({
                    text: "SELECT id, name FROM keys;",
                    name: "api_get_uers",
                }, genericAPIResult(client, done, res));
            // /juush/db/whoami/
            // Return a list of user ids for current IP
            }else if(urldata.path[2] === "whoami"){
                client.query({
                    text: "SELECT DISTINCT keyid FROM index WHERE ip=$1",
                    name: "api_whoami",
                    values: [req.connection.remoteAddress],
                }, genericAPIListResult(client, done, res)("keyid"));
            // /juush/db/userinfo/<userid>
            // Give info about a user.
            }else if(urldata.path[2] === "userinfo"){
                let ret = {};
                let rtot = 2;

                const sendResult = () => res.end(JSON.stringify(ret));
                const sendNone = () => res.end("{}");


                const info1 = function(err, result){
                    if(U.dbError(err, client, done)) return U.juushError(res);
                    if(!result.rows[0]) return sendNone();
                    ret.name = result.rows[0].name;
                    ret.key = result.rows[0].key;
                    if(!--rtot) sendResult();
                };

                if(U.isAdmin(req.connection.remoteAddress)){
                    client.query({
                        text: "SELECT name,key FROM keys WHERE id = $1;",
                        name: "api_get_info_admin1",
                        values: [urldata.path[3]],
                    }, info1);
                }else{
                    client.query({
                        text: "SELECT name FROM keys WHERE id = $1;",
                        name: "api_get_info1",
                        values: [urldata.path[3]],
                    }, info1);
                }

                client.query({
                    text: "SELECT SUM(downloads), COUNT(*) FROM index WHERE keyid = $1;",
                    name: "api_get_info2",
                    values: [urldata.path[3]],
                }, function(err, result){
                    if(U.dbError(err, client, done)) return U.juushError(res);
                    let r = result.rows[0];
                    if(!r) return sendNone();
                    ret.downloads = r.sum;
                    ret.total = r.count;
                    if(!--rtot) sendResult();
                });
            }else if(urldata.path[2] === "deluser"){
                if(!U.isAdmin(req.connection.remoteAddress)){
                    res.writeHead(401, {});
                    res.end("You cannot delete users");
                    return;
                }

                client.query({
                    text: "DELETE FROM keys WHERE id=$1;",
                    name: "api_deluser",
                    values: [urldata.path[3]],
                }, genericAPIOperationResult(client, done, res));
            }else{
                res.end("Unknown endpoint");
            }
            done();
        });
    // /juush/isadmin/[ip]
    // Returns if the ip (or connector) is an admin
    }else if(urldata.path[1] === "isadmin"){
        let ip = req.connection.remoteAddress;
        if(urldata.path[2]) ip = urldata.path[2];
        res.end(U.isAdmin(ip) ? "true" : "false");
    }else{
        res.end("Unknown method");
    }
};
