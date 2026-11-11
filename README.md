
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
- `/f/<id>` serves the CDN copy (the web MP4 for video); `/f/<id>/orig` (or `/original`) the original; `/f/<id>/dl` the original as an attachment; `/f/<id>/thumb` the thumbnail. Only video, audio, raster images, plain text and PDF render inline; every other type (HTML, SVG, XML, ...) is served as an attachment, always with `X-Content-Type-Options: nosniff`.
- Link unfurlers (Discordbot, Slackbot, ...) fetching `/f/<id>` get an Open Graph page instead: a video player for videos whose CDN copy is an MP4/WebM/MOV of at most 80 MiB, otherwise a card with name, type, size and uploader. Images and audio get the raw bytes. These fetches do not count as downloads.
- Changes are `POST /f/<id>/{delete,rename,hide,unhide,reprocess}` by the owner (session `juush_user_id` equal to the upload's `keyid`) or an admin, authenticated by the `session_token` cookie (same-origin `Origin` required) or `Authorization: Bearer <session token>`. `rename` takes `{"name": "..."}`. A GET on these suffixes returns 405; any other GET of a deleted upload returns 410.
- The disk cache is pruned in-process (`prune.ts`).
- A delete keeps the Mongo row as a tombstone (every path returns 410) and starts `DeleteUploadWorkflow`, which removes the Spaces copy and thumbnail, then every filer object (original, web MP4, thumbnail), and stamps `purgedAt`. Each web pod's pruner removes its cached copy within 5 minutes, and a reconciler on the web pods restarts purges that did not finish. The CDN edge may keep serving a copy until its cache TTL expires. Tombstones from before `deletedAt` existed are purged in batches with `scripts/maintenance/stamp-legacy-deletes.job.yaml`.
- Web pods and worker pods are separate deployments of the same image. A purge needs a worker build that knows `DeleteUploadWorkflow`; if a web pod starts one before that, the workflow fails and the delete reconciler starts it again on its next retry (within an hour). After a deploy that changes workflows, check `temporal worker deployment describe --namespace john2143-com --name john2143-com-worker`.

## Operations

**Uploads stuck without a filer copy.** A web pod serves an upload from its own disk and ingests it to the filer inside `ProcessUploadWorkflow`; until that succeeds, `rustfsBackedUp` stays `"uploading"` and there is no filer copy. The ingest reconciler starts workflows for uploads that never started (10 min grace) and retries stuck ones whose start is more than an hour old, so an outage heals itself. A row whose file is gone from its volume's disk is marked `ingestFailed: "local-copy-missing"` once, instead of looping; clearing that field retries it.
- Find stuck rows: `{ rustfsBackedUp: "uploading", mimetype: { $ne: "deleted" } }`.
- `volumeId` identifies the disk holding the file (`./juushFiles/.volume-id`, stable across restarts) and ingest activities run on the per-volume queue, so only the pod owning that disk can ingest. The home cluster and the DOKS cluster have different volume ids, and their disks are not interchangeable.
- Every pod that ingests needs its S3 access key in the filer's identity config (`seaweedfs-s3-config`). A key the filer does not know fails with `InvalidAccessKeyId`, which no reconciler can fix.
- To recover uploads from a volume that cannot reach the filer: copy the files out of that pod's `/app/juushFiles`, write them into a pod whose key works, point those rows at the receiving pod's `volumeId`, unset `workflowStartedAt`, and terminate any still-open `upload-<id>` workflow first (a closed run can be restarted under the same id).
- Writes for one upload are independent of deletes: every artifact write is conditional on the upload not being deleted, and a losing write removes what it just stored.

**Purges.** A delete starts `delete-<id>` (3 activities: CDN, filer, mark). Verify one with `temporal workflow show` and by checking `purgedAt`. A purge that failed is retried hourly by the delete reconciler. The one-time purge of tombstones that predate `deletedAt` runs from `scripts/maintenance/stamp-legacy-deletes.job.yaml` (`DRY_RUN=1`, then `LIMIT=5`, then `LIMIT=0`; `UNDO=1` works until the first purge of that batch, about 10 minutes).

## Sharex Settings
 1. Go to destination settings
 2. Scroll to custom uploader
 3. Click import from clipboard (after copying settings)
 4. Test settings

![](https://john2143.com/f/1LXy.png)
![](https://john2143.com/f/9rd6.png)
