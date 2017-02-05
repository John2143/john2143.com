
import {juushErrorCatch, isAdmin, query, randomStr} from "./util.js";

//Create new user
export default async function(server, reqx){
    const {res, urldata, req} = reqx;
    //Only people on the same network as the server can create users
    if(isAdmin(req.connection.remoteAddress)){
        const key = randomStr(32);
        const name = urldata.path[1];

        query.keys.insert({
            name, key,
            _id: await query.counter("keyid"),
        }).then(_result => {
            serverLog("A new user has been created", name, key);
            res.setHeader("Content-Type", "text/plain");
            res.end(key);
        }).catch(juushErrorCatch(res));
    }else{
        res.writeHead(401, {
            "Content-Type": "text/html"
        });
        res.end("You cannot make users");
    }
}
