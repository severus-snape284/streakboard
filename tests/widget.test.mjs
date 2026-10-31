// Runs the Scriptable widget script against a minimal stub of Scriptable's API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { scenario } from './fixtures.mjs';

const SRC = fs.readFileSync(new URL('../widgets/streakboard-widget.js', import.meta.url), 'utf8');

function makeEnv({ family, inWidget = true, creds = true, fail = null, param = '', now = null, shortcut, siri = false }) {
  const texts = [];
  const keychain = new Map(creds ? [['streakboard_habitica_user_id', 'u'], ['streakboard_habitica_api_token', 't']] : []);
  const files = new Map();
  const requests = [];
  const clock = now ?? Date.now();
  const today = new Date(clock + 330 * 60000 - 5 * 3600000).toISOString().slice(0, 10);
  const { user, dailies, habits } = scenario(today);
  const out = { shortcut: null, spoken: null, posts: [] };
  user.lastCron = new Date(clock - 60000).toISOString();
  // Optionally freeze the script's clock.
  const FakeDate = now == null ? Date : class extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  };
  class Stack {
    constructor() { this.children = []; }
    addText(s) { const t = { text: s }; texts.push(String(s)); this.children.push(t); return t; }
    addStack() { const s = new Stack(); this.children.push(s); return s; }
    addImage() { return {}; }
    addSpacer() {} layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} setPadding() {}
  }
  let set = null;
  const notif = { removed: [], scheduled: [] };
  const env = {
    Date: FakeDate,
    Notification: class {
      static async removePending(ids) { notif.removed.push(...ids); }
      setTriggerDate(d) { this.at = d; }
      async schedule() { notif.scheduled.push(this); }
    },
    console,
    Color: Object.assign(function (hex) { this.hex = hex; }, { white: () => ({ hex: '#fff' }) }),
    Font: { systemFont: () => ({}), boldSystemFont: () => ({}), boldRoundedSystemFont: () => ({}) },
    Size: function (w, h) { this.w = w; this.h = h; },
    SFSymbol: { named: () => ({ image: {} }) },
    ListWidget: class extends Stack { async presentMedium() { set = this; } async presentSmall() { set = this; } async presentLarge() { set = this; } },
    Keychain: { contains: (k) => keychain.has(k), get: (k) => keychain.get(k), set: (k, v) => keychain.set(k, v) },
    FileManager: { local: () => ({
      documentsDirectory: () => '/docs', joinPath: (a, b) => `${a}/${b}`,
      writeString: (p, s) => files.set(p, s), readString: (p) => files.get(p), fileExists: (p) => files.has(p),
    }) },
    Request: class {
      constructor(url) { this.url = url; requests.push(this); }
      async loadJSON() {
        if (this.method === 'POST') {
          out.posts.push(this.url);
          if (fail === 'post') return { success: false, message: 'Server exploded' };
          return { success: true, data: { delta: 1 } };
        }
        if (fail && fail !== 'post') { this.response = { statusCode: fail }; return fail === 'network' ? Promise.reject(new Error('offline')) : { success: false, message: 'Unauthorized' }; }
        this.response = { statusCode: 200 };
        return { success: true, data: this.url.includes('type=habits') ? habits : this.url.includes('/tasks/') ? dailies : user };
      }
    },
    Alert: class { addTextField() {} addSecureTextField() {} addAction() {} addCancelAction() {} async presentAlert() { return -1; } async presentSheet() { return 0; } textFieldValue() { return ''; } },
    config: { runsInWidget: shortcut !== undefined || siri ? false : inWidget, widgetFamily: family, runsWithSiri: siri },
    args: { widgetParameter: param, shortcutParameter: shortcut },
    Script: { setWidget: (w) => { set = w; }, complete: () => {}, setShortcutOutput: (v) => { out.shortcut = v; } },
    Speech: { speak: (t) => { out.spoken = t; } },
  };
  return { env, texts, files, requests, notif, dailies, user, out, get widget() { return set; }, setFail: (f) => { fail = f; } };
}

