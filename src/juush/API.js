
import {juushErrorCatch, isAdmin, query, whoami} from "./util.js";

//Returns true on success, false if it failed
const genericAPIOperationResult = res => result => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({success: result.result.n >= 1 ? true : false}));
};

const genericJSON = res => obj => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
};

export default async function(server, reqx){
    const {res, urldata, req} = reqx;
    // /juush/uploads/<userid>/[page]/
    // lists some number of uploads from a user, with an optional offset
    const ip = req.headers["x-real-ip"];

    if(urldata.path[1] === "uploads"){
        const [, , userid_, page = 0] = urldata.path;
        const userid = Number(userid_);

        let queryObj = {
            keyid: userid,
        };

        if(urldata.query["hidden"]){
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

        const perPage = 25;
        query.index.find(queryObj, {
            filename: 1, mimetype: 1, downloads: 1, uploaddate: 1, modifiers: 1
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
        whoami(ip)
            .then(genericJSON(res))
            .catch(juushErrorCatch(res));
    // /juush/userinfo/<userid>
    // Give info about a user.
    }else if(urldata.path[1] === "userinfo"){
        try{
            let projection = {name: 1, autohide: 1, customURL: 1};
            if(urldata.query["key"]){
                if(!await isAdmin(ip)){
                    res.statusCode = 403;
                    res.end("You may not see user keys");
                    return;
                }
                projection.key = 1;
            }

            res.setHeader("Content-Type", "application/json");

            const _id = Number(urldata.path[2]);

            const user = await query.keys.findOne({_id}, projection);

            if(!user){
                res.end(JSON.stringify({error:
                    `User ${_id} not found`
                }));
                return;
            }

            //Try to get stats, or return an empty object if no stats found
            const stats = await query.index.aggregate([])
                .match({keyid: _id})
                .group({
                    _id: "mem",
                    total: {$sum: "$downloads"},
                    count: {$sum: 1},
                })
                .next() || {};

            let result = {
                name: user.name,
                key: user.key,
                customURL: user.customURL,
                autohide: user.autohide,
                downloads: stats.total || 0,
                total: stats.count || 0,
            };

            res.end(JSON.stringify(result));
        }catch(e){
            serverLog("Failed: ", e);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({error: e.message}));
        }
    // /juush/deluser/<userid>
    // Delete a user
    }else if(urldata.path[1] === "deluser"){
        if(!isAdmin(ip)){
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
        if(urldata.path[2]) ip = urldata.path[2];
        res.setHeader("Content-Type", "text/plain");
        res.end(isAdmin(ip) ? "true" : "false");
    // /juush/usersetting/<id>/<setting>/<value>
    }else if(urldata.path[1] === "usersetting"){
        let _id = Number(urldata.path[2]);

        if(!(await whoami(ip)).includes(_id)){
            res.statusCode = 403;
            res.end("You cannot change settings for this user");
            return;
        }

        let setting = urldata.path[3];
        let newvalue = urldata.path[4];
        if(setting === "autohide"){
            newvalue = newvalue == "true";
            await query.keys.updateOne({_id}, {$set: {autohide:
                newvalue
            }});
        }else if(setting === "customURL"){
            if(newvalue === "") newvalue = null;
            await query.keys.updateOne({_id}, {$set: {customURL:
                newvalue
            }});
        }else{
            res.statusCode = 405;
            res.end("unknown option");
        }

        res.end  (`setting changed for ${_id}: '${setting}' = '${newvalue}'`);
        serverLog(`setting changed for ${_id}: '${setting}' = '${newvalue}'`);
    }else{
        res.statusCode = 405;
        res.end("Unknown method");
    }
}
