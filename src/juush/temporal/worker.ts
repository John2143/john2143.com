import { setTimeout as sleep } from "node:timers/promises";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { getTemporalTlsConfig } from "./tls.js";
import { ingestTaskQueue } from "../volume.js";
import * as activities from "./activities.js";
import * as ingestActivities from "./ingest-activities.js";

// index.ts owns SIGTERM (drain, flush, then stop workers); the SDK must not
// start its own shutdown on the same signal.
Runtime.install({ shutdownSignals: [] });

type WorkerName = "main" | "ingest";

const running: Record<WorkerName, boolean> = { main: false, ingest: false };
const workers = new Map<WorkerName, Worker>();
const loops: Promise<void>[] = [];
let stopping = false;

// Keeps one worker alive: reconnects with backoff after connection loss or a worker failure.
async function runWorkerLoop(name: WorkerName, makeWorker: (connection: NativeConnection) => Promise<Worker>): Promise<void> {
    const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
    let delayMs = 5_000;
    while (!stopping) {
        let connection: NativeConnection | undefined;
        try {
            connection = await NativeConnection.connect({ address, tls: await getTemporalTlsConfig() });
            const worker = await makeWorker(connection);
            if (stopping) break;
            workers.set(name, worker);
            console.log(`Temporal: ${name} started`);
            running[name] = true;
            delayMs = 5_000;
            await worker.run();
        } catch (e) {
            console.warn(`Temporal: ${name} failed (${(e as Error).message}), retrying`);
        } finally {
            running[name] = false;
            workers.delete(name);
            await connection?.close().catch(() => {});
        }
        if (stopping) break;
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 60_000);
    }
}

function startLoop(name: WorkerName, makeWorker: (connection: NativeConnection) => Promise<Worker>): Promise<void> {
    const loop = runWorkerLoop(name, makeWorker);
    loops.push(loop);
    return loop;
}

// Worker pods: workflows plus the CDN/artifact activities, versioned by TWC.
export async function startMainWorker(): Promise<void> {
    const buildId = process.env.TEMPORAL_WORKER_BUILD_ID;
    const deploymentName = process.env.TEMPORAL_DEPLOYMENT_NAME;
    if (!buildId || !deploymentName) {
        console.warn("Temporal: TWC env missing, not starting worker");
        return;
    }
    await startLoop("main", (connection) => Worker.create({
        connection,
        namespace: "john2143-com",
        taskQueue: "john2143-com",
        workflowsPath: new URL("./workflows.js", import.meta.url).pathname,
        activities,
        maxConcurrentActivityTaskExecutions: 2,
        shutdownGraceTime: "15s",
        workerDeploymentOptions: {
            version: { buildId, deploymentName },
            useWorkerVersioning: true,
            defaultVersioningBehavior: "PINNED",
        },
    }));
}

// Web pods: filer ingest for files on this pod's disk. Unversioned on purpose: the
// server delivers activities on a queue with only unversioned pollers even when the
// workflow is pinned, and versioning here would break that routing.
export async function startIngestWorker(volumeId: string): Promise<void> {
    await startLoop("ingest", (connection) => Worker.create({
        connection,
        namespace: "john2143-com",
        taskQueue: ingestTaskQueue(volumeId),
        activities: ingestActivities,
        maxConcurrentActivityTaskExecutions: 2,
        shutdownGraceTime: "15s",
    }));
}

export function isWorkerRunning(name: WorkerName): boolean {
    return running[name];
}

export async function stopWorkers(timeoutMs: number): Promise<void> {
    stopping = true;
    for (const worker of workers.values()) {
        // shutdown() throws IllegalStateError outside RUNNING.
        if (worker.getState() === "RUNNING") worker.shutdown();
    }
    await Promise.race([Promise.allSettled(loops), sleep(timeoutMs)]);
}
