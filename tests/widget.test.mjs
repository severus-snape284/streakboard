// Runs the Scriptable widget script against a minimal stub of Scriptable's API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { scenario } from './fixtures.mjs';

const SRC = fs.readFileSync(new URL('../widgets/streakboard-widget.js', import.meta.url), 'utf8');

function makeEnv({ family, inWidget = true, creds = true, fail = null, param = '', now = null }) {
  const texts = [];
  const keychain = new Map(creds ? [['streakboard_habitica_user_id', 'u'], ['streakboard_habitica_api_token', 't']] : []);
  const files = new Map();
  const requests = [];
  const clock = now ?? Date.now();
  const today = new Date(clock + 330 * 60000 - 5 * 3600000).toISOString().slice(0, 10);
  const { user, dailies } = scenario(today);
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
        if (fail) { this.response = { statusCode: fail }; return fail === 'network' ? Promise.reject(new Error('offline')) : { success: false, message: 'Unauthorized' }; }
        this.response = { statusCode: 200 };
        return { success: true, data: this.url.includes('/tasks/') ? dailies : user };
      }
    },
    Alert: class { addTextField() {} addSecureTextField() {} addAction() {} addCancelAction() {} async presentAlert() { return -1; } async presentSheet() { return 0; } textFieldValue() { return ''; } },
    config: { runsInWidget: inWidget, widgetFamily: family },
    args: { widgetParameter: param },
    Script: { setWidget: (w) => { set = w; }, complete: () => {} },
  };
  return { env, texts, files, requests, notif, dailies, user, get widget() { return set; }, setFail: (f) => { fail = f; } };
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