async function run(e) {
  await vm.runInNewContext(`(async () => {\n${SRC}\n})()`, e.env);
}

for (const family of ['small', 'medium', 'large', 'accessoryRectangular', 'accessoryCircular', 'accessoryInline']) {
  test(`widget renders: ${family}`, async () => {
    const e = makeEnv({ family });
    await run(e);
    assert.ok(e.widget, 'widget was set');
    const all = e.texts.join(' | ');
    assert.ok(/26/.test(all) || family === 'accessoryCircular', `shows top streak 26: ${all}`);
    assert.ok(/4/.test(all), `shows 4 open dailies: ${all}`);
    assert.equal(e.widget.url, 'https://severus-snape284.github.io/streakboard/');
    if (family === 'medium') assert.ok(all.includes('Read 20 pages'), all);
    assert.equal(e.requests[0].headers['x-client'], 'u-HabiticaStreakDashboard');
  });
}

test('widget "risk" parameter lists at-risk dailies first', async () => {
  const e = makeEnv({ family: 'medium', param: 'risk' });
  await run(e);
  const names = e.texts.filter((t) => ['Floss', 'Stretch', 'Read 20 pages', 'Meditate'].includes(t));
  assert.equal(names[0], 'Floss');
});

test('widget falls back to cache when offline, and explains missing credentials', async () => {
  const e = makeEnv({ family: 'medium' });
  await run(e);
  assert.equal(e.files.size, 1);
  e.texts.length = 0;
  e.setFail('network');
  await run(e);
  assert.ok(e.texts.join(' ').includes('offline'), e.texts.join(' | '));

  const n = makeEnv({ family: 'small', creds: false });
  await run(n);
  assert.ok(n.texts.join(' ').includes('Run this script in Scriptable once'));

  const bad = makeEnv({ family: 'small', fail: 401 });
  await run(bad);
  assert.ok(bad.texts.join(' ').includes('Check your Habitica credentials'));
});

test('widget never stores credentials in its cache file', async () => {
  const e = makeEnv({ family: 'small' });
  await run(e);
  const cached = [...e.files.values()].join('');
  assert.ok(!cached.includes('"t"') && !cached.includes('api'), cached.slice(0, 100));
});

// 12:00 in UTC+5:30 on 2026-10-31: both reminders are still ahead.
const NOON = Date.parse('2026-10-31T06:30:00Z');

test('widget schedules smart reminders only while dailies are due', async () => {
  const e = makeEnv({ family: 'small', now: NOON });
  await run(e);
  assert.deepEqual(e.notif.removed, ['streakboard-evening', 'streakboard-lastcall']);
  assert.equal(e.notif.scheduled.length, 2, 'evening + last-call reminders scheduled');
  // Last call = 90 min before the 05:00 local reset = 03:30 local = 22:00Z.
  assert.equal(e.notif.scheduled.find((n) => n.identifier === 'streakboard-lastcall').at.toISOString(), '2026-10-31T22:00:00.000Z');
  for (const n of e.notif.scheduled) {
    assert.ok(n.at.getTime() > NOON, 'trigger is in the future');
    assert.ok(n.body.includes('still due'), n.body);
    assert.ok(n.body.includes('Floss'), `names the top at-risk daily: ${n.body}`);
    assert.equal(n.openURL, 'https://severus-snape284.github.io/streakboard/');
  }

  const done = makeEnv({ family: 'small', now: NOON });
  for (const t of done.dailies) t.completed = true;
  await run(done);
  assert.equal(done.notif.removed.length, 2, 'pending reminders cleared');
  assert.equal(done.notif.scheduled.length, 0, 'nothing scheduled when all done');

  const late = makeEnv({ family: 'small', now: Date.parse('2026-10-31T22:30:00Z') }); // 04:00 local
  await run(late);
  assert.equal(late.notif.scheduled.length, 0, 'no reminders once their times have passed');

  const off = makeEnv({ family: 'small', now: NOON });
  await run(off);
  off.notif.removed.length = 0; off.notif.scheduled.length = 0;
  off.setFail('network');
  await run(off);
  assert.equal(off.notif.removed.length, 0, 'offline cache never touches reminders');
});

