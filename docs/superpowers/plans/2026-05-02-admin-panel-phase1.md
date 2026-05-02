# Admin Panel (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Admin Panel where specialists can view only their classrooms and a super-admin (via `SUPER_ADMIN_KEY`) can view and manage all classrooms and verification campaigns.

**Architecture:** Add a small authenticated API surface under `/admin` with OTP-based specialist login (code delivered via Telegram DM) and an elevation path for super-admin via `SUPER_ADMIN_KEY`. Serve a minimal static HTML UI that uses `fetch` to call these APIs.

**Tech Stack:** Node.js, Express, Telegraf, Firebase Admin (Firestore).

---

## File Structure

**Create**
- `public/admin.html` — Admin Panel UI shell
- `public/admin.js` — Minimal UI logic (login, fetch tables, actions)
- `public/admin.css` — Minimal styling

**Modify**
- [index.js](file:///workspace/skillforge-bot/index.js) — add admin routes, OTP/session helpers, and super-admin actions
- [package.json](file:///workspace/skillforge-bot/package.json) — (optional) add `cookie` dependency only if needed; otherwise implement cookie parsing manually

---

## Task 1: Add env vars and helper functions

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add env var reads**

Add near other env vars:

```js
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || null;
```

- [ ] **Step 2: Add cookie + session helpers**

Add helpers (no external libs):

```js
const parseCookies = (cookieHeader) => {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
};

const randomCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (code) => require('crypto').createHash('sha256').update(String(code)).digest('hex');
const randomSessionId = () => require('crypto').randomBytes(24).toString('hex');
```

- [ ] **Step 3: Syntax check**

Run:

```bash
node --check index.js
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(admin): add admin env and auth helpers"
```

---

## Task 2: Serve Admin Panel static assets

**Files:**
- Create: `public/admin.html`
- Create: `public/admin.js`
- Create: `public/admin.css`
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add files**

`public/admin.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Skillforge Bot Admin</title>
    <link rel="stylesheet" href="/public/admin.css" />
  </head>
  <body>
    <div class="wrap">
      <header class="row">
        <h1>Skillforge Bot Admin</h1>
        <div class="right">
          <span id="role"></span>
          <button id="logout" class="btn secondary" style="display:none;">Logout</button>
        </div>
      </header>

      <section id="loginBox" class="card">
        <h2>Login</h2>
        <p>Enter your Telegram ID, request a code in DM, then verify it.</p>
        <div class="grid">
          <label>
            Telegram ID
            <input id="telegramId" placeholder="123456789" />
          </label>
          <button id="requestCode" class="btn">Request code</button>
          <label>
            Code
            <input id="code" placeholder="123456" />
          </label>
          <button id="verifyCode" class="btn">Verify</button>
        </div>
        <hr/>
        <p>Super admin: enter key to elevate.</p>
        <div class="grid">
          <label>
            Super Admin Key
            <input id="superKey" placeholder="SUPER_ADMIN_KEY" />
          </label>
          <button id="elevate" class="btn secondary">Elevate</button>
        </div>
        <div id="loginMsg" class="msg"></div>
      </section>

      <section id="app" style="display:none;">
        <nav class="tabs">
          <button class="tab active" data-tab="classrooms">Classrooms</button>
          <button class="tab" data-tab="today">Today</button>
          <button class="tab" data-tab="exports">Exports</button>
        </nav>

        <section id="tab-classrooms" class="card">
          <h2>Classrooms</h2>
          <table class="table" id="classroomsTable"></table>
        </section>

        <section id="tab-today" class="card" style="display:none;">
          <h2>Today’s Classes</h2>
          <table class="table" id="todayTable"></table>
        </section>

        <section id="tab-exports" class="card" style="display:none;">
          <h2>Attendance Export</h2>
          <div class="grid">
            <label>Group ID <input id="exportGroupId" placeholder="-100..." /></label>
            <label>From (YYYY-MM-DD) <input id="exportFrom" placeholder="2026-05-01" /></label>
            <label>To (YYYY-MM-DD) <input id="exportTo" placeholder="2026-05-07" /></label>
            <button id="exportBtn" class="btn">Download CSV</button>
          </div>
          <div id="exportMsg" class="msg"></div>
        </section>
      </section>
    </div>

    <script src="/public/admin.js"></script>
  </body>
</html>
```

`public/admin.css`

```css
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; margin:0; background:#0b1020; color:#e8eefc}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.card{background:#121a33;border:1px solid #22305b;border-radius:12px;padding:16px;margin-top:16px}
.grid{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#bcd}
input{padding:10px;border-radius:10px;border:1px solid #2b3d78;background:#0c1328;color:#e8eefc}
.btn{padding:10px 12px;border-radius:10px;border:1px solid #3a55b8;background:#2a4cff;color:white;cursor:pointer}
.btn.secondary{background:#0c1328;border-color:#2b3d78}
.tabs{display:flex;gap:8px;margin-top:16px}
.tab{padding:10px 12px;border-radius:10px;border:1px solid #2b3d78;background:#0c1328;color:#e8eefc;cursor:pointer}
.tab.active{background:#2a4cff;border-color:#3a55b8}
.table{width:100%;border-collapse:collapse;margin-top:10px}
.table th,.table td{border-bottom:1px solid #22305b;padding:10px;text-align:left;font-size:13px}
.msg{margin-top:10px;color:#ffd27d;font-size:13px;min-height:18px}
```

`public/admin.js`

```js
const qs = (id) => document.getElementById(id);
const state = { me: null };

const setMsg = (el, text) => { el.textContent = text || ''; };

const renderTable = (el, cols, rows) => {
  el.innerHTML = '';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; trh.appendChild(th); });
  thead.appendChild(trh);
  el.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      td.innerHTML = r[c] ?? '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  el.appendChild(tbody);
};

const fetchJson = async (url, opts) => {
  const res = await fetch(url, { credentials: 'include', ...opts });
  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch {}
  if (!res.ok) throw new Error(json?.error || txt || `HTTP ${res.status}`);
  return json;
};

const refreshMe = async () => {
  try {
    state.me = await fetchJson('/admin/api/me');
    qs('loginBox').style.display = 'none';
    qs('app').style.display = '';
    qs('logout').style.display = '';
    qs('role').textContent = `${state.me.role} (${state.me.telegram_id})`;
    await loadClassrooms();
    await loadToday();
  } catch (e) {
    state.me = null;
    qs('loginBox').style.display = '';
    qs('app').style.display = 'none';
    qs('logout').style.display = 'none';
    qs('role').textContent = '';
  }
};

const loadClassrooms = async () => {
  const data = await fetchJson('/admin/api/classrooms');
  const cols = ['group_name','group_id','specialist_name','specialist_id','verified','unverified','campaign','actions'];
  const rows = data.items.map(x => ({
    group_name: x.group_name,
    group_id: x.group_id,
    specialist_name: x.specialist_name,
    specialist_id: x.specialist_id,
    verified: String(x.verification?.verified ?? 0),
    unverified: String(x.verification?.unverified ?? 0),
    campaign: x.campaign?.active ? 'active' : 'off',
    actions: x.can_manage ? `
      <button class="btn secondary" data-action="announce" data-g="${x.group_id}">Announce</button>
      <button class="btn secondary" data-action="start" data-g="${x.group_id}">Start</button>
      <button class="btn secondary" data-action="stop" data-g="${x.group_id}">Stop</button>
    ` : ''
  }));
  renderTable(qs('classroomsTable'), cols, rows);
};

const loadToday = async () => {
  const data = await fetchJson('/admin/api/today');
  const cols = ['group_name','group_id','time','topic','status'];
  const rows = data.items.map(x => ({
    group_name: x.group_name,
    group_id: x.group_id,
    time: x.time,
    topic: x.topic || '',
    status: x.status
  }));
  renderTable(qs('todayTable'), cols, rows);
};

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  const groupId = btn.getAttribute('data-g');
  try {
    await fetchJson(`/admin/api/classrooms/${encodeURIComponent(groupId)}/${action}`, { method: 'POST' });
    await loadClassrooms();
  } catch (err) {
    alert(err.message);
  }
});

qs('requestCode').onclick = async () => {
  const telegram_id = qs('telegramId').value.trim();
  try {
    await fetchJson('/admin/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegram_id }) });
    setMsg(qs('loginMsg'), 'Code sent to your Telegram DM.');
  } catch (e) {
    setMsg(qs('loginMsg'), e.message);
  }
};

qs('verifyCode').onclick = async () => {
  const telegram_id = qs('telegramId').value.trim();
  const code = qs('code').value.trim();
  try {
    await fetchJson('/admin/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegram_id, code }) });
    setMsg(qs('loginMsg'), '');
    await refreshMe();
  } catch (e) {
    setMsg(qs('loginMsg'), e.message);
  }
};

qs('elevate').onclick = async () => {
  const key = qs('superKey').value.trim();
  try {
    await fetchJson('/admin/auth/elevate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    await refreshMe();
  } catch (e) {
    setMsg(qs('loginMsg'), e.message);
  }
};

qs('logout').onclick = async () => {
  try { await fetchJson('/admin/auth/logout', { method: 'POST' }); } catch {}
  await refreshMe();
};

document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.getAttribute('data-tab');
    qs('tab-classrooms').style.display = tab === 'classrooms' ? '' : 'none';
    qs('tab-today').style.display = tab === 'today' ? '' : 'none';
    qs('tab-exports').style.display = tab === 'exports' ? '' : 'none';
  };
});

qs('exportBtn').onclick = async () => {
  const groupId = qs('exportGroupId').value.trim();
  const from = qs('exportFrom').value.trim();
  const to = qs('exportTo').value.trim();
  if (!groupId || !from || !to) return setMsg(qs('exportMsg'), 'Fill groupId, from, to.');
  window.location.href = `/admin/api/attendance/export?groupId=${encodeURIComponent(groupId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
};

refreshMe();
```

- [ ] **Step 2: Add route**

In `index.js`, add:

```js
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
```

- [ ] **Step 3: Commit**

```bash
git add public/admin.html public/admin.js public/admin.css index.js
git commit -m "feat(admin): add admin panel static UI"
```

---

## Task 3: Implement OTP login APIs

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add JSON body parsing already exists**

Confirm `app.use(express.json())` exists.

- [ ] **Step 2: Implement `/admin/auth/request`**

Add:

```js
app.post('/admin/auth/request', async (req, res) => {
  try {
    const telegram_id = String(req.body?.telegram_id || '').trim();
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
    const specialistDoc = await db.collection('specialists').doc(telegram_id).get();
    if (!specialistDoc.exists) return res.status(403).json({ error: 'not a specialist' });

    const code = randomCode();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
    await db.collection('admin_sessions_pending').doc(telegram_id).set({
      telegram_id,
      code_hash: hashCode(code),
      attempts: 0,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      expires_at: expiresAt
    }, { merge: true });

    await bot.telegram.sendMessage(telegram_id, `Skillforge Admin login code: ${code}\n\nThis code expires in 10 minutes.`);
    return res.json({ ok: true });
  } catch (e) {
    await reportError('admin auth request failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});
```

- [ ] **Step 3: Implement `/admin/auth/verify`**

```js
app.post('/admin/auth/verify', async (req, res) => {
  try {
    const telegram_id = String(req.body?.telegram_id || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!telegram_id || !code) return res.status(400).json({ error: 'telegram_id and code required' });

    const pendingDoc = await db.collection('admin_sessions_pending').doc(telegram_id).get();
    if (!pendingDoc.exists) return res.status(403).json({ error: 'no pending code' });
    const pending = pendingDoc.data();
    const expiresAt = pending.expires_at?.toDate ? pending.expires_at.toDate().getTime() : 0;
    if (Date.now() > expiresAt) return res.status(403).json({ error: 'code expired' });

    const attempts = Number(pending.attempts || 0);
    if (attempts >= 5) return res.status(429).json({ error: 'too many attempts' });

    if (hashCode(code) !== pending.code_hash) {
      await db.collection('admin_sessions_pending').doc(telegram_id).set({ attempts: attempts + 1 }, { merge: true });
      return res.status(403).json({ error: 'invalid code' });
    }

    const sessionId = randomSessionId();
    const sessionExpires = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 12 * 60 * 60 * 1000));
    await db.collection('admin_sessions').doc(sessionId).set({
      session_id: sessionId,
      telegram_id,
      role: 'specialist',
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      expires_at: sessionExpires
    });
    await db.collection('admin_sessions_pending').doc(telegram_id).delete();

    res.setHeader('Set-Cookie', `sf_admin_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`);
    return res.json({ ok: true });
  } catch (e) {
    await reportError('admin auth verify failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});
```

- [ ] **Step 4: Add `/admin/api/me`**

```js
const getAdminSession = async (req) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.sf_admin_session;
  if (!sid) return null;
  const doc = await db.collection('admin_sessions').doc(String(sid)).get();
  if (!doc.exists) return null;
  const sess = doc.data();
  const exp = sess.expires_at?.toDate ? sess.expires_at.toDate().getTime() : 0;
  if (Date.now() > exp) return null;
  return sess;
};

app.get('/admin/api/me', async (req, res) => {
  const sess = await getAdminSession(req);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ telegram_id: sess.telegram_id, role: sess.role });
});
```

- [ ] **Step 5: Add logout**

```js
app.post('/admin/auth/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.sf_admin_session;
  if (sid) await db.collection('admin_sessions').doc(String(sid)).delete().catch(() => {});
  res.setHeader('Set-Cookie', 'sf_admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  return res.json({ ok: true });
});
```

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(admin): add OTP login and session auth"
```

---

## Task 4: Super-admin elevation and authorization middleware

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Add elevate endpoint**

```js
app.post('/admin/auth/elevate', async (req, res) => {
  const sess = await getAdminSession(req);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  const key = String(req.body?.key || '').trim();
  if (!SUPER_ADMIN_KEY || key !== SUPER_ADMIN_KEY) return res.status(403).json({ error: 'invalid key' });
  await db.collection('admin_sessions').doc(sess.session_id).set({ role: 'super_admin' }, { merge: true });
  return res.json({ ok: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(admin): add super-admin elevation"
```

---

## Task 5: Data APIs (classrooms + today)

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Implement `/admin/api/classrooms`**

Return each classroom with verification counts and campaign state:

```js
app.get('/admin/api/classrooms', async (req, res) => {
  try {
    const sess = await getAdminSession(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });

    const classroomsQuery = sess.role === 'super_admin'
      ? db.collection('classrooms')
      : db.collection('classrooms').where('specialist_id', '==', String(sess.telegram_id));

    const snap = await classroomsQuery.get();
    const items = [];
    for (const doc of snap.docs) {
      const room = doc.data();
      const groupId = String(room.group_id || doc.id);

      const verSnap = await db.collection('group_verifications').where('group_id', '==', groupId).get();
      const verified = verSnap.docs.filter(d => d.data().verified).length;
      const removed = verSnap.docs.filter(d => d.data().removed).length;
      const unverified = verSnap.size - verified - removed;

      const settingsDoc = await db.collection('group_settings').doc(groupId).get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};

      items.push({
        group_id: groupId,
        group_name: room.group_name || groupId,
        specialist_id: room.specialist_id || '',
        specialist_name: room.specialist_name || '',
        verification: { verified, unverified, removed },
        campaign: { active: Boolean(settings.verify_campaign_active) },
        can_manage: sess.role === 'super_admin'
      });
    }

    return res.json({ items });
  } catch (e) {
    await reportError('admin classrooms api failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});
```

- [ ] **Step 2: Implement `/admin/api/today`**

```js
app.get('/admin/api/today', async (req, res) => {
  try {
    const sess = await getAdminSession(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    const todayStr = getLagosDateString();

    let q = db.collection('classes').where('date', '==', todayStr).where('status', '==', 'active');
    const classesSnap = await q.get();
    const items = [];
    for (const doc of classesSnap.docs) {
      const c = doc.data();
      if (sess.role !== 'super_admin' && String(c.specialist_id) !== String(sess.telegram_id)) continue;
      items.push({
        id: doc.id,
        group_id: c.group_id,
        group_name: c.group_name,
        time: c.time,
        topic: c.topic || null,
        status: c.status
      });
    }
    return res.json({ items });
  } catch (e) {
    await reportError('admin today api failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(admin): add classrooms and today APIs"
```

---

## Task 6: Super-admin actions (campaign + announcement)

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Implement POST action endpoints**

```js
const requireSuperAdmin = async (req, res) => {
  const sess = await getAdminSession(req);
  if (!sess) return { ok: false, res: res.status(401).json({ error: 'unauthorized' }) };
  if (sess.role !== 'super_admin') return { ok: false, res: res.status(403).json({ error: 'forbidden' }) };
  return { ok: true, sess };
};

app.post('/admin/api/classrooms/:groupId/start', async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth.ok) return;
  await startVerifyCampaign(req.params.groupId);
  return res.json({ ok: true });
});

app.post('/admin/api/classrooms/:groupId/stop', async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth.ok) return;
  await stopVerifyCampaign(req.params.groupId);
  return res.json({ ok: true });
});

app.post('/admin/api/classrooms/:groupId/announce', async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth.ok) return;
  const groupId = String(req.params.groupId);
  await bot.telegram.sendMessage(groupId, '✅ Verification Required\n\nTap below to verify:', Markup.inlineKeyboard([
    [Markup.button.url('Verify Now âœ…', getVerifyLink(groupId))]
  ]));
  return res.json({ ok: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(admin): add super-admin campaign actions"
```

---

## Task 7: Attendance CSV export

**Files:**
- Modify: [index.js](file:///workspace/skillforge-bot/index.js)

- [ ] **Step 1: Implement export endpoint**

```js
app.get('/admin/api/attendance/export', async (req, res) => {
  try {
    const sess = await getAdminSession(req);
    if (!sess) return res.status(401).send('unauthorized');
    const groupId = String(req.query.groupId || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (!groupId || !from || !to) return res.status(400).send('groupId, from, to required');

    if (sess.role !== 'super_admin') {
      const roomDoc = await db.collection('classrooms').doc(groupId).get();
      if (!roomDoc.exists || String(roomDoc.data().specialist_id) !== String(sess.telegram_id)) {
        return res.status(403).send('forbidden');
      }
    }

    const classesSnap = await db.collection('classes')
      .where('group_id', '==', groupId)
      .where('date', '>=', from)
      .where('date', '<=', to)
      .get();

    const classIds = classesSnap.docs.map(d => d.id);
    const rows = [];
    for (const classId of classIds) {
      const attSnap = await db.collection('attendance').where('class_id', '==', classId).get();
      for (const doc of attSnap.docs) {
        const a = doc.data();
        rows.push({ class_id: classId, user_id: a.user_id, attended: a.attended ? 'true' : 'false' });
      }
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${groupId}_${from}_to_${to}.csv"`);
    res.write('class_id,user_id,attended\n');
    for (const r of rows) res.write(`${r.class_id},${r.user_id},${r.attended}\n`);
    res.end();
  } catch (e) {
    await reportError('attendance export failed', e);
    return res.status(500).send('failed');
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(admin): add attendance CSV export"
```

---

## Task 8: Verification steps

- [ ] **Step 1: Syntax check**

```bash
node --check index.js
```

- [ ] **Step 2: Dependency install**

```bash
npm ci
```

- [ ] **Step 3: Manual smoke test**

Run the server (with real envs):

```bash
BOT_TOKEN=... BOT_USERNAME=... STAFF_PASSWORD=... FIREBASE_JSON=... SUPER_ADMIN_KEY=... node index.js
```

Then:
- Open `${SERVER_URL}/admin` (or locally `http://localhost:3000/admin`).
- Request OTP for a known specialist telegram id and confirm DM received.
- Verify OTP, confirm `/admin/api/me` returns role `specialist`.
- Elevate with `SUPER_ADMIN_KEY`, confirm role `super_admin`.
- Confirm `Classrooms` table populates and action buttons work for super-admin.

