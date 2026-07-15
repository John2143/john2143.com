import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";

const { checkFileOnDisk, downloadFromS3IfMissing, uploadToSeaweedFS, markRustfsBackedUp } =
    proxyActivities<typeof activities>({
        startToCloseTimeout: "5 minutes",
        retry: { maximumAttempts: 5 },
    });

export async function UploadToRustFSWorkflow(url: string, mimetype: string): Promise<void> {
    await checkFileOnDisk(url);
    await downloadFromS3IfMissing(url, mimetype);
    await uploadToSeaweedFS(url);
    await markRustfsBackedUp(url);
}
