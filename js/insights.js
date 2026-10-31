// Pure consistency analytics built on per-day statuses ('done' | 'missed' | 'notdue' | 'due').
import { addDays, dayKey, MILESTONES } from './streaks.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const weekdayIndex = (key) => (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0
export const weekdayName = (i) => WEEKDAYS[i];
const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const weekdayLong = (i) => LONG[i];

/** Next Habitica day rollover (ms), given today's Habitica day key. */
export function nextRollover(today, tz, dayStart) {
  return Date.parse(addDays(today, 1) + 'T00:00:00Z') + tz * 60000 + dayStart * 3600000;
}

export function fmtDuration(ms) {
  if (ms <= 0) return '0m';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

/** Outcome of the most recent due day strictly before `before`: 'done' | 'missed' | null. */
export function lastDueOutcome(days, before) {
  let best = null;
  for (const [k, v] of Object.entries(days)) {
    if (k < before && (v === 'done' || v === 'missed') && (!best || k > best[0])) best = [k, v];
  }
  return best ? best[1] : null;
}

/** "Never miss twice": missed last time it was due, and due-but-open today. */
export function missedLastTime(t, today) {
  return t.isDue && !t.completed && lastDueOutcome(t.days || {}, today) === 'missed';
}

/**
 * Per-day roll-up across dailies. A day is perfect when at least one daily was due
 * and none was missed (today counts only once everything due is done).
 */
export function dayRollup(tasks, today) {
  const map = {};
  for (const t of tasks) {
    for (const [k, v] of Object.entries(t.days || {})) {
      if (!map[k]) map[k] = { done: 0, missed: 0, open: 0 };
      if (v === 'done') map[k].done++;
      else if (v === 'missed') map[k].missed++;
      else if (v === 'due') map[k].open++;
    }
  }
  const out = {};
  for (const [k, r] of Object.entries(map)) {
    const due = r.done + r.missed + r.open;
    if (!due) continue;
    out[k] = { ...r, due, perfect: r.missed === 0 && r.open === 0 && (k < today || r.done > 0) };
  }
  return out;
}

/** Consecutive perfect days ending today (if already perfect) or yesterday; days without data are neutral. */
export function perfectStreak(rollup, today) {
  const keys = Object.keys(rollup).filter((k) => k <= today).sort();
  let current = 0;
  for (const k of [...keys].reverse()) {
    if (k === today && !rollup[k].perfect) continue; // today still in progress
    if (rollup[k].perfect) current++; else break;
  }
  let best = 0, run = 0;
  for (const k of keys) {
    if (rollup[k].perfect) best = Math.max(best, ++run);
    else if (k < today) run = 0;
  }
  return { current, best };
}

/** Completion stats over the `n` days ending yesterday (plus today's finished work). */
export function periodStats(tasks, today, n) {
  const from = addDays(today, -n + 1);
  const prevFrom = addDays(from, -n);
  const range = (t, a, b) => {
    let done = 0, due = 0;
    for (const [k, v] of Object.entries(t.days || {})) {
      if (k < a || k > b) continue;
      if (v === 'done') { done++; due++; } else if (v === 'missed') due++;
    }
    return { done, due, rate: due ? done / due : null };
  };
  const per = tasks.map((t) => ({ task: t, ...range(t, from, today), prev: range(t, prevFrom, addDays(from, -1)) }));
  const sum = (arr, key) => arr.reduce((s, x) => s + x[key], 0);
  const done = sum(per, 'done'), due = sum(per, 'due');
  const pDone = per.reduce((s, x) => s + x.prev.done, 0), pDue = per.reduce((s, x) => s + x.prev.due, 0);
  const rollup = dayRollup(tasks, today);
  const perfect = Object.entries(rollup).filter(([k, r]) => k >= from && k <= today && r.perfect).length;
  return {
    from, per,
    rate: due ? done / due : null,
    prevRate: pDue ? pDone / pDue : null,
    done, due, perfect,
  };
}

/** Completion rate by weekday for one daily's (or all dailies') days. */
export function weekdayStats(daysList, from = '0000-00-00') {
  const w = Array.from({ length: 7 }, () => ({ done: 0, due: 0 }));
  for (const days of daysList) {
    for (const [k, v] of Object.entries(days)) {
      if (k < from) continue;
      const i = weekdayIndex(k);
      if (v === 'done') { w[i].done++; w[i].due++; } else if (v === 'missed') w[i].due++;
    }
  }
  return w.map((x, i) => ({ ...x, i, rate: x.due ? x.done / x.due : null }));
}

/** Weakest weekday with enough samples (≥2 due days and at least one miss), or null. */
export function weakestWeekday(stats) {
  const cands = stats.filter((s) => s.due >= 2 && s.done < s.due);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.rate < a.rate ? b : a));
}

