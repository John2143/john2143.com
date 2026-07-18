import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { getTemporalTlsConfig } from "../juush/temporal/tls.js";

describe("getTemporalTlsConfig", () => {
    beforeEach(() => {
        process.env.TEMPORAL_TLS = "true";
        process.env.SPIFFE_ENDPOINT_SOCKET = "unix:///run/spire/socket";
        process.env.TEMPORAL_TLS_CA_PATH = "/etc/certs/ca.crt";
        delete process.env.TEMPORAL_TLS_SERVER_NAME;
    });

    afterEach(() => {
        mock.restoreAll();
    });

    it("returns undefined when TEMPORAL_TLS is false", async () => {
        process.env.TEMPORAL_TLS = "false";
        assert.strictEqual(await getTemporalTlsConfig(), undefined);
    });

    it("returns undefined when TEMPORAL_TLS is unset", async () => {
        delete process.env.TEMPORAL_TLS;
        assert.strictEqual(await getTemporalTlsConfig(), undefined);
    });

    it("throws when SPIFFE_ENDPOINT_SOCKET is missing", async () => {
        delete process.env.SPIFFE_ENDPOINT_SOCKET;
        await assert.rejects(
            () => getTemporalTlsConfig(),
            { message: /SPIFFE_ENDPOINT_SOCKET/ },
        );
    });

    it("throws when TEMPORAL_TLS_CA_PATH is missing", async () => {
        delete process.env.TEMPORAL_TLS_CA_PATH;
        await assert.rejects(
            () => getTemporalTlsConfig(),
            { message: /TEMPORAL_TLS_CA_PATH/ },
        );
    });
});
