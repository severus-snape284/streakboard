// Pure streak logic — no DOM, no storage. Runs in the browser and in Node tests.

export const MILESTONES = [7, 21, 30, 66, 100, 365];
const DAY_MS = 86400000;

/**
 * Habitica "day" key (YYYY-MM-DD) for a timestamp, using Habitica's own timezone
 * convention (timezoneOffset = minutes *behind* UTC, like Date#getTimezoneOffset)
 * and the user's custom day start hour.
 */
export function dayKey(ts, tzOffsetMin = 0, dayStart = 0) {
  const shifted = new Date(Number(ts) - tzOffsetMin * 60000 - dayStart * 3600000);
  return shifted.toISOString().slice(0, 10);
}

export function addDays(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/** True when Habitica's cron hasn't run yet for the current Habitica day. */
export function isCronStale(lastCron, now, tzOffsetMin, dayStart) {
  if (!lastCron) return false;
  return dayKey(Date.parse(lastCron), tzOffsetMin, dayStart) < dayKey(now, tzOffsetMin, dayStart);
}

/**
 * How Habitica writes daily history (verified against real data):
 *  - Every check-off writes an entry with completed:true at the time of the check-off.
 *  - Cron writes an entry (completed:false, isDue for the day being closed) only for
 *    dailies that were NOT completed. Completed dailies get no cron entry.
 *  - Any activity triggers cron, so a cron entry closes the previous *active* day
 *    (usually yesterday; earlier if the app wasn't opened for a while).
 *  - Check-offs made before that day's cron (the "record yesterday's activity"
 *    prompt) belong to the previous active day.
 *
 * analyzeHistory gathers the cross-daily facts: the first cron time per day and
 * the set of days with any activity.
 */
export function analyzeHistory(dailies, { lastCron, tzOffsetMin = 0, dayStart = 0 } = {}) {
  const cronStart = {};
  const active = new Set();
  const note = (ts, isCron) => {
    const k = dayKey(ts, tzOffsetMin, dayStart);
    active.add(k);
    if (isCron && (!cronStart[k] || ts < cronStart[k])) cronStart[k] = ts;
  };
  for (const t of dailies) for (const h of t.history || []) note(Number(h.date), !h.completed);
  if (lastCron) note(Date.parse(lastCron), true);
  return { cronStart, activeDays: [...active].sort(), tzOffsetMin, dayStart };
}

function prevActive(activeDays, k) {
  let lo = 0, hi = activeDays.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (activeDays[mid] < k) { ans = activeDays[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Convert one daily's history into per-day statuses: 'done' | 'missed' | 'notdue'. */
export function historyToDays(task, { cronStart, activeDays, tzOffsetMin = 0, dayStart = 0 }) {
  const days = {};
  const set = (key, status) => {
    const prev = days[key];
    // done beats missed beats notdue
    if (!prev || status === 'done' || (status === 'missed' && prev === 'notdue')) days[key] = status;
  };
  const hist = [...(task.history || [])].sort((a, b) => a.date - b.date);
  for (const h of hist) {
    if (h.completed === undefined && h.isDue === undefined) continue; // compressed old entry
    const ts = Number(h.date);
    const k = dayKey(ts, tzOffsetMin, dayStart);
    const prev = prevActive(activeDays, k) || addDays(k, -1);
    if (h.completed) {
      set(cronStart[k] && ts < cronStart[k] ? prev : k, 'done');
    } else {
      // If the previous active day is already done, a silent active day (no entries
      // at all) must have happened in between — fall back to yesterday.
      const closed = h.isDue && days[prev] === 'done' ? addDays(k, -1) : prev;
      set(closed, h.isDue ? 'missed' : 'notdue');
    }
  }
  return days;
}

/**
 * Merge Habitica-derived days with locally observed snapshot days.
 * Local snapshots are { day, completed, isDue } as seen at fetch time; a day
 * observed as due-but-incomplete is only a miss once it's in the past.
 */
export function mergeDays(historyDays, snapshots, today) {
  const days = { ...historyDays };
  for (const s of snapshots) {
    const status = s.completed ? 'done' : s.isDue ? (s.day < today ? 'missed' : 'due') : 'notdue';
    const prev = days[s.day];
    if (!prev || status === 'done' || (prev === 'notdue' && status !== 'notdue')) days[s.day] = status;
  }
  return days;
}

/**
 * Walk days chronologically, Habitica-style: done → +1, missed → reset, others neutral.
 * Returns the longest run and recorded breaks.
 */
export function reconstructStreaks(days) {
  const keys = Object.keys(days).sort();
  let cur = 0, best = 0, bestEnd = null, completions = 0, due = 0;
  const breaks = [];
  for (const k of keys) {
    const s = days[k];
    if (s === 'done') {
      cur++; completions++; due++;
      if (cur > best) { best = cur; bestEnd = k; }
    } else if (s === 'missed') {
      due++;
      if (cur > 0) breaks.push({ day: k, lost: cur });
      cur = 0;
    }
  }
  return { best, bestEnd, current: cur, breaks, completions, dueDays: due };
}

export function milestoneFor(streak) {
  let m = 0;
  for (const x of MILESTONES) if (streak >= x) m = x;
  return m;
}

export function nextMilestone(streak) {
  return MILESTONES.find((x) => x > streak) || null;
}

export function atRisk(task) {
  return task.isDue && !task.completed && task.streak >= 3;
}

export function statusOf(task) {
  if (task.completed) return 'done';
  return task.isDue ? 'due' : 'notdue';
}

export function sortTasks(tasks, mode) {
  const arr = [...tasks];
  const byName = (a, b) => a.text.localeCompare(b.text);
  if (mode === 'name') return arr.sort(byName);
  if (mode === 'due') {
    const rank = (t) => (t.isDue && !t.completed ? 0 : t.completed ? 1 : 2);
    return arr.sort((a, b) => rank(a) - rank(b) || b.streak - a.streak || byName(a, b));
  }
  return arr.sort((a, b) => b.streak - a.streak || byName(a, b));
}

export function heroStats(tasks) {
  let top = null;
  for (const t of tasks) if (!top || t.streak > top.streak) top = t;
  return {
    top: top && top.streak > 0 ? top : null,
    active: tasks.filter((t) => t.streak > 0).length,
    dueLeft: tasks.filter((t) => t.isDue && !t.completed).length,
  };
}
