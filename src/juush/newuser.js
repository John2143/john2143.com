
import {juushErrorCatch, isAdmin, pool, randomStr} from "./util.js";

//Create new user
export default async function(server, reqx){
    const {res, urldata, req} = reqx;
    //Only people on the same network as the server can create users
    if(isAdmin(req.connection.remoteAddress)){
        var newKey = randomStr(32);
        pool.query({
            text: "INSERT INTO keys(name, key) VALUES ($1, $2)",
            name: "new_user",
            values: [reqx.urldata.path[1], newKey],
        }).then(result => {
            serverLog("A new user has been created", reqx.urldata.path[1], newKey);
            res.setHeader("Content-Type", "text/plain");
            res.end(newKey);
        }).catch(juushErrorCatch(res));
    }else{
        res.writeHead(401, {
            "Content-Type": "text/html"
        });
        res.end("You cannot make users");
    }
};
