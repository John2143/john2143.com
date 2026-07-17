import { fetchTemporalAccessToken, startTemporalAccessTokenRefresh } from "./token-supplier.js";

import { NativeConnection, Worker } from "@temporalio/worker";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as activities from "./activities.js";

function getTlsConfig() {
    const socketPath = (process.env.SPIFFE_ENDPOINT_SOCKET || "").replace("unix://", "");
    if (!socketPath) return undefined;
    try {
        const svidDir = mkdtempSync(join(tmpdir(), "svid-"));
        execSync(`spire-agent api fetch x509 -socketPath ${socketPath} -write ${svidDir} -timeout 30s`, { timeout: 35000 });
        const tlsConfig = {
            clientCertPair: {
                crt: readFileSync(join(svidDir, "svid.0.pem")),
                key: readFileSync(join(svidDir, "svid.0.key")),
            },
            serverRootCACertificate: readFileSync(join(svidDir, "bundle.0.pem")),
        };
        console.log("Temporal: fetched SPIRE X.509 SVID for mTLS");
        return tlsConfig;
    } catch (e) {
        console.warn(`Temporal: SVID fetch failed (${(e as Error).message}) — connecting without mTLS`);
        return undefined;
    }
}

export async function startTemporalWorker(): Promise<void> {
    const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
    let connection: NativeConnection | null = null;
    let worker: Worker | null = null;
    let cancelRefresh: (() => void) | null = null;
    try {
        const token = await fetchTemporalAccessToken();
        connection = await NativeConnection.connect({ address, tls: getTlsConfig(), apiKey: token.token });
        worker = await Worker.create({
            connection,
            namespace: "john2143-com",
            taskQueue: "john2143-com",
            workflowsPath: new URL("./workflows.js", import.meta.url).pathname,
            activities,
        });
        cancelRefresh = startTemporalAccessTokenRefresh(
            async (t) => { connection?.setApiKey(t); },
            async () => { await worker?.shutdown(); },
        );
        console.log(`Temporal: worker started on john2143-com queue (${address})`);
        await worker.run();
    } catch (e) {
        console.warn(`Temporal: worker unavailable (${(e as Error).message}) — uploads use Mongo queue only`);
    } finally {
        cancelRefresh?.();
        await connection?.close();
    }
}
