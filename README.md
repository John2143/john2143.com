[![Build Status](https://travis-ci.org/John2143/john2143.com.svg?branch=master)](https://travis-ci.org/John2143/john2143.com)
[![Coverage Status](https://coveralls.io/repos/github/John2143/john2143.com/badge.svg?branch=master)](https://coveralls.io/github/John2143/john2143.com?branch=master)

This is the code currently being used to run john2143.com and jschmidt.co (443 + 80)

By default, if just an ip and port are given, it acts as a basic routing service, supporting

 - Static content (/pages/ directory)
 - Redirects (redirs table strings, see main.js)
 - Funcions (simiarly to createServer().listen, but with some helpers)

If ssl keys and two ports are provided, then it will run two servers, one to
upgrade http requests to https and one to serve secure content

If (postgres) database info is provided, it will also start a image server,
juush. Access /nuser/<name> to create users and obtain their upload key.

## Sharex Settings
 1. Go to destination settings
 2. Scroll to custom uploader
 3. Click import from clipboard (after copying settings)
 4. Test settings

![](https://john2143.com/f/1LXy.png)
![](https://john2143.com/f/9rd6.png)
