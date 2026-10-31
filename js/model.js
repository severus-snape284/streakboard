// Pure data model: turns API responses + local records into what the UI renders.
import { crossedMilestones, usualTime } from './insights.js';
import {
  dayKey, isCronStale, analyzeHistory, historyToDays, mergeDays,
  reconstructStreaks, daysBetween,
} from './streaks.js';

const KEEP = ['id', 'text', 'notes', 'streak', 'completed', 'isDue', 'nextDue', 'history',
  'frequency', 'everyX', 'repeat', 'daysOfMonth', 'weeksOfMonth', 'startDate', 'createdAt', 'checklist'];

export function slimTask(t) {
  const out = {};
  for (const k of KEEP) if (k in t) out[k] = t[k];
  out.checklist = (t.checklist || []).map((c) => ({ id: c.id, text: c.text, completed: !!c.completed }));
  return out;
}

export function slimHabit(h) {
  const { id, text, notes, up, down, counterUp, counterDown, frequency, history, value } = h;
  return { id, text, notes, up, down, counterUp, counterDown, frequency, value,
    history: (history || []).map(({ date, value: v, scoredUp, scoredDown }) => ({ date, value: v, scoredUp, scoredDown })) };
}

/** Habitica's tz/dayStart, plus the "current" Habitica day (the day the last cron opened). */
export function timeCtx(user, now = Date.now()) {
  const tz = user?.preferences?.timezoneOffset ?? new Date().getTimezoneOffset();
  const ds = user?.preferences?.dayStart ?? 0;
  const today = dayKey(now, tz, ds);
  const cronDay = user?.lastCron ? dayKey(Date.parse(user.lastCron), tz, ds) : today;
  return { tz, ds, today, cronDay, resting: !!user?.preferences?.sleep, stale: !!user?.needsCron || isCronStale(user?.lastCron, now, tz, ds) };
}

const RANK = { done: 4, missed: 3, rest: 2, due: 1, notdue: 0 };
function unionDays(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || RANK[v] > RANK[out[k]]) out[k] = v;
  return out;
}

/**
 * Update a task's observed record after a fetch. Accumulates history-derived days
 * (Habitica eventually compresses old history, so we keep what we've seen),
 * the max streak observed, and breaks (a drop in streak between fetches).
 */
export function updateObserved(prev, task, historyDays, day) {
  const o = prev ? { ...prev } : { taskId: task.id, maxStreak: 0, breaks: [], days: {} };
  // The current day is still mutable (unticking deletes its history entry), so only
  // accumulate closed days; the current day comes from the latest snapshot.
  const closed = Object.fromEntries(Object.entries(historyDays).filter(([k]) => k < day));
  o.days = unionDays(o.days, closed);
  if (task.streak > o.maxStreak) { o.maxStreak = task.streak; o.maxDay = day; }
  if (o.lastStreak > 0 && task.streak < o.lastStreak) {
    if (!o.breaks.some((b) => b.day === day)) o.breaks = [...o.breaks, { day, lost: o.lastStreak, source: 'observed' }];
  }
  o.lastStreak = task.streak;
  o.lastDay = day;
  return o;
}

export function mergeObserved(a, b) {
  if (!a) return b;
  const breaks = [...(a.breaks || [])];
  for (const br of b.breaks || []) if (!breaks.some((x) => x.day === br.day)) breaks.push(br);
  const useB = (b.maxStreak || 0) > (a.maxStreak || 0);
  return {
    ...a,
    maxStreak: useB ? b.maxStreak : a.maxStreak,
    maxDay: useB ? b.maxDay : a.maxDay,
    breaks: breaks.sort((x, y) => x.day.localeCompare(y.day)),
    days: unionDays(a.days, b.days),
  };
}