test('single-daily widget: matches app logic for best streak and last 7 days', async () => {
  const { ingest, buildView } = await import('../js/model.js');
  const { recentDots } = await import('../js/insights.js');
  for (const family of ['small', 'medium', 'accessoryRectangular', 'accessoryCircular', 'accessoryInline']) {
    const e = makeEnv({ family, param: 'meditate', now: NOON });
    await run(e);
    const all = e.texts.join(' | ');
    assert.ok(all.includes('1') && (family.startsWith('accessory') || all.includes('Meditate')), `${family}: ${all}`);
    if (family === 'small' || family === 'medium') {
      // Same numbers as the app: best 7 for Meditate, and the same 7-day pattern.
      const { snapshots, observed } = ingest(e.user, e.dailies, [], NOON);
      const v = buildView({ user: e.user, dailies: e.dailies, fetchedAt: NOON }, snapshots, observed, NOON);
      const t = v.tasks.find((x) => x.text === 'Meditate');
      assert.ok(all.includes(`best ${t.best}`), `best ${t.best} in: ${all}`);
      const appDots = recentDots(t, v.ctx.cronDay, 7).map((x) => (x.status === 'due' ? '□' : '■')).join('');
      const widgetDots = e.texts.filter((x) => x === '■' || x === '□').slice(0, 7).join('');
      assert.equal(widgetDots, appDots);
      assert.ok(all.includes('Due'), all);
    }
  }
  const none = makeEnv({ family: 'small', param: 'nonexistent daily', now: NOON });
  await run(none);
  assert.ok(none.texts.join(' ').includes('No daily matches'));
  const risk = makeEnv({ family: 'medium', param: 'RISK', now: NOON });
  await run(risk);
  assert.ok(!risk.texts.join(' ').includes('No daily matches'), 'risk keyword is case-insensitive');
});

// ---------- Siri & Apple Intelligence ----------

test('siri briefing: done/due counts, at-risk, don\'t-miss-twice, milestone nudge, time left, best streak', async () => {
  const e = makeEnv({ shortcut: 'briefing', now: NOON });
  await run(e);
  const t = e.out.shortcut;
  assert.ok(t.startsWith('Good afternoon.'), t);
  assert.ok(t.includes("You've done 1 of 5 dailies."), t);
  assert.ok(t.includes('Floss, 6-day streak, at risk'), t);
  assert.ok(t.includes('Journal tag, missed last time') || t.includes('Journal <b>tag</b>, missed last time'), t);
  assert.ok(t.includes('Tick Floss today to reach 7 days.'), t);
  assert.ok(/\d+ hours?( and \d+ minutes?)? until your day resets/.test(t), t);
  assert.ok(t.includes('Your best current streak is Read 20 pages at 26 days.'), t);
  assert.equal(e.widget, null, 'no widget rendered in voice mode');
  // An empty parameter also means briefing.
  const e2 = makeEnv({ shortcut: '', now: NOON });
  await run(e2);
  assert.ok(e2.out.shortcut.includes('1 of 5'));
});

test('siri: Run Script without parameter via Siri speaks the briefing', async () => {
  const e = makeEnv({ siri: true, now: NOON });
  await run(e);
  assert.ok(e.out.spoken && e.out.spoken.includes('1 of 5'), e.out.spoken);
});

