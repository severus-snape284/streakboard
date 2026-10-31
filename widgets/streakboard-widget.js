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
// Siri & Apple Intelligence: run this script from a Shortcut ("Run Script" action) with a parameter:
//   briefing (or empty)   spoken status: what's done, what's due, what's at risk, time left
//   tomorrow              what's due tomorrow
//   week                  the last 7 days: rate, perfect days, strongest and weakest daily
//   tick <name>           check off a daily, or +1 a positive habit, by (part of) its name
//   ask <question>        returns a prompt with your data for the "Use Model" action
// The reply is the shortcut's output; end the Shortcut with "Show Result" so Siri reads it aloud.
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

async function post(path, uid, tok) {
  const r = new Request(API + path);
  r.method = 'POST';
  r.headers = { 'x-api-user': uid, 'x-api-key': tok, 'x-client': `${uid}-HabiticaStreakDashboard` };
  r.timeoutInterval = 20;
  const body = await r.loadJSON();
  if (!body || !body.success) throw new Error(body?.message || 'Habitica rejected the change');
  return body.data;
}

function creds() {
  return Keychain.contains(KEY_TOKEN) ? { uid: Keychain.get(KEY_UID), tok: Keychain.get(KEY_TOKEN) } : null;
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
      get('/user?userFields=preferences.dayStart,preferences.timezoneOffset,preferences.sleep,lastCron', uid, tok),
      get('/tasks/user?type=dailys', uid, tok),
    ]);
    const slim = {
      at: Date.now(),
      user: { preferences: user.preferences, lastCron: user.lastCron },
      dailies: dailies.map((t) => ({
        id: t.id, text: t.text, streak: t.streak || 0, isDue: !!t.isDue, completed: !!t.completed, nextDue: t.nextDue || [],
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

// ---------- Siri & Apple Intelligence ----------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayOf = (key) => WEEKDAYS[new Date(key + 'T00:00:00Z').getUTCDay()];

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function spokenLeft(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60), r = m % 60;
  const hs = h ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const rs = r ? `${r} minute${r === 1 ? '' : 's'}` : '';
  return hs && rs ? `${hs} and ${rs}` : hs || rs || 'less than a minute';
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** Habitica time context plus per-daily day maps (same logic as the app). */
function voiceCtx(data, now) {
  const tz = data.user.preferences?.timezoneOffset ?? 0;
  const ds = data.user.preferences?.dayStart ?? 0;
  const today = data.user.lastCron ? dayKey(Date.parse(data.user.lastCron), tz, ds) : dayKey(now, tz, ds);
  const a = analyzeHistory(data.dailies, data.user.lastCron, tz, ds);
  const days = data.dailies.map((t) => historyToDays(t, a, tz, ds));
  return { tz, ds, today, a, days, s: summarize(data.user, data.dailies, now), resting: !!data.user.preferences?.sleep };
}

function lastDueOutcome(days, before) {
  const keys = Object.keys(days).filter((k) => k < before && (days[k] === 'done' || days[k] === 'missed')).sort();
  return keys.length ? days[keys[keys.length - 1]] : null;
}

function briefingText(data, now) {
  const v = voiceCtx(data, now);
  const { s } = v;
  const h = new Date(now - v.tz * 60000).getUTCHours(); // your Habitica time zone
  // Before your custom day start it's still "last night" in Habitica terms.
  const parts = [`${h < v.ds || h >= 18 ? 'Good evening' : h < 12 ? 'Good morning' : 'Good afternoon'}.`];
  if (v.resting) parts.push("You're resting in the Inn, so your streaks are safe.");
  if (s.stale) parts.push(`Habitica hasn't started your new day yet, so anything you tick now still counts for ${weekdayOf(v.today)}.`);
  if (!s.dueTotal) parts.push('Nothing is due today.');
  else if (!s.open) parts.push(`Perfect day: all ${s.dueTotal} dailies are done.`);
  else {
    parts.push(`You've done ${s.doneDue} of ${s.dueTotal} dailies.`);
    const open = s.byRisk.filter((t) => t.isDue && !t.completed);
    const desc = open.slice(0, 4).map((t) => {
      const twice = lastDueOutcome(v.days[data.dailies.indexOf(t)], v.today) === 'missed';
      return `${plain(t.text)}${t.streak ? `, ${t.streak}-day streak` : ''}${twice ? ', missed last time' : t.streak >= 3 ? ', at risk' : ''}`;
    });
    parts.push(`Still due: ${desc.join('; ')}${open.length > 4 ? `; and ${open.length - 4} more` : ''}.`);
    const ms = open.find((t) => MILESTONES.includes(t.streak + 1));
    if (ms) parts.push(`Tick ${plain(ms.text)} today to reach ${ms.streak + 1} days.`);
    if (s.left != null) parts.push(`${cap(spokenLeft(s.left))} until your day resets.`);
  }
  if (s.top) parts.push(`Your best current streak is ${plain(s.top.text)} at ${s.top.streak} days.`);
  return parts.join(' ');
}

function dueTomorrow(data, now) {
  const v = voiceCtx(data, now);
  const tomorrow = addDays(v.today, 1);
  const known = data.dailies.some((t) => (t.nextDue || []).length);
  const list = data.dailies.filter((t) => (t.nextDue || []).some((d) => {
    const ts = Date.parse(d);
    return !isNaN(ts) && dayKey(ts, v.tz, 0) === tomorrow;
  }));
  return { known, list, tomorrow };
}

function tomorrowText(data, now) {
  const { known, list, tomorrow } = dueTomorrow(data, now);
  if (!known) return "I don't have tomorrow's schedule yet. Open Streakboard once and ask again.";
  if (!list.length) return `Nothing is due on ${weekdayOf(tomorrow)}. Enjoy the break.`;
  const names = list.map((t) => `${plain(t.text)}${t.streak ? ` (${t.streak} day${t.streak === 1 ? '' : 's'})` : ''}`);
  return `On ${weekdayOf(tomorrow)} you have ${list.length} ${list.length === 1 ? 'daily' : 'dailies'} due: ${listJoin(names)}.`;
}

function weekStats(data, v, from, to) {
  let done = 0, due = 0;
  const per = data.dailies.map((t, i) => {
    let d = 0, m = 0;
    for (const [k, st] of Object.entries(v.days[i])) {
      if (k < from || k > to) continue;
      if (st === 'done') d++; else if (st === 'missed') m++;
    }
    done += d; due += d + m;
    return { t, done: d, missed: m };
  });
  const byDay = {};
  v.days.forEach((dm) => Object.entries(dm).forEach(([k, st]) => {
    if (k < from || k > to || (st !== 'done' && st !== 'missed')) return;
    byDay[k] = byDay[k] || { done: 0, missed: 0 };
    byDay[k][st]++;
  }));
  const perfect = Object.values(byDay).filter((x) => x.missed === 0 && x.done > 0).length;
  return { done, due, per, perfect };
}

function weekText(data, now) {
  const v = voiceCtx(data, now);
  const w = weekStats(data, v, addDays(v.today, -7), addDays(v.today, -1));
  const prev = weekStats(data, v, addDays(v.today, -14), addDays(v.today, -8));
  if (!w.due) return "I don't have enough history for the last 7 days yet.";
  const rate = Math.round((100 * w.done) / w.due);
  const parts = [`Over the last 7 days you did ${w.done} of ${w.due} due dailies, ${rate} percent, with ${w.perfect} perfect day${w.perfect === 1 ? '' : 's'}.`];
  if (prev.due) {
    const p = Math.round((100 * prev.done) / prev.due);
    parts.push(rate > p ? `That's up from ${p} percent the week before.` : rate < p ? `That's down from ${p} percent the week before.` : 'Same as the week before.');
  }
  const strong = w.per.filter((x) => x.done > 0 && x.missed === 0).sort((a, b) => b.done - a.done || b.t.streak - a.t.streak);
  const weak = w.per.filter((x) => x.missed > 0).sort((a, b) => b.missed - a.missed);
  if (strong.length) parts.push(`Strongest: ${listJoin(strong.slice(0, 2).map((x) => plain(x.t.text)))}, done every time it was due.`);
  if (weak.length) parts.push(`Needs work: ${plain(weak[0].t.text)}, missed ${weak[0].missed} time${weak[0].missed === 1 ? '' : 's'}.`);
  return parts.join(' ');
}

/** Compact, plain-text facts for the on-device / Private Cloud Compute model. */
function factsText(data, now, habits = []) {
  const v = voiceCtx(data, now);
  const { s } = v;
  const reset = new Date(nextRollover(v.today, v.tz, v.ds));
  const sym = { done: 'X', missed: '.', notdue: '-', rest: 'r' };
  const lines = [];
  lines.push(`Today is ${weekdayOf(v.today)} ${v.today} (Habitica day; it resets daily at ${v.ds}:00). ${s.stale ? "Habitica hasn't started the new day yet." : `${spokenLeft(s.left)} left today.`}${v.resting ? ' The user is resting in the Inn: streaks are paused and safe.' : ''}`);
  lines.push(`Today: ${s.doneDue} of ${s.dueTotal} due dailies done.`);
  lines.push('Dailies (name | current streak | best ever | today | last 14 days oldest to newest: X done, . missed, - not due, r rest, ? no data | done when due over the last 30 days | usual time ticked | weakest weekday):');
  data.dailies.forEach((t, i) => {
    const dm = v.days[i];
    let pattern = '';
    for (let k = 13; k >= 1; k--) pattern += sym[dm[addDays(v.today, -k)]] || '?';
    pattern += t.completed ? 'X' : t.isDue ? 'o' : '-';
    let d30 = 0, m30 = 0;
    const wd = Array.from({ length: 7 }, () => [0, 0]);
    for (const [k, st] of Object.entries(dm)) {
      if (k >= v.today) continue;
      if (st !== 'done' && st !== 'missed') continue;
      const wi = new Date(k + 'T00:00:00Z').getUTCDay();
      wd[wi][1]++; if (st === 'done') wd[wi][0]++;
      if (k >= addDays(v.today, -30)) { if (st === 'done') d30++; else m30++; }
    }
    const weak = wd.map((x, wi) => ({ wi, rate: x[1] >= 2 && x[0] < x[1] ? x[0] / x[1] : 2 })).sort((a, b) => a.rate - b.rate)[0];
    const mins = (t.history || []).filter((h) => h.completed && !(v.a.cronStart[dayKey(Number(h.date), v.tz, v.ds)] > Number(h.date)))
      // minutes since the Habitica day start, so 23:00 and 01:00 sort as late evening, not midday
      .map((h) => { const loc = new Date(Number(h.date) - v.tz * 60000); return (loc.getUTCHours() * 60 + loc.getUTCMinutes() - v.ds * 60 + 1440) % 1440; })
      .slice(-30).sort((a, b) => a - b);
    const med = mins.length >= 3 ? (mins[mins.length >> 1] + v.ds * 60) % 1440 : null;
    const usual = med == null ? 'unknown' : `${String(Math.floor(med / 60)).padStart(2, '0')}:${String(med % 60).padStart(2, '0')}`;
    const best = bestStreak(Object.fromEntries(Object.entries(dm).filter(([k]) => k < v.today)), t.streak);
    lines.push(`- ${plain(t.text)} | ${t.streak} | ${best} | ${t.completed ? 'done' : t.isDue ? 'due, not done' : 'not due'} | ${pattern} | ${d30 + m30 ? `${Math.round((100 * d30) / (d30 + m30))}% (${d30}/${d30 + m30})` : 'no data'} | ${usual} | ${weak.rate <= 1 ? WEEKDAYS[weak.wi] : 'none'}`);
  });
  const w = weekStats(data, v, addDays(v.today, -7), addDays(v.today, -1));
  if (w.due) lines.push(`Last 7 closed days: ${w.done}/${w.due} done (${Math.round((100 * w.done) / w.due)}%), ${w.perfect} perfect day${w.perfect === 1 ? '' : 's'}.`);
  if (habits.length) {
    lines.push('Positive habits (name | resets | clicks this period):');
    for (const hb of habits) lines.push(`- ${plain(hb.text)} | ${hb.frequency || 'daily'} | ${hb.counterUp || 0}`);
  }
  return lines.join('\n');
}

function askPrompt(question, facts) {
  return `You are the habit coach inside Streakboard, a streak tracker for the user's Habitica dailies. Answer the user's question using only the data below. Your answer will be read aloud by Siri, so reply in 2 to 4 short, plain sentences with no lists, markdown or emoji. Be specific (use daily names and numbers), honest and encouraging, and end with one practical suggestion when it fits. If the data can't answer the question, say so briefly.

DATA
${facts}

QUESTION
${question}`;
}

async function fetchHabits(c) {
  try {
    return (await get('/tasks/user?type=habits', c.uid, c.tok)).filter((h) => h.up);
  } catch {
    return [];
  }
}

async function tickText(data, query, now) {
  const q = query.trim();
  const c = creds();
  if (!q) return 'Which daily? Say tick, followed by its name.';
  if (data.cached) return "I couldn't reach Habitica just now, so nothing was ticked. Try again in a moment.";
  const v = voiceCtx(data, now);
  const t = findDaily(data.dailies, q);
  if (t) {
    const name = plain(t.text);
    if (t.completed) return `${name} is already done. You're on a ${t.streak}-day streak.`;
    try {
      await post(`/tasks/${encodeURIComponent(t.id)}/score/up`, c.uid, c.tok);
    } catch (e) {
      return `I couldn't tick ${name}: ${e.message}.`;
    }
    t.completed = true;
    t.streak += 1;
    try { const [fm, path] = cachePath(); fm.writeString(path, JSON.stringify({ ...data, cached: undefined })); } catch { /* cache is best-effort */ }
    const left = data.dailies.filter((x) => x.isDue && !x.completed).length;
    const parts = [`Done. ${name} is now on a ${t.streak}-day streak.`];
    if (MILESTONES.includes(t.streak)) parts.push(`That's a ${t.streak}-day milestone. Well done!`);
    if (v.s.stale) parts.push(`That counts for ${weekdayOf(v.today)}.`);
    parts.push(left ? `${left} still due.` : "That's everything for today. Perfect day!");
    return parts.join(' ');
  }
  const habits = await fetchHabits(c);
  const hb = findDaily(habits, q);
  if (hb) {
    try {
      await post(`/tasks/${encodeURIComponent(hb.id)}/score/up`, c.uid, c.tok);
    } catch (e) {
      return `I couldn't log ${plain(hb.text)}: ${e.message}.`;
    }
    const period = { weekly: 'this week', monthly: 'this month' }[hb.frequency] || 'today';
    const n = (hb.counterUp || 0) + 1;
    return `Logged ${plain(hb.text)}. That's ${n} time${n === 1 ? '' : 's'} ${period}.`;
  }
  const names = data.dailies.map((x) => plain(x.text));
  return `I couldn't find a daily or habit called "${q}". Your dailies are ${listJoin(names)}.`;
}

/** Route a Shortcut/Siri request to a spoken reply. */
async function voiceReply(param) {
  const raw = Array.isArray(param) ? param.join(' ') : String(param ?? '');
  const p = raw.trim();
  const lower = p.toLowerCase();
  if (!creds()) return 'Open Scriptable and run the Streakboard script once to sign in to Habitica.';
  let data;
  try {
    data = await loadData();
  } catch (e) {
    return `I couldn't load your streaks: ${e.message}.`;
  }
  const now = Date.now();
  if (!data.cached) await syncReminders(planReminders(summarize(data.user, data.dailies, now), now));
  if (!lower || lower === 'briefing' || lower === 'status' || lower === 'today') return briefingText(data, now);
  if (lower === 'tomorrow') return tomorrowText(data, now);
  if (lower === 'week' || lower === 'weekly' || lower === 'review') return weekText(data, now);
  const m = /^(tick|done|did|log|check)\s+(.*)$/i.exec(p);
  if (m) return tickText(data, m[2], now);
  const question = /^ask\s+/i.test(p) ? p.replace(/^ask\s+/i, '') : p;
  if (lower === 'data') return factsText(data, now, await fetchHabits(creds()));
  return askPrompt(question, factsText(data, now, await fetchHabits(creds())));
}

// ---------- main ----------

async function main() {
  // From Shortcuts ("Run Script" with a parameter) or Siri: reply with text instead of a widget.
  if (args.shortcutParameter != null || config.runsWithSiri) {
    const reply = await voiceReply(args.shortcutParameter);
    Script.setShortcutOutput(reply);
    if (config.runsWithSiri && args.shortcutParameter == null) Speech.speak(reply);
    return Script.complete();
  }
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
