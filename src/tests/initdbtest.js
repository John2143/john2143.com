import mongo from "mongodb";

describe("database init", function(){
    let query, db;
    before(async function(){
        let client = new mongo.MongoClient();
        db = await client.connect(serverConst.dbstring);
        query = db.collection("test");
    });

    const obj = {hello: "world"};

    it("should be queryable", function(){
        query.insert(obj);
        query.remove(obj);
        query.remove();
    });

    if(process.env.SETUPDB){
        it("should reset some databases", function(){
            db.collection("keys")    .remove({});
            db.collection("index")   .remove({});
            db.collection("counters").remove({});
        });
    }
});
