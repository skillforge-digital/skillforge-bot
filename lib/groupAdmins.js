const isGroupAdmin = async (db, groupId, userId) => {
    const doc = await db.collection('group_admins').doc(String(groupId)).collection('users').doc(String(userId)).get();
    return doc.exists;
};

const setGroupAdmin = async (db, groupId, userId, payload = {}) => {
    await db.collection('group_admins').doc(String(groupId)).collection('users').doc(String(userId)).set({
        group_id: String(groupId),
        user_id: String(userId),
        ...payload
    }, { merge: true });
};

const removeGroupAdmin = async (db, groupId, userId) => {
    await db.collection('group_admins').doc(String(groupId)).collection('users').doc(String(userId)).delete();
};

const listGroupAdmins = async (db, groupId, limit = 50) => {
    const snap = await db.collection('group_admins').doc(String(groupId)).collection('users').limit(limit).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

module.exports = { isGroupAdmin, setGroupAdmin, removeGroupAdmin, listGroupAdmins };
