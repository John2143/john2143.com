# RustFS Lifecycle Tiering — Implementation Plan

## Architecture

```
Upload (Tigris S3)
     │
     ▼
Post-process → RustFS Hot (Longhorn NVMe, 50GB, imagehost-files bucket)
     │                    │
     │ lifecycle:          │ manual: rc mv for files >150MB
     │ transition→COLD    │ (in handleUploadToRustfs)
     │ after 30 days      │
     ▼                    ▼
RustFS Cold (closet X9 SSD, 4TB) ←── bucket replication ──→ RustFS Cold-2 (NAS HDD, 24TB)
```

## What needs to happen

### 1. Admin: Set up cold tier and lifecycle (CLI, one-time)

On the hot RustFS instance (NAS):

```bash
# Add cold tier pointing to closet
rc ilm tier add rustfs COLD local --endpoint http://192.168.5.36:9000 \
  --access-key <admin-key> --secret-key <admin-secret> --bucket cold-files

# Lifecycle rule: objects older than 30 days transition to cold
rc ilm rule add local/imagehost-files --transition-days 30 --storage-class COLD

# Replication: cold closet → cold NAS backup
rc alias set cold http://192.168.5.36:9000 <key> <secret>
rc replicate add local/cold-files \
  --remote-bucket cold/cold-files \
  --replicate delete,delete-marker,existing-objects
```

### 2. Code: Manual transition for large files (jobs.ts)

In `src/juush/jobs.ts`, after the PutObject in `handleUploadToRustfs`, check file size. If >150MB, immediately transition to cold using server-side CopyObject + DeleteObject:

```typescript
// In handleUploadToRustfs, after line 393 (rustfsBackedUp: true):

// Files over 150MB: transition to cold tier immediately
const fileSize = /* from the uploaded content-length or stat */;
if (fileSize > 150 * 1024 * 1024) {
  serverLog(`JobQueue: transitioning ${job.url} to cold tier (${humanFileSize(fileSize)})`);
  const { CopyObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const coldBucket = process.env.COLD_BUCKET || "cold-files";
  
  await U.minio_client.send(new CopyObjectCommand({
    Bucket: coldBucket,
    Key: job.url,
    CopySource: `${process.env.BUCKET || "imagehost-files"}/${encodeURIComponent(job.url)}`,
  }));
  await U.minio_client.send(new DeleteObjectCommand({
    Bucket: process.env.BUCKET || "imagehost-files",
    Key: job.url,
  }));
}
```

### 3. Code: Import CopyObjectCommand (util.ts)

Add `CopyObjectCommand, DeleteObjectCommand` to the S3 import in `src/juush/util.ts` line 17.

### 4. Env: New variables

- `COLD_BUCKET` — cold bucket name (default: `cold-files`)

## How the download flow works after tiering

When a user requests a file that was transitioned to cold:

1. App tries `minio_client.headObject(hotBucket, key)` — returns 404 (moved to cold)
2. App tries `minio_client.headObject(coldBucket, key)` — found
3. App serves from cold bucket
4. OR: restore to hot first via `rc ilm restore hot-bucket/key --days 7`

## Verification

- Manual transition: CopyObject between buckets on same RustFS instance is metadata-only (verified against RustFS source — `TransitionClient` handles server-side copy)
- 30-day lifecycle: `rc ilm rule list local/` shows the rule
- Cold replication: `rc replicate status local/cold-files` shows metrics
