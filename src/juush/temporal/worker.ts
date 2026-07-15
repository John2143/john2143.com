import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

export async function startTemporalWorker(): Promise<void> {
    const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
    try {
        const connection = await NativeConnection.connect({ address });
        const worker = await Worker.create({
            connection,
            namespace: "john2143-com",
            taskQueue: "john2143-com",
            workflowsPath: new URL("./workflows.js", import.meta.url).pathname,
            activities,
        });
        await worker.run();
        console.log(`Temporal: worker started on john2143-com queue (${address})`);
    } catch (e) {
        console.warn(`Temporal: worker unavailable (${(e as Error).message}) — uploads use Mongo queue only`);
    }
}