/** Milestones crossed going from `prev` to `next` streak. */
export function crossedMilestones(prev, next) {
  return MILESTONES.filter((m) => prev < m && next >= m);
}

// ---------- habits ----------

function periodKey(day, frequency) {
  if (frequency === 'weekly') return addDays(day, -weekdayIndex(day)); // Monday
  if (frequency === 'monthly') return day.slice(0, 7);
  return day;
}
function prevPeriod(key, frequency) {
  if (frequency === 'weekly') return addDays(key, -7);
  if (frequency === 'monthly') {
    const [y, m] = key.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  }
  return addDays(key, -1);
}

/**
 * Positive habit consistency: number of consecutive periods (day/week/month, per the
 * habit's reset frequency) with at least one + click. The current period counts once
 * it has a click; until then the streak runs through the previous period.
 */
export function habitStats(habit, tz, dayStart, today, target = 1) {
  const freq = habit.frequency || 'daily';
  const ups = {};
  let prevValue = null;
  for (const h of [...(habit.history || [])].sort((a, b) => a.date - b.date)) {
    // Older entries lack scoredUp; infer a + click from a rising value.
    const n = h.scoredUp ?? (prevValue != null && h.value > prevValue ? 1 : 0);
    prevValue = h.value;
    if (!n) continue;
    const p = periodKey(dayKey(Number(h.date), tz, dayStart), freq);
    ups[p] = (ups[p] || 0) + n;
  }
  const cur = periodKey(today, freq);
  const thisPeriod = ups[cur] || 0;
  const hit = (k) => (ups[k] || 0) >= target;
  // The current period counts once the target is met; until then the streak runs through the previous one.
  let streak = 0;
  let p = hit(cur) ? cur : prevPeriod(cur, freq);
  while (hit(p)) { streak++; p = prevPeriod(p, freq); }
  let best = 0, run = 0, last = null;
  for (const k of Object.keys(ups).filter(hit).sort()) {
    run = last && prevPeriod(k, freq) === last ? run + 1 : 1;
    best = Math.max(best, run);
    last = k;
  }
  const unit = freq === 'weekly' ? 'week' : freq === 'monthly' ? 'month' : 'day';
  return { streak, best: Math.max(best, streak), thisPeriod, target, unit, ups };
}

// ---------- timing, plans, reasons ----------

const DAY_MS = 86400000;

/** Minutes since the Habitica day start (0..1439) for a timestamp. */
export function minutesIntoDay(ts, tz, dayStart) {
  const local = (((Number(ts) - tz * 60000) % DAY_MS) + DAY_MS) % DAY_MS;
  return (Math.floor(local / 60000) - dayStart * 60 + 1440) % 1440;
}

/**
 * Median time of day this daily gets ticked, from recent check-offs (minutes since
 * day start), or null with fewer than 3 samples. Late "record yesterday" ticks made
 * before that day's cron are excluded; they don't reflect when you do the habit.
 */
export function usualTime(task, { tz, dayStart, cronStart = {} }, limit = 30) {
  const mins = [];
  for (const h of task.history || []) {
    if (!h.completed) continue;
    const ts = Number(h.date);
    const k = dayKey(ts, tz, dayStart);
    if (cronStart[k] && ts < cronStart[k]) continue;
    mins.push(minutesIntoDay(ts, tz, dayStart));
  }
  const recent = mins.slice(-limit).sort((a, b) => a - b);
  if (recent.length < 3) return null;
  return recent[Math.floor(recent.length / 2)];
}

