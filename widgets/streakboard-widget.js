// Streakboard widget for the Scriptable app (iOS): https://scriptable.app
// Shows your Habitica streaks on the Home Screen or Lock Screen.
//
// Setup: paste this into a new Scriptable script, run it once in the app to enter your
// Habitica User ID + API token (stored in the iOS Keychain, never in this file), then add
// a Scriptable widget and choose this script.
// Optional widget parameter:
//   (empty)        top streaks
//   risk           at-risk / due dailies first
//   <daily name>   a single daily, e.g. "Google" or "read emails" (matches part of the name)
//
// Smart reminders: whenever the widget refreshes (or you run the script), it schedules local
// notifications only if dailies are still due, and clears them once everything is done.
// Change the times below. Scriptable asks for notification permission the first time.
const REMINDERS = true;
const EVENING_REMINDER = '21:00'; // your phone's local time, or '' to turn off
const LAST_CALL_MINUTES = 90;      // minutes before your Habitica day resets, or 0 to turn off

const APP_URL = 'https://severus-snape284.github.io/streakboard/';
const API = 'https://habitica.com/api/v3';
const KEY_UID = 'streakboard_habitica_user_id';
const KEY_TOKEN = 'streakboard_habitica_api_token';
const CACHE_FILE = 'streakboard-widget-cache.json';

const C = {
  bg: new Color('#0e0e12'),
  surface: new Color('#1d1d25'),
  text: new Color('#f5f5f7'),
  muted: new Color('#9d9dab'),
  flame: new Color('#ff8a3d'),
  done: new Color('#3fcf8e'),
  due: new Color('#ffcc4d'),
  risk: new Color('#ff5f5f'),
};

// ---------- pure helpers (same rules as the web app) ----------

function dayKey(ts, tz, dayStart) {
  return new Date(ts - tz * 60000 - dayStart * 3600000).toISOString().slice(0, 10);
}

function nextRollover(today, tz, dayStart) {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime() + tz * 60000 + dayStart * 3600000;
}

