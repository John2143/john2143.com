/**
 * The ITEM/PROGRESS/SUMMARY report shared by the maintenance scripts.
 *
 * Everything goes to a local JSONL file, which is published to Seaweed at the end
 * (`maintenance/<mode>-<dry|real>-<iso>.jsonl`) and named in the SUMMARY. The
 * kubelet rotates container logs at 10 MiB, so stdout alone is not a record.
 */
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { putFilerFile } from "../juush/pipeline.js";

export type ReportInit = { mode: string; dryRun: boolean; runId?: string };

export class Report {
    readonly startedAt = new Date();
    readonly filePath: string;
    readonly reportKey: string;
    readonly counts: Record<string, number> = {};
    items = 0;
    private readonly dryRun: boolean;
    private readonly mode: string;
    private readonly runId: string;
    private readonly stream: ReturnType<typeof createWriteStream>;

    constructor(init: ReportInit) {
        this.mode = init.mode;
        this.dryRun = init.dryRun;
        this.runId = init.runId || "";
        const stamp = this.startedAt.toISOString().replace(/[:.]/g, "-");
        this.filePath = path.join(os.tmpdir(), `${init.mode}-${stamp}.jsonl`);
        this.reportKey = `maintenance/${init.mode}-${init.dryRun ? "dry" : "real"}-${stamp}.jsonl`;
        this.stream = createWriteStream(this.filePath);
    }

    line(obj: unknown): void {
        this.stream.write(`${JSON.stringify(obj)}\n`);
    }

    item(obj: Record<string, unknown>): void {
        const action = String(obj.action);
        this.items++;
        this.counts[action] = (this.counts[action] || 0) + 1;
        this.line(obj);
        console.log(`ITEM ${JSON.stringify(obj)}`);
    }

    progress(extra: Record<string, unknown> = {}): void {
        const obj = { items: this.items, counts: this.counts, at: new Date().toISOString(), ...extra };
        this.line({ k: "#progress", ...obj });
        console.log(`PROGRESS ${JSON.stringify(obj)}`);
    }

    async finish(summary: Record<string, unknown>): Promise<void> {
        await new Promise<void>((resolve, reject) => this.stream.end(() => resolve()).on("error", reject));
        const out: Record<string, unknown> = {
            ...summary,
            reportKey: this.reportKey,
            seconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
            startedAt: this.startedAt.toISOString(),
            dryRun: this.dryRun ? 1 : 0,
            mode: this.mode,
            runId: this.runId || null,
        };
        try {
            await putFilerFile(this.reportKey, this.filePath, "application/x-ndjson");
        } catch (e) {
            console.error(`report upload failed: ${(e as Error).message}`);
            out.reportKey = `${this.reportKey} (upload failed; local ${this.filePath})`;
        }
        console.log(`SUMMARY ${JSON.stringify(out)}`);
    }
}
