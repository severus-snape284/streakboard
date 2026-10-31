// End-to-end check at iPhone viewport with a mocked Habitica API.
// Serves the repo under /streakboard/ (like GitHub Pages) and drives it with Playwright.
// Usage: node tests/e2e.mjs [screenshotDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scenario } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/streakboard/')) { res.writeHead(404); return res.end(); }
  let p = path.join(ROOT, url.pathname.slice('/streakboard/'.length) || 'index.html');
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/streakboard/`;

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark', serviceWorkers: 'allow' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));

// Mock Habitica. The fixture's "today" is the real current Habitica day so cron isn't stale.
const now = Date.now();
const today = new Date(now + 330 * 60000 - 5 * 3600000).toISOString().slice(0, 10);
const { user, dailies, habits } = scenario(today);
user.lastCron = new Date(Math.min(Date.parse(user.lastCron), now - 60000)).toISOString();
let mode = 'ok';
const seenHeaders = [];
const posts = [];
await ctx.route('https://habitica.com/api/v3/**', async (route) => {
  const req = route.request();
  seenHeaders.push(req.headers());
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After' };
  const ok = (data) => route.fulfill({ status: 200, headers: { ...cors, 'x-ratelimit-remaining': '25', 'x-ratelimit-limit': '30' }, json: { success: true, data } });
  if (mode === '429') return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '60' }, json: { success: false, message: 'Too many requests' } });
  if (mode === '401') return route.fulfill({ status: 401, headers: cors, json: { success: false, message: 'Unauthorized' } });
  const u = new URL(req.url());
  if (req.method() === 'POST') {
    posts.push(u.pathname);
    if (mode === 'fail') return route.fulfill({ status: 500, headers: cors, json: { success: false, message: 'Server exploded' } });
    let m;
    if ((m = u.pathname.match(/\/tasks\/([^/]+)\/score\/(up|down)$/))) {
      const t = dailies.find((d) => d.id === m[1]);
      if (t) {
        if (m[2] === 'up') { t.completed = true; t.streak++; t.history.push({ date: Date.now(), value: 1, isDue: true, completed: true }); }
        else { t.completed = false; t.streak--; t.history.pop(); }
      }
      const h = habits.find((x) => x.id === m[1]);
      if (h) { h.counterUp++; h.history.push({ date: Date.now(), value: 1, scoredUp: 1, scoredDown: 0 }); }
      return ok({ delta: 1 });
    }
    if ((m = u.pathname.match(/\/tasks\/([^/]+)\/checklist\/([^/]+)\/score$/))) {
      const c = dailies.find((d) => d.id === m[1]).checklist.find((x) => x.id === m[2]);
      c.completed = !c.completed;
      return ok({});
    }
    if (u.pathname.endsWith('/cron')) { user.lastCron = new Date().toISOString(); return ok({}); }
    if (u.pathname.endsWith('/user/sleep')) { user.preferences.sleep = !user.preferences.sleep; return ok(user.preferences.sleep); }
    return route.fulfill({ status: 404, headers: cors, json: { success: false, message: 'nope' } });
  }
  if (u.pathname === '/api/v3/user') return ok(user);
  return ok(u.searchParams.get('type') === 'habits' ? habits : dailies);
});

const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const noHScroll = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// 1. First launch → setup screen
await page.goto(BASE);
await page.waitForSelector('#creds-form');
check(await page.locator('#nav').isHidden(), 'bottom nav hidden during setup');
await shot('01-setup');

// 2. 401 on bad credentials
mode = '401';
await page.fill('#uid', 'bad-user');
await page.fill('#tok', 'bad-token');
await page.click('button[type=submit]');
await page.waitForSelector('#toast:not([hidden])');
check((await page.textContent('#toast')).includes('rejected'), 'bad credentials show an error');

// 3. Connect
mode = 'ok';
await page.fill('#uid', 'test-user');
await page.fill('#tok', 'test-token');
await page.click('button[type=submit]');
await page.waitForSelector('.row');
await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 6);
check(seenHeaders.some((h) => h['x-client'] === 'test-user-HabiticaStreakDashboard' && h['x-api-user'] === 'test-user'), 'sends x-api-user and x-client headers');
check((await page.textContent('.hero-num')).trim() === '26', 'hero shows best current streak (26)');
check((await page.textContent('.hero-label b')).includes('Read 20 pages'), 'hero names the top daily');
check((await page.textContent('.ring-wrap .num')).trim() === '1/5', 'today ring shows 1/5 due dailies done');
check(/\d+h \d+m|\d+m/.test(await page.textContent('[data-countdown]')), 'countdown to day reset shown');
const stats = await page.locator('.hero-stats b').allTextContents();
check(stats[0] === '5' && stats[1] === '0', `hero stats: active=5, perfect streak=0 (got ${stats})`);
const riskText = (await page.locator('.attention li[data-kind=risk]').allTextContents()).join(' ');
check(riskText.includes('Stretch') && riskText.includes('Floss') && !riskText.includes('Journal'), 'needs-attention lists Stretch and Floss as at risk');
check((await page.textContent('.attention li[data-kind=twice]')).includes('Journal'), "needs-attention lists Journal as don't-miss-twice");
const titles = await page.locator('.row-title').allTextContents();
const todo = await page.locator('.list[data-group=todo] .row-title').allTextContents();
check(todo.join('|') === 'Floss|Stretch|Meditate|Journal <b>tag</b>', `To do group sorted by streak (${todo.join(' | ')})`);
check((await page.textContent('.list[data-group=done]')).includes('Read 20 pages'), 'Done group holds completed dailies');
check((await page.textContent('.list[data-group=later]')).includes('Bike clean'), 'Not today group holds not-due dailies');
check(await page.locator('.row .dots').count() === 6 && await page.locator('.row .dots i').count() === 42, 'every row shows 7 recent days');
check(titles.includes('Journal <b>tag</b>'), 'task text is HTML-escaped');
check(await page.locator('.row.milestone').count() === 1, 'milestone styling on 21+ streak');
check(await noHScroll(), 'home: no horizontal scroll');
await shot('02-home');

// 3b. Tick a daily (optimistic) → POST score/up
const stretchRow = page.locator('.list .row', { hasText: 'Stretch' });
await stretchRow.locator('.check').click();
await page.waitForFunction(() => [...document.querySelectorAll('.list .row')].some((r) => r.textContent.includes('Stretch') && r.querySelector('.check.on')));
check((await stretchRow.locator('.row-streak').textContent()).trim() === '4', 'tick bumps streak 3 → 4 instantly');
check(posts.some((p) => p.endsWith('/tasks/bbbb-2/score/up')), 'tick sends POST score/up');
check(!(await page.textContent('.attention')).includes('Stretch'), 'ticked daily leaves needs-attention');
check((await page.textContent('.list[data-group=done]')).includes('Stretch'), 'ticked daily moves to Done');
check(await page.locator('#toast .toast-btn').textContent() === 'Undo', 'tick shows an Undo toast');
await page.click('#toast .toast-btn');
await page.waitForFunction(() => [...document.querySelectorAll('.list .row')].some((r) => r.textContent.includes('Stretch') && !r.querySelector('.check.on') && !r.querySelector('.check.pending')));
check(posts.some((p) => p.endsWith('/tasks/bbbb-2/score/down')), 'Undo sends score/down without a confirm');
await stretchRow.locator('.check').click();
await page.waitForFunction(() => [...document.querySelectorAll('.list .row')].some((r) => r.textContent.includes('Stretch') && r.querySelector('.check.on') && !r.querySelector('.check.pending')));

// 3c. Milestone celebration: Floss 6 → 7
await page.locator('.list .row', { hasText: 'Floss' }).locator('.check').click();
await page.waitForSelector('#celebrate:not([hidden])');
check((await page.textContent('.celebrate-num')).trim() === '7', 'hitting 7 days shows a celebration');
await shot('02b-celebrate');
await page.click('[data-action=dismiss-celebration]');

// 3d. Failed write rolls back
mode = 'fail';
const readRow = page.locator('.list .row', { hasText: 'Meditate' });
await readRow.locator('.check').click();
await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Server exploded'));
await page.waitForFunction(() => [...document.querySelectorAll('.list .row')].some((r) => r.textContent.includes('Meditate') && !r.querySelector('.check.on') && !r.querySelector('.check.pending')));
const rb = (await readRow.locator('.row-streak').textContent()).trim();
check(rb === '1', `failed tick is rolled back (streak ${rb}, toast: ${await page.textContent('#toast')})`);
mode = 'ok';

// 3e. Untick asks for confirmation
page.once('dialog', (d) => d.dismiss());
await stretchRow.locator('.check').click();
check(await stretchRow.locator('.check.on').count() === 1, 'dismissing the untick confirm keeps it done');
await page.waitForTimeout(3000); // let the background sync settle
check((await stretchRow.locator('.row-streak').textContent()).trim() === '4', 'background sync agrees with Habitica');

// 4. Sort toggle
await page.click('[data-sort=name]');
const byName = await page.locator('.list[data-group=todo] .row-title').allTextContents();
check(byName.join('|') === [...byName].sort((a, b) => a.localeCompare(b)).join('|'), `sort by name within groups (${byName.join(' | ')})`);
await page.click('[data-sort=streak]');

// 5. Detail view
await page.click('.row >> text=Meditate');
await page.waitForSelector('.heat');
check((await page.textContent('.detail-hero .big')).trim() === '1', 'detail shows current streak');
const statVals = await page.locator('.stats b').allTextContents();
check(statVals[0] === '7', `detail best streak = 7 (got ${statVals[0]})`);
check(await page.locator('.heat i.done').count() >= 8, 'heatmap has done cells');
check(await page.locator('.heat i.missed').count() >= 2, 'heatmap has missed cells');
check((await page.textContent('.breaks')).includes('7'), 'break history lists lost 7-day streak');
check(await noHScroll(), 'detail: no horizontal page scroll');
check(await page.locator('.trends .chart svg').count() === 2, 'detail: streak-line and weekly charts');
check(await page.locator('.trends .line').count() === 1 && await page.locator('.trends .col').count() >= 1, 'detail charts have data marks');
check(await page.locator('.trends .xhair[visibility=visible]').count() === 0, 'crosshair hidden until you tap');
await page.locator('.trends .chart').nth(1).locator('.hit').last().click();
await page.waitForSelector('.chart-tip:not([hidden])');
check((await page.textContent('.chart-tip')).includes('Week of'), 'tapping a column shows a tooltip');
await shot('03-detail');

// 5b. Checklist toggle on Stretch
await page.goto(BASE + '#/t/bbbb-2');
await page.waitForSelector('.checklist');
await page.click('.checklist [data-item=cl-2]');
await page.waitForFunction(() => { const b = document.querySelector('.checklist [data-item=cl-2]'); return b.classList.contains('on') && !b.classList.contains('pending'); });
await page.waitForTimeout(200);
check(posts.some((p) => p.endsWith('/tasks/bbbb-2/checklist/cl-2/score')), 'checklist item toggle sends POST');

// 5b2. Plan (when/where) shows on the home row; miss reasons
await page.goto(BASE + '#/t/cccc-3');
await page.waitForSelector('#cue-form');
check((await page.textContent('#cue-form')).includes('usually tick this around'), 'detail shows usual time');
check(/On track for \d+ days on/.test(await page.textContent('.detail-hero')), 'milestone forecast shown');
await page.fill('#cue-form input[name=cue]', 'After lunch, on the balcony');
await page.fill('#cue-form input[name=mini]', 'Three slow breaths');
await page.click('#cue-form button[type=submit]');
await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Plan saved'));
check(await page.locator('.why .chip').count() > 0, 'unexplained misses ask why');
const before = await page.locator('.why-day').count();
await page.locator('.why-day').first().locator('.chip', { hasText: 'Forgot' }).click();
await page.waitForFunction((n) => document.querySelectorAll('.why-day').length === n - 1, before);
check((await page.textContent('body')).includes('Miss reasons logged'), 'miss reason recorded');
await shot('03a-detail-plan');
await page.click('#nav a[data-nav=home]');
await page.waitForSelector('.row-cue');
check((await page.textContent('.list .row:has-text("Meditate") .row-cue')).includes('After lunch'), 'plan shows under the daily on home');
await page.click('[data-sort=time]');
check((await page.locator('[data-sort=time]').getAttribute('aria-pressed')) === 'true', 'time sort selectable');
check(/~\d/.test(await page.textContent('.list')), 'time sort shows usual times');
await page.click('[data-sort=streak]');

// 5c. Habits tab
await page.click('#nav a[data-nav=habits]');
await page.waitForSelector('.check.plus');
check(await page.locator('.list .row').count() === 2, 'habits tab shows only positive habits');
const water = page.locator('.list .row', { hasText: 'Drink water' });
check((await water.locator('.row-streak').textContent()).includes('4'), 'habit day streak = 4 before today');
await water.locator('.check.plus').click();
await page.waitForFunction(() => [...document.querySelectorAll('.list .row')].some((r) => r.textContent.includes('Drink water') && r.textContent.includes('1× today')));
check((await water.locator('.row-streak').textContent()).includes('5'), '+1 extends habit streak to 5');
check(await water.locator('.check.plus.met').count() === 1, 'habit button turns green once the daily goal is met');
check(await page.locator('.list .row', { hasText: 'Gym' }).locator('.check.plus.met').count() === 1, 'weekly habit already done this week shows as met');
check(await noHScroll(), 'habits: no horizontal scroll');
page.once('dialog', (d) => d.accept('3'));
await page.locator('.list .row', { hasText: 'Gym' }).locator('[data-action=target]').click();
await page.waitForFunction(() => document.body.textContent.includes('Goal: 3/week'));
check((await page.textContent('.list .row:has-text("Gym")')).includes('1/3 this week'), 'habit goal shows progress 1/3');
await shot('03b-habits');

// 5d. Insights tab
await page.click('#nav a[data-nav=insights]');
await page.waitForSelector('.bars');
check(await page.locator('.bar').count() === 7, 'insights: weekday bars');
check((await page.textContent('.review')).includes('Weekly review'), 'insights: weekly review card');
check((await page.textContent('.review')).includes('Wins') && (await page.textContent('.review')).includes('Slips'), 'review lists wins and slips');
await page.locator('.review .chip', { hasText: 'Meditate' }).click();
await page.waitForFunction(() => document.querySelector('.review h3:last-of-type').textContent.includes('Focus: Meditate'));
check(true, 'focus chosen from weekly review');
await shot('03c0-review');
check(/\d+%/.test(await page.textContent('.hero-num')), 'insights: completion rate shown');
check(await page.locator('.rates li').count() >= 4, 'insights: per-daily rates');
check(await page.locator('.heat i.done').count() > 0, 'insights: consistency calendar');
check(await page.locator('.trends .col').count() >= 4, 'insights: overall weekly trend chart');
check(await page.locator('table.months tbody tr').count() >= 2, 'insights: month-by-month table');
check(await page.locator('.rates .spark').count() >= 4, 'insights: per-daily sparklines');
check((await page.textContent('body')).includes('Why you miss'), 'insights: miss reasons card');
await page.click('[data-period="30"]');
check((await page.textContent('.hero-label b')).includes('30 days'), 'insights: 30-day toggle');
check(await noHScroll(), 'insights: no horizontal scroll');
await shot('03c-insights');

// 5e. Focus card pinned on home; 2-minute version shown where it matters
await page.click('#nav a[data-nav=home]');
await page.waitForSelector('.focus');
check((await page.textContent('.focus')).includes("This week's focus") && (await page.textContent('.focus')).includes('Meditate'), 'focus card pinned on home');
check((await page.textContent('.list .row:has-text("Meditate")')).includes('Focus'), 'focus pill on the row');

// 6. Settings
await page.click('#nav a[data-nav=settings]');
await page.waitForSelector('[data-action=export]');
check(await noHScroll(), 'settings: no horizontal scroll');
check((await page.textContent('body')).includes('Scriptable'), 'settings: widget setup instructions');
check((await page.textContent('#siri')).includes('Use Model') && (await page.textContent('#siri')).includes('Streakboard tick'), 'settings: Siri & Apple Intelligence setup');
check((await page.textContent('#ai-notify')).includes('Time of Day') && (await page.textContent('#ai-notify')).includes('notify'), 'settings: smart notification automation steps');
const widgetSrc = await page.evaluate(() => fetch('widgets/streakboard-widget.js').then((r) => r.text()));
check(widgetSrc.includes('ListWidget'), 'widget script is served with the app');
await shot('04-settings');

// 6b. Rest in the Inn and back
page.once('dialog', (d) => d.accept());
await page.click('[data-action=sleep]');
await page.waitForFunction(() => document.querySelector('[data-action=sleep]')?.textContent.includes('Leave the Inn'));
check(posts.some((p) => p.endsWith('/user/sleep')), 'Rest in the Inn sends POST /user/sleep');
await page.click('#nav a[data-nav=home]');
await page.waitForSelector('.rescue.rest');
check((await page.textContent('.rescue.rest')).includes('Resting in the Inn'), 'home shows resting banner');
check(await page.locator('.attention, .pill.risk').count() === 0, 'no streak warnings while resting');
await shot('04b-inn');
page.once('dialog', (d) => d.accept());
await page.click('.rescue.rest [data-action=sleep]');
await page.waitForFunction(() => !document.querySelector('.rescue.rest'));
check(true, 'leaving the Inn removes the banner');
await page.click('#nav a[data-nav=settings]');
await page.waitForSelector('[data-action=export]');

// 7. Export produces a backup file
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export]')]);
const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
check(backup.app === 'streakboard' && backup.observed.length === 6, 'export contains observed records');
check(!JSON.stringify(backup).includes('test-token'), 'export does not contain the API token');
check(backup.prefs?.cues?.['cccc-3']?.includes('After lunch') && backup.prefs?.targets?.['h-2'] === 3, 'export includes plans and goals');

// 8. Rate limit handling
await page.click('#nav a[data-nav=home]');
mode = '429';
await page.click('[data-action=refresh]');
await page.waitForSelector('.note.err');
check((await page.textContent('.note.err')).includes('rate limit'), '429 shows rate-limit message');
check(await page.locator('.list .row').count() === 6, 'cached data still shown on error');
mode = 'ok';
await page.evaluate(() => localStorage.removeItem('sb.rateBlockedUntil'));

// 9. Offline: service worker serves the shell, IndexedDB serves the data
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForFunction(() => !!navigator.serviceWorker.controller);
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('.row');
check(await page.locator('.list .row').count() === 6, 'offline reload shows cached streaks');
await ctx.setOffline(false);

// 9b. Streak rescue: Habitica's day hasn't rolled over yet
user.lastCron = new Date(now - 30 * 3600000).toISOString();
await page.evaluate(() => localStorage.removeItem('sb.rateBlockedUntil'));
await page.click('[data-action=refresh]');
await page.waitForSelector('.rescue');
check((await page.textContent('.rescue')).includes('still open'), 'rescue banner when the Habitica day is still open');
await shot('03d-rescue');
page.once('dialog', (d) => d.accept());
await page.click('[data-action=cron]');
await page.waitForFunction(() => !document.querySelector('.rescue'));
check(posts.some((p) => p.endsWith('/cron')), 'Start my new day sends POST /cron');

// 10. Light mode renders
await page.emulateMedia({ colorScheme: 'light' });
await page.goto(BASE + '#/');
await page.waitForSelector('.row');
await shot('05-home-light');

// 11. Logout clears credentials
await page.goto(BASE + '#/settings');
page.once('dialog', (d) => d.accept());
await page.click('[data-action=logout]');
await page.waitForSelector('#creds-form');
check(await page.evaluate(() => localStorage.getItem('sb.creds')) === null, 'logout removes credentials');

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' / ') : ''}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