function fmtLeft(ms) {
  if (ms <= 0) return '0m';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function summarize(user, dailies, now) {
  const tz = user.preferences?.timezoneOffset ?? 0;
  const ds = user.preferences?.dayStart ?? 0;
  const today = dayKey(now, tz, ds);
  const stale = !!user.lastCron && dayKey(Date.parse(user.lastCron), tz, ds) < today;
  const due = dailies.filter((t) => t.isDue);
  const open = due.filter((t) => !t.completed);
  const risk = open.filter((t) => t.streak >= 3).sort((a, b) => b.streak - a.streak);
  const byStreak = [...dailies].sort((a, b) => b.streak - a.streak || a.text.localeCompare(b.text));
  const rank = (t) => (t.isDue && !t.completed ? (t.streak >= 3 ? 0 : 1) : t.completed ? 2 : 3);
  const byRisk = [...dailies].sort((a, b) => rank(a) - rank(b) || b.streak - a.streak);
  return {
    top: byStreak[0] && byStreak[0].streak > 0 ? byStreak[0] : null,
    byStreak, byRisk, risk,
    dueTotal: due.length,
    doneDue: due.length - open.length,
    open: open.length,
    active: dailies.filter((t) => t.streak > 0).length,
    left: stale ? null : nextRollover(today, tz, ds) - now,
    toReset: nextRollover(today, tz, ds) - now,
    stale,
  };
}

// Per-day statuses from Habitica history. Mirrors analyzeHistory/historyToDays in js/streaks.js
// (kept in step by tests/widget.test.mjs).
function addDays(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function analyzeHistory(dailies, lastCron, tz, ds) {
  const cronStart = {};
  const active = new Set();
  const note = (ts, isCron) => {
    const k = dayKey(ts, tz, ds);
    active.add(k);
    if (isCron && (!cronStart[k] || ts < cronStart[k])) cronStart[k] = ts;
  };
  for (const t of dailies) for (const h of t.history || []) note(Number(h.date), !h.completed);
  if (lastCron) note(Date.parse(lastCron), true);
  return { cronStart, activeDays: [...active].sort() };
}

function historyToDays(task, a, tz, ds) {
  const RANK = { done: 4, missed: 3, rest: 2, notdue: 0 };
  const days = {};
  const set = (k, st) => { if (!days[k] || RANK[st] > RANK[days[k]]) days[k] = st; };
  let prevValue = null;
  for (const h of [...(task.history || [])].sort((x, y) => x.date - y.date)) {
    if (h.completed === undefined && h.isDue === undefined) continue;
    const ts = Number(h.date);
    const k = dayKey(ts, tz, ds);
    const prev = a.activeDays.filter((d) => d < k).pop() || addDays(k, -1);
    if (h.completed) set(a.cronStart[k] && ts < a.cronStart[k] ? prev : k, 'done');
    else {
      const closed = h.isDue && days[prev] === 'done' ? addDays(k, -1) : prev;
      const rest = h.isDue && prevValue != null && h.value === prevValue;
      set(closed, !h.isDue ? 'notdue' : rest ? 'rest' : 'missed');
    }
    prevValue = h.value;
  }
  return days;
}

function bestStreak(days, current) {
  let cur = 0, best = 0;
  for (const k of Object.keys(days).sort()) {
    if (days[k] === 'done') best = Math.max(best, ++cur);
    else if (days[k] === 'missed') cur = 0;
  }
  return Math.max(best, current);
}

const MILESTONES = [7, 21, 30, 66, 100, 365];

/** Everything the single-daily widget shows. */
function dailyDetail(task, all, user, now) {
  const tz = user.preferences?.timezoneOffset ?? 0;
  const ds = user.preferences?.dayStart ?? 0;
  const today = user.lastCron ? dayKey(Date.parse(user.lastCron), tz, ds) : dayKey(now, tz, ds);
  const days = historyToDays(task, analyzeHistory(all, user.lastCron, tz, ds), tz, ds);
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const k = addDays(today, -i);
    last7.push(i === 0 ? (task.completed ? 'done' : task.isDue ? 'due' : 'notdue') : days[k] && days[k] !== '' ? days[k] : '');
  }
  const next = MILESTONES.find((m) => m > task.streak) || null;
  const s = summarize(user, all, now);
  return { best: bestStreak(Object.fromEntries(Object.entries(days).filter(([k]) => k < today)), task.streak), last7, next, left: s.left, stale: s.stale };
}

function findDaily(dailies, query) {
  const q = query.toLowerCase();
  return dailies.find((t) => plain(t.text).toLowerCase() === q) || dailies.find((t) => plain(t.text).toLowerCase().includes(q)) || null;
}

function plain(text) {
  // Habitica task text can contain markdown/emoji shortcodes; keep it readable.
  return String(text || '').replace(/[*_`~]/g, '').replace(/:([a-z0-9_+-]+):/g, '').trim();
}

// ---------- reminders ----------

const REMINDER_IDS = ['streakboard-evening', 'streakboard-lastcall'];

function reminderBody(s) {
  if (s.stale) return "You haven't started your Habitica day yet. Open it and keep your streaks going.";
  if (!s.open) return null;
  const first = s.risk[0] || s.byStreak.find((t) => t.isDue && !t.completed);
  const more = s.open - 1;
  return `${plain(first.text)}${first.streak ? ` (${first.streak}-day streak)` : ''}${more ? ` and ${more} more` : ''} still due.`;
}

/** Notifications to schedule from now: [{ id, at: Date, title, body }]. */
function planReminders(s, now) {
  if (!REMINDERS) return [];
  const body = reminderBody(s);
  if (!body) return [];
  const out = [];
  const m = /^(\d{1,2}):(\d{2})$/.exec(EVENING_REMINDER || '');
  if (m) {
    const at = new Date(now);
    at.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (at.getTime() > now + 60000 && at.getTime() < now + s.toReset) {
      out.push({ id: REMINDER_IDS[0], at, title: s.risk.length ? `🔥 ${s.risk.length} streak${s.risk.length === 1 ? '' : 's'} at risk` : 'Dailies still due', body });
    }
  }
  if (LAST_CALL_MINUTES > 0) {
    const at = now + s.toReset - LAST_CALL_MINUTES * 60000;
    if (at > now + 60000) out.push({ id: REMINDER_IDS[1], at: new Date(at), title: `Last call: day resets in ${fmtLeft(LAST_CALL_MINUTES * 60000)}`, body });
  }
  return out;
}

async function syncReminders(plan) {
  try {
    await Notification.removePending(REMINDER_IDS);
    for (const r of plan) {
      const n = new Notification();
      n.identifier = r.id;
      n.threadIdentifier = 'streakboard';
      n.title = r.title;
      n.body = r.body;
      n.openURL = APP_URL;
      n.setTriggerDate(r.at);
      await n.schedule();
    }
  } catch (e) {
    // Reminders are best-effort; the widget still renders.
    console.log(`Reminder scheduling failed: ${e}`);
  }
}

// ---------- credentials & data ----------

async function askCredentials() {
  const a = new Alert();
  a.title = 'Streakboard widget';
  a.message = 'Enter your Habitica User ID and API token (Habitica → Settings → Site Data → API). They are stored in the iOS Keychain.';
  a.addTextField('User ID', Keychain.contains(KEY_UID) ? Keychain.get(KEY_UID) : '');
  a.addSecureTextField('API token', '');
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if ((await a.presentAlert()) === -1) return false;
  const uid = a.textFieldValue(0).trim();
  const tok = a.textFieldValue(1).trim();
  if (!uid || !tok) return false;
  Keychain.set(KEY_UID, uid);
  Keychain.set(KEY_TOKEN, tok);
  return true;
}

async function get(path, uid, tok) {
  const r = new Request(API + path);
  r.headers = { 'x-api-user': uid, 'x-api-key': tok, 'x-client': `${uid}-HabiticaStreakDashboard` };
  r.timeoutInterval = 20;
  const body = await r.loadJSON();
  if (!body || !body.success) {
    const code = r.response ? r.response.statusCode : 0;
    throw new Error(code === 401 ? 'Check your Habitica credentials' : body?.message || `Habitica error ${code}`);
  }
  return body.data;
}

function cachePath() {
  const fm = FileManager.local();
  return [fm, fm.joinPath(fm.documentsDirectory(), CACHE_FILE)];
}

async function loadData() {
  const uid = Keychain.contains(KEY_UID) ? Keychain.get(KEY_UID) : null;
  const tok = Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : null;
  if (!uid || !tok) throw new Error('Run this script in Scriptable once to sign in');
  const [fm, path] = cachePath();
  try {
    const [user, dailies] = await Promise.all([
      get('/user?userFields=preferences.dayStart,preferences.timezoneOffset,lastCron', uid, tok),
      get('/tasks/user?type=dailys', uid, tok),
    ]);
    const slim = {
      at: Date.now(),
      user: { preferences: user.preferences, lastCron: user.lastCron },
      dailies: dailies.map((t) => ({
        text: t.text, streak: t.streak || 0, isDue: !!t.isDue, completed: !!t.completed,
        history: (t.history || []).map((h) => ({ date: h.date, value: h.value, isDue: h.isDue, completed: h.completed })),
      })),
    };
    fm.writeString(path, JSON.stringify(slim));
    return slim;
  } catch (e) {
    // Offline or rate-limited: fall back to the last good data.
    if (fm.fileExists(path)) return { ...JSON.parse(fm.readString(path)), cached: true, error: e.message };
    throw e;
  }
}

// ---------- rendering ----------

function txt(stack, s, size, color, { bold = false, rounded = false, lines = 1 } = {}) {
  const t = stack.addText(String(s));
  t.font = rounded ? Font.boldRoundedSystemFont(size) : bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.6;
  return t;
}

function flame(stack, size, color = C.flame) {
  const img = stack.addImage(SFSymbol.named('flame.fill').image);
  img.imageSize = new Size(size, size);
  img.tintColor = color;
  return img;
}

function statusColor(t) {
  if (t.completed) return C.done;
  if (t.isDue) return t.streak >= 3 ? C.risk : C.due;
  return C.muted;
}

function header(w, s) {
  const row = w.addStack();
  row.centerAlignContent();
  flame(row, 26);
  row.addSpacer(4);
  txt(row, s.top ? s.top.streak : 0, 34, C.text, { rounded: true });
  row.addSpacer();
  const right = row.addStack();
  right.layoutVertically();
  txt(right, s.dueTotal && s.open === 0 ? 'Perfect day' : `${s.open} due`, 14, s.open ? C.due : C.done, { bold: true });
  txt(right, s.stale ? 'New day pending' : `${fmtLeft(s.left)} left`, 11, C.muted);
  return row;
}

function taskRow(w, t, size = 13) {
  const r = w.addStack();
  r.centerAlignContent();
  const dot = r.addText('●');
  dot.font = Font.systemFont(size - 3);
  dot.textColor = statusColor(t);
  r.addSpacer(6);
  txt(r, plain(t.text), size, t.completed ? C.muted : C.text);
  r.addSpacer();
  flame(r, size - 1, t.streak ? C.flame : C.muted);
  r.addSpacer(2);
  txt(r, t.streak, size + 1, t.streak ? C.text : C.muted, { rounded: true });
}

const DOT = { done: C.done, missed: C.risk, notdue: C.muted, rest: new Color('#5b8ac7'), due: C.due, '': new Color('#3a3a46') };

function dotsRow(stack, statuses, size, mono = false) {
  const r = stack.addStack();
  r.spacing = 3;
  statuses.forEach((st, i) => {
    const t = r.addText(st === 'due' ? '□' : '■');
    t.font = Font.systemFont(size);
    t.textColor = mono ? (st === 'done' ? Color.white() : new Color('#ffffff', 0.35)) : DOT[st] || DOT[''];
    if (i === statuses.length - 1 && !mono) t.font = Font.boldSystemFont(size);
  });
  return r;
}

function statusText(task, d) {
  if (task.completed) return ['✓ Done today', C.done];
  if (task.isDue) return [d.stale ? 'Due · new day pending' : `Due · ${fmtLeft(d.left)} left`, task.streak >= 3 ? C.risk : C.due];
  return ['Not due today', C.muted];
}

function buildSingle(data, task, family, now) {
  const d = dailyDetail(task, data.dailies, data.user, now);
  const w = new ListWidget();
  w.url = APP_URL;
  w.refreshAfterDate = new Date(now + 15 * 60000);
  const name = plain(task.text);
  const [status, statusColorV] = statusText(task, d);

  if (family === 'accessoryInline') {
    w.addText(`🔥${task.streak} ${name}${task.completed ? ' ✓' : ''}`);
    return w;
  }
  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const st = w.addStack();
    st.layoutVertically();
    st.centerAlignContent();
    const top = st.addStack();
    top.addSpacer();
    flame(top, 12, Color.white());
    top.addSpacer();
    const n = st.addStack();
    n.addSpacer();
    txt(n, task.streak, 20, Color.white(), { rounded: true });
    n.addSpacer();
    txt(st, task.completed ? 'done' : 'days', 9, Color.white());
    return w;
  }
  if (family === 'accessoryRectangular') {
    const r = w.addStack();
    r.centerAlignContent();
    flame(r, 14, Color.white());
    r.addSpacer(3);
    txt(r, `${task.streak}  ${name}`, 15, Color.white(), { rounded: true });
    txt(w, task.completed ? 'Done today ✓' : task.isDue ? (d.stale ? 'Due' : `Due · ${fmtLeft(d.left)} left`) : 'Not due today', 12, Color.white());
    dotsRow(w, d.last7, 10, true);
    return w;
  }

  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);
  const body = family === 'small' ? w : w.addStack();
  const left = family === 'small' ? w : body.addStack();
  if (family !== 'small') { body.layoutHorizontally(); left.layoutVertically(); }
  txt(left, name, 13, C.muted, { bold: true, lines: 2 });
  left.addSpacer();
  const big = left.addStack();
  big.centerAlignContent();
  flame(big, 28, task.streak ? C.flame : C.muted);
  big.addSpacer(2);
  txt(big, task.streak, 44, task.streak ? C.text : C.muted, { rounded: true });
  txt(left, `day streak · best ${d.best}`, 11, C.muted);
  left.addSpacer(6);
  dotsRow(left, d.last7, 11);
  left.addSpacer(4);
  txt(left, status, 11, statusColorV, { bold: true });
  if (family !== 'small') {
    body.addSpacer();
    const right = body.addStack();
    right.layoutVertically();
    if (d.next) {
      txt(right, 'Next milestone', 11, C.muted);
      txt(right, `${d.next - task.streak} to go`, 22, C.text, { rounded: true });
      txt(right, `→ ${d.next} days`, 11, C.muted);
      right.addSpacer(8);
    }
    txt(right, 'Best ever', 11, C.muted);
    const b = right.addStack();
    b.centerAlignContent();
    flame(b, 14);
    b.addSpacer(2);
    txt(b, d.best, 22, C.text, { rounded: true });
    right.addSpacer();
  }
  return w;
}

function buildWidget(data, family, rawParam, now) {
  const param = (rawParam || '').trim();
  if (param && param.toLowerCase() !== 'risk') {
    const task = findDaily(data.dailies, param);
    if (!task) return errorWidget(`No daily matches "${param}". Set the widget parameter to part of a daily's name.`);
    return buildSingle(data, task, family, now);
  }
  const s = summarize(data.user, data.dailies, now);
  const list = param.toLowerCase() === 'risk' ? s.byRisk : s.byStreak;
  const w = new ListWidget();
  w.url = APP_URL;
  w.refreshAfterDate = new Date(now + 15 * 60000);

  if (family === 'accessoryInline') {
    w.addText(`🔥${s.top ? s.top.streak : 0} · ${s.open} due${s.left != null ? ` · ${fmtLeft(s.left)}` : ''}`);
    return w;
  }
  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const st = w.addStack();
    st.layoutVertically();
    st.centerAlignContent();
    txt(st, s.open, 22, Color.white(), { rounded: true });
    txt(st, 'due', 10, Color.white());
    return w;
  }
  if (family === 'accessoryRectangular') {
    const r = w.addStack();
    r.centerAlignContent();
    flame(r, 14, Color.white());
    r.addSpacer(3);
    txt(r, `${s.top ? s.top.streak : 0} · ${s.open} due`, 15, Color.white(), { rounded: true });
    const first = s.risk[0] || list.find((t) => t.isDue && !t.completed);
    txt(w, first ? `${plain(first.text)} (${first.streak})` : 'All done today', 12, Color.white());
    txt(w, s.stale ? 'New day pending' : `${fmtLeft(s.left)} left today`, 11, Color.white());
    return w;
  }

  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);
  header(w, s);
  if (family === 'small') {
    w.addSpacer(6);
    txt(w, s.top ? plain(s.top.text) : 'Start a streak', 12, C.muted, { lines: 2 });
    w.addSpacer();
    if (s.risk.length) txt(w, `⚠︎ ${s.risk.length} at risk`, 12, C.risk, { bold: true });
    else txt(w, `${s.doneDue}/${s.dueTotal} done · ${s.active} active`, 11, C.muted);
  } else {
    w.addSpacer(8);
    const n = family === 'medium' ? 4 : 10;
    for (const t of list.slice(0, n)) { taskRow(w, t, family === 'medium' ? 13 : 15); w.addSpacer(family === 'medium' ? 3 : 6); }
    w.addSpacer();
    txt(w, `${s.doneDue}/${s.dueTotal} done today · ${s.active} active streak${s.active === 1 ? '' : 's'}${data.cached ? ' · offline' : ''}`, 10, C.muted);
  }
  return w;
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = APP_URL;
  txt(w, 'Streakboard', 13, C.flame, { bold: true });
  w.addSpacer(4);
  txt(w, msg, 12, C.muted, { lines: 4 });
  w.refreshAfterDate = new Date(Date.now() + 30 * 60000);
  return w;
}

