
const U = require("./util.js");

//Create new user
module.exports = function(server, reqx){
    const {res, urldata, req} = reqx;
    //Only people on the same network as the server can create users
    if(U.isAdmin(req.connection.remoteAddress)){
        U.pool.connect(function(err, client, done){
            if(U.dbError(err, client, done)) return;
            var newKey = U.randomStr(32);
            client.query({
                text: "INSERT INTO keys(name, key) VALUES ($1, $2)",
                name: "new_user",
                values: [reqx.urldata.path[1], newKey],
            }, function(err, result){
                if(U.dbError(err, client, done)) return;
                res.writeHead(200, {
                    "Content-Type": "text/html"
                });
                res.end(newKey);
            });
        });
    }else{
        res.writeHead(401, {
            "Content-Type": "text/html"
        });
        res.end("You cannot make users");
    }
};

