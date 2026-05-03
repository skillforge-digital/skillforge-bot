# WebApp Menu + Polling Mode Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the menu and bot delivery so `/start` and HTML menu buttons work reliably on Render by switching to polling mode and using Telegram WebApp `sendData`.

**Architecture:** Run the bot in polling mode (no webhook). Serve `/menu` as a Telegram WebApp that (1) asks the backend for role via verified initData, and (2) sends actions to the bot via `Telegram.WebApp.sendData`.

**Tech Stack:** Node.js, Express, Telegraf, Firebase Admin (Firestore).

---

## Files

**Modify**
- [index.js](file:///workspace/skillforge-bot/index.js)
- [public/menu.html](file:///workspace/skillforge-bot/public/menu.html)

---

## Task 1: Switch to polling mode

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js#L2895-L2952)

- [ ] **Step 1: Force polling**

Replace webhook branch with:

```js
await bot.telegram.deleteWebhook();
await bot.launch();
console.log('Skillforge Bot launched in polling mode');
```

Remove `WEBHOOK_SECRET` hard requirement in startup path.

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "fix(deploy): switch bot to polling mode on render"
```

---

## Task 2: Verify Telegram WebApp initData on backend

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add initData verification helper**

Add a function that validates Telegram initData:

```js
const verifyTelegramInitData = (initData, botToken) => {
  const crypto = require('crypto');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing hash' };
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return { ok: false, error: 'bad hash' };

  const userStr = params.get('user');
  if (!userStr) return { ok: false, error: 'missing user' };
  const user = JSON.parse(userStr);
  return { ok: true, user };
};
```

- [ ] **Step 2: Add role endpoint**

```js
app.post('/api/webapp/role', async (req, res) => {
  try {
    const initData = String(req.body?.initData || '').trim();
    if (!initData) return res.status(400).json({ ok: false, error: 'initData required' });
    const verified = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verified.ok) return res.status(401).json({ ok: false, error: verified.error });

    const userId = String(verified.user.id);
    const specialistDoc = await db.collection('specialists').doc(userId).get();
    const role = specialistDoc.exists ? 'specialist' : 'public';
    return res.json({ ok: true, role, user_id: userId });
  } catch (e) {
    await reportError('webapp role failed', e);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(menu): add telegram webapp role verification endpoint"
```

---

## Task 3: Rebuild menu.html to use Telegram WebApp API

**Files:**
- Modify: [public/menu.html](file:///workspace/skillforge-bot/public/menu.html)

- [ ] **Step 1: Add Telegram WebApp script**

In `<head>`:

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```

- [ ] **Step 2: Replace anchors with buttons**

Change menu links to buttons:

```html
<button class="menu-btn btn-info" data-action="schedule">
  <span class="emoji">⏰</span> Schedule Class
</button>
```

- [ ] **Step 3: Add JS controller**

At bottom:

```html
<script>
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) { try { tg.ready(); } catch(e) {} }

  async function loadRole() {
    if (!tg) return { role: 'public' };
    const res = await fetch('/api/webapp/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData })
    });
    return await res.json();
  }

  function sendAction(action) {
    if (!tg) return;
    tg.sendData(JSON.stringify({ action }));
    tg.close();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.preventDefault();
    const action = btn.getAttribute('data-action');
    sendAction(action);
  });

  (async () => {
    const r = await loadRole();
    document.body.classList.toggle('is-staff', r.ok && r.role === 'specialist');
  })();
</script>
```

- [ ] **Step 4: Hide staff sections by default**

Add CSS:
- default hide staff section
- show when `body.is-staff` true

- [ ] **Step 5: Commit**

```bash
git add public/menu.html
git commit -m "feat(menu): make webapp menu sendData and role-gated"
```

---

## Task 4: Handle WebApp actions in the bot

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add web_app_data handler**

```js
bot.on('message', async (ctx, next) => {
  const wad = ctx.message?.web_app_data;
  if (!wad?.data) return next();
  try {
    const payload = JSON.parse(wad.data);
    const action = String(payload?.action || '');
    if (!action) return;
    return ctx.telegram.sendMessage(ctx.from.id, `/start ${action}`);
  } catch (e) {
    await reportError('web_app_data parse failed', e);
    return;
  }
});
```

Then refactor to call the same internal dispatcher used by `/start` rather than sending a fake command (optional improvement):
- Extract a `handleStartPayload(ctx, payload)` function
- Use it from both `/start` and `web_app_data`

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(menu): handle telegram webapp actions"
```

---

## Task 5: Verify locally and push

- [ ] **Step 1: Syntax check**

```bash
node --check index.js
```

- [ ] **Step 2: Install**

```bash
npm ci
```

- [ ] **Step 3: Push**

```bash
git push
```

