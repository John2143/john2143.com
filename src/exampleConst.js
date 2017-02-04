//Server ip to listen on, ipv6 should work fine as well
export const IP = "localhost";
//HTTPS port, if null then no https
export const PORT = 443;
//HTTP port
export const HTTPPORT = 80;

//SSL info
const pathToKeys = "/etc/letsencrypt/live/example.com/";
export const keys = {
    key:  fs.readFileSync(pathToKeys + "privkey.pem"),
    cert: fs.readFileSync(pathToKeys + "fullchain.pem"),
    ca:   fs.readFileSync(pathToKeys + "chain.pem"),
};

export const dbstring = "mongodb://....";
