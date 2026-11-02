export default [
    {
        files: ["src/**/*.ts", "src/**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                // Node.js
                console: "readonly",
                process: "readonly",
                Buffer: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                setImmediate: "readonly",
                // ES6
                Promise: "readonly",
                Map: "readonly",
                Set: "readonly",
                Symbol: "readonly",
            },
        },
        rules: {
            indent: ["warn", 4],
            quotes: ["error", "double", { avoidEscape: true }],
            semi: ["error", "always"],
            "no-console": "off",
            "no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "no-undef": "warn",
        },
    },
];
