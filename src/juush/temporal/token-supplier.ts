import { createClient } from "spiffe";

export type TemporalAccessToken = { token: string; expiresAt: number };

let cachedToken: TemporalAccessToken | null = null;

export async function fetchTemporalAccessToken(): Promise<TemporalAccessToken> {
    const clientId = process.env.POCKETID_TEMPORAL_CLIENT_ID;
    const tokenUrl = process.env.POCKETID_TOKEN_URL || "https://au.2143.me/api/oidc/token";
    const resource = process.env.POCKETID_TEMPORAL_RESOURCE || "https://temporal.john2143.com";
    const scope = process.env.POCKETID_TEMPORAL_SCOPE || "john2143-com:write";

    if (!clientId) {
        throw new Error("POCKETID_TEMPORAL_CLIENT_ID not set");
    }

    // Fetch fresh JWT-SVID from Workload API
    const spireClient = createClient();
    const svidResponse = await spireClient.fetchJWTSVID({
        audience: ["https://au.2143.me"],
        spiffeId: "",
    });
    const jwtSvid = svidResponse.response.svids[0].svid;

    // Exchange JWT-SVID for PocketID access token
    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        client_id: clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: jwtSvid,
        resource,
        scope,
    });

    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!response.ok) {
        throw new Error(`PocketID token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number; token_type: string };
    if (!data.access_token || !data.expires_in) {
        throw new Error(`PocketID response missing access_token or expires_in`);
    }

    const token: TemporalAccessToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000) - 60000, // refresh 1 min before expiry
    };

    cachedToken = token;
    return token;
}

export function currentTemporalAccessToken(): string {
    if (!cachedToken || Date.now() >= cachedToken.expiresAt) {
        throw new Error("No unexpired Temporal access token available");
    }
    return cachedToken.token;
}

export function startTemporalAccessTokenRefresh(
    onToken: (token: string) => Promise<void> | void,
    onExpired: () => Promise<void> | void,
): () => void {
    let stopped = false;
    const controller = new AbortController();

    async function refreshLoop() {
        while (!stopped) {
            try {
                const { token, expiresAt } = await fetchTemporalAccessToken();
                if (!stopped) {
                    await onToken(token);
                    const delay = Math.max(0, expiresAt - Date.now() - 30000); // refresh 30s before expiry
                    if (delay > 0) {
                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(resolve, delay);
                            controller.signal.addEventListener("abort", () => {
                                clearTimeout(timer);
                                resolve();
                            });
                        });
                    }
                }
            } catch (e) {
                console.warn(`Token refresh failed: ${(e as Error).message}`);
                if (!stopped) {
                    await onExpired();
                }
                break;
            }
        }
    }

    refreshLoop();

    return () => {
        stopped = true;
        controller.abort();
    };
}
