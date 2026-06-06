
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

**Cache eviction and S3 backup** are handled by Kubernetes sidecar containers, NOT by this Node.js application. See `2143-k8s/overlays/prod/deployment-bastion.yaml`:

- **`bastion-pruner`** — Runs `prune.fish` every 60s. When disk usage is high, deletes files older than 24 hours that have been backed up to Minio.
- **`bastion-minio`** — Runs `upload.fish` every 10s. Uploads new files to Minio (S3-compatible) and creates marker files in `processed_minio/`.
- **`bastion-s3`** (commented out) — Same pattern for DigitalOcean Spaces.

The Node.js app ALSO does an async S3 upload after each upload (`upload.ts:479`). The sidecar provides a safety net for any failures.

## Sharex Settings
 1. Go to destination settings
 2. Scroll to custom uploader
 3. Click import from clipboard (after copying settings)
 4. Test settings

![](https://john2143.com/f/1LXy.png)
![](https://john2143.com/f/9rd6.png)
