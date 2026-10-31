// Screen renderers: pure functions of app state → HTML strings.
import { sortTasks, heroStats, atRisk, statusOf, milestoneFor, nextMilestone, MILESTONES, addDays } from './streaks.js';
import {
  missedLastTime, dayRollup, perfectStreak, periodStats, weekdayStats, weakestWeekday,
  weekdayName, weekdayLong, habitStats, nextRollover, fmtDuration,
} from './insights.js';
import { describeSchedule } from './model.js';
import { esc, relTime, fmtDay, pct, FLAME, REFRESH_ICON, CHECK_ICON, PLUS_ICON, ring } from './ui.js';

export const APP_VERSION = '2.0.0';

const link = (id) => `#/t/${encodeURIComponent(id)}`;

/** "today", or the day Habitica still considers current when its rollover is pending. */
function dayLabel(ctx) {
  return ctx?.stale ? fmtDay(ctx.cronDay, { weekday: 'short' }) : 'today';
}

function topbar(state, title) {
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

function notes(state, { rescue = false } = {}) {
  const v = state.view;
  let out = '';
  if (state.error) out += `<p class="note err">${esc(state.error)}</p>`;
  if (v?.user?.preferences?.sleep) {
    out += `<p class="note">You're resting in the Inn. Habitica has paused your dailies, so streaks won't break.</p>`;
  } else if (v?.ctx?.stale) {
    const day = fmtDay(v.ctx.cronDay, { weekday: 'long' });
    const open = v.tasks.filter((t) => t.isDue && !t.completed).length;
    out += rescue
      ? `<section class="rescue" aria-label="Yesterday is still open">
          <h2>${esc(day)} is still open</h2>
          <p>Habitica hasn't started your new day yet, so anything you tick now still counts for ${esc(day)}${open ? ` — ${open} due daily${open === 1 ? '' : 's'} still unticked` : ''}. Tick what you actually did, then start your new day.</p>
          <button class="btn primary" data-action="cron">Start my new day</button>
        </section>`
      : `<p class="note">Habitica's new day hasn't started yet: ticks still count for ${esc(day)}.</p>`;
  }
  return out;
}

function statusPill(t, ctx) {
  const s = statusOf(t);
  const d = dayLabel(ctx);
  if (s === 'done') return `<span class="pill done">✓ Done ${esc(d)}</span>`;
  if (s === 'due') {
    if (missedLastTime(t, ctx.cronDay)) return '<span class="pill risk">Don\'t miss twice</span>';
    return atRisk(t) ? '<span class="pill risk">At risk</span>' : `<span class="pill due">Due ${esc(d)}</span>`;
  }
  return `<span class="pill">Not due ${esc(d)}</span>`;
}

function checkButton(t, pending, big = false) {
  const done = !!t.completed;
  return `<button class="check${done ? ' on' : ''}${big ? ' big' : ''}${pending ? ' pending' : ''}" data-action="toggle" data-id="${esc(t.id)}"
    aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}">${CHECK_ICON}${big ? `<span>${done ? 'Done' : 'Mark done'}</span>` : ''}</button>`;
}

function rowView(t, state) {
  const ms = milestoneFor(t.streak);
  const cls = ['row', statusOf(t)];
  if (!t.streak) cls.push('zero');
  if (ms) cls.push('milestone');
  if (ms && ms === t.streak) cls.push('milestone-hit');
  const cl = t.checklist?.length ? `<span>☑ ${t.checklist.filter((c) => c.completed).length}/${t.checklist.length}</span>` : '';
  return `<li class="${cls.join(' ')}">
    ${checkButton(t, state.pending.has(t.id))}
    <a class="row-link" href="${link(t.id)}">
      <div class="row-body">
        <div class="row-title">${esc(t.text)}</div>
        <div class="row-meta">${statusPill(t, state.view.ctx)}${ms ? `<span class="pill ms">${ms}-day</span>` : ''}${cl}<span>best <span class="num">${t.best}</span></span></div>
      </div>
      <div class="row-streak num" aria-label="${t.streak} day streak">${FLAME}${t.streak}</div>
    </a>
  </li>`;
}

export function homeView(state) {
  const v = state.view;
  if (!v) {
    if (state.error) {
      return `${topbar(state, 'Streakboard')}<div class="empty"><h2>Couldn't load your streaks</h2><p>${esc(state.error)}</p>
        <button class="btn primary" data-action="refresh">Try again</button></div>`;
    }
    return `${topbar(state, 'Streakboard')}<ul class="list">${'<li class="skel"></li>'.repeat(5)}</ul>`;
  }
  const { tasks, ctx } = v;
  if (!tasks.length) {
    return `${topbar(state, 'Streakboard')}${notes(state)}<div class="empty"><h2>No dailies yet</h2><p>Add dailies in Habitica and they'll show up here.</p></div>`;
  }
  const hero = heroStats(tasks);
  const dueTotal = tasks.filter((t) => t.isDue).length;
  const doneDue = tasks.filter((t) => t.isDue && t.completed).length;
  const perfect = perfectStreak(dayRollup(tasks, ctx.cronDay), ctx.cronDay);
  const twice = sortTasks(tasks.filter((t) => missedLastTime(t, ctx.cronDay)), 'streak');
  const risky = sortTasks(tasks.filter((t) => atRisk(t) && !missedLastTime(t, ctx.cronDay)), 'streak');
  const left = ctx.stale ? null : nextRollover(ctx.today, ctx.tz, ctx.ds) - Date.now();
  const sorted = sortTasks(tasks, state.sort);
  const seg = [['streak', 'Streak'], ['due', 'Due'], ['name', 'Name']]
    .map(([k, l]) => `<button data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join('');
  const bannerItem = (t) => `<li>${checkButton(t, state.pending.has(t.id))}<a href="${link(t.id)}"><span>${esc(t.text)}</span><span class="num">${FLAME}${t.streak}</span></a></li>`;

  return `${topbar(state, 'Streakboard')}${notes(state, { rescue: true })}
    ${risky.length ? `<section class="risk" aria-label="Streaks at risk"><h2>Streak at risk${left != null ? ` · <span data-countdown>${fmtDuration(left)}</span> left` : ''}</h2><ul>${risky.map(bannerItem).join('')}</ul></section>` : ''}
    ${twice.length ? `<section class="risk twice" aria-label="Don't miss twice"><h2>Don't miss twice</h2>
      <p>Missed last time. Doing it today keeps one slip from becoming a pattern.</p><ul>${twice.map(bannerItem).join('')}</ul></section>` : ''}
    <section class="hero">
      <div class="hero-main">
        <div class="hero-num num">${FLAME}${hero.top ? hero.top.streak : 0}</div>
        <div class="hero-label">Best current streak<b>${hero.top ? esc(hero.top.text) : 'Start one today'}</b></div>
      </div>
      <div class="hero-today">
        <div class="ring-wrap">${ring(doneDue, dueTotal)}<span class="num">${doneDue}/${dueTotal}</span></div>
        <div>
          <b>${dueTotal && doneDue === dueTotal ? 'Perfect day!' : `${dueTotal - doneDue} still due ${esc(dayLabel(ctx))}`}</b>
          <span class="muted">${left != null ? `<span data-countdown>${fmtDuration(left)}</span> until your day resets` : 'New Habitica day is waiting'}</span>
        </div>
      </div>
      <div class="hero-stats">
        <div><b class="num">${hero.active}</b><span>active streak${hero.active === 1 ? '' : 's'}</span></div>
        <div><b class="num">${perfect.current}</b><span>perfect day${perfect.current === 1 ? '' : 's'} in a row</span></div>
      </div>
    </section>
    <div class="seg" role="group" aria-label="Sort by">${seg}</div>
    <ul class="list">${sorted.map((t) => rowView(t, state)).join('')}</ul>`;
}

function heatmap(t, ctx) {
  const today = ctx.cronDay;
  const keys = Object.keys(t.days).sort();
  const first = keys[0] || today;
  let start = addDays(today, -7 * 17);
  if (first < start) start = first;
  const dow = (k) => (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7;
  start = addDays(start, -dow(start));
  const end = addDays(today, 6 - dow(today));
  let html = '';
  let lastMonth = '';
  for (let wk = start; wk <= end; wk = addDays(wk, 7)) {
    const month = wk.slice(0, 7);
    html += `<span class="m">${month !== lastMonth ? fmtDay(wk, { month: 'short' }) : ''}</span>`;
    lastMonth = month;
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

export function detailView(state, id) {
  const v = state.view;
  const t = v?.tasks.find((x) => x.id === id);
  if (!t) return `<a class="back" href="#/">‹ Streaks</a><div class="empty"><h2>Daily not found</h2><p>It may have been deleted in Habitica.</p></div>`;
  const next = nextMilestone(t.streak);
  const prevMs = milestoneFor(t.streak);
  const progress = next ? Math.round(((t.streak - prevMs) / (next - prevMs)) * 100) : 100;
  const reached = MILESTONES.filter((m) => t.best >= m);
  const weak = weakestWeekday(weekdayStats([t.days]));
  const last30 = periodStats([t], v.ctx.cronDay, 30);
  return `<a class="back" href="#/">‹ Streaks</a>
    <div class="detail-head"><h1>${esc(t.text)}</h1></div>
    ${notes(state)}
    <div class="detail-hero">
      <div class="big num">${FLAME}${t.streak}</div>
      <div class="side">${statusPill(t, v.ctx)}<div class="muted" style="margin-top:6px;font-size:14px">${esc(describeSchedule(t))}</div></div>
    </div>
    ${checkButton(t, state.pending.has(t.id), true)}
    ${t.checklist?.length ? `<div class="card"><h2>Checklist</h2><ul class="checklist">${t.checklist.map((c) => `<li>
        <button class="check sm${c.completed ? ' on' : ''}" data-action="checklist" data-id="${esc(t.id)}" data-item="${esc(c.id)}" aria-pressed="${c.completed}" aria-label="${esc(c.text)}">${CHECK_ICON}</button>
        <span>${esc(c.text)}</span></li>`).join('')}</ul></div>` : ''}
    <div class="card">
      ${next ? `<div class="spread"><span class="muted">Next milestone</span><span><b class="num">${next - t.streak}</b> <span class="muted">to go → ${next} days</span></span></div>
        <div class="progress"><i style="width:${progress}%"></i></div>` : `<div style="font-size:14px">Past every milestone. Legendary.</div>`}
      ${reached.length ? `<div class="row-meta" style="margin-top:12px"><span>Milestones reached:</span>${reached.map((m) => `<span class="pill ms">${m}-day</span>`).join('')}</div>` : ''}
    </div>
    <div class="stats">
      <div><b class="num">${t.best}</b><span>Best streak</span></div>
      <div><b class="num">${pct(last30.rate)}</b><span>Done when due, 30 days</span></div>
      <div><b class="num">${t.completions}</b><span>Completions on record</span></div>
      <div><b class="num">${t.breaks.length}</b><span>Streak breaks</span></div>
    </div>
    ${weak ? `<p class="note">You miss this most on <b>${weekdayLong(weak.i)}s</b> (${weak.done}/${weak.due} done). Plan ahead for ${weekdayLong(weak.i)}s.</p>` : ''}
    <div class="card"><h2>History</h2>${heatmap(t, v.ctx)}</div>
    <div class="card"><h2>Streak breaks</h2>
      ${t.breaks.length ? `<ul class="breaks">${t.breaks.map((b) => `<li><span>${fmtDay(b.day, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span class="muted">lost a <b class="num">${b.lost}</b>-day streak</span></li>`).join('')}</ul>`
        : '<p>No breaks on record.</p>'}
    </div>
    ${t.notes ? `<div class="card"><h2>Notes</h2><p style="white-space:pre-wrap">${esc(t.notes)}</p></div>` : ''}`;
}

export function insightsView(state) {
  const v = state.view;
  if (!v) return `${topbar(state, 'Insights')}<ul class="list">${'<li class="skel"></li>'.repeat(3)}</ul>`;
  const n = state.period;
  const p = periodStats(v.tasks, v.ctx.cronDay, n);
  const perfect = perfectStreak(dayRollup(v.tasks, v.ctx.cronDay), v.ctx.cronDay);
  const trend = p.rate != null && p.prevRate != null ? Math.round((p.rate - p.prevRate) * 100) : null;
  const wd = weekdayStats(v.tasks.map((t) => t.days), p.from);
  const weak = weakestWeekday(wd);
  const per = [...p.per].filter((x) => x.due > 0).sort((a, b) => a.rate - b.rate || b.due - a.due);
  const seg = [[7, '7 days'], [30, '30 days']]
    .map(([k, l]) => `<button data-period="${k}" aria-pressed="${n === k}">${l}</button>`).join('');
  const arrow = (d) => (d == null ? '' : d > 0 ? `<span class="up">▲ ${d}</span>` : d < 0 ? `<span class="down">▼ ${-d}</span>` : '<span class="muted">±0</span>');
  return `${topbar(state, 'Insights')}
    <div class="seg" role="group" aria-label="Period">${seg}</div>
    <section class="hero">
      <div class="hero-main">
        <div class="hero-num num">${pct(p.rate)}</div>
        <div class="hero-label">Done when due<b>${p.done} of ${p.due} · last ${n} days</b>${trend != null ? `<div class="trend">${arrow(trend)} pts vs previous ${n}</div>` : ''}</div>
      </div>
      <div class="hero-stats">
        <div><b class="num">${p.perfect}</b><span>perfect days (last ${n})</span></div>
        <div><b class="num">${perfect.current}<small> / ${perfect.best}</small></b><span>perfect-day streak / best</span></div>
      </div>
    </section>
    <div class="card"><h2>By weekday</h2>
      <div class="bars">${wd.map((w) => `<div class="bar${weak && weak.i === w.i ? ' weak' : ''}" title="${w.done}/${w.due}">
        <i style="height:${w.rate == null ? 0 : Math.max(4, Math.round(w.rate * 100))}%"></i><span>${weekdayName(w.i).slice(0, 2)}</span></div>`).join('')}</div>
      <p style="margin:10px 0 0">${weak ? `Weakest day: <b>${weekdayLong(weak.i)}</b> (${pct(weak.rate)}). A small plan for ${weekdayLong(weak.i)}s goes a long way.` : 'No weak spots in this period. Nice.'}</p>
    </div>
    <div class="card"><h2>Per daily · weakest first</h2>
      ${per.length ? `<ul class="rates">${per.map((x) => `<li><a href="${link(x.task.id)}">
        <div class="spread"><span class="rate-title">${esc(x.task.text)}</span><span><b class="num">${pct(x.rate)}</b> ${arrow(x.prev.rate != null ? Math.round((x.rate - x.prev.rate) * 100) : null)}</span></div>
        <div class="progress"><i style="width:${Math.round(x.rate * 100)}%"></i></div>
        <div class="muted small">${x.done}/${x.due} due days done</div></a></li>`).join('')}</ul>` : '<p>No due days recorded in this period yet.</p>'}
    </div>
    <p class="muted small" style="text-align:center">Days you didn't open Habitica have no data and aren't counted.</p>`;
}

export function habitsView(state) {
  const v = state.view;
  if (!v) return `${topbar(state, 'Habits')}<ul class="list">${'<li class="skel"></li>'.repeat(3)}</ul>`;
  const habits = v.habits;
  if (!habits.length) return `${topbar(state, 'Habits')}<div class="empty"><h2>No positive habits</h2><p>Habits with a + button in Habitica show up here.</p></div>`;
  const rows = habits.map((h) => ({ h, s: habitStats(h, v.ctx.tz, v.ctx.ds, v.ctx.cronDay) }))
    .sort((a, b) => b.s.streak - a.s.streak || a.h.text.localeCompare(b.h.text));
  const periodWord = { day: 'today', week: 'this week', month: 'this month' };
  return `${topbar(state, 'Habits')}
    <p class="muted small">A habit's streak counts the days, weeks or months in a row (its Habitica reset period) with at least one +.</p>
    <ul class="list">${rows.map(({ h, s }) => `<li class="row${s.streak ? '' : ' zero'}${s.thisPeriod ? ' done' : ''}">
      <button class="check plus${state.pending.has(h.id) ? ' pending' : ''}" data-action="habit" data-id="${esc(h.id)}" aria-label="Plus one: ${esc(h.text)}">${PLUS_ICON}</button>
      <div class="row-link">
        <div class="row-body">
          <div class="row-title">${esc(h.text)}</div>
          <div class="row-meta">
            ${s.thisPeriod ? `<span class="pill done">✓ ${s.thisPeriod}× ${periodWord[s.unit]}</span>` : `<span class="pill due">Not yet ${periodWord[s.unit]}</span>`}
            <span>best <span class="num">${s.best}</span> ${s.unit}s</span>
          </div>
        </div>
        <div class="row-streak num" aria-label="${s.streak} ${s.unit} streak">${FLAME}${s.streak}<small>${s.unit[0]}</small></div>
      </div>
    </li>`).join('')}</ul>`;
}

export function settingsView(state, setup, creds) {
  const badgeSupported = 'setAppBadge' in navigator;
  return `${setup ? `<header class="topbar"><h1>Welcome to Streakboard</h1></header>
      <p class="muted">Your Habitica streaks, streak-first. Enter your Habitica API credentials to start. They're stored only on this device and sent only to habitica.com.</p>`
    : '<header class="topbar"><h1>Settings</h1></header>'}
    <form class="card" id="creds-form" autocomplete="off">
      <h2>Habitica account</h2>
      <p>Find these in Habitica → Settings → Site Data → API.</p>
      <label for="uid">User ID</label>
      <input type="text" id="uid" name="userId" autocapitalize="off" spellcheck="false" value="${esc(creds?.userId || '')}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required>
      <label for="tok">API token</label>
      <div class="field">
        <input type="password" id="tok" name="apiToken" autocapitalize="off" spellcheck="false" value="${esc(creds?.apiToken || '')}" placeholder="API token" required>
        <button type="button" class="icon-btn" data-action="toggle-token" aria-label="Show token" style="border:1px solid var(--line)">👁</button>
      </div>
      <div style="margin-top:14px"><button class="btn primary" type="submit">${creds ? 'Save & test' : 'Connect'}</button></div>
    </form>
    ${setup ? '' : `
    <div class="card">
      <h2>App icon badge</h2>
      <p>Show how many dailies are still due on the Home Screen icon. It updates whenever you open Streakboard.${badgeSupported ? ' iOS asks for notification permission to allow badges.' : ' Not supported in this browser.'}</p>
      <button class="btn" data-action="badge" ${badgeSupported ? '' : 'disabled'}>${state.badge ? 'Turn off badge' : 'Turn on badge'}</button>
    </div>
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