test('siri week and tomorrow', async () => {
  const w = makeEnv({ shortcut: 'week', now: NOON });
  await run(w);
  assert.ok(/Over the last 7 days you did \d+ of \d+ due dailies, \d+ percent, with \d+ perfect days?\./.test(w.out.shortcut), w.out.shortcut);
  assert.ok(w.out.shortcut.includes('Needs work: Journal'), w.out.shortcut);
  const t = makeEnv({ shortcut: 'tomorrow', now: NOON });
  for (const d of t.dailies) d.nextDue = [];
  await run(t);
  assert.ok(t.out.shortcut.includes("don't have tomorrow's schedule"), t.out.shortcut);
  const t2 = makeEnv({ shortcut: 'tomorrow', now: NOON });
  t2.dailies[0].nextDue = ['2026-10-31T18:30:00.000Z']; // local midnight of Nov 1
  await run(t2);
  assert.ok(t2.out.shortcut.includes('On Sunday you have 1 daily due: Read 20 pages (26 days).'), t2.out.shortcut);
});

test('siri tick: dailies by partial name, habits, already done, unknown, failure', async () => {
  const e = makeEnv({ shortcut: 'tick flo', now: NOON });
  await run(e);
  assert.ok(e.out.posts.some((u) => u.endsWith('/tasks/ffff-6/score/up')), e.out.posts.join());
  assert.ok(e.out.shortcut.includes('Done. Floss is now on a 7-day streak.'), e.out.shortcut);
  assert.ok(e.out.shortcut.includes("7-day milestone"), e.out.shortcut);
  assert.ok(e.out.shortcut.includes('3 still due.'), e.out.shortcut);

  const already = makeEnv({ shortcut: 'tick read', now: NOON });
  await run(already);
  assert.equal(already.out.posts.length, 0);
  assert.ok(already.out.shortcut.includes('already done'), already.out.shortcut);

  const habit = makeEnv({ shortcut: 'log gym', now: NOON });
  await run(habit);
  assert.ok(habit.out.posts.some((u) => u.endsWith('/tasks/h-2/score/up')));
  assert.ok(habit.out.shortcut.includes("Logged Gym. That's 2 times this week."), habit.out.shortcut);

  const unknown = makeEnv({ shortcut: 'tick yoga', now: NOON });
  await run(unknown);
  assert.equal(unknown.out.posts.length, 0);
  assert.ok(unknown.out.shortcut.includes("couldn't find a daily or habit called \"yoga\""), unknown.out.shortcut);

  const failing = makeEnv({ shortcut: 'tick stretch', now: NOON, fail: 'post' });
  await run(failing);
  assert.ok(failing.out.shortcut.includes("couldn't tick Stretch"), failing.out.shortcut);
});

test('ask: builds a grounded, read-aloud prompt with compact data', async () => {
  const e = makeEnv({ shortcut: 'ask which daily am I worst at?', now: NOON });
  await run(e);
  const p = e.out.shortcut;
  assert.ok(p.startsWith('You are the habit coach inside Streakboard'), p.slice(0, 80));
  assert.ok(p.includes('read aloud by Siri'));
  assert.ok(p.trim().endsWith('QUESTION\nwhich daily am I worst at?'), p.slice(-80));
  assert.ok(p.includes('- Meditate | 1 | 7 | due, not done |'), p);
  assert.ok(p.includes('- Read 20 pages | 26 | 26 | done |'), p);
  assert.ok(/- Floss \| 6 \| 6 \| due, not done \| [X.\-r?]{13}o \| 100% \(6\/6\) \| 20:\d\d \|/.test(p), p);
  assert.ok(p.includes('- Gym | weekly | 1'), 'habits included');
  assert.ok(p.length < 4000, `prompt stays compact (${p.length} chars)`);
  assert.ok(!p.includes('"u"') && !p.includes('t-token'), 'no credentials in the prompt');
  // A bare question without the "ask" prefix works too.
  const bare = makeEnv({ shortcut: 'how am I doing this week?', now: NOON });
  await run(bare);
  assert.ok(bare.out.shortcut.trim().endsWith('how am I doing this week?'));
});

test('voice mode without credentials explains how to sign in', async () => {
  const e = makeEnv({ shortcut: 'briefing', creds: false, now: NOON });
  await run(e);
  assert.ok(e.out.shortcut.includes('run the Streakboard script once'), e.out.shortcut);
});
