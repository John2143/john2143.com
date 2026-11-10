/**
 * Upload type classification. No imports: the Temporal workflow bundle and the unit
 * tests both load this module, and util.ts constructs a MongoClient at load.
 */
export const guessFileExtension = filename => {
    if(!filename) return null;

    let fileExtension = filename.split(".");
    //No extension
    if(fileExtension.length === 1) return null;
    fileExtension = fileExtension[fileExtension.length - 1];
    //extension too long
    if(fileExtension.length > 8) return null;
    return fileExtension;
};

export const VIDEO_EXTS: Record<string, true> = { mp4: true, m4v: true, mov: true, mkv: true, webm: true, avi: true, wmv: true, flv: true, mpg: true, mpeg: true, "3gp": true };
// Formats sharp's prebuilt libvips reads. Other image/* types (HEIC, BMP) fail
// thumbnailing (logged, non-fatal) and fall back to the full image.
export const IMAGE_EXTS: Record<string, true> = { png: true, jpg: true, jpeg: true, gif: true, webp: true, avif: true, tif: true, tiff: true, svg: true };

export type MediaKind = "video" | "image" | "gif" | "other";

// The mimetype is client-supplied (often application/octet-stream), so the extension counts too.
export function classifyUpload(mimetype: string | undefined, filename: string | undefined): MediaKind {
    const mime = mimetype || "application/octet-stream";
    const ext = (guessFileExtension(filename) ?? "").toLowerCase();
    if (mime.startsWith("video/") || Object.hasOwn(VIDEO_EXTS, ext)) return "video";
    if (mime.startsWith("image/") || Object.hasOwn(IMAGE_EXTS, ext)) {
        return mime === "image/gif" || ext === "gif" ? "gif" : "image";
    }
    return "other";
}
