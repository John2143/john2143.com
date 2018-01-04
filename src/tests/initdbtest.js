import mongo from "mongodb";

describe("database init", function(){
    let query, db;
    before(async function(){
        let mongoServer = new mongo.Server(serverConst.dbopts.ip, serverConst.dbopts.port);
        let client = new mongo.MongoClient(mongoServer);
        let dbclient = await client.connect();
        db = dbclient.db(serverConst.dbopts.db);
        query = db.collection("test");
    });

    const obj = {hello: "world"};

    it("should be queryable", function(){
        query.insert(obj);
        query.deleteMany(obj);
    });

    /* istanbul ignore next */
    if(process.env.SETUPDB){
        it("should reset some databases", function(){
            db.collection("keys")    .deleteMany({});
            db.collection("index")   .deleteMany({});
            db.collection("counters").deleteMany({});
        });
    }
});
