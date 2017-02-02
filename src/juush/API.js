
import {juushErrorCatch, isAdmin, query, whoami} from "./util.js";


//If rows only have one field, then use this so that the json is a array instead
const genericAPIListResult = field => res => result => {
    const data = result.map(x => x[field]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
};

//Returns true on success, false if it failed
const genericAPIOperationResult = res => result => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({success: result.result.n >= 1 ? true : false}));
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

        let queryObj = {
            keyid: userid,
        };

        if(urldata.query["hidden"]){
            const ip = req.connection.remoteAddress;
            if((await whoami(ip)).includes(userid) || await isAdmin(ip)){
                //noop
            }else{
                res.statusCode = 403;
                res.end("You cannot see hidden uploads for this user");
                return;
            }
        }else{
            queryObj["modifiers.hidden"] = {$exists: false};
        }
            //text: `SELECT id, filename, mimetype, downloads, uploaddate
                   //FROM index
                   //WHERE keyid = $1 AND (
                       //$4 OR
                       //(SELECT COUNT(*) FROM modifiers WHERE uploadid=index.id AND modifier = 1) = 0
                   //)
                   //ORDER BY uploaddate
                   //DESC LIMIT $3 OFFSET $2`,
        const perPage = 25;
        query.index.find(queryObj, {
            filename: 1, mimetype: 1, downloads: 1, uploaddate: 1,
        }).sort({
            uploaddate: -1
        }).skip(page * perPage).limit(perPage).toArray()
            .then(genericJSON(res))
            .catch(juushErrorCatch(res));
    // /juush/users/
    // Return all juush users
    }else if(urldata.path[1] === "users"){
        query.keys.find({}, {id: 1, name: 1}).toArray()
            .then(genericJSON(res))
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
            let projection = {name: 1};
            if(urldata.query["key"]){
                projection.key = 1;
            }

            res.setHeader("Content-Type", "application/json");

            const _id = Number(urldata.path[2]);

            const user = await query.keys.findOne({_id}, projection);

            if(!user){
                res.end(JSON.stringify({error: new Error("User not fround")}));
                return;
            }

            let stats = await query.index.aggregate([{
                $match: {
                    keyid: _id,
                }
            }, {
                $group: {
                    _id: null,
                    total: {$sum: "$downloads"},
                    count: {$sum: 1}
                },
            }]).toArray();

            let result = {
                name: user.name,
                key: user.key,
                downloads: stats.total || 0,
                total: stats.count || 0,
            };

            res.end(JSON.stringify(result));
        }catch(e){
            serverLog("Failed: ", e);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({error: e}));
        }
    // /juush/deluser/<userid>
    // Delete a user
    }else if(urldata.path[1] === "deluser"){
        if(!isAdmin(req.connection.remoteAddress)){
            res.writeHead(401, {});
            res.end("You cannot delete users");
            return;
        }

        query.keys.deleteOne({_id: Number(urldata.path[2])})
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