export function fmtClock(minSinceDayStart, dayStart) {
  const m = (minSinceDayStart + dayStart * 60) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  // Round to the nearest 15 minutes; it's an estimate.
  const q = Math.round(mm / 15) * 15;
  const hh = (h + (q === 60 ? 1 : 0)) % 24;
  const ap = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 || 12;
  return `${h12}${q % 60 ? ':' + String(q % 60).padStart(2, '0') : ''} ${ap}`;
}

/** Due, not done, and more than an hour past the usual time. */
export function pastUsualTime(task, nowMin) {
  return task.usual != null && task.isDue && !task.completed && nowMin > task.usual + 60;
}

/**
 * Date (day key) the next milestone is reached if no due day is missed, using
 * Habitica's own nextDue list; extrapolates for simple every-N-days schedules.
 */
export function milestoneForecast(task, target, today, tz) {
  if (!target || target <= task.streak) return null;
  const need = target - task.streak;
  const dates = [];
  if (task.isDue && !task.completed) dates.push(today);
  for (const d of task.nextDue || []) {
    const t = Date.parse(d);
    if (isNaN(t)) continue;
    const k = dayKey(t, tz, 0); // nextDue values are local midnights
    if (k > today && !dates.includes(k)) dates.push(k);
  }
  dates.sort();
  if (need <= dates.length) return dates[need - 1];
  if (task.frequency === 'daily') {
    const last = dates.length ? dates[dates.length - 1] : today;
    return addDays(last, (need - dates.length) * (task.everyX || 1));
  }
  return null;
}

export const MISS_REASONS = ['Forgot', 'No time', 'Tired', 'Sick', 'Travel', 'Rest day', 'Other'];

/** Missed days in the last `days` days that have no reason recorded yet (newest first). */
export function unexplainedMisses(task, reasons = {}, today, days = 14) {
  const from = addDays(today, -days);
  return Object.entries(task.days || {})
    .filter(([k, v]) => v === 'missed' && k >= from && k < today && !reasons[k])
    .map(([k]) => k)
    .sort()
    .reverse();
}

/** Reason counts across tasks since `from`, most common first. */
export function reasonStats(reasonsByTask = {}, from = '0000-00-00') {
  const counts = {};
  for (const byDay of Object.values(reasonsByTask)) {
    for (const [k, r] of Object.entries(byDay || {})) if (k >= from) counts[r] = (counts[r] || 0) + 1;
  }
  return Object.entries(counts).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
}

// ---------- weekly review & focus ----------

function rangeCounts(days, from, to) {
  let done = 0, missed = 0;
  for (const [k, v] of Object.entries(days || {})) {
    if (k < from || k > to) continue;
    if (v === 'done') done++; else if (v === 'missed') missed++;
  }
  return { done, missed, due: done + missed };
}

/**
 * Review of the last 7 closed days: wins (every due day done), slips (with any
 * reasons logged) and a suggested focus (the slip with the lowest completion rate).
 */
export function weeklyReview(tasks, reasonsByTask = {}, today) {
  const from = addDays(today, -7), to = addDays(today, -1);
  const rows = tasks.map((t) => ({ task: t, ...rangeCounts(t.days, from, to) })).filter((r) => r.due > 0);
  const wins = rows.filter((r) => r.missed === 0).sort((a, b) => b.task.streak - a.task.streak);
  const slips = rows.filter((r) => r.missed > 0).map((r) => {
    const why = Object.entries(reasonsByTask[r.task.id] || {}).filter(([k]) => k >= from && k <= to).map(([, v]) => v);
    return { ...r, rate: r.done / r.due, why };
  }).sort((a, b) => a.rate - b.rate || b.missed - a.missed);
  const roll = dayRollup(tasks, today);
  const perfect = Object.entries(roll).filter(([k, r]) => k >= from && k <= to && r.perfect).length;
  const done = rows.reduce((s, r) => s + r.done, 0), due = rows.reduce((s, r) => s + r.due, 0);
  return { from, to, wins, slips, perfect, rate: due ? done / due : null, suggestion: slips[0]?.task || null };
}

/** Focus progress since it was chosen (days up to and including today). */
export function focusProgress(task, since, today) {
  const c = rangeCounts(task.days, since, today);
  return { ...c, rate: c.due ? c.done / c.due : null };
}

/** A focus lasts a week; after that the review suggests picking a new one. */
export function focusExpired(focus, today) {
  return !focus?.taskId || addDays(focus.since, 7) <= today;
}
