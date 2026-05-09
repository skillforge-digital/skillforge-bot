const { FieldValue } = require('firebase-admin/firestore');

const buildCounterUpdates = (deltas) => {
    const out = {};
    for (const [k, v] of Object.entries(deltas || {})) {
        const n = Number(v || 0);
        if (!n) continue;
        out[k] = FieldValue.increment(n);
    }
    return out;
};

const adjustGroupCounters = async (db, groupId, deltas) => {
    const updates = buildCounterUpdates(deltas);
    if (!Object.keys(updates).length) return;
    const ref = db.collection('group_settings').doc(String(groupId));
    const doc = await ref.get();
    if (!doc.exists) {
        await ref.set({ group_id: String(groupId), counters_initialized: true, ...updates }, { merge: true });
        return;
    }
    await ref.set(updates, { merge: true });
};

const computeCountersFromVerificationDocs = (docs) => {
    let verified = 0;
    let unverified = 0;
    let pending = 0;
    let timed_out = 0;
    for (const d of docs) {
        const removed = Boolean(d.removed);
        if (removed) continue;
        if (Boolean(d.verified)) {
            verified += 1;
            continue;
        }
        unverified += 1;
        if (Boolean(d.timed_out)) {
            timed_out += 1;
        } else {
            pending += 1;
        }
    }
    return {
        verified_count: verified,
        unverified_count: unverified,
        pending_count: pending,
        timed_out_count: timed_out
    };
};

module.exports = { adjustGroupCounters, computeCountersFromVerificationDocs };
