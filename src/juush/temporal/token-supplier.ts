export type TemporalAccessToken = { token: string; expiresAt: number };

let cachedToken: TemporalAccessToken | null = null;

/**
 * Returns undefined — PocketID JWT-SVID token exchange is deferred (Phase 4).
 * Linkerd handles mTLS transparently; Temporal connections work without API keys.
 */
export async function fetchTemporalAccessToken(): Promise<TemporalAccessToken | undefined> {
    console.warn("Temporal: connecting without API key (Linkerd handles mTLS; PocketID token exchange deferred)");
    return undefined;
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
                const result = await fetchTemporalAccessToken();
                if (!result) {
                    // No token available — Linkerd handles mTLS, no refresh needed
                    console.warn("Temporal: no access token to refresh (Linkerd mTLS mode)");
                    if (!stopped) await onExpired();
                    break;
                }
                const { token, expiresAt } = result;
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
