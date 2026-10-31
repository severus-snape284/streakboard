// Runs the Scriptable widget script against a minimal stub of Scriptable's API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { scenario } from './fixtures.mjs';

const SRC = fs.readFileSync(new URL('../widgets/streakboard-widget.js', import.meta.url), 'utf8');

function makeEnv({ family, inWidget = true, creds = true, fail = null, param = '' }) {
  const texts = [];
  const keychain = new Map(creds ? [['streakboard_habitica_user_id', 'u'], ['streakboard_habitica_api_token', 't']] : []);
  const files = new Map();
  const requests = [];
  const today = new Date(Date.now() + 330 * 60000 - 5 * 3600000).toISOString().slice(0, 10);
  const { user, dailies } = scenario(today);
  user.lastCron = new Date(Date.now() - 60000).toISOString();
  class Stack {
    constructor() { this.children = []; }
    addText(s) { const t = { text: s }; texts.push(String(s)); this.children.push(t); return t; }
    addStack() { const s = new Stack(); this.children.push(s); return s; }
    addImage() { return {}; }
    addSpacer() {} layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} setPadding() {}
  }
  let set = null;
  const env = {
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
  return { env, texts, files, requests, get widget() { return set; }, setFail: (f) => { fail = f; } };
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
