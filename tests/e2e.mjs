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
const { user, dailies } = scenario(today);
user.lastCron = new Date(Math.min(Date.parse(user.lastCron), now - 60000)).toISOString();
let mode = 'ok';
const seenHeaders = [];
await ctx.route('https://habitica.com/api/v3/**', async (route) => {
  const req = route.request();
  seenHeaders.push(req.headers());
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After' };
  if (mode === '429') return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '60' }, json: { success: false, message: 'Too many requests' } });
  if (mode === '401') return route.fulfill({ status: 401, headers: cors, json: { success: false, message: 'Unauthorized' } });
  const u = new URL(req.url());
  const data = u.pathname === '/api/v3/user' ? user : dailies;
  return route.fulfill({ status: 200, headers: { ...cors, 'x-ratelimit-remaining': '25', 'x-ratelimit-limit': '30' }, json: { success: true, data } });
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
await page.waitForFunction(() => document.querySelectorAll('.row').length === 5);
check(seenHeaders.some((h) => h['x-client'] === 'test-user-HabiticaStreakDashboard' && h['x-api-user'] === 'test-user'), 'sends x-api-user and x-client headers');
check((await page.textContent('.hero-num')).trim() === '26', 'hero shows best current streak (26)');
check((await page.textContent('.hero-label b')).includes('Read 20 pages'), 'hero names the top daily');
const stats = await page.locator('.hero-stats b').allTextContents();
check(stats[0] === '4' && stats[1] === '3', `hero stats: active=4, dueLeft=3 (got ${stats})`);
check(await page.locator('.risk li').count() === 1 && (await page.textContent('.risk')).includes('Stretch'), 'at-risk banner lists only Stretch');
const titles = await page.locator('.row-title').allTextContents();
check(titles[0] === 'Read 20 pages' && titles[1] === 'Bike clean', `sorted by streak desc (${titles.join(' | ')})`);
check(titles.includes('Journal <b>tag</b>'), 'task text is HTML-escaped');
check(await page.locator('.row.milestone').count() === 1, 'milestone styling on 21+ streak');
check(await noHScroll(), 'home: no horizontal scroll');
await shot('02-home');

// 4. Sort toggle
await page.click('[data-sort=name]');
check((await page.locator('.row-title').first().textContent()) === 'Bike clean', 'sort by name');
await page.click('[data-sort=due]');
check((await page.locator('.row-title').first().textContent()) === 'Stretch', 'sort by due today');
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
await shot('03-detail');

// 6. Settings
await page.click('#nav a[data-nav=settings]');
await page.waitForSelector('[data-action=export]');
check(await noHScroll(), 'settings: no horizontal scroll');
await shot('04-settings');

// 7. Export produces a backup file
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export]')]);
const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
check(backup.app === 'streakboard' && backup.observed.length === 5, 'export contains observed records');
check(!JSON.stringify(backup).includes('test-token'), 'export does not contain the API token');

// 8. Rate limit handling
await page.click('#nav a[data-nav=home]');
mode = '429';
await page.click('[data-action=refresh]');
await page.waitForSelector('.note.err');
check((await page.textContent('.note.err')).includes('rate limit'), '429 shows rate-limit message');
check(await page.locator('.row').count() === 5, 'cached data still shown on error');
mode = 'ok';
await page.evaluate(() => localStorage.removeItem('sb.rateBlockedUntil'));

// 9. Offline: service worker serves the shell, IndexedDB serves the data
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForFunction(() => !!navigator.serviceWorker.controller);
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('.row');
check(await page.locator('.row').count() === 5, 'offline reload shows cached streaks');
await ctx.setOffline(false);

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
