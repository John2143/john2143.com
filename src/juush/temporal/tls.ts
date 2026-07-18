import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface TLSConfig {
    clientCertPair?: {
        crt: Buffer;
        key: Buffer;
    };
    serverRootCACertificate?: Buffer;
}

/**
 * Build a TLS config with SPIRE mTLS, or undefined when TLS is disabled.
 *
 * Requires SPIFFE_ENDPOINT_SOCKET and TEMPORAL_TLS_CA_PATH when
 * TEMPORAL_TLS is enabled.  Fetches the X.509 SVID up to three times
 * with five-second waits between attempts, constructs the full client
 * certificate chain (leaf + bundle), and throws after the third
 * failure — no plain-TLS fallback.
 */
export async function getTemporalTlsConfig(): Promise<TLSConfig | undefined> {
    const tlsEnabled = (process.env.TEMPORAL_TLS ?? "").toLowerCase();
    if (!["1", "true", "yes"].includes(tlsEnabled)) return undefined;

    const socketPath = (process.env.SPIFFE_ENDPOINT_SOCKET ?? "").replace("unix://", "");
    if (!socketPath) {
        throw new Error("TEMPORAL_TLS is enabled but SPIFFE_ENDPOINT_SOCKET is not set");
    }

    const serverCaPath = process.env.TEMPORAL_TLS_CA_PATH;
    if (!serverCaPath) {
        throw new Error("TEMPORAL_TLS is enabled but TEMPORAL_TLS_CA_PATH is not set");
    }

    let lastErr: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
        let svidDir: string | undefined;
        try {
            svidDir = mkdtempSync(join(tmpdir(), "svid-"));
            execFileSync("spire-agent", [
                "api", "fetch", "x509",
                "-socketPath", socketPath,
                "-write", svidDir,
                "-timeout", "30s",
            ], { timeout: 35000 });

            // Concatenate leaf cert with bundle for full chain
            const crt = Buffer.concat([
                readFileSync(join(svidDir, "svid.0.pem")),
                readFileSync(join(svidDir, "bundle.0.pem")),
            ]);

            const tlsConfig: TLSConfig = {
                clientCertPair: {
                    crt,
                    key: readFileSync(join(svidDir, "svid.0.key")),
                },
                serverRootCACertificate: readFileSync(serverCaPath),
            };

            console.log(`Temporal: fetched SPIRE X.509 SVID for mTLS (attempt ${attempt})`);
            return tlsConfig;
        } catch (e) {
            lastErr = e;
            if (attempt < 3) {
                console.warn(
                    `Temporal: SVID fetch attempt ${attempt}/3 failed (${(e as Error).message}) — retrying in 5s`,
                );
                const { promise, resolve } = Promise.withResolvers<void>();
                setTimeout(resolve, 5000);
                await promise;
            }
        } finally {
            if (svidDir) {
                rmSync(svidDir, { recursive: true, force: true });
            }
        }
    }

    throw new Error(
        `Failed to fetch SPIRE X.509 SVID after 3 attempts: ${(lastErr as Error).message}`,
    );
}
