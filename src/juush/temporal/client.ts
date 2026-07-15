import { Client, Connection } from "@temporalio/client";
import { readFileSync } from "fs";

function getTlsConfig() {
    const dir = process.env.TEMPORAL_TLS_CERT_DIR;
    if (!dir) return undefined;
    try {
        return {
            clientCertPair: {
                crt: readFileSync(`${dir}/tls.crt`),
                key: readFileSync(`${dir}/tls.key`),
            },
            serverRootCACertificate: readFileSync(`${dir}/ca.crt`),
        };
    } catch {
        console.warn("Temporal: TLS cert dir set but files unreadable — connecting without mTLS");
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
        const connection = await Connection.connect({ address, tls: getTlsConfig() });
        client = new Client({ connection, namespace: "john2143-com" });
        console.log(`Temporal: connected to ${address}`);
    } catch (e) {
        console.warn(`Temporal: unavailable at ${address} (${(e as Error).message}) — falling through to Mongo queue`);
        client = null;
    }
}
