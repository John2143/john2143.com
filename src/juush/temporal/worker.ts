import { fetchTemporalAccessToken, startTemporalAccessTokenRefresh } from "./token-supplier.js";
import { getTemporalTlsConfig } from "./tls.js";

import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

export async function startTemporalWorker(): Promise<void> {
    const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
    let connection: NativeConnection | null = null;
    let worker: Worker | null = null;
    let cancelRefresh: (() => void) | null = null;
    try {
        const token = await fetchTemporalAccessToken();
        connection = await NativeConnection.connect({
            address,
            tls: await getTemporalTlsConfig(),
            apiKey: token ? token.token : undefined,
        });
        worker = await Worker.create({
            connection,
            namespace: "john2143-com",
            taskQueue: "john2143-com",
            workflowsPath: new URL("./workflows.js", import.meta.url).pathname,
            activities,
        });
        if (token) {
            cancelRefresh = startTemporalAccessTokenRefresh(
                async (t) => { connection?.setApiKey(t); },
                async () => { await worker?.shutdown(); },
            );
        }
        console.log(`Temporal: worker started on john2143-com queue (${address})`);
        await worker.run();
    } catch (e) {
        console.warn(`Temporal: worker unavailable (${(e as Error).message}) — uploads use Mongo queue only`);
    } finally {
        cancelRefresh?.();
        await connection?.close();
    }
}
