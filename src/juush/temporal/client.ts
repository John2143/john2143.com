import { fetchTemporalAccessToken, currentTemporalAccessToken, startTemporalAccessTokenRefresh } from "./token-supplier.js";
import { getTemporalTlsConfig } from "./tls.js";

import { Client, Connection } from "@temporalio/client";

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
            tls: await getTemporalTlsConfig(),
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
