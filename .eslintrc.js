module.exports = {
    "env": {
        "commonjs": true,
        "node": true,
        "mocha": true,
        "mongo": true,
        "es6": true
    },
    "extends": "eslint:recommended",
    "parserOptions": {
        "sourceType": "module",
        "ecmaVersion": 8
    },
    "rules": {
        "indent": [
            "error",
            4
        ],
        "linebreak-style": [
            "error",
            "windows"
        ],
        "quotes": [
            "error",
            "double",
            {"avoidEscape": true}
        ],
        "semi": [
            "error",
            "always"
        ],
        "no-console": "off",
        "no-unused-vars": [
            "warn",
            {"argsIgnorePattern": "^_",
             "varsIgnorePattern": "^_"}
        ],
        "no-undef": "warn",
        "indent": "warn",
    },
    "globals": {
        "fs"         : true,
        "serverLog"  : true,
        "serverConst": true,
        "chai"       : true,
        "query"      : true,
        "expect"     : true,
    }
};
