//Server ip to listen on, ipv6 should work fine as well
exports.IP = "192.168.1.5";
//HTTPS port, if null then no https
exports.PORT = 443;
//HTTP port
exports.HTTPPORT = 80;

//SSL info
const pathToKeys = "/etc/letsencrypt/live/www.john2143.com/";
exports.keys = {
    //key:  fs.readFileSync(pathToKeys + "privkey.pem"),
    //cert: fs.readFileSync(pathToKeys + "fullchain.pem"),
    //ca:   fs.readFileSync(pathToKeys + "chain.pem"),
};

//Database info (postgres)
/* Here is what the database actually looks like internally
john@pi ~/server/john2143.com $ psql
psql (9.1.22)
Type "help" for help.

john=> \c juush
You are now connected to database "juush" as user "john".
juush=> \d keys
                                Table "public.keys"
 Column |         Type          |                     Modifiers
--------+-----------------------+---------------------------------------------------
 id     | integer               | not null default nextval('keys_id_seq'::regclass)
 key    | character(32)         |
 name   | character varying(32) |
Indexes:
    "keys_pkey" PRIMARY KEY, btree (id)
    "keys_key_key" UNIQUE CONSTRAINT, btree (key)
    "keys_name_key" UNIQUE CONSTRAINT, btree (name)
Referenced by:
    TABLE "index" CONSTRAINT "index_keyid_fkey" FOREIGN KEY (keyid) REFERENCES keys(id)

juush=> \d index
                                        Table "public.index"
    Column    |            Type             |                       Modifiers
--------------+-----------------------------+-------------------------------------------------------
 id           | character varying(8)        | not null
 uploaddate   | timestamp without time zone |
 ip           | cidr                        |
 filename     | character varying(256)      | default 'upload.bin'::character varying
 mimetype     | character varying(127)      | default 'application/octet-stream'::character varying
 keyid        | integer                     |
 downloads    | integer                     | not null default 0
 lastdownload | timestamp without time zone |
Indexes:
    "index_pkey" PRIMARY KEY, btree (id)
Foreign-key constraints:
    "index_keyid_fkey" FOREIGN KEY (keyid) REFERENCES keys(id)

juush=>
*/
exports.dbpass = "databasePass";
exports.dbuser = "databaseUser";
exports.dbhost = "databaseIP";
