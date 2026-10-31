// App controller: state, routing, actions, boot.
import * as store from './store.js';
import { crossedMilestones, fmtDuration, nextRollover } from './insights.js';
import { homeView, detailView, insightsView, habitsView, settingsView } from './views.js';
import { esc, relTime, toast, FLAME } from './ui.js';

const app = document.getElementById('app');

const state = {
  view: null,
  loading: false,
  error: null,
  sort: localStorage.getItem('sb.sort') || 'streak',
  period: Number(localStorage.getItem('sb.period')) || 7,
  badge: localStorage.getItem('sb.badge') === '1',
  persisted: null,
  pending: new Set(), // task ids with a write in flight
};

// ---------- routing ----------

function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (!store.getCreds()) return { name: 'settings', setup: true };
  if (h.startsWith('/t/')) return { name: 'detail', id: decodeURIComponent(h.slice(3)) };
  if (['/settings', '/insights', '/habits'].includes(h)) return { name: h.slice(1) };
  return { name: 'home' };
}

function render() {
  const r = route();
  document.body.classList.toggle('setup', !!r.setup);
  document.querySelectorAll('#nav a').forEach((a) => {
    const active = a.dataset.nav === (r.name === 'detail' ? 'home' : r.name);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (r.name === 'settings') app.innerHTML = settingsView(state, r.setup, store.getCreds());
  else if (r.name === 'detail') app.innerHTML = detailView(state, r.id);
  else if (r.name === 'insights') app.innerHTML = insightsView(state);
  else if (r.name === 'habits') app.innerHTML = habitsView(state);
  else app.innerHTML = homeView(state);
  if (r.name === 'detail') {
    const hw = app.querySelector('.heat-wrap');
    if (hw) hw.scrollLeft = hw.scrollWidth;
  }
  updateBadge();
}

// Re-render data views only (never wipe a half-filled settings form).
function rerenderData() {
  if (route().name !== 'settings') render();
  else tick();
}

function tick() {
  app.querySelectorAll('[data-rel]').forEach((el) => (el.textContent = relTime(Number(el.dataset.rel))));
  const ctx = state.view?.ctx;
  if (ctx && !ctx.stale) {
    const left = nextRollover(ctx.today, ctx.tz, ctx.ds) - Date.now();
    app.querySelectorAll('[data-countdown]').forEach((el) => (el.textContent = fmtDuration(left)));
    if (left <= 0) doRefresh({ quiet: true }); // a new Habitica day may have begun
  }
}

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const due = state.view?.tasks.filter((t) => t.isDue && !t.completed).length || 0;
  if (state.badge && due) navigator.setAppBadge(due).catch(() => {});
  else navigator.clearAppBadge?.().catch(() => {});
}

// ---------- celebrations ----------

const celebrateQueue = [];
function celebrate(list) {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem('sb.celebrated') || '[]'); } catch { /* ignore */ }
  for (const c of list) {
    const key = `${c.taskId}:${c.m}:${c.day}`;
    if (seen.includes(key)) continue;
    seen.push(key);
    celebrateQueue.push(c);
  }
  localStorage.setItem('sb.celebrated', JSON.stringify(seen.slice(-100)));
  showNextCelebration();
}

function showNextCelebration() {
  const el = document.getElementById('celebrate');
  if (!el.hidden || !celebrateQueue.length) return;
  const c = celebrateQueue.shift();
  const words = { 7: 'One full week.', 21: 'Three weeks: this is becoming a habit.', 30: 'A whole month.', 66: '66 days: the average time for a habit to stick.', 100: 'Triple digits.', 365: 'A full year. Incredible.' };
  el.innerHTML = `<div class="celebrate-card" role="dialog" aria-label="Milestone reached">
    <div class="burst">${FLAME}</div>
    <div class="celebrate-num num">${c.m}</div>
    <div class="celebrate-sub">day streak</div>
    <p><b>${esc(c.text)}</b></p>
    <p class="muted">${words[c.m] || ''}</p>
    <button class="btn primary" data-action="dismiss-celebration">Keep going</button>
  </div>`;
  el.hidden = false;
}

document.getElementById('celebrate').addEventListener('click', (e) => {
  if (e.target.closest('[data-action=dismiss-celebration]') || e.target.id === 'celebrate') {
    e.currentTarget.hidden = true;
    showNextCelebration();
  }
});

// ---------- data ----------

