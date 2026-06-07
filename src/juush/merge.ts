/**
 * Admin Merge Panel handlers — merging user documents.
 *
 * Pure functions (no Hono context, no auth). Auth is handled by route wrappers.
 */
import { serverLog } from "../logger.js";

// Fields users can choose between target/source
const CHOICE_FIELDS = ["display_name", "username", "key", "autohide", "customURL", "primary_provider"];

// Fields always compared in diff
const COMPARE_FIELDS = [...CHOICE_FIELDS, "juush_user_id", "is_admin", "disabled"];

/**
 * Search users by query string. Returns up to 20 results.
 */
export async function handleMergeSearch(usersCol: any, q: string): Promise<any[]> {
    if (!q || q.length < 2) return [];

    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(safe, "i");

    const conditions: any[] = [
        { key: regex },
        { username: regex },
        { display_name: regex },
        { "oauth.pocketid.email": regex },
        { "oauth.discord.username": regex },
    ];

    // Exact number match for juush_user_id
    if (/^\d+$/.test(q)) {
        conditions.push({ juush_user_id: parseInt(q, 10) });
    }

    const results = await usersCol.find(
        { $or: conditions },
        {
            projection: {
                _id: 1, juush_user_id: 1, username: 1, display_name: 1,
                key: 1, primary_provider: 1,
            },
            limit: 20,
        }
    ).toArray();

    return results.map((u: any) => ({
        _id: u._id,
        juush_user_id: u.juush_user_id,
        username: u.username,
        display_name: u.display_name,
        key_prefix: u.key ? u.key.substring(0, 8) + "..." : null,
        primary_provider: u.primary_provider,
    }));
}

/**
 * Preview diff between two user documents.
 */
export async function handleMergePreview(usersCol: any, id1: string, id2: string): Promise<any> {
    const user1 = await usersCol.findOne({ _id: id1 });
    const user2 = await usersCol.findOne({ _id: id2 });

    if (!user1 || !user2) {
        throw new Error(`User not found: ${!user1 ? id1 : id2}`);
    }

    const diffs: string[] = [];
    for (const field of COMPARE_FIELDS) {
        if (JSON.stringify(user1[field]) !== JSON.stringify(user2[field])) {
            diffs.push(field);
        }
    }

    const providers1 = Object.keys(user1.oauth || {});
    const providers2 = Object.keys(user2.oauth || {});
    const allProviders = [...new Set([...providers1, ...providers2])];
    if (allProviders.length > 0 && providers1.join() !== providers2.join()) {
        if (!diffs.includes("oauth")) diffs.push("oauth");
    }

    const pick = (u: any) => ({
        _id: u._id,
        juush_user_id: u.juush_user_id,
        username: u.username,
        display_name: u.display_name,
        key_prefix: u.key ? u.key.substring(0, 8) + "..." : null,
        autohide: u.autohide,
        customURL: u.customURL,
        primary_provider: u.primary_provider,
        is_admin: u.is_admin,
        disabled: u.disabled,
        oauth_providers: providers1 === Object.keys(u.oauth || {}) ? providers1 : Object.keys(u.oauth || {}),
    });

    return { user1: pick(user1), user2: pick(user2), diffs };
}

/**
 * Apply merge: merge source user into target user.
 *
 * - Merges choice fields based on fieldChoices map
 * - Combines oauth providers, is_admin, disabled
 * - Migrates index keyid from source → target
 * - Marks source as _merged_into + disabled
 */
export async function handleMergeApply(
    usersCol: any,
    indexCol: any,
    targetId: string,
    sourceId: string,
    fieldChoices: Record<string, string>,
): Promise<any> {
    const target = await usersCol.findOne({ _id: targetId });
    const source = await usersCol.findOne({ _id: sourceId });

    if (!target || !source) {
        throw new Error(`User not found: ${!target ? targetId : sourceId}`);
    }
    if (target._id === source._id) {
        throw new Error("Cannot merge a user with itself");
    }

    // Build update for target
    const setFields: Record<string, any> = {};

    // Choice fields: copy from source if selected
    for (const field of CHOICE_FIELDS) {
        if (fieldChoices[field] === "source" && source[field] !== undefined) {
            setFields[field] = source[field];
        }
    }

    // OAuth: combine providers from both
    setFields["oauth"] = { ...(target.oauth || {}), ...(source.oauth || {}) };

    // is_admin: true if either is admin
    if (target.is_admin || source.is_admin) {
        setFields["is_admin"] = true;
    }

    // disabled: true if either is disabled
    if (target.disabled || source.disabled) {
        setFields["disabled"] = true;
    }

    // Back up source's key (if different from target's)
    if (source.key && source.key !== target.key) {
        const mergedKeys = target._merged_keys || [];
        if (!mergedKeys.includes(source.key)) {
            mergedKeys.push(source.key);
        }
        setFields["_merged_keys"] = mergedKeys;
    }

    // Clear source's oauth BEFORE setting oauth on target → avoids unique index conflict
    // (oauth.pocketid.sub_1 and oauth.discord.id_1 are unique sparse indexes)
    await usersCol.updateOne(
        { _id: sourceId },
        { $unset: { oauth: "" } },
    );

    await usersCol.updateOne({ _id: targetId }, { $set: setFields });

    // Migrate index entries from source → target
    if (source.juush_user_id != null && target.juush_user_id != null
        && source.juush_user_id !== target.juush_user_id) {
        const idxResult = await indexCol.updateMany(
            { keyid: source.juush_user_id },
            { $set: { keyid: target.juush_user_id } },
        );
        serverLog(`Merge index migration: ${idxResult.modifiedCount} entries moved from ${source.juush_user_id} to ${target.juush_user_id}`);
    }

    // Mark source as merged — clear juush_user_id so it disappears from the dropdown
    await usersCol.updateOne(
        { _id: sourceId },
        {
            $set: { _merged_into: targetId, disabled: true },
            $unset: { juush_user_id: "" },
        },
    );

    const updatedTarget = await usersCol.findOne({ _id: targetId });
    return { success: true, target: updatedTarget };
}
