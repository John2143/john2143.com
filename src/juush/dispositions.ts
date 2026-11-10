/**
 * Which `/f/<id>/<suffix>` dispositions ask for the byte-exact upload. A separate
 * module with no imports: importing download.ts pulls in util.ts, which constructs
 * a MongoClient at module load, so the table must be testable on its own.
 */
export const ORIGINAL_DISPOSITIONS: Record<string, true> = { orig: true, original: true, dl: true };

export function isOriginalDisposition(disposition: string | undefined): boolean {
    return disposition !== undefined && Object.hasOwn(ORIGINAL_DISPOSITIONS, disposition);
}

// Types a browser may render on our origin. Everything else is served as an attachment.
export const INLINE_SAFE_TYPES: Record<string, true> = {
    "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true,
    "image/bmp": true, "image/x-icon": true, "image/vnd.microsoft.icon": true,
    "text/plain": true, "application/pdf": true,
};

// Video and audio cannot run script; SVG, HTML and XML can, so they never render inline.
export function isInlineSafe(mimetype: string | undefined): boolean {
    const essence = (mimetype ?? "").split(";")[0].trim().toLowerCase();
    return essence.startsWith("video/") || essence.startsWith("audio/") || Object.hasOwn(INLINE_SAFE_TYPES, essence);
}

// RFC 6266: an ASCII fallback for old clients plus the exact name as RFC 5987 filename*.
export function contentDisposition(type: "inline" | "attachment", filename: string | undefined): string {
    if (!filename) return type;
    const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Suffixes that change an upload. They are POST-only; a GET gets 405.
export const MUTATION_VERBS: Record<string, true> = { delete: true, rename: true, hide: true, unhide: true, reprocess: true };

export function isMutationVerb(disposition: string | undefined): boolean {
    return disposition !== undefined && Object.hasOwn(MUTATION_VERBS, disposition);
}
