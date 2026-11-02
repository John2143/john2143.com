
This is the code currently being used to run john2143.com and jschmidt.co (443 + 80)

By default, if just an ip and port are given, it acts as a basic routing service, supporting

 - Static content (/pages/ directory)
 - Redirects (redirs table strings, see index.ts)
 - Funcions (simiarly to createServer().listen, but with some helpers)

If ssl keys and two ports are provided, then it will run two servers, one to
upgrade http requests to https and one to serve secure content


If (MongoDB) database info is provided, it will also start a image server,
juush. Access /nuser/<name> to create users and obtain their upload key.

## Architecture Notes

- Web pods write each upload to their own disk, PUT it to the Seaweed filer via `MINIO_ENDPOINT_URL` (in-cluster at home, the WireGuard `home-tunnel-proxy` on DO, never files.john2143.com), and start `ProcessUploadWorkflow`.
- Worker pods build the web MP4, the WebP thumbnail and the ≤160-byte preview, store them on the filer, and push the CDN copies to Spaces.
- `/f/<id>` serves the CDN copy (the web MP4 for video); `/f/<id>/orig` the original inline; `/f/<id>/dl` the original as an attachment; `/f/<id>/thumb` the thumbnail.
- The disk cache is pruned in-process (`prune.ts`).

## Sharex Settings
 1. Go to destination settings
 2. Scroll to custom uploader
 3. Click import from clipboard (after copying settings)
 4. Test settings

![](https://john2143.com/f/1LXy.png)
![](https://john2143.com/f/9rd6.png)
