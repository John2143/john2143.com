
import {juushErrorCatch, isAdmin, pool, whoami} from "./util.js";


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

const genericJSON = res => obj => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
}

export default async function(server, reqx){
    const {res, urldata, req} = reqx;
    // /juush/uploads/<userid>/[page]/
    // lists some number of uploads from a user, with an optional offset
    if(urldata.path[1] === "uploads"){
        const [, , userid_, page = 0] = urldata.path;
        const userid = Number(userid_);

        let showHidden = false;
        if(urldata.query["hidden"]){
            const ip = req.connection.remoteAddress;
            if((await whoami(ip)).includes(userid) || await isAdmin(ip)){
                showHidden = true;
            }else{
                res.statusCode = 403;
                res.end("You cannot see hidden uploads for this user");
                return;
            }
        }
        const perPage = 25;
        pool.query({
            text: `SELECT id, filename, mimetype, downloads, uploaddate
                   FROM index
                   WHERE keyid = $1 AND (
                       $4 OR
                       (SELECT COUNT(*) FROM modifiers WHERE uploadid=index.id AND modifier = 1) = 0
                   )
                   ORDER BY uploaddate
                   DESC LIMIT $3 OFFSET $2`,
            name: "api_get_uploads",
            values: [userid, page * perPage, perPage, showHidden],
        })
            .then(genericAPIResult(res))
            .catch(juushErrorCatch(res));
    // /juush/users/
    // Return all juush users
    }else if(urldata.path[1] === "users"){
        pool.query({
            text: "SELECT id, name FROM keys;",
            name: "api_get_uers",
        })
            .then(genericAPIResult(res))
            .catch(juushErrorCatch(res));
    // /juush/whoami/
    // Return a list of user ids for current IP
    }else if(urldata.path[1] === "whoami"){
        whoami(req.connection.remoteAddress)
            .then(genericJSON(res))
            .catch(juushErrorCatch(res));
    // /juush/userinfo/<userid>
    // Give info about a user.
    }else if(urldata.path[1] === "userinfo"){
        try{
            let infos = await Promise.all([
                pool.query({
                    text: "SELECT name FROM keys WHERE id = $1;",
                    name: "api_get_info1",
                    values: [urldata.path[2]],
                }),
                pool.query({
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
        if(!isAdmin(req.connection.remoteAddress)){
            res.writeHead(401, {});
            res.end("You cannot delete users");
            return;
        }

        pool.query({
            text: "DELETE FROM keys WHERE id=$1;",
            name: "api_deluser",
            values: [urldata.path[2]],
        })
            .then(genericAPIOperationResult(res))
            .catch(juushErrorCatch(res));
    // /juush/isadmin/[ip]
    // Returns if the ip (or connector) is an admin
    }else if(urldata.path[1] === "isadmin"){
        let ip = req.connection.remoteAddress;
        if(urldata.path[2]) ip = urldata.path[2];
        res.setHeader("Content-Type", "text/plain");
        res.end(isAdmin(ip) ? "true" : "false");
    }else{
        res.statusCode = 405;
        res.end("Unknown method");
    }
};
