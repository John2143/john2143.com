/**
 * Which processing steps an upload still needs. Loaded by the workflow bundle, so
 * its import graph must stay free of node modules (filetype.ts has no imports).
 */
import { classifyUpload } from "../filetype.js";

export type StepName = "thumbnail" | "preview" | "thumbnailCdn" | "webVideo" | "cdn";
export type UploadKind = "video" | "image" | "gif" | "other" | "deleted" | "missing";

export interface PlanDoc {
    mimetype?: string;
    filename?: string;
    cdn?: string;
    thumb?: string;
    preview?: string;
    artifacts?: { faststart?: string; thumbnail?: string };
}

export interface UploadPlan { kind: UploadKind; filename?: string; mimetype?: string; steps: StepName[] }

export const STEP_LABELS: Record<StepName, string> = {
    thumbnail: "make thumbnail",
    preview: "make blur preview",
    thumbnailCdn: "publish thumbnail to CDN",
    webVideo: "make web video (MP4)",
    cdn: "publish to CDN",
};

// Thumbnail and preview come first so the gallery card fills in before a long
// transcode; cdn comes last because for video the CDN copy must be the web MP4.
export function planSteps(doc: PlanDoc | null): UploadPlan {
    if (!doc) return { kind: "missing", steps: [] };
    if (doc.mimetype === "deleted") return { kind: "deleted", filename: doc.filename, mimetype: doc.mimetype, steps: [] };
    const kind = classifyUpload(doc.mimetype, doc.filename);
    const visual = kind === "video" || kind === "image";
    const steps: StepName[] = [];
    if (visual && !doc.artifacts?.thumbnail?.endsWith(".thumb.webp")) steps.push("thumbnail");
    if (kind !== "other" && !doc.preview) steps.push("preview");
    // A legacy .thumb.jpg CDN thumbnail gets republished as WebP.
    if (visual && !doc.thumb?.endsWith(".thumb.webp")) steps.push("thumbnailCdn");
    if (kind === "video" && !doc.artifacts?.faststart) steps.push("webVideo");
    if (!doc.cdn) steps.push("cdn");
    return { kind, filename: doc.filename, mimetype: doc.mimetype, steps };
}

// Markdown checklist for the workflow's current details.
export function renderDetails(url: string, plan: UploadPlan, results: Partial<Record<StepName, string>>): string {
    const head = `**${plan.kind}** \`${plan.filename ?? url}\` ${plan.mimetype ?? ""}`.trim();
    if (plan.steps.length === 0) return `${head}\n\nnothing to do`;
    const lines = plan.steps.map((s) => results[s] !== undefined ? `- [x] ${STEP_LABELS[s]}: ${results[s]}` : `- [ ] ${STEP_LABELS[s]}`);
    return `${head}\n\n${lines.join("\n")}`;
}
