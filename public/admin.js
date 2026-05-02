const qs = (id) => document.getElementById(id);
const state = { me: null };

const setMsg = (el, text) => {
  el.textContent = text || '';
};

const renderTable = (el, cols, rows) => {
  el.innerHTML = '';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  cols.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    trh.appendChild(th);
  });
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
