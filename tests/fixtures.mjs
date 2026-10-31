// Synthetic Habitica data generator: simulates cron entries + check-off entries
// so tests never need real account data.
const DAY = 86400000;
export const TZ = -330; // UTC+5:30, Habitica convention
export const DAY_START = 5;

// Local wall-clock time on a given YYYY-MM-DD -> UTC ms.
const at = (key, h, m = 0) => Date.parse(key + 'T00:00:00Z') + (h * 60 + m) * 60000 + TZ * 60000;
const add = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

/**
 * Mirrors Habitica: check-offs write completed:true entries; cron writes a
 * completed:false entry only for dailies that weren't completed.
 * pattern: one char per day ending *yesterday*: 'x' done, 'y' done late via the
 * "record yesterday's activity" prompt (written next day before cron), '.' due & missed, '-' not due.
 * todayState: 'done' | 'due' | 'notdue'. skipCron: day indices the app wasn't opened.
 */
export function makeDaily(id, text, pattern, todayState, today, skipCron = new Set(), restDays = new Set()) {
  const n = pattern.length;
  const start = add(today, -n);
  const history = [];
  let streak = 0;
  let value = 0; // check-offs raise it, penalised misses lower it (as in Habitica)
  let pendingDone = false, pendingDue = false, missedSince = false;
  for (let i = 0; i <= n; i++) {
    const day = add(start, i);
    // Cron at 09:00 local closes the previous day (unless the app wasn't opened).
    if (i > 0 && !skipCron.has(i)) {
      if (pattern[i - 1] === 'y') {
        value += 1;
        history.push({ date: at(day, 8, 59), value, isDue: true, completed: true });
        pendingDone = true; streak++;
      }
      const resting = restDays.has(i - 1);
      if (!pendingDone && missedSince && !resting) value -= 1;
      if (!pendingDone) history.push({ date: at(day, 9, 0) + id.length * 7, value, isDue: pendingDue, completed: false });
      if (!pendingDone && missedSince && !resting) streak = 0;
      pendingDone = false; missedSince = false;
    }
    if (i === n) break;
    const c = pattern[i];
    pendingDue = c !== '-';
    if (c === 'x') {
      pendingDone = true; streak++; value += 1;
      history.push({ date: at(day, 20, id.charCodeAt(0) % 50), value, isDue: true, completed: true });
    } else if (c === '.') missedSince = true;
  }
  const completed = todayState === 'done';
  if (completed) { streak++; history.push({ date: at(today, 21, 0), value: value + 1, isDue: true, completed: true }); }
  return {
    id, _id: id, text, type: 'daily', notes: '', streak, completed, isDue: todayState !== 'notdue',
    frequency: 'daily', everyX: 1, repeat: { m: true, t: true, w: true, th: true, f: true, s: true, su: true },
    daysOfMonth: [], weeksOfMonth: [], startDate: new Date(at(start, 0)).toISOString(), checklist: [], history,
    nextDue: [], createdAt: new Date(at(start, 0)).toISOString(),
  };
}

export function scenario(today = '2026-10-31') {
  const dailies = [
    makeDaily('aaaa-1', 'Read 20 pages', 'x'.repeat(10) + '.' + 'x'.repeat(25), 'done', today),
    makeDaily('bbbb-2', 'Stretch', 'xxxx.xxx', 'due', today),
    makeDaily('cccc-3', 'Meditate', 'xxxxxxx..x', 'due', today),
    makeDaily('dddd-4', 'Bike clean', 'x------x------x------', 'notdue', today),
    makeDaily('eeee-5', 'Journal <b>tag</b>', '....', 'due', today),
    makeDaily('ffff-6', 'Floss', 'xxxxxx', 'due', today),
  ];
  dailies[1].checklist = [{ id: 'cl-1', text: 'Hamstrings', completed: true }, { id: 'cl-2', text: 'Hips', completed: false }];
  const habit = (id, text, frequency, upDays) => ({
    id, _id: id, type: 'habit', text, notes: '', up: true, down: false, frequency, value: 1,
    counterUp: 0, counterDown: 0,
    history: upDays.map((n) => ({ date: at(add(today, -n), 18), value: 1, scoredUp: 1, scoredDown: 0 })),
  });
  const habits = [
    habit('h-1', 'Drink water', 'daily', [1, 2, 3, 4]),
    habit('h-2', 'Gym', 'weekly', [0, 7, 14]),
    { ...habit('h-3', 'Junk food', 'daily', []), up: false, down: true },
  ];
  habits[1].counterUp = 1;
  const user = {
    id: 'test-user', lastCron: new Date(at(today, 9)).toISOString(),
    preferences: { dayStart: DAY_START, timezoneOffset: TZ }, profile: { name: 'Tester' },
  };
  return { user, dailies, habits };
}