/** Run after each successful fetch: snapshot rows + updated observed records. */
export function ingest(user, dailies, observedList, now = Date.now()) {
  const ctx = timeCtx(user, now);
  const analysis = analyzeHistory(dailies, { lastCron: user?.lastCron, tzOffsetMin: ctx.tz, dayStart: ctx.ds });
  const prev = new Map(observedList.map((o) => [o.taskId, o]));
  const snapshots = [];
  const observed = [];
  const celebrations = [];
  for (const t of dailies) {
    const before = prev.get(t.id);
    if (before && before.lastStreak != null) {
      for (const m of crossedMilestones(before.lastStreak, t.streak)) celebrations.push({ taskId: t.id, text: t.text, m, day: ctx.cronDay });
    }
    const hd = historyToDays(t, analysis);
    observed.push(updateObserved(prev.get(t.id), t, hd, ctx.cronDay));
    snapshots.push({ taskId: t.id, day: ctx.cronDay, completed: !!t.completed, isDue: !!t.isDue, streak: t.streak, ts: now });
  }
  return { snapshots, observed, celebrations };
}

/** Breaks from reconstruction and from observation, de-duplicated (observation lags by a day or two). */
function mergeBreaks(recon, observed) {
  const out = recon.map((b) => ({ ...b, source: 'history' }));
  for (const b of observed || []) {
    if (!out.some((r) => Math.abs(daysBetween(r.day, b.day)) <= 3)) out.push(b);
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

export function buildView(data, snapshots, observedList, now = Date.now()) {
  if (!data) return null;
  const ctx = timeCtx(data.user, now);
  const obs = new Map(observedList.map((o) => [o.taskId, o]));
  const snapsBy = new Map();
  for (const s of snapshots) {
    if (!snapsBy.has(s.taskId)) snapsBy.set(s.taskId, []);
    snapsBy.get(s.taskId).push(s);
  }
  const analysis = analyzeHistory(data.dailies, { lastCron: data.user?.lastCron, tzOffsetMin: ctx.tz, dayStart: ctx.ds });
  const timing = { tz: ctx.tz, dayStart: ctx.ds, cronStart: analysis.cronStart };
  const tasks = data.dailies.map((t) => {
    const o = obs.get(t.id);
    const days = mergeDays(o?.days || {}, snapsBy.get(t.id) || [], ctx.cronDay);
    const recon = reconstructStreaks(days);
    const best = Math.max(t.streak || 0, recon.best, o?.maxStreak || 0);
    return {
      ...t,
      days,
      best,
      breaks: mergeBreaks(recon.breaks, o?.breaks),
      completions: recon.completions,
      dueDays: recon.dueDays,
      rate: recon.dueDays ? recon.completions / recon.dueDays : null,
      usual: usualTime(t, timing),
    };
  });
  return { ctx, user: data.user, fetchedAt: data.fetchedAt, tasks, habits: data.habits || [] };
}

const DOW = [['su', 'Sun'], ['m', 'Mon'], ['t', 'Tue'], ['w', 'Wed'], ['th', 'Thu'], ['f', 'Fri'], ['s', 'Sat']];

export function describeSchedule(t) {
  const n = t.everyX || 1;
  if (t.frequency === 'daily') return n === 1 ? 'Every day' : `Every ${n} days`;
  if (t.frequency === 'weekly') {
    const days = DOW.filter(([k]) => t.repeat?.[k]).map(([, l]) => l);
    const which = days.length === 7 ? 'every day' : days.join(', ') || 'no days';
    return (n === 1 ? 'Weekly' : `Every ${n} weeks`) + ` · ${which}`;
  }
  if (t.frequency === 'monthly') {
    if (t.daysOfMonth?.length) return `${n === 1 ? 'Monthly' : `Every ${n} months`} · day ${t.daysOfMonth.join(', ')}`;
    return n === 1 ? 'Monthly' : `Every ${n} months`;
  }
  if (t.frequency === 'yearly') return n === 1 ? 'Yearly' : `Every ${n} years`;
  return '';
}

/** User-entered data: { cues: {taskId: text}, reasons: {taskId: {day: reason}}, targets: {habitId: n} }. */
export function mergePrefs(a = {}, b = {}) {
  const reasons = { ...(a.reasons || {}) };
  for (const [id, byDay] of Object.entries(b.reasons || {})) reasons[id] = { ...(reasons[id] || {}), ...byDay };
  return {
    cues: { ...(b.cues || {}), ...(a.cues || {}) },
    minis: { ...(b.minis || {}), ...(a.minis || {}) },
    focus: a.focus || b.focus || null,
    targets: { ...(b.targets || {}), ...(a.targets || {}) },
    reasons,
  };
}
