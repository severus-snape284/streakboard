import * as store from './store.js';
import { sortTasks, heroStats, atRisk, statusOf, milestoneFor, nextMilestone, MILESTONES, addDays } from './streaks.js';
import { describeSchedule } from './model.js';

const APP_VERSION = '1.0.0';
const app = document.getElementById('app');
const FLAME = '<svg class="flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c.9 3.3-1.4 5.2-2.8 7.1C7.9 11.4 7.4 12.9 7.4 14.3c0 3.3 2.3 6.2 4.6 6.2s4.6-2.9 4.6-6.2c0-1.9-.9-3.3-1.8-4.3.2 1.4-.3 2.6-1.2 3.1.3-3.1-.6-6.8-1.6-10.6z"/></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4l-2.3 2.3z"/></svg>';

const state = {
  view: null,
  loading: false,
  error: null,
  sort: localStorage.getItem('sb.sort') || 'streak',
  persisted: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const fmtDay = (key, opts = { month: 'short', day: 'numeric' }) =>
  new Date(key + 'T12:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

// ---------- routing ----------

function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (!store.getCreds()) return { name: 'settings', setup: true };
  if (h.startsWith('/t/')) return { name: 'detail', id: decodeURIComponent(h.slice(3)) };
  if (h === '/settings') return { name: 'settings' };
  return { name: 'home' };
}

function render() {
  const r = route();
  document.body.classList.toggle('setup', !!r.setup);
  document.querySelectorAll('#nav a').forEach((a) => {
    const active = a.dataset.nav === (r.name === 'detail' ? 'home' : r.name);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (r.name === 'settings') app.innerHTML = settingsView(r.setup);
  else if (r.name === 'detail') app.innerHTML = detailView(r.id);
  else app.innerHTML = homeView();
  if (r.name === 'detail') {
    const hw = app.querySelector('.heat-wrap');
    if (hw) hw.scrollLeft = hw.scrollWidth;
  }
}

// Re-render data views only (never wipe a half-filled settings form).
function rerenderData() {
  if (route().name !== 'settings') render();
  else updateRelTimes();
}

function updateRelTimes() {
  app.querySelectorAll('[data-rel]').forEach((el) => (el.textContent = relTime(Number(el.dataset.rel))));
}

// ---------- views ----------

function topbar(title) {
  const v = state.view;
  return `<header class="topbar">
    <h1>${esc(title)}</h1>
    <div class="updated">
      ${v ? `<span>Updated <span data-rel="${v.fetchedAt}">${relTime(v.fetchedAt)}</span></span>` : ''}
      <button class="icon-btn" data-action="refresh" aria-label="Refresh">
        <span class="${state.loading ? 'spin' : ''}" style="display:inline-flex">${REFRESH_ICON}</span>
      </button>
    </div>
  </header>`;
}

function notes() {
  const v = state.view;
  let out = '';
  if (state.error) out += `<p class="note err">${esc(state.error)}</p>`;
  if (v?.user?.preferences?.sleep) out += `<p class="note">You're resting in the Inn — Habitica has paused your dailies, so streaks won't break.</p>`;
  else if (v?.ctx?.stale) out += `<p class="note">Habitica hasn't started your new day yet. Streaks and today's status update after you next open Habitica.</p>`;
  return out;
}

function statusPill(t) {
  const s = statusOf(t);
  if (s === 'done') return '<span class="pill done">✓ Done today</span>';
  if (s === 'due') return atRisk(t) ? '<span class="pill risk">At risk</span>' : '<span class="pill due">Due today</span>';
  return '<span class="pill">Not due today</span>';
}

function rowView(t) {
  const ms = milestoneFor(t.streak);
  const cls = ['row', statusOf(t)];
  if (!t.streak) cls.push('zero');
  if (ms) cls.push('milestone');
  if (ms && ms === t.streak) cls.push('milestone-hit');
  return `<li><a class="${cls.join(' ')}" href="#/t/${encodeURIComponent(t.id)}">
    <div class="row-body">
      <div class="row-title">${esc(t.text)}</div>
      <div class="row-meta">${statusPill(t)}${ms ? `<span class="pill ms">${ms}-day</span>` : ''}<span><span class="num">${t.streak}</span> / best <span class="num">${t.best}</span></span></div>
    </div>
    <div class="row-streak num" aria-label="${t.streak} day streak">${FLAME}${t.streak}</div>
  </a></li>`;
}

function homeView() {
  const v = state.view;
  if (!v) {
    if (state.error) {
      return `${topbar('Streakboard')}<div class="empty"><h2>Couldn't load your streaks</h2><p>${esc(state.error)}</p>
        <button class="btn primary" data-action="refresh">Try again</button></div>`;
    }
    return `${topbar('Streakboard')}<ul class="list">${'<li class="skel"></li>'.repeat(5)}</ul>`;
  }
  const tasks = v.tasks;
  if (!tasks.length) {
    return `${topbar('Streakboard')}${notes()}<div class="empty"><h2>No dailies yet</h2><p>Add dailies in Habitica and they'll show up here.</p></div>`;
  }
  const hero = heroStats(tasks);
  const risky = sortTasks(tasks.filter(atRisk), 'streak');
  const sorted = sortTasks(tasks, state.sort);
  const seg = [['streak', 'Streak'], ['due', 'Due today'], ['name', 'Name']]
    .map(([k, l]) => `<button data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join('');
  return `${topbar('Streakboard')}${notes()}
    ${risky.length ? `<section class="risk" aria-label="Streaks at risk"><h2>Streak at risk</h2><ul>
      ${risky.map((t) => `<li><a href="#/t/${encodeURIComponent(t.id)}"><span>${esc(t.text)}</span><span class="num">${FLAME}${t.streak}</span></a></li>`).join('')}
    </ul></section>` : ''}
    <section class="hero">
      <div class="hero-main">
        <div class="hero-num num">${FLAME}${hero.top ? hero.top.streak : 0}</div>
        <div class="hero-label">Best current streak<b>${hero.top ? esc(hero.top.text) : 'Start one today'}</b></div>
      </div>
      <div class="hero-stats">
        <div><b class="num">${hero.active}</b><span>active streak${hero.active === 1 ? '' : 's'}</span></div>
        <div><b class="num">${hero.dueLeft}</b><span>still due today</span></div>
      </div>
    </section>
    <div class="seg" role="group" aria-label="Sort by">${seg}</div>
    <ul class="list">${sorted.map(rowView).join('')}</ul>`;
}

function heatmap(t, ctx) {
  const today = ctx.cronDay;
  const keys = Object.keys(t.days).sort();
  const first = keys[0] || today;
  // Start on a Monday, at least 17 weeks back.
  let start = addDays(today, -7 * 17);
  if (first < start) start = first;
  const dow = (k) => (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0
  start = addDays(start, -dow(start));
  const end = addDays(today, 6 - dow(today));
  let html = '';
  let lastMonth = '';
  for (let wk = start; wk <= end; wk = addDays(wk, 7)) {
    const month = wk.slice(0, 7);
    const label = month !== lastMonth ? fmtDay(wk, { month: 'short' }) : '';
    lastMonth = month;
    html += `<span class="m">${label}</span>`;
    for (let d = 0; d < 7; d++) {
      const k = addDays(wk, d);
      const st = k > today ? 'future' : t.days[k] || '';
      const title = k > today ? '' : `${fmtDay(k)}: ${({ done: 'done', missed: 'missed', notdue: 'not due', due: 'due, not done yet' })[st] || 'no data'}`;
      html += `<i class="${st}${k === today ? ' today' : ''}" title="${esc(title)}"></i>`;
    }
  }
  return `<div class="heat-wrap"><div class="heat" role="img" aria-label="Completion calendar">${html}</div></div>
    <div class="legend">
      <span><i style="background:var(--cell-done)"></i>Done</span>
      <span><i style="background:var(--cell-missed)"></i>Missed</span>
      <span><i style="background:var(--cell-notdue)"></i>Not due</span>
      <span><i style="background:var(--cell-empty)"></i>No data</span>
    </div>`;
}

function detailView(id) {
  const v = state.view;
  const t = v?.tasks.find((x) => x.id === id);
  if (!t) return `<a class="back" href="#/">‹ Streaks</a><div class="empty"><h2>Daily not found</h2><p>It may have been deleted in Habitica.</p></div>`;
  const next = nextMilestone(t.streak);
  const prevMs = milestoneFor(t.streak);
  const pct = next ? Math.round(((t.streak - prevMs) / (next - prevMs)) * 100) : 100;
  const rate = t.rate == null ? '—' : `${Math.round(t.rate * 100)}%`;
  const reached = MILESTONES.filter((m) => t.best >= m);
  return `<a class="back" href="#/">‹ Streaks</a>
    <div class="detail-head"><h1>${esc(t.text)}</h1></div>
    ${notes()}
    <div class="detail-hero">
      <div class="big num">${FLAME}${t.streak}</div>
      <div class="side">${statusPill(t)}<div class="muted" style="margin-top:6px;font-size:14px">${esc(describeSchedule(t))}</div></div>
    </div>
    <div class="card">
      ${next ? `<div style="display:flex;justify-content:space-between;font-size:14px"><span class="muted">Next milestone</span><span><b class="num">${next - t.streak}</b> <span class="muted">to go → ${next} days</span></span></div>
        <div class="progress"><i style="width:${pct}%"></i></div>` : `<div style="font-size:14px">Past every milestone. Legendary.</div>`}
      ${reached.length ? `<div class="row-meta" style="margin-top:12px"><span>Milestones reached:</span>${reached.map((m) => `<span class="pill ms">${m}-day</span>`).join('')}</div>` : ''}
    </div>
    <div class="stats">
      <div><b class="num">${t.best}</b><span>Best streak</span></div>
      <div><b class="num">${t.completions}</b><span>Completions on record</span></div>
      <div><b class="num">${rate}</b><span>Done when due</span></div>
      <div><b class="num">${t.breaks.length}</b><span>Streak breaks</span></div>
    </div>
    <div class="card"><h2>History</h2>${heatmap(t, v.ctx)}</div>
    <div class="card"><h2>Streak breaks</h2>
      ${t.breaks.length ? `<ul class="breaks">${t.breaks.map((b) => `<li><span>${fmtDay(b.day, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span class="muted">lost a <b class="num">${b.lost}</b>-day streak</span></li>`).join('')}</ul>`
        : '<p>No breaks on record.</p>'}
    </div>
    ${t.notes ? `<div class="card"><h2>Notes</h2><p style="white-space:pre-wrap">${esc(t.notes)}</p></div>` : ''}`;
}

function settingsView(setup) {
  const c = store.getCreds();
  return `${setup ? `<header class="topbar"><h1>Welcome to Streakboard</h1></header>
      <p class="muted">Your Habitica streaks, streak-first. Enter your Habitica API credentials to start — they're stored only on this device and sent only to habitica.com.</p>`
    : '<header class="topbar"><h1>Settings</h1></header>'}
    <form class="card" id="creds-form" autocomplete="off">
      <h2>Habitica account</h2>
      <p>Find these in Habitica → Settings → Site Data → API.</p>
      <label for="uid">User ID</label>
      <input type="text" id="uid" name="userId" inputmode="text" autocapitalize="off" spellcheck="false" value="${esc(c?.userId || '')}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required>
      <label for="tok">API token</label>
      <div class="field">
        <input type="password" id="tok" name="apiToken" autocapitalize="off" spellcheck="false" value="${esc(c?.apiToken || '')}" placeholder="API token" required>
        <button type="button" class="icon-btn" data-action="toggle-token" aria-label="Show token" style="border:1px solid var(--line)">👁</button>
      </div>
      <div style="margin-top:14px"><button class="btn primary" type="submit">${c ? 'Save & test' : 'Connect'}</button></div>
    </form>
    ${setup ? '' : `
    <div class="card">
      <h2>Backup</h2>
      <p>Streak history and best streaks live only on this device. iOS can clear website data, so export a backup now and then.</p>
      <button class="btn" data-action="export">Export backup (JSON)</button>
      <button class="btn" data-action="import">Import backup</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <p style="margin:12px 0 0;font-size:13px">Persistent storage: ${state.persisted === true ? 'granted' : state.persisted === false ? 'not granted (export backups)' : 'unknown'}</p>
    </div>
    <div class="card">
      <h2>Account</h2>
      <button class="btn danger" data-action="logout">Log out &amp; clear credentials</button>
      <button class="btn danger" data-action="wipe">Delete local streak history</button>
    </div>
    <p class="muted" style="text-align:center;font-size:12px">Streakboard ${APP_VERSION} · not affiliated with Habitica</p>`}`;
}

// ---------- actions ----------

async function doRefresh({ force = false, quiet = false } = {}) {
  const creds = store.getCreds();
  if (!creds || state.loading) return;
  state.loading = true;
  if (!quiet) rerenderData();
  try {
    const v = await store.refresh(creds, { force });
    if (v) { state.view = v; state.error = null; }
  } catch (e) {
    state.error = e.retryAt
      ? `Habitica rate limit reached — try again after ${new Date(e.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
      : e.message || 'Something went wrong.';
    if (e.status === 401) state.error += ' Check your credentials in Settings.';
  } finally {
    state.loading = false;
    rerenderData();
  }
}

app.addEventListener('click', async (ev) => {
  const sortBtn = ev.target.closest('[data-sort]');
  if (sortBtn) {
    state.sort = sortBtn.dataset.sort;
    localStorage.setItem('sb.sort', state.sort);
    render();
    return;
  }
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'refresh') doRefresh({ force: true });
  else if (action === 'toggle-token') {
    const i = document.getElementById('tok');
    i.type = i.type === 'password' ? 'text' : 'password';
  } else if (action === 'export') exportBackup();
  else if (action === 'import') document.getElementById('import-file').click();
  else if (action === 'logout') {
    if (!confirm('Log out and remove your Habitica credentials from this device? Your local streak history is kept.')) return;
    store.clearCreds();
    location.hash = '#/settings';
    render();
  } else if (action === 'wipe') {
    if (!confirm('Delete all locally stored streak history and best streaks? Export a backup first if unsure.')) return;
    await store.wipeLocalData();
    state.view = null;
    toast('Local history deleted');
    doRefresh({ force: true });
  }
});

app.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'creds-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const creds = { userId: String(f.get('userId')).trim(), apiToken: String(f.get('apiToken')).trim() };
  const btn = ev.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await store.testCreds(creds);
    store.setCreds(creds);
    state.error = null;
    toast('Connected to Habitica');
    location.hash = '#/';
    render();
    doRefresh({ force: true });
  } catch (e) {
    toast(e.message || 'Could not connect', 4000);
    btn.disabled = false;
    btn.textContent = 'Try again';
  }
});

app.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'import-file' || !ev.target.files[0]) return;
  try {
    const json = JSON.parse(await ev.target.files[0].text());
    const r = await store.importBackup(json);
    state.view = await store.loadView();
    toast(`Imported ${r.snapshots} snapshots for ${r.tasks} dailies`);
  } catch (e) {
    toast(e.message || 'Import failed', 4000);
  }
  ev.target.value = '';
});

