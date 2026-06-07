// One-time migration: existing "keys" collection → "users" collection
// This ALSO runs automatically at startup in util.ts:startdb().
// This file allows running manually: npx tsx src/juush/migrate.ts

import { randomStr, mongoclient } from "./util.js";

export async function migrateKeysToUsers(): Promise<number> {
    const db = mongoclient.db("juush");
    const legacyKeysCol = db.collection("keys");
    const usersCol = db.collection("users");

    const oldKeys = await legacyKeysCol.find({}).toArray();
    let migrated = 0;

    for (const key of oldKeys) {
        const existing = await usersCol.findOne({ juush_user_id: key._id });
        if (existing) continue;

        await usersCol.insertOne({
            _id: randomStr(10) as any,
            juush_user_id: key._id,
            username: "legacy_" + (key.name || "unknown"),
            display_name: key.name || "unknown",
            key: key.key,
            autohide: key.autohide || false,
            customURL: key.customURL || null,
            primary_provider: null,
            oauth: {},
            is_admin: false,
            disabled: false,
            created_at: new Date(),
        });

        migrated++;
    }

    console.log(`Migrated ${migrated} keys to users collection`);
    return migrated;
}

// Run directly: npx tsx src/juush/migrate.ts
if (require.main === module) {
    import("./util.js").then(({ startdb }) => startdb()).then(() => migrateKeysToUsers()).then((n) => {
        console.log(`Done. ${n} keys migrated.`);
        process.exit(0);
    }).catch((e) => {
        console.error("Migration failed:", e);
        process.exit(1);
    });
}
