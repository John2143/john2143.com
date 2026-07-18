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
        // Read the SVID cert — may contain only the leaf cert, not the full chain.
        // Temporal's mTLS server-side validation needs the complete chain (leaf + intermediates).
        let crt: Buffer = readFileSync(join(svidDir, "svid.0.pem"));
        const pemBoundaries = crt.toString().match(/-----BEGIN CERTIFICATE-----/g);
        if (pemBoundaries && pemBoundaries.length === 1) {
            // Only leaf cert present — fetch the full chain via stdout
            try {
                crt = execSync(`spire-agent api fetch x509 -socketPath ${socketPath} -write - -timeout 30s`, { timeout: 35000 });
                console.log("Temporal: fetched full SVID cert chain (leaf + intermediates)");
            } catch (chainErr) {
                console.warn(`Temporal: full chain fetch failed (${(chainErr as Error).message}) — using leaf cert only`);
                // crt already holds the leaf cert from the file read above
            }
        }
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
