/**
 * One-off backfill: adds `plateNormalized` to every vehicle doc that's
 * missing it, so the matcher's equality query works.
 *
 * Run once: node backfill-plates.js
 * Safe to re-run — it skips vehicles that already have the field unless
 * you pass --force, which recomputes everyone (use if you change the
 * normalization rules later).
 */
require('dotenv').config();
const { db } = require('./firestoreClient');
const { normalizePlate } = require('./matching');

async function backfill() {
    const force = process.argv.includes('--force');
    const snapshot = await db.collection('matatus').get();

    if (snapshot.empty) {
        console.log('No vehicles found.');
        return;
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();

        if (!force && data.plateNormalized) {
            skipped++;
            continue;
        }

        if (!data.plateNumber) {
            console.warn(`Vehicle ${doc.id} has no plateNumber — skipping`);
            failed++;
            continue;
        }

        const normalized = normalizePlate(data.plateNumber);
        await doc.ref.update({ plateNormalized: normalized });
        console.log(`${doc.id}: "${data.plateNumber}" → "${normalized}"`);
        updated++;
    }

    console.log(`\nDone. Updated: ${updated}, skipped (already set): ${skipped}, failed: ${failed}`);
}

backfill()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Backfill failed:', err);
        process.exit(1);
    });