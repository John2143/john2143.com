/**
 * Hands soft-deleted uploads that predate `deletedAt` to the delete reconciler, which purges their
 * CDN and filer copies through DeleteUploadWorkflow (≤ 50 per web pod per minute, starting 10
 * minutes after stamping). Irreversible once a row is purged.
 *
 * Environment
 *   DRY_RUN  "1" prints counts and exits
 *   LIMIT    max rows to stamp, oldest first (default 0 = all); ids are printed when 1..20
 *   UNDO     "1" removes the stamp from rows whose purge has not run yet
 *   DB       as in the web pods
 *
 * Manifest: scripts/maintenance/stamp-legacy-deletes.job.yaml.
 */
import * as U from "../juush/util.js";

const flag = (v: string | undefined) => v === "1" || v === "true";
const DRY_RUN = flag(process.env.DRY_RUN);
const UNDO = flag(process.env.UNDO);
const LIMIT = Number(process.env.LIMIT || 0) || 0;

// Tombstones from before deletes recorded deletedAt.
const LEGACY = { mimetype: "deleted", deletedAt: { $exists: false } };
// Stamped by this script and not purged yet: the only rows UNDO may touch.
const STAMPED = { deleteStampedBy: "legacy-backfill", purgedAt: { $exists: false } };

async function main(): Promise<void> {
    let code = 0;
    try {
        await U.startdb();
        if (DRY_RUN) {
            console.log(`legacy tombstones: ${await U.query.index.countDocuments(LEGACY)}`);
            console.log(`stamped, not yet purged: ${await U.query.index.countDocuments(STAMPED)}`);
        } else if (UNDO) {
            const r = await U.query.index.updateMany(STAMPED, { $unset: { deletedAt: "", deleteStampedBy: "", deleteWorkflowStartedAt: "" } });
            console.log(`unstamped ${r.modifiedCount}`);
        } else {
            let cursor = U.query.index.find(LEGACY, { projection: { _id: 1 } }).sort({ uploaddate: 1 });
            if (LIMIT > 0) cursor = cursor.limit(LIMIT);
            const ids: string[] = (await cursor.toArray()).map((d: { _id: string }) => d._id);
            const r = await U.query.index.updateMany(
                { _id: { $in: ids }, deletedAt: { $exists: false } },
                { $set: { deletedAt: new Date(), deleteStampedBy: "legacy-backfill" } },
            );
            console.log(`stamped ${r.modifiedCount} legacy tombstones`);
            if (LIMIT >= 1 && LIMIT <= 20) console.log(ids.join(" "));
        }
    } catch (e) {
        console.error(`FATAL ${(e as Error)?.stack ?? e}`);
        code = 1;
    }
    await U.mongoclient.close().catch(() => {});
    process.exit(code);
}

void main();
