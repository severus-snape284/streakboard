// Screen renderers: pure functions of app state → HTML strings.
import { sortTasks, heroStats, atRisk, statusOf, milestoneFor, nextMilestone, MILESTONES, addDays } from './streaks.js';
import {
  missedLastTime, dayRollup, perfectStreak, periodStats, weekdayStats, weakestWeekday,
  weekdayName, weekdayLong, habitStats, nextRollover, fmtDuration,
  fmtClock, pastUsualTime, minutesIntoDay, milestoneForecast, unexplainedMisses, reasonStats, MISS_REASONS,
  weeklyReview, focusProgress, focusExpired, dueTomorrow, adjustmentTips,
} from './insights.js';
import { describeSchedule } from './model.js';
import { esc, relTime, fmtDay, pct, FLAME, REFRESH_ICON, CHECK_ICON, PLUS_ICON, ring } from './ui.js';

export const APP_VERSION = '2.3.0';

const nowMin = (ctx) => minutesIntoDay(Date.now(), ctx.tz, ctx.ds);

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
    out += `<section class="rescue rest" aria-label="Resting in the Inn">
      <h2>Resting in the Inn</h2>
      <p>Habitica isn't resetting streaks or taking damage while you rest. You can still tick dailies, and they'll still count. Leave the Inn when you're back to normal.</p>
      <button class="btn" data-action="sleep">Leave the Inn</button>
    </section>`;
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
    if (atRisk(t)) return '<span class="pill risk">At risk</span>';
    if (!ctx.stale && pastUsualTime(t, nowMin(ctx))) return `<span class="pill late">Usually done by ${esc(fmtClock(t.usual, ctx.ds))}</span>`;
    return `<span class="pill due">Due ${esc(d)}</span>`;
  }
  return `<span class="pill">Not due ${esc(d)}</span>`;
}

function checkButton(t, pending, big = false) {
  const done = !!t.completed;
  return `<button class="check${done ? ' on' : ''}${big ? ' big' : ''}${pending ? ' pending' : ''}" data-action="toggle" data-id="${esc(t.id)}"
    aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}">${CHECK_ICON}${big ? `<span>${done ? 'Done' : 'Mark done'}</span>` : ''}</button>`;
}