async function exportBackup() {
  const data = await store.exportBackup();
  const name = `streakboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  // iOS standalone PWAs handle the share sheet better than downloads.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- pull to refresh ----------

(function pullToRefresh() {
  const ptr = document.getElementById('ptr');
  let startY = null, dy = 0;
  const THRESHOLD = 70;
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || route().name === 'settings' || state.loading) return;
    startY = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    if (dy <= 0) return;
    const pull = Math.min(dy * 0.5, 90);
    ptr.style.transition = app.style.transition = 'none';
    ptr.style.transform = `translateY(${pull - 40}px) rotate(${dy * 2}deg)`;
    ptr.style.opacity = String(Math.min(1, dy / THRESHOLD));
    app.style.transform = `translateY(${pull * 0.5}px)`;
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    ptr.style.transition = app.style.transition = '';
    app.style.transform = '';
    if (dy >= THRESHOLD) {
      ptr.classList.add('loading');
      ptr.style.transform = 'translateY(16px)';
      await doRefresh({ force: true });
      ptr.classList.remove('loading');
    }
    ptr.style.transform = '';
    ptr.style.opacity = '0';
  });
})();

// ---------- boot ----------

async function boot() {
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  render();
  try { state.view = await store.loadView(); } catch (e) { console.warn('cache load failed', e); }
  render(); // first paint from cache
  store.requestPersistence().then((p) => { state.persisted = p; }).catch(() => {});
  if (store.getCreds()) doRefresh({ force: true, quiet: !!state.view });

  // Refresh on return to the app when data is older than a few minutes; tick relative times.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!state.view || Date.now() - state.view.fetchedAt > store.AUTO_REFRESH_MS)) {
      doRefresh({ quiet: true });
    }
  });
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (state.view && Date.now() - state.view.fetchedAt > store.AUTO_REFRESH_MS) doRefresh({ quiet: true });
    else updateRelTimes();
  }, 30000);

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
    // A new version took over: reload once so the new shell is used.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !boot.reloaded) { boot.reloaded = true; location.reload(); }
    });
  }
}

boot();
