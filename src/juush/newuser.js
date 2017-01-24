
const U = require("./util.js");

//Create new user
module.exports = async function(server, reqx){
    const {res, urldata, req} = reqx;
    //Only people on the same network as the server can create users
    if(U.isAdmin(req.connection.remoteAddress)){
        var newKey = U.randomStr(32);
        U.pool.query({
            text: "INSERT INTO keys(name, key) VALUES ($1, $2)",
            name: "new_user",
            values: [reqx.urldata.path[1], newKey],
        }).then(result => {
            serverLog("A new user has been created", reqx.urldata.path[1], newKey);
            res.setHeader("Content-Type", "text/plain");
            res.end(newKey);
        }).catch(U.juushErrorCatch(res));
    }else{
        res.writeHead(401, {
            "Content-Type": "text/html"
        });
        res.end("You cannot make users");
    }
};
