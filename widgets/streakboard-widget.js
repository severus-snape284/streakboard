// Streakboard widget for the Scriptable app (iOS): https://scriptable.app
// Shows your Habitica streaks on the Home Screen or Lock Screen.
//
// Setup: paste this into a new Scriptable script, run it once in the app to enter your
// Habitica User ID + API token (stored in the iOS Keychain, never in this file), then add
// a Scriptable widget and choose this script.
// Optional widget parameter: "risk" shows at-risk/due dailies first instead of top streaks.

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
    stale,
  };
}

function plain(text) {
  // Habitica task text can contain markdown/emoji shortcodes; keep it readable.
  return String(text || '').replace(/[*_`~]/g, '').replace(/:([a-z0-9_+-]+):/g, '').trim();
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
      dailies: dailies.map((t) => ({ text: t.text, streak: t.streak || 0, isDue: !!t.isDue, completed: !!t.completed })),
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

function buildWidget(data, family, param, now) {
  const s = summarize(data.user, data.dailies, now);
  const list = param === 'risk' ? s.byRisk : s.byStreak;
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
    w = buildWidget(data, config.widgetFamily || 'medium', (args.widgetParameter || '').trim().toLowerCase(), Date.now());
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
