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
        // svid.0.pem has leaf + intermediate; bundle.0.pem has the root CAs.
        // Concatenate both so Temporal's server-side mTLS gets the full chain.
        const crt = Buffer.concat([
            readFileSync(join(svidDir, "svid.0.pem")),
            readFileSync(join(svidDir, "bundle.0.pem")),
        ]);
        // Read Temporal server CA cert for server verification
        // (SPIRE bundle is only trusted by the server for client auth)
        const serverCaPath = process.env.TEMPORAL_TLS_CA_PATH;
        const serverRootCACertificate: Buffer | undefined = serverCaPath
            ? readFileSync(serverCaPath)
            : undefined;
        const tlsConfig = {
            clientCertPair: {
                crt,
                key: readFileSync(join(svidDir, "svid.0.key")),
            },
            serverRootCACertificate,
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
        connection = await NativeConnection.connect({
            address,
            tls: getTlsConfig(),
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
