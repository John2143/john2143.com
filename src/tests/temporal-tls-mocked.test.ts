/**
 * Mocked tests for getTemporalTlsConfig — run with:
 *   node --experimental-test-module-mocks c/tests/temporal-tls-mocked.test.js
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { TLSConfig } from "../juush/temporal/tls.js";

let execBehaviour: Array<"throw" | "ok"> = [];
let execCallCount = 0;
let mkdtempDirs: string[] = [];
let mkdtempCallCount = 0;
let fileData: Record<string, string> = {};

function reset(): void {
    execBehaviour = [];
    execCallCount = 0;
    mkdtempDirs = [];
    mkdtempCallCount = 0;
    fileData = {};
}

let getTemporalTlsConfig: () => Promise<TLSConfig | undefined>;

describe("getTemporalTlsConfig (mocked)", () => {
    before(async () => {
        mock.module("node:fs", {
            exports: {
                mkdtempSync: () => {
                    const dir = mkdtempDirs[mkdtempCallCount] ?? "/tmp/svid-fb";
                    mkdtempCallCount++;
                    return dir;
                },
                rmSync: () => {},
                readFileSync: (p: string) => {
                    const data = fileData[p];
                    if (!data) throw new Error("Unexpected read: " + p);
                    return Buffer.from(data);
                },
            },
        });
        mock.module("node:child_process", {
            exports: {
                execFileSync: () => {
                    const action = execBehaviour[execCallCount] ?? "ok";
                    execCallCount++;
                    if (action === "throw") {
                        throw new Error("spire-agent: connection refused");
                    }
                },
            },
        });

        mock.timers.enable({ apis: ["setTimeout"] });

        const mod = await import("../juush/temporal/tls.js");
        getTemporalTlsConfig = mod.getTemporalTlsConfig;

        process.env.TEMPORAL_TLS = "true";
        process.env.SPIFFE_ENDPOINT_SOCKET = "unix:///run/spire/socket";
        process.env.TEMPORAL_TLS_CA_PATH = "/etc/certs/ca.crt";
    });

    after(() => {
        mock.restoreAll();
    });

    it("constructs full cert chain on first attempt", async () => {
        reset();
        execBehaviour = ["ok"];
        mkdtempDirs = ["/tmp/svid-abc"];
        fileData = {
            "/tmp/svid-abc/svid.0.pem": "leaf-cert\n",
            "/tmp/svid-abc/bundle.0.pem": "bundle-cert\n",
            "/tmp/svid-abc/svid.0.key": "key-data\n",
            "/etc/certs/ca.crt": "ca-cert\n",
        };

        const config = await getTemporalTlsConfig();

        assert.ok(config);
        assert.ok(config.clientCertPair);
        assert.ok(config.clientCertPair.crt.toString().includes("leaf-cert"));
        assert.ok(config.clientCertPair.crt.toString().includes("bundle-cert"));
        assert.ok(config.clientCertPair.key.toString().includes("key-data"));
        assert.ok(config.serverRootCACertificate.toString().includes("ca-cert"));
        assert.strictEqual(execCallCount, 1);
    });

    it("succeeds on second attempt after first failure", async () => {
        reset();
        execBehaviour = ["throw", "ok"];
        mkdtempDirs = ["/tmp/svid-1", "/tmp/svid-2"];
        fileData = {
            "/tmp/svid-2/svid.0.pem": "leaf-cert\n",
            "/tmp/svid-2/bundle.0.pem": "bundle-cert\n",
            "/tmp/svid-2/svid.0.key": "key-data\n",
            "/etc/certs/ca.crt": "ca-cert\n",
        };

        const promise = getTemporalTlsConfig();
        // Attempt 1 fails, setTimeout(5000) fires, attempt 2 succeeds
        mock.timers.tick(5000);
        const config = await promise;

        assert.ok(config);
        assert.strictEqual(execCallCount, 2);
    });

    it("throws after three failures", async () => {
        reset();
        execBehaviour = ["throw", "throw", "throw"];
        mkdtempDirs = ["/tmp/svid-fail"];

        const promise = getTemporalTlsConfig();
        // Attempt 1 fails, setTimeout(5000) fires
        mock.timers.tick(5000);
        // Flush microtask: attempt 1's await resolves, attempt 2 runs, fails,
        // setTimeout(5000) scheduled
        await new Promise<void>((r) => queueMicrotask(r));
        // Fire the second setTimeout
        mock.timers.tick(5000);
        // Flush microtask: attempt 2's await resolves, attempt 3 runs, fails,
        // loop exits, throws → promise rejected
        await new Promise<void>((r) => queueMicrotask(r));

        await assert.rejects(
            () => promise,
            { message: /3 attempts/ },
        );

        assert.strictEqual(execCallCount, 3);
    });
});
