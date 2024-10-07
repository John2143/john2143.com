"use strict";

import { MongoClient } from "mongodb";
import { S3Client, PutObjectCommand, UploadPartCommand, CreateMultipartUploadCommand, CompleteMultipartUploadCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";

export let mongoclient = new MongoClient(serverConst.dbstring);
export let query;

export let db_index;
export let db_keys;

export let s3_client: S3Client;
export let fake_s3_client: S3Client;

export async function test_uploads() {
    console.log("Uploading test file to s3");
    let res = await s3_client.send(new PutObjectCommand({
        Bucket: process.env.BUCKET,
        Key: "test/access_upload_test",
        Body: "Hello, World!",
        ACL: "private",
    }));
    console.log("Uploaded test file to s3");

    let tr = await s3_client.send(new ListMultipartUploadsCommand({
        Bucket: process.env.BUCKET,
        MaxUploads: 10,
    }));

    console.log("Checking multipart uploads");

    // Uploads: [
    // {
    //   UploadId: '2~_Z9dKoL7ZgqlIEAij8sVkF1Htke9H84',
    //   Key: 'dev/abcd',
    //   Initiated: 2024-10-06T21:46:07.328Z,
    //   StorageClass: 'STANDARD',
    //   Owner: [Object],
    //   Initiator: [Object]
    // },
    for(let upload of tr.Uploads || []) {
        let upload_age_seconds = (new Date().getTime() - upload.Initiated.getTime()) / 1000;
        if(!upload.Key.startsWith(process.env.FOLDER + "/")){
            continue;
        }
        if(upload_age_seconds > 60){
            console.log("Aborting upload: ", upload.UploadId);
            await s3_client.send(new AbortMultipartUploadCommand({
                Bucket: process.env.BUCKET,
                Key: upload.Key,
                UploadId: upload.UploadId,
            }));
        }
    }
}

export async function test_multipart_uploads() {

    // Create multipart upload
    let mpu = await s3_client.send(new CreateMultipartUploadCommand({
        Bucket: process.env.BUCKET,
        Key: "test/access_upload_test",
        ACL: "public-read",
    }));

    let entry = [];

    for(let i = 0; i < 10; i++){
        // Now start uploading parts
        let res = await s3_client.send(new UploadPartCommand({
            Bucket: "imagehost-files",
            Key: "test/access_upload_test",
            ContentLength: 1024 * 1024 * 7,
            Body: Array(1024 * 1024 * 7).fill(32),
            UploadId: mpu.UploadId,
            PartNumber: i + 1,
        }));
        entry.push({
            ETag: res.ETag,
            PartNumber: i + 1,
        });
    }

    console.log(entry);

    let res2 = await s3_client.send(new CompleteMultipartUploadCommand({
        Bucket: "imagehost-files",
        Key: "a/test3",
        UploadId: mpu.UploadId,
        MultipartUpload: {
            Parts: entry,
        }
    }));

    console.log(res2);
}

export async function startdb() {
    // If the user set this environment variable, we will use s3
    if(process.env.S3_ENDPOINT_URL){
        console.log("setting up s3 connection");
        s3_client = new S3Client({
            endpoint: `${process.env.S3_ENDPOINT_URL}`,
            forcePathStyle: false,
            region: "us-east-1",
            maxAttempts: 5,
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY,
                secretAccessKey: process.env.S3_SECRET_KEY,
            },
        });

        await test_uploads();
    }

    console.log("Connecting to database...");
    let cli = await mongoclient.connect();
    let db = cli.db("juush");
    const countersSeen = [];

    const counters = db.collection("counters");
    console.log("Connected to database.");
    db_keys = db.collection("keys");
    db_index = db.collection("index");

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
}

//This works with dbError to end a broken session
export const juushError = function(res, err, code){
    serverLog(err, code);
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
    isAdmin = ip => ip === "127.0.0.1" || ip === "::1";
}

export const IPEqual = (a, b) => a && b && a.split("/")[0] === b.split("/")[0];
export const getFilename = id => "./juushFiles/" + id;

export const ipHasAccess = async (ip, uploadID) => {
    //"SELECT ip FROM index WHERE keyid=(SELECT keyid FROM index WHERE id=$1) GROUP BY ip ORDER BY max(uploaddate)",
    const keyid = (await query.index.findOne({_id: uploadID}, {keyid: 1})).keyid;
    if(!keyid) return "NOFILE";

    const result = await query.index
        .find({keyid}, {uploaddate: 1, ip: 1})
        //.sort({uploaddate: 1})
        .toArray();

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