// ---------- main ----------

async function main() {
  if (!config.runsInWidget && !Keychain.contains(KEY_TOKEN)) {
    if (!(await askCredentials())) return Script.complete();
  }
  let w;
  try {
    const data = await loadData();
    const now = Date.now();
    // Only (re)plan reminders from fresh data, never from the offline cache.
    if (!data.cached) await syncReminders(planReminders(summarize(data.user, data.dailies, now), now));
    w = buildWidget(data, config.widgetFamily || 'medium', (args.widgetParameter || '').trim(), now);
  } catch (e) {
    w = errorWidget(e.message);
  }
  if (config.runsInWidget) Script.setWidget(w);
  else {
    const a = new Alert();
    a.title = 'Streakboard widget';
    a.addAction('Preview medium');
    a.addAction('Preview small');
    a.addAction('Preview large');
    a.addAction('Change credentials');
    a.addCancelAction('Done');
    const i = await a.presentSheet();
    if (i === 0) await w.presentMedium();
    else if (i === 1) await buildWidgetFor('small');
    else if (i === 2) await buildWidgetFor('large');
    else if (i === 3) await askCredentials();
  }
  Script.complete();
}

async function buildWidgetFor(family) {
  try {
    const w = buildWidget(await loadData(), family, '', Date.now());
    if (family === 'small') await w.presentSmall(); else await w.presentLarge();
  } catch (e) {
    await errorWidget(e.message).presentSmall();
  }
}

await main();
