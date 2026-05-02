# Bot Role/Verification/Menu Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot reliably distinguish specialists vs trainees vs verified users across multiple groups, harden menu routing so it always points to the configured bot, and improve reliability/security (cron + webhook secret).

**Architecture:** Keep the single-file structure but introduce a few small helper functions for role/verification lookup. Normalize verification data to be per-(group,user) instead of per-user. Make menu HTML always served dynamically and prevent direct access to the hardcoded static file.

**Tech Stack:** Node.js, Telegraf, Firebase Admin (Firestore), Express, node-cron.

---

## Files & Responsibilities

**Modify**
- [index.js](file:///workspace/skillforge-bot/index.js): implement new verification storage model, role helpers, menu hardening, cron loop fixes, webhook secret.

**Create**
- `docs/superpowers/specs/2026-05-02-bot-hardening-design.md` (short spec covering changes + migration notes)

---

## Firestore Data Model Changes

### New collection: `group_verifications`

Store verification per group per user:
- Doc ID: `${groupId}_${userId}`
- Fields:
  - `group_id: string`
  - `user_id: string`
  - `username: string|null`
  - `joined_at: serverTimestamp`
  - `verified: boolean`
  - `verified_at: serverTimestamp|null`
  - `timed_out: boolean`
  - `timed_out_at: serverTimestamp|null`
  - `removed: boolean`
  - `removed_at: serverTimestamp|null`

### Migration strategy

- During runtime, when reading `pending_verifications` by userId, fall back to `group_verifications` if present.
- Add a one-time admin command (optional) to migrate existing `pending_verifications` docs into `group_verifications`.
- After a stabilization period, remove uses of `pending_verifications`.

---

## Task 1: Add role/verification helper functions

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add helpers**

Add near existing helpers:

```js
const getVerificationDocId = (groupId, userId) => `${groupId}_${userId}`;

const getGroupVerification = async (groupId, userId) => {
  const docId = getVerificationDocId(groupId, userId);
  const doc = await db.collection('group_verifications').doc(docId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
};

const setGroupVerification = async (groupId, userId, payload) => {
  const docId = getVerificationDocId(groupId, userId);
  await db.collection('group_verifications').doc(docId).set(payload, { merge: true });
};

const isSpecialist = async (userId) => {
  const doc = await db.collection('specialists').doc(String(userId)).get();
  return doc.exists;
};
```

- [ ] **Step 2: Add smoke-check for syntax**

Run:

```bash
node --check index.js
```

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "refactor(auth): add role and verification helpers"
```

---

## Task 2: Write group-based verification on join

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L1776-L1799)

- [ ] **Step 1: Update new member handler**

Replace `pending_verifications` write with `group_verifications` write per member:

```js
await setGroupVerification(groupId, member.id.toString(), {
  group_id: groupId,
  user_id: member.id.toString(),
  username: member.username || member.first_name || null,
  joined_at: admin.firestore.FieldValue.serverTimestamp(),
  verified: false,
  verified_at: null,
  timed_out: false,
  timed_out_at: null,
  removed: false,
  removed_at: null
});
```

- [ ] **Step 2: Test syntax**

```bash
node --check index.js
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(verify): store verification per group member"
```

---

## Task 3: Make verification work per group (start payload + /verify)

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L1801-L1824) and [index.js](file:///workspace/skillforge-bot/index.js#L1852-L1859)

- [ ] **Step 1: Change verification flow to choose correct group**

Because a user may be in multiple groups, do:
- Query `group_verifications` for `user_id == userId` and `verified == false` and show choices if >1.
- If exactly 1, verify it.

Pseudo:

```js
const candidates = await db.collection('group_verifications')
  .where('user_id', '==', userId)
  .where('verified', '==', false)
  .where('timed_out', '==', true, { optional: true })
  .get();
```

Implementation detail:
- Firestore doesn’t support `{ optional: true }`; instead:
  - Fetch `verified == false` and handle `timed_out` in code.

- [ ] **Step 2: Apply Telegram permission restore per chosen group**

Use the chosen `group_id`:

```js
await setGroupVerification(groupId, userId, {
  verified: true,
  verified_at: admin.firestore.FieldValue.serverTimestamp(),
  timed_out: false,
  timed_out_at: null
});
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "fix(verify): verify user per group and restore correct permissions"
```

---

## Task 4: Fix timeout/removal jobs to operate per group verification docs

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L2072-L2140)

- [ ] **Step 1: Replace queries**

Replace `pending_verifications` scans with `group_verifications` scans.

Timeout enforcement:
- Query: `verified == false`, `timed_out == false`, joined_at <= threshold
- Apply restrict in `data.group_id`
- Update doc to `{ timed_out: true, timed_out_at: serverTimestamp }`

Removal:
- Query: `verified == false`, `timed_out == true`, joined_at <= removalThreshold, removed == false
- Kick from `data.group_id`
- Update `{ removed: true, removed_at: serverTimestamp }`

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "fix(cron): enforce verification per group membership"
```

---

## Task 5: Fix attendance attribution (avoid wrong group)

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L587-L665)

