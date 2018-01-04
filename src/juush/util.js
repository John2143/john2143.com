import mongodb from "mongodb";

export const mongoserver = new mongodb.Server(serverConst.dbopts.ip, serverConst.dbopts.port);
export const mongoclient = new mongodb.MongoClient(mongoserver);
export let query;

export const initializeMongo = async () => {
    let dbclient = await mongoclient.connect();
    let db = dbclient.db(serverConst.dbopts.db);
    const countersSeen = [];

    const counters = db.collection("counters");

    query = {
        keys: db.collection("keys"),
        index: db.collection("index"),
        async counter(name){
            if(!countersSeen[name]){
                //Make sure the counter has been initialized
                await counters.updateOne(
                    {_id: name},
                    {$setOnInsert: {value: 1}},
                    {upsert: true}
                );
                countersSeen[name] = true;
            }

            const counter = await counters.findOneAndUpdate(
                {_id: name},
                {$inc: {value: 1}}
            );

            return counter.value.value;
        }
    };
    if(global.it) global.query = query;
    setTimeout(() => dbclient.close(), 5000);
};

//This works with dbError to end a broken session
export const juushError = function(res, err, code){
    if(!res){
        serverLog("!!!!!something super weird happened...");
        try{throw new Error();}catch(e){
            serverLog(e);
        }
        return;
    }

    res.writeHead(code, {
        "Content-Type": "text/html",
    });
    res.end("Internal server error.");
    serverLog("JuushError!");
    if(err) serverLog(err);
};

//This is an error wrapper
export const juushErrorCatch = (res, code = 500) =>
    err => juushError(res, err, code);

//This is used to create a random string as an ID
export const randomStr = function(length = 32){
    const charSet = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    //Random index from charset
    const ran = () => Math.floor(Math.random() * charSet.length);
    let str = "";
    for(let i = 0; i < length; i++){
        str += charSet[ran() % charSet.length];
    }
    return str;
};

export const guessFileExtension = filename => {
    if(!filename) return null;

    let fileExtension = filename.split(".");
    //No extension
    if(fileExtension.length === 1) return null;
    fileExtension = fileExtension[fileExtension.length - 1];
    //extension too long
    if(fileExtension.length > 8) return null;
    return fileExtension;
};

export let isAdmin;
if(global.it){
    global.testIsAdmin = true;
    isAdmin = __ip => global.testIsAdmin;
}else{
    isAdmin = ip => ip.indexOf("192.168") >= 0 || ip === "127.0.0.1" || ip === "::1";
}

export const IPEqual = (a, b) => a && b && a.split("/")[0] === b.split("/")[0];
export const getFilename = id => "./juushFiles/" + id;

//Returns false if access is granted
export const ipHasAccess = async (ip, uploadID, queryStub = query) => {
    //Querystub is passed only for testing purposes. See tests/units.js
    if(!queryStub) throw new Error("Trying to use util function without db init");

    let result = await queryStub.index.findOne({_id: uploadID}, {keyid: 1});
    if(!result) throw new Error("MongoDB failure");
    const keyid = result.keyid;
    if(!keyid) return "NOFILE";


    result = await queryStub.index
        .find({keyid}, {ip: 1})
        //.sort({uploaddate: 1})
        .toArray();

    if(!result) throw new Error("MongoDB failure");

    if(result.length === 0){
        return "NOUPLOADS";
    }

    for(let x of result){
        if(IPEqual(x.ip, ip)){
            return false;
        }
    }

    return "NOACCESS";
};

export const setModifier = async (uploadID, modifier, value) => {
    const isUnset = value === undefined;
    await query.index.updateOne({_id: uploadID}, {
        [isUnset ? "$unset" : "$set"]: {
            ["modifiers." + modifier]: isUnset ? 1 : value,
        }
    });
};

export const whoami = async ip => (await query.index.distinct("keyid", {ip}));
