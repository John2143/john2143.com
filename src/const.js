"use strict";

exports.IP = process.env.IP || "0.0.0.0";
exports.HTTPPORT = process.env.PORT || 3000;

exports.dbstring = process.env.DB || "mongodb://admin:pass@mongo/";
//exports.dbstring = "mongodb://localhost/";
//exports.dbstring = "mongodb://127.0.0.1:9876/juush";