async function doRefresh({ force = false, quiet = false } = {}) {
  const creds = store.getCreds();
  if (!creds || state.loading) return;
  state.loading = true;
  if (!quiet) rerenderData();
  try {
    const r = await store.refresh(creds, { force });
    if (r) {
      state.view = r.view;
      state.error = null;
      if (r.celebrations.length) celebrate(r.celebrations);
    }
  } catch (e) {
    state.error = e.retryAt
      ? `Habitica rate limit reached. Try again after ${new Date(e.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
      : e.message || 'Something went wrong.';
    if (e.status === 401) state.error += ' Check your credentials in Settings.';
  } finally {
    state.loading = false;
    rerenderData();
  }
}

// After writes, pull the authoritative state from Habitica once things settle.
let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doRefresh({ force: true, quiet: true }), 2500);
}

/** Optimistic write: patch locally, call Habitica, roll back on failure. */
async function optimistic(kind, id, apply, revert, call) {
  const creds = store.getCreds();
  if (!creds || state.pending.has(id)) return false;
  state.pending.add(id);
  state.view = (await store.patchLocal(kind, id, apply)) || state.view;
  render();
  try {
    await call(creds);
    scheduleSync();
    return true;
  } catch (e) {
    state.view = (await store.patchLocal(kind, id, revert)) || state.view;
    toast(e.message || 'Could not save. Change undone.', 4000);
    return false;
  } finally {
    state.pending.delete(id);
    render();
  }
}

async function toggleDaily(id) {
  const t = state.view?.tasks.find((x) => x.id === id);
  if (!t) return;
  const up = !t.completed;
  if (!up && !confirm(`Mark "${t.text}" as not done? This lowers its streak by one.`)) return;
  const before = { completed: t.completed, streak: t.streak };
  const ok = await optimistic('daily', id,
    (it) => { it.completed = up; it.streak = Math.max(0, it.streak + (up ? 1 : -1)); },
    (it) => { it.completed = before.completed; it.streak = before.streak; },
    (creds) => store.scoreTask(creds, id, up ? 'up' : 'down'));
  if (ok && up) {
    const day = state.view.ctx.cronDay;
    celebrate(crossedMilestones(before.streak, before.streak + 1).map((m) => ({ taskId: id, text: t.text, m, day })));
  }
}

function toggleChecklist(id, itemId) {
  const flip = (it) => { const c = it.checklist.find((x) => x.id === itemId); if (c) c.completed = !c.completed; };
  return optimistic('daily', id, flip, flip, (creds) => store.scoreChecklistItem(creds, id, itemId));
}

function plusHabit(id) {
  const now = Date.now();
  return optimistic('habit', id,
    (h) => { h.counterUp = (h.counterUp || 0) + 1; h.history = [...(h.history || []), { date: now, value: h.value, scoredUp: 1, scoredDown: 0 }]; },
    (h) => { h.counterUp = Math.max(0, (h.counterUp || 1) - 1); h.history = (h.history || []).filter((x) => x.date !== now); },
    (creds) => store.scoreTask(creds, id, 'up'));
}

async function startNewDay() {
  const v = state.view;
  const open = v.tasks.filter((t) => t.isDue && !t.completed);
  const msg = open.length
    ? `Start your new day? ${open.length} unticked due daily${open.length === 1 ? '' : 's'} (${open.map((t) => t.text).slice(0, 3).join(', ')}${open.length > 3 ? '…' : ''}) will count as missed.`
    : 'Start your new day?';
  if (!confirm(msg)) return;
  try {
    await store.runCron(store.getCreds());
    toast('New day started');
  } catch (e) {
    toast(e.message || 'Could not start the new day', 4000);
  }
  doRefresh({ force: true });
}

async function toggleBadge() {
  if (!state.badge) {
    // iOS only shows badges for installed PWAs with notification permission.
    if ('Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { toast('Badge needs notification permission'); return; }
    }
    state.badge = true;
  } else {
    state.badge = false;
  }
  localStorage.setItem('sb.badge', state.badge ? '1' : '0');
  render();
  toast(state.badge ? 'Badge on' : 'Badge off');
}

// ---------- events ----------

app.addEventListener('click', async (ev) => {
  const sortBtn = ev.target.closest('[data-sort]');
  if (sortBtn) {
    state.sort = sortBtn.dataset.sort;
    localStorage.setItem('sb.sort', state.sort);
    return render();
  }
  const perBtn = ev.target.closest('[data-period]');
  if (perBtn) {
    state.period = Number(perBtn.dataset.period);
    localStorage.setItem('sb.period', String(state.period));
    return render();
  }
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'refresh') doRefresh({ force: true });
  else if (action === 'toggle') toggleDaily(id);
  else if (action === 'checklist') toggleChecklist(id, btn.dataset.item);
  else if (action === 'habit') plusHabit(id);
  else if (action === 'cron') startNewDay();
  else if (action === 'badge') toggleBadge();
  else if (action === 'toggle-token') {
    const i = document.getElementById('tok');
    i.type = i.type === 'password' ? 'text' : 'password';
  } else if (action === 'export') exportBackup();
  else if (action === 'import') document.getElementById('import-file').click();
  else if (action === 'logout') {
    if (!confirm('Log out and remove your Habitica credentials from this device? Your local streak history is kept.')) return;
    store.clearCreds();
    navigator.clearAppBadge?.().catch(() => {});
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!state.view || Date.now() - state.view.fetchedAt > store.AUTO_REFRESH_MS)) {
      doRefresh({ quiet: true });
    }
  });
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (state.view && Date.now() - state.view.fetchedAt > store.AUTO_REFRESH_MS) doRefresh({ quiet: true });
    else tick();
  }, 30000);

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !boot.reloaded) { boot.reloaded = true; location.reload(); }
    });
  }
}

boot();