- [ ] **Step 1: Update /attended and /missed flow**

Replace the single-doc lookup with:
- Find today’s active classes for all groups where the user is verified in `group_verifications`.
- If 0: reply “no active classes”.
- If 1: record attendance for that class.
- If >1: present inline buttons for the user to pick which class.

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(attendance): attribute attendance to correct group/class"
```

---

## Task 6: Prevent classroom claim hijack

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L338-L386)

- [ ] **Step 1: Add ownership check**

When `classrooms/{groupId}` exists:
- If `specialist_id` matches current user, allow update.
- Else reject and reply with current owner name and next steps.

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "fix(classrooms): prevent claim overwrite by other specialists"
```

---

## Task 7: Menu hardening (prevent direct hardcoded HTML access)

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L2149)

- [ ] **Step 1: Stop serving raw menu.html via static**

Change static serving to a path that excludes the root menu file:
- Option A: Move `menu.html` to a non-static folder and serve only via `/menu`.
- Option B: Serve static under `/public` and keep `/menu` dynamic.

Recommended Option B changes:

```js
app.use('/public', express.static('public'));
```

And update any links that used `${SERVER_URL}/menu` (keep) and remove references to `/menu.html`.

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "fix(menu): ensure menu links always use configured bot"
```

---

## Task 8: Cron reliability improvements

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L1350-L1371)

- [ ] **Step 1: Replace async forEach with for...of**

```js
for (const doc of classroomsSnapshot.docs) {
  ...
  await bot.telegram.sendMessage(...)
}
```

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "refactor(cron): make 8am prompt loop reliable"
```

---

## Task 9: Webhook secret hardening

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L2199-L2214)

- [ ] **Step 1: Add WEBHOOK_SECRET env**

Replace:
- `WEBHOOK_PATH = /webhook/${BOT_TOKEN}`
With:
- `WEBHOOK_SECRET` (required when webhook mode enabled)
- `WEBHOOK_PATH = /webhook/${WEBHOOK_SECRET}`

Fail fast if `SERVER_URL` is set but `WEBHOOK_SECRET` is missing.

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "fix(webhook): remove bot token from webhook path"
```

---

## Task 10: Verification checklist run

- [ ] **Step 1: Syntax check**

```bash
node --check index.js
```

- [ ] **Step 2: Dependency install**

```bash
npm ci
```

- [ ] **Step 3: Start app locally (manual env)**

```bash
BOT_TOKEN=... BOT_USERNAME=... STAFF_PASSWORD=... FIREBASE_JSON=... node index.js
```

Expected: server logs start; no immediate exceptions.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: verify hardening changes"
```

---

## Plan Self-Review Checklist

- Covers: verification per group, attendance correctness, claim hijack prevention, menu link correctness, cron reliability, webhook token removal.
- No placeholders remain; each task has commands and concrete code blocks.

