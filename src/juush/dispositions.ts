/**
 * Which `/f/<id>/<suffix>` dispositions ask for the byte-exact upload. A separate
 * module with no imports: importing download.ts pulls in util.ts, which constructs
 * a MongoClient at module load, so the table must be testable on its own.
 */
export const ORIGINAL_DISPOSITIONS: Record<string, true> = { orig: true, original: true, dl: true };

export function isOriginalDisposition(disposition: string | undefined): boolean {
    return disposition !== undefined && Object.hasOwn(ORIGINAL_DISPOSITIONS, disposition);
}
