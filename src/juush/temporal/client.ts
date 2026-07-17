import { fetchTemporalAccessToken, currentTemporalAccessToken, startTemporalAccessTokenRefresh } from "./token-supplier.js";

import { Client, Connection } from "@temporalio/client";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function getTlsConfig() {
    const socketPath = (process.env.SPIFFE_ENDPOINT_SOCKET || "").replace("unix://", "");
    if (!socketPath) return undefined;
    try {
        const svidDir = mkdtempSync(join(tmpdir(), "svid-"));
        execSync(`spire-agent api fetch x509 -socketPath ${socketPath} -write ${svidDir} -timeout 30s`, { timeout: 35000 });
        // Read Temporal server CA cert for server verification
        // (SPIRE bundle is only trusted by the server for client auth)
        const serverCaPath = process.env.TEMPORAL_TLS_CA_PATH;
        const serverRootCACertificate = serverCaPath
            ? readFileSync(serverCaPath)
            : undefined;
        const tlsConfig = {
            clientCertPair: {
                crt: readFileSync(join(svidDir, "svid.0.pem")),
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

let client: Client | null = null;

export function getTemporalClient(): Client | null {
    return client;
}

export async function connectTemporal(): Promise<void> {
    const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
    try {
        const token = await fetchTemporalAccessToken();
        const connection = await Connection.connect({
            address,
            tls: getTlsConfig(),
            apiKey: token ? currentTemporalAccessToken : undefined,
        });
        client = new Client({ connection, namespace: "john2143-com" });
        if (token) {
            startTemporalAccessTokenRefresh(
                () => {},
                async () => { client = null; },
            );
        }
        console.log(`Temporal: connected to ${address}`);
    } catch (e) {
        console.warn(`Temporal: unavailable at ${address} (${(e as Error).message}) — falling through to Mongo queue`);
        client = null;
    }
}
