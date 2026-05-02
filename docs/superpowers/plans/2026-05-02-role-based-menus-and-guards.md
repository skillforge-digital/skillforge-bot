# Role-Based Menus + Command Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide staff-only menus from trainees, keep super-admin features hidden from specialists, and enforce role-based access on server-side Telegram commands.

**Architecture:** Add a single role resolver helper (`getUserRole`) and use it in `/start` to render appropriate menus. Add a reusable `requireSpecialist` guard used by staff-only commands.

**Tech Stack:** Node.js, Telegraf, Firebase Admin (Firestore), Express.

---

## Files

**Modify**
- [index.js](file:///workspace/skillforge-bot/index.js)

---

## Task 1: Add role resolver helper

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add helper**

Add near other helpers:

```js
const getUserRole = async (userId) => {
  const uid = String(userId);
  const specialistDoc = await db.collection('specialists').doc(uid).get();
  if (specialistDoc.exists) return { role: 'specialist' };

  const verifiedSnap = await db.collection('group_verifications')
    .where('user_id', '==', uid)
    .where('verified', '==', true)
    .where('removed', '==', false)
    .limit(1)
    .get();
  if (!verifiedSnap.empty) return { role: 'trainee_verified' };

  return { role: 'trainee_unverified' };
};
```

- [ ] **Step 2: Syntax check**

```bash
node --check index.js
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "refactor(auth): add user role resolver"
```

---

## Task 2: Update /start menu rendering

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Update /start fallthrough menu**

Use role:
- specialist: keep current staff menu + web menu link
- trainee_verified: show only attendance/help
- trainee_unverified: show verify/help

Example buttons for trainee_verified:

```js
Markup.inlineKeyboard([
  [Markup.button.callback('✅ Attendance', 'trainee_attendance_help')],
  [Markup.button.callback('❓ Help', 'help_info')]
])
```

- [ ] **Step 2: Add the new callback handler**

```js
bot.action('trainee_attendance_help', async (ctx) => {
  await ctx.reply('Use /attended or /missed in DM after a class. If multiple classes apply, you will be asked to pick one.');
  ctx.answerCbQuery();
});
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(menu): show trainee-safe start menu"
```

---

## Task 3: Add specialist-only guard and apply to staff commands

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add guard helper**

```js
const requireSpecialist = async (ctx) => {
  const uid = ctx.from?.id ? String(ctx.from.id) : null;
  if (!uid) return false;
  const ok = await isSpecialist(uid);
  if (!ok) {
    await ctx.reply('Staff only.');
    return false;
  }
  return true;
};
```

- [ ] **Step 2: Apply to commands**

At the start of each staff-only command handler:
- `/claim`
- `/setclass`
- `/cancelclass`
- `/rescheduleclass`
- report-related commands used by specialists

Example:

```js
bot.command('setclass', async (ctx) => {
  if (!(await requireSpecialist(ctx))) return;
  ...
});
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "fix(auth): enforce specialist-only commands"
```

---

## Task 4: Verify and push

- [ ] **Step 1: Syntax check**

```bash
node --check index.js
```

- [ ] **Step 2: Dependency install**

```bash
npm ci
```

- [ ] **Step 3: Push**

```bash
git push
```