function rowView(t, state) {
  const ctx = state.view.ctx;
  const cue = state.prefs.cues[t.id];
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
        ${cue ? `<div class="row-cue">→ ${esc(cue)}</div>` : ''}
        <div class="row-meta">${state.prefs.focus?.taskId === t.id && !focusExpired(state.prefs.focus, ctx.cronDay) ? '<span class="pill ms">Focus</span>' : ''}${statusPill(t, ctx)}${state.sort === 'time' && t.usual != null ? `<span>~${esc(fmtClock(t.usual, ctx.ds))}</span>` : ''}${ms ? `<span class="pill ms">${ms}-day</span>` : ''}${cl}<span>best <span class="num">${t.best}</span></span></div>
      </div>
      <div class="row-streak num" aria-label="${t.streak} day streak">${FLAME}${t.streak}</div>
    </a>
  </li>`;
}

/** Day plan order: open dailies by usual time (unknown last), then done, then not due. */
function sortByTime(tasks) {
  const rank = (t) => (t.isDue && !t.completed ? 0 : t.completed ? 1 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (a.usual ?? 9999) - (b.usual ?? 9999) || a.text.localeCompare(b.text));
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
  // Streaks can't break while resting in the Inn, so skip the warnings then.
  const resting = !!v.user?.preferences?.sleep;
  const twice = resting ? [] : sortTasks(tasks.filter((t) => missedLastTime(t, ctx.cronDay)), 'streak');
  const risky = resting ? [] : sortTasks(tasks.filter((t) => atRisk(t) && !missedLastTime(t, ctx.cronDay)), 'streak');
  const left = ctx.stale ? null : nextRollover(ctx.today, ctx.tz, ctx.ds) - Date.now();
  const sorted = state.sort === 'time' ? sortByTime(tasks) : sortTasks(tasks, state.sort);
  const tomorrow = ctx.stale ? [] : dueTomorrow(tasks, ctx.cronDay, ctx.tz);
  const seg = [['streak', 'Streak'], ['due', 'Due'], ['time', 'Time'], ['name', 'Name']]
    .map(([k, l]) => `<button data-sort="${k}" aria-pressed="${state.sort === k}">${l}</button>`).join('');
  const bannerItem = (t) => {
    const mini = state.prefs.minis?.[t.id];
    return `<li>${checkButton(t, state.pending.has(t.id))}<a href="${link(t.id)}"><span>${esc(t.text)}${mini ? `<small class="mini">Short on time? ${esc(mini)}</small>` : ''}</span><span class="num">${FLAME}${t.streak}</span></a></li>`;
  };
  const focus = state.prefs.focus;
  const focusTask = !focusExpired(focus, ctx.cronDay) && tasks.find((t) => t.id === focus.taskId);
  let focusCard = '';
  if (focusTask) {
    const fp = focusProgress(focusTask, focus.since, ctx.cronDay);
    focusCard = `<a class="focus" href="${link(focusTask.id)}">
      <div class="focus-label">This week's focus</div>
      <div class="spread"><b>${esc(focusTask.text)}</b><span class="num">${FLAME}${focusTask.streak}</span></div>
      <div class="small muted">${fp.done}/${fp.due} due days done since ${esc(fmtDay(focus.since, { weekday: 'short' }))}${focusTask.isDue && !focusTask.completed ? ' · due today' : focusTask.completed ? ' · done today ✓' : ''}</div>
    </a>`;
  } else if (Object.keys(tasks[0]?.days || {}).length) {
    focusCard = `<a class="focus prompt" href="#/insights">
      <div class="focus-label">Weekly review</div>
      <div>Review last week and pick one daily to focus on →</div>
    </a>`;
  }

  return `${topbar(state, 'Streakboard')}${notes(state, { rescue: true })}
    ${risky.length ? `<section class="risk" aria-label="Streaks at risk"><h2>Streak at risk${left != null ? ` · <span data-countdown>${fmtDuration(left)}</span> left` : ''}</h2><ul>${risky.map(bannerItem).join('')}</ul></section>` : ''}
    ${twice.length ? `<section class="risk twice" aria-label="Don't miss twice"><h2>Don't miss twice</h2>
      <p>Missed last time. Doing it today keeps one slip from becoming a pattern.</p><ul>${twice.map(bannerItem).join('')}</ul></section>` : ''}
    ${focusCard}
    <section class="hero">
      <div class="hero-main">
        <div class="hero-num num">${FLAME}${hero.top ? hero.top.streak : 0}</div>
        <div class="hero-label">Best current streak<b>${hero.top ? esc(hero.top.text) : 'Start one today'}</b></div>
      </div>
      <div class="hero-today">
        <div class="ring-wrap">${ring(doneDue, dueTotal)}<span class="num">${doneDue}/${dueTotal}</span></div>
        <div>
          <b>${dueTotal && doneDue === dueTotal ? 'Perfect day!' : `${dueTotal - doneDue} still due ${esc(dayLabel(ctx))}`}</b>
          ${dueTotal && doneDue === dueTotal && tomorrow.length ? `<span class="muted">Tomorrow: ${tomorrow.length} due (${esc(tomorrow.slice(0, 3).map((t) => t.text).join(', '))}${tomorrow.length > 3 ? '…' : ''})</span><br>` : ''}
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
      const title = k > today ? '' : `${fmtDay(k)}: ${({ done: 'done', missed: 'missed', notdue: 'not due', due: 'due, not done yet', rest: 'resting (streak kept)' })[st] || 'no data'}`;
      html += `<i class="${st}${k === today ? ' today' : ''}" title="${esc(title)}"></i>`;
    }
  }
  return `<div class="heat-wrap"><div class="heat" role="img" aria-label="Completion calendar">${html}</div></div>
    <div class="legend">
      <span><i style="background:var(--cell-done)"></i>Done</span>
      <span><i style="background:var(--cell-missed)"></i>Missed</span>
      <span><i style="background:var(--cell-notdue)"></i>Not due</span>
      <span><i style="background:var(--cell-rest)"></i>Rest</span>
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
  const forecast = milestoneForecast(t, next, v.ctx.cronDay, v.ctx.tz);
  const reasons = state.prefs.reasons[t.id] || {};
  const misses = unexplainedMisses(t, reasons, v.ctx.cronDay).slice(0, 3);
  const cue = state.prefs.cues[t.id] || '';
  const logged = Object.entries(reasons).sort().reverse().slice(0, 5);
  return `<a class="back" href="#/">‹ Streaks</a>
    <div class="detail-head"><h1>${esc(t.text)}</h1></div>
    ${notes(state)}
    <div class="detail-hero">
      <div class="big num">${FLAME}${t.streak}</div>
      <div class="side">${statusPill(t, v.ctx)}<div class="muted" style="margin-top:6px;font-size:14px">${esc(describeSchedule(t))}</div></div>
    </div>
    ${checkButton(t, state.pending.has(t.id), true)}
    ${misses.length ? `<div class="card why"><h2>Why did you miss?</h2><p>Naming the obstacle makes it easier to plan around next time.</p>
      ${misses.map((d) => `<div class="why-day"><div class="small muted">${esc(fmtDay(d, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
        <div class="chips">${MISS_REASONS.map((r) => `<button class="chip" data-action="reason" data-id="${esc(t.id)}" data-day="${d}" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div></div>`).join('')}
    </div>` : ''}
    <form class="card" id="cue-form" data-id="${esc(t.id)}">
      <h2>Plan</h2>
      <p>A specific cue ("After morning coffee, at my desk") makes it far more likely to happen. A tiny fallback keeps the streak alive on hard days: showing up matters more than doing it perfectly.</p>
      <label for="cue-in">When and where</label>
      <input type="text" id="cue-in" name="cue" maxlength="80" value="${esc(cue)}" placeholder="After … , at …">
      <label for="mini-in">2-minute version (for busy days)</label>
      <input type="text" id="mini-in" name="mini" maxlength="80" value="${esc(state.prefs.minis?.[t.id] || '')}" placeholder="e.g. Read one page">
      <button class="btn" type="submit" style="margin-top:12px">Save plan</button>
      ${t.usual != null ? `<p class="small" style="margin:10px 0 0">You usually tick this around <b>${esc(fmtClock(t.usual, v.ctx.ds))}</b>.</p>` : ''}
    </form>
    ${t.checklist?.length ? `<div class="card"><h2>Checklist</h2><ul class="checklist">${t.checklist.map((c) => `<li>
        <button class="check sm${c.completed ? ' on' : ''}" data-action="checklist" data-id="${esc(t.id)}" data-item="${esc(c.id)}" aria-pressed="${c.completed}" aria-label="${esc(c.text)}">${CHECK_ICON}</button>
        <span>${esc(c.text)}</span></li>`).join('')}</ul></div>` : ''}
    <div class="card">
      ${next ? `<div class="spread"><span class="muted">Next milestone</span><span><b class="num">${next - t.streak}</b> <span class="muted">to go → ${next} days</span></span></div>
        <div class="progress"><i style="width:${progress}%"></i></div>
        ${forecast ? `<p class="small muted" style="margin:8px 0 0">Keep going and you'll reach ${next} days on <b>${esc(fmtDay(forecast, { weekday: 'short', month: 'short', day: 'numeric' }))}</b>.</p>` : ''}` : `<div style="font-size:14px">Past every milestone. Legendary.</div>`}
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
    ${logged.length ? `<div class="card"><h2>Miss reasons logged</h2><ul class="breaks">${logged.map(([d, r]) => `<li><span>${esc(fmtDay(d, { month: 'short', day: 'numeric' }))}</span><span class="muted">${esc(r)}</span></li>`).join('')}</ul></div>` : ''}
    <div class="card"><h2>Streak breaks</h2>
      ${t.breaks.length ? `<ul class="breaks">${t.breaks.map((b) => `<li><span>${fmtDay(b.day, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span class="muted">lost a <b class="num">${b.lost}</b>-day streak</span></li>`).join('')}</ul>`
        : '<p>No breaks on record.</p>'}
    </div>
    ${t.notes ? `<div class="card"><h2>Notes</h2><p style="white-space:pre-wrap">${esc(t.notes)}</p></div>` : ''}`;
}

function overallCalendar(v) {
  const today = v.ctx.cronDay;
  const roll = dayRollup(v.tasks, today);
  const dow = (k) => (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7;
  let start = addDays(today, -7 * 17);
  start = addDays(start, -dow(start));
  const end = addDays(today, 6 - dow(today));
  let html = '', lastMonth = '';
  for (let wk = start; wk <= end; wk = addDays(wk, 7)) {
    const month = wk.slice(0, 7);
    html += `<span class="m">${month !== lastMonth ? fmtDay(wk, { month: 'short' }) : ''}</span>`;
    lastMonth = month;
    for (let d = 0; d < 7; d++) {
      const k = addDays(wk, d);
      const r = roll[k];
      let cls = k > today ? 'future' : '';
      if (r && k <= today) cls = r.perfect ? 'done' : r.done === 0 ? (k < today ? 'missed' : '') : 'part';
      const title = r ? `${fmtDay(k)}: ${r.done}/${r.due} done` : `${fmtDay(k)}: no data`;
      html += `<i class="${cls}${k === today ? ' today' : ''}" title="${esc(title)}"></i>`;
    }
  }
  return `<div class="heat-wrap"><div class="heat" role="img" aria-label="Daily completion calendar">${html}</div></div>
    <div class="legend">
      <span><i style="background:var(--cell-done)"></i>All done</span>
      <span><i style="background:var(--cell-part)"></i>Some</span>
      <span><i style="background:var(--cell-missed)"></i>None</span>
      <span><i style="background:var(--cell-empty)"></i>No data</span>
    </div>`;
}

function reasonsCard(state, from, n) {
  const stats = reasonStats(state.prefs.reasons, from);
  if (!stats.length) return '';
  const total = stats.reduce((s, x) => s + x.n, 0);
  const tips = {
    Forgot: 'Add a plan (when + where) to the dailies you forget, or tie them to something you already do.',
    'No time': 'Try a 2-minute version on busy days: showing up keeps the streak alive.',
    Tired: 'Move tiring dailies earlier in the day, before your energy runs out.',
    Travel: 'Decide in advance what the travel version of each daily looks like.',
  };
  const top = stats[0].reason;
  return `<div class="card"><h2>Why you miss · last ${n} days</h2>
    <ul class="rates">${stats.map((x) => `<li><div style="padding:10px 0">
      <div class="spread"><span>${esc(x.reason)}</span><b class="num">${x.n}</b></div>
      <div class="progress"><i style="width:${Math.round((x.n / total) * 100)}%"></i></div></div></li>`).join('')}</ul>
    ${tips[top] ? `<p style="margin:10px 0 0">${esc(tips[top])}</p>` : ''}
  </div>`;
}

function adjustCard(state) {
  const v = state.view;
  const tips = adjustmentTips(v.tasks, v.ctx.cronDay, { minis: state.prefs.minis || {}, dayStart: v.ctx.ds });
  if (!tips.length) return '';
  return `<section class="card"><h2>Needs adjustment</h2>
    <p>These dailies were done less than 60% of the time they were due over the last 30 days. A small change usually works better than more willpower.</p>
    <ul class="rates">${tips.map((x) => `<li><a href="${link(x.task.id)}">
      <div class="spread"><span class="rate-title">${esc(x.task.text)}</span><b class="num">${pct(x.rate)}</b></div>
      <div class="small muted" style="margin-top:4px">${esc(x.tip)}</div></a></li>`).join('')}</ul>
  </section>`;
}

function reviewCard(state) {
  const v = state.view;
  const r = weeklyReview(v.tasks, state.prefs.reasons, v.ctx.cronDay);
  if (!r.wins.length && !r.slips.length) return '';
  const focus = state.prefs.focus;
  const active = !focusExpired(focus, v.ctx.cronDay) ? v.tasks.find((t) => t.id === focus.taskId) : null;
  const range = `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
  const choices = [...r.slips.map((x) => x.task), ...v.tasks.filter((t) => !r.slips.some((x) => x.task.id === t.id))].slice(0, 6);
  return `<section class="card review" id="review">
    <h2>Weekly review · ${esc(range)}</h2>
    <div class="review-stats"><span><b class="num">${pct(r.rate)}</b> done when due</span><span><b class="num">${r.perfect}</b> perfect day${r.perfect === 1 ? '' : 's'}</span></div>
    ${r.wins.length ? `<h3>Wins</h3><ul class="plain">${r.wins.slice(0, 5).map((x) => `<li>✓ ${esc(x.task.text)} <span class="muted">${x.done}/${x.due}${x.task.streak ? ` · ${x.task.streak}-day streak` : ''}</span></li>`).join('')}</ul>` : ''}
    ${r.slips.length ? `<h3>Slips</h3><ul class="plain">${r.slips.slice(0, 5).map((x) => `<li>${esc(x.task.text)} <span class="muted">missed ${x.missed}${x.why.length ? ` · ${esc([...new Set(x.why)].join(', '))}` : ''}</span></li>`).join('')}</ul>` : ''}
    <h3>${active ? `Focus: ${esc(active.text)}` : 'Pick one focus for this week'}</h3>
    ${active ? `<p class="small muted" style="margin:0 0 8px">Chosen ${esc(fmtDay(focus.since, { weekday: 'long' }))}. It's pinned at the top of Streaks. Change it:</p>`
      : `<p class="small muted" style="margin:0 0 8px">One thing at a time works better than fixing everything at once.${r.suggestion ? ` Suggested: <b>${esc(r.suggestion.text)}</b>.` : ''}</p>`}
    <div class="chips">${choices.map((t) => `<button class="chip${active?.id === t.id ? ' on' : ''}" data-action="focus" data-id="${esc(t.id)}">${esc(t.text)}</button>`).join('')}
      ${active ? '<button class="chip" data-action="focus" data-id="">Clear</button>' : ''}</div>
  </section>`;
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
    ${reviewCard(state)}
    ${adjustCard(state)}
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
    <div class="card"><h2>Consistency calendar</h2>${overallCalendar(v)}</div>
    ${reasonsCard(state, p.from, n)}
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
  const rows = habits.map((h) => ({ h, s: habitStats(h, v.ctx.tz, v.ctx.ds, v.ctx.cronDay, state.prefs.targets[h.id] || 1) }))
    .sort((a, b) => b.s.streak - a.s.streak || a.h.text.localeCompare(b.h.text));
  const periodWord = { day: 'today', week: 'this week', month: 'this month' };
  return `${topbar(state, 'Habits')}
    <p class="muted small">A habit's streak counts the days, weeks or months in a row (its Habitica reset period) where you hit its goal. Tap a goal to change it.</p>
    <ul class="list">${rows.map(({ h, s }) => `<li class="row${s.streak ? '' : ' zero'}${s.thisPeriod ? ' done' : ''}">
      <button class="check plus${state.pending.has(h.id) ? ' pending' : ''}" data-action="habit" data-id="${esc(h.id)}" aria-label="Plus one: ${esc(h.text)}">${PLUS_ICON}</button>
      <div class="row-link">
        <div class="row-body">
          <div class="row-title">${esc(h.text)}</div>
          <div class="row-meta">
            ${s.target > 1
              ? `<span class="pill ${s.thisPeriod >= s.target ? 'done' : 'due'}">${s.thisPeriod >= s.target ? '✓ ' : ''}${s.thisPeriod}/${s.target} ${periodWord[s.unit]}</span>`
              : s.thisPeriod ? `<span class="pill done">✓ ${s.thisPeriod}× ${periodWord[s.unit]}</span>` : `<span class="pill due">Not yet ${periodWord[s.unit]}</span>`}
            <button class="pill pill-btn" data-action="target" data-id="${esc(h.id)}">Goal: ${s.target}/${s.unit}</button>
            <span>best <span class="num">${s.best}</span></span>
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
      <h2>Home Screen &amp; Lock Screen widget</h2>
      <p>iOS doesn't allow widgets for web apps, so the widget runs in the free <b>Scriptable</b> app and reads Habitica directly.</p>
      <ol class="steps">
        <li>Install <b>Scriptable</b> from the App Store.</li>
        <li>Tap <b>Copy widget script</b> below. In Scriptable, tap <b>+</b>, paste, and name it "Streakboard".</li>
        <li>Run it once (▶) and enter your User ID and API token. They're saved in the iOS Keychain.</li>
        <li>Long-press your Home Screen → <b>+</b> → Scriptable → pick a size → <b>Add Widget</b>.</li>
        <li>Then <b>long-press the new widget → Edit Widget</b> → Script: <b>Streakboard</b>, and tap outside to close. (Just tapping the widget opens Scriptable instead.) Optional parameter: <code>risk</code> shows at-risk dailies first.</li>
        <li>Lock Screen: customise it → add a Scriptable widget → choose Streakboard.</li>
      </ol>
      <button class="btn" data-action="copy-widget">Copy widget script</button>
      <a class="btn" href="widgets/streakboard-widget.js" target="_blank" rel="noopener">View script</a>
    </div>
    <div class="card">
      <h2>Taking a break?</h2>
      <p>Sick, travelling or need a real rest day? Resting in Habitica's Inn pauses penalties: streaks don't reset and you take no damage while you rest. (Party quest bosses can still hurt your party if others miss dailies.)</p>
      <button class="btn" data-action="sleep">${state.view?.user?.preferences?.sleep ? 'Leave the Inn' : 'Rest in the Inn'}</button>
    </div>
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
