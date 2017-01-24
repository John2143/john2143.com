const pg = require("pg");
const Pool = pg.Pool;

describe("database init", function(){
    let pool;
    before(function(){
        pool = new Pool({
            user: serverConst.dbuser,
            host: serverConst.dbhost,
            database: "juush",
            port: serverConst.dbport,
            password: serverConst.dbpass,
            max: 10,
            idleTimeoutMillis: 100,
        });

        pool.on("error", function(err, client){
            //console.log("Error in client", err);
        });

        expect(pool).to.be.ok;
    });

    it("should be queryable", function(){
        return pool.query("SELECT 1");
    });

    if(process.env.SETUPDB){
        it("!should never drop production databases!", function(){
            return pool.query(`

DROP TABLE IF EXISTS index, keys;
DROP SEQUENCE IF EXISTS keys_id_seq;

                `);
        });

        it("should create some tables", function(){
            return pool.query(`

CREATE SEQUENCE keys_id_seq
    INCREMENT 1
    MINVALUE 1
    MAXVALUE 9223372036854775807
    START 1
    CACHE 1;

CREATE TABLE index
(
  id character varying(8) NOT NULL,
  uploaddate timestamp without time zone,
  ip cidr,
  filename character varying(256),
  mimetype character varying(127),
  keyid integer NOT NULL,
  downloads integer NOT NULL DEFAULT 0,
  lastdownload timestamp without time zone,
  CONSTRAINT index_pkey PRIMARY KEY (id)
);

CREATE TABLE keys
(
  id integer NOT NULL DEFAULT nextval('keys_id_seq'::regclass),
  key character(32),
  name character varying(32),
  CONSTRAINT keys_pkey PRIMARY KEY (id)
);

            `);

        });
    }
});
