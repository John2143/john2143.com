import { setTimeout as sleep } from "node:timers/promises";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalTlsConfig } from "./tls.js";
import * as U from "../util.js";
import type { UploadInput } from "./workflows.js";

let client: Client | null = null;

// Retries until connected; afterwards gRPC reconnects on its own, so the client is
// never dropped. Web pods keep serving uploads meanwhile (the reconciler starts
// their workflows once this succeeds).
export async function connectTemporal(): Promise<void> {
    const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
    let delayMs = 5_000;
    for (;;) {
        try {
            const connection = await Connection.connect({ address, tls: await getTemporalTlsConfig() });
            client = new Client({ connection, namespace: "john2143-com" });
            console.log(`Temporal: connected to ${address}`);
            return;
        } catch (e) {
            console.warn(`Temporal: unavailable at ${address} (${(e as Error).message}), retrying in ${delayMs / 1000}s`);
            await sleep(delayMs);
            delayMs = Math.min(delayMs * 2, 60_000);
        }
    }
}

export async function startUploadWorkflow(
    input: UploadInput,
    workflowId = `upload-${input.url}`,
): Promise<"started" | "exists" | "unavailable"> {
    if (!client) return "unavailable";
    let result: "started" | "exists";
    try {
        await client.workflow.start("ProcessUploadWorkflow", { args: [input], taskQueue: "john2143-com", workflowId });
        result = "started";
    } catch (e) {
        if (!(e instanceof WorkflowExecutionAlreadyStartedError)) {
            console.warn(`Temporal: start ${workflowId} failed: ${(e as Error).message}`);
            return "unavailable";
        }
        result = "exists";
    }
    // Lets the reconciler skip this upload. If the write fails, the reconciler's
    // later start just returns "exists".
    await U.query.index.updateOne({ _id: input.url }, { $set: { workflowStartedAt: new Date() } })
        .catch((e: Error) => console.warn(`Temporal: workflowStartedAt write failed for ${input.url}: ${e.message}`));
    console.log(`Temporal: ${result} ${workflowId}`);
    return result;
}
