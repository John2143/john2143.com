
const U = require("./util.js");

//Returns rows as json
const genericAPIResult = res => result => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result.rows));
};

//If rows only have one field, then use this so that the json is a array instead
const genericAPIListResult = field => res => result => {
    const data = result.rows.map(x => x[field]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
};

//Returns true on success, false if it failed
const genericAPIOperationResult = res => result=> {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({success: result.rowCount >= 1 ? true : false}));
};

//
module.exports = async (function(server, reqx){
    const {res, urldata, req} = reqx;
    // /juush/uploads/<userid>/[page]/
    // lists some number of uploads from a user, with an optional offset
    if(urldata.path[1] === "uploads"){
        const perPage = 25;
        U.pool.query({
            text: "SELECT id, filename, mimetype, downloads, uploaddate " +
                  "FROM index WHERE keyid = $1 ORDER BY uploaddate " +
                  "DESC LIMIT $3 OFFSET $2",
            name: "api_get_uploads",
            values: [urldata.path[2], (urldata.path[3] || 0) * perPage, perPage],
        })
            .then(genericAPIResult(res))
            .catch(U.juushErrorCatch(res));
    // /juush/users/
    // Return all juush users
    }else if(urldata.path[1] === "users"){
        U.pool.query({
            text: "SELECT id, name FROM keys;",
            name: "api_get_uers",
        })
            .then(genericAPIResult(res))
            .catch(U.juushErrorCatch(res));
    // /juush/whoami/
    // Return a list of user ids for current IP
    }else if(urldata.path[1] === "whoami"){
        U.pool.query({
            text: "SELECT DISTINCT keyid FROM index WHERE ip=$1",
            name: "api_whoami",
            values: [req.connection.remoteAddress],
        })
            .then(genericAPIListResult("keyid")(res))
            .catch(U.juushErrorCatch(res));
    // /juush/userinfo/<userid>
    // Give info about a user.
    }else if(urldata.path[1] === "userinfo"){
        try{
            let infos = await ([
                U.pool.query({
                    text: "SELECT name FROM keys WHERE id = $1;",
                    name: "api_get_info1",
                    values: [urldata.path[2]],
                }),
                U.pool.query({
                    text: "SELECT SUM(downloads), COUNT(*) FROM index WHERE keyid = $1;",
                    name: "api_get_info2",
                    values: [urldata.path[2]],
                })
            ]);

            let result = {
                name: infos[0].rows[0].name,
                key: infos[0].rows[0].key,
                downloads: infos[1].rows[0].sum,
                total: infos[1].rows[0].count,
            };

            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result));
        }catch(e){
            serverLog("Failed: ", e);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({error: e}));
        }
    // /juush/deluser/userid
    // Delete a user
    }else if(urldata.path[1] === "deluser"){
        if(!U.isAdmin(req.connection.remoteAddress)){
            res.writeHead(401, {});
            res.end("You cannot delete users");
            return;
        }

        U.pool.query({
            text: "DELETE FROM keys WHERE id=$1;",
            name: "api_deluser",
            values: [urldata.path[2]],
        })
            .then(genericAPIOperationResult(res))
            .catch(U.juushErrorCatch(res));
    // /juush/isadmin/[ip]
    // Returns if the ip (or connector) is an admin
    }else if(urldata.path[1] === "isadmin"){
        let ip = req.connection.remoteAddress;
        if(urldata.path[2]) ip = urldata.path[2];
        res.end(U.isAdmin(ip) ? "true" : "false");
    }else{
        res.end("Unknown method");
    }
});
