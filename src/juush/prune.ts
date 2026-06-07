/**
 * Disk cache pruner — weighted scoring to keep disk at ≤50% usage.
 *
 * Scoring: score = age_ms * file_size_bytes / (downloads + 1)
 * Higher score → deleted first. This favors:
 *   - Old files (not downloaded recently)
 *   - Large files (free more space)
 *   - Low-popularity files (few downloads)
 *
 * Videos with many downloads get the lowest scores and are kept longest.
 */
import { serverLog } from "../logger.js";
import { query, getFilename } from "./util.js";
import * as fs from "node:fs/promises";
import { statfs } from "node:fs/promises";

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;  // check every 5 minutes
const TARGET_DISK_PCT = 50;
const MIN_LAST_DOWNLOAD_AGE_MS = 1 * 60 * 60 * 1000;  // 1 hour

let prunerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic pruner. Call once after DB is ready. */
export function startPruner() {
    if (prunerTimer) return;
    serverLog("Pruner: starting with 5min interval, target ≤50% disk");
    prunerTimer = setInterval(handlePrune, PRUNE_INTERVAL_MS);
    // Run once immediately
    handlePrune().catch((e) => serverLog("Pruner: initial run failed", e));
}

/** Stop the periodic pruner. */
export function stopPruner() {
    if (prunerTimer) {
        clearInterval(prunerTimer);
        prunerTimer = null;
    }
}

async function getDiskUsagePct(): Promise<number> {
    try {
        const s = await statfs(getFilename("."));
        const total = s.blocks * Number(s.bsize);
        const free = s.bfree * Number(s.bsize);
        const used = total - free;
        return (used / total) * 100;
    } catch {
        return 0; // can't determine — skip
    }
}

/** Estimate disk pct after deleting `bytesToFree` bytes. */
function estimateDiskAfter(totalBytes: number, bytesToFree: number, currentPct: number): number {
    const total = totalBytes;
    const used = total * (currentPct / 100);
    const newUsed = Math.max(0, used - bytesToFree);
    return (newUsed / total) * 100;
}

export async function handlePrune(): Promise<void> {
    const diskPct = await getDiskUsagePct();
    if (diskPct <= TARGET_DISK_PCT) return;

    serverLog(`Pruner: disk at ${diskPct.toFixed(0)}%, pruning to ≤${TARGET_DISK_PCT}%`);

    const oneHourAgo = new Date(Date.now() - MIN_LAST_DOWNLOAD_AGE_MS);

    // Find candidates: backed-up files not downloaded in the last hour
    const candidates = await query.index.find({
        $or: [
            { lastdownload: { $lt: oneHourAgo } },
            { lastdownload: { $exists: false } },
        ],
        mimetype: { $ne: "deleted" },
    }, {
        projection: { _id: 1, downloads: 1, uploaddate: 1, lastdownload: 1 },
    }).toArray();

    const scored: Array<{
        id: string;
        score: number;
        size: number;
        filePath: string;
        markerPath: string;
    }> = [];

    for (const c of candidates) {
        const filePath = getFilename(c._id);
        const markerPath = getFilename(`processed_minio/${c._id}`);

        try {
            // Check that both the file and its minio backup marker exist on disk
            await Promise.all([
                fs.stat(filePath),
                fs.access(markerPath),
            ]);
        } catch {
            continue; // file missing or not backed up — skip
        }

        const stat = await fs.stat(filePath);
        const size = stat.size;

        const lastAccess = c.lastdownload?.getTime() || c.uploaddate?.getTime() || 0;
        const ageMs = Date.now() - lastAccess;

        // score = age * size / (downloads + 1)
        const score = ageMs * size / ((c.downloads || 0) + 1);

        scored.push({ id: c._id, score, size, filePath, markerPath });
    }

    // Sort highest score first
    scored.sort((a, b) => b.score - a.score);

    // Estimate total bytes to free
    const s = await statfs(getFilename("."));
    const totalBytes = s.blocks * Number(s.bsize);

    let freed = 0;
    let deleted = 0;

    for (const candidate of scored) {
        const currentPct = await getDiskUsagePct();
        if (currentPct <= TARGET_DISK_PCT) break;

        try {
            await fs.unlink(candidate.filePath);
            await fs.unlink(candidate.markerPath).catch(() => {});
            freed += candidate.size;
            deleted++;
        } catch (e) {
            serverLog(`Pruner: failed to delete ${candidate.id}: ${e}`);
        }
    }

    // Clean up stale markers (markers with no corresponding file)
    if (deleted > 0 || scored.length > 0) {
        try {
            const markerDir = getFilename("processed_minio");
            const markers = await fs.readdir(markerDir);
            let staleRemoved = 0;
            for (const marker of markers) {
                const filePath = getFilename(marker);
                try {
                    await fs.access(filePath);
                } catch {
                    // File doesn't exist — marker is stale
                    await fs.unlink(`${markerDir}/${marker}`).catch(() => {});
                    staleRemoved++;
                }
            }
            if (staleRemoved > 0) {
                serverLog(`Pruner: cleaned up ${staleRemoved} stale markers`);
            }
        } catch {
            // marker dir doesn't exist or not accessible
        }
    }

    const finalPct = await getDiskUsagePct();
    serverLog(`Pruner: deleted ${deleted} files (${(freed / 1024 / 1024).toFixed(1)}MB), disk now at ${finalPct.toFixed(0)}%`);
}
