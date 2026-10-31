import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../js/streaks.js';
import { ingest, buildView, mergeObserved, describeSchedule } from '../js/model.js';
import * as I from '../js/insights.js';
import { scenario, makeDaily, TZ, DAY_START } from './fixtures.mjs';

const NOW = Date.parse('2026-10-31T16:00:00Z'); // 21:30 local

test('dayKey respects timezone and dayStart', () => {
  // 2026-10-31 03:00 local (UTC+5:30) is before a 5am day start → previous day.
  assert.equal(s.dayKey(Date.parse('2026-10-30T21:30:00Z'), TZ, DAY_START), '2026-10-30');
  assert.equal(s.dayKey(Date.parse('2026-10-31T00:00:00Z'), TZ, DAY_START), '2026-10-31');
});

test('cron staleness', () => {
  assert.equal(s.isCronStale('2026-10-31T03:30:00Z', NOW, TZ, DAY_START), false);
  assert.equal(s.isCronStale('2026-10-30T03:30:00Z', NOW, TZ, DAY_START), true);
});

test('reconstructed current streak matches Habitica streak', () => {
  const { user, dailies } = scenario();
  const { observed, snapshots } = ingest(user, dailies, [], NOW);
  const v = buildView({ user, dailies, fetchedAt: NOW }, snapshots, observed, NOW);
  for (const t of v.tasks) {
    const r = s.reconstructStreaks(t.days);
    assert.equal(r.current, t.streak, `${t.text}: reconstructed ${r.current} vs actual ${t.streak}`);
  }
  const read = v.tasks.find((t) => t.text === 'Read 20 pages');
  assert.equal(read.streak, 26);
  assert.equal(read.best, 26);
  const med = v.tasks.find((t) => t.text === 'Meditate');
  assert.equal(med.best, 7);
  assert.equal(med.breaks.length, 1);
  assert.equal(med.breaks[0].lost, 7);
  const bike = v.tasks.find((t) => t.text === 'Bike clean');
  assert.equal(bike.best, 3);
  assert.equal(bike.days['2026-10-30'], 'notdue');
});

test("late check-offs (before cron) count for the previous day", () => {
  const t = makeDaily('x', 'Late', 'xxyx', 'due', '2026-10-31');
  const other = makeDaily('y', 'Other', '....', 'due', '2026-10-31');
  const a = s.analyzeHistory([t, other], { tzOffsetMin: TZ, dayStart: DAY_START });
  const days = s.historyToDays(t, a);
  assert.equal(t.streak, 4);
  assert.equal(days['2026-10-29'], 'done');
  assert.equal(s.reconstructStreaks(days).current, 4);
});

test('works with a single daily', () => {
  const t = makeDaily('x', 'Solo', 'xx.xxx', 'done', '2026-10-31');
  const a = s.analyzeHistory([t], { tzOffsetMin: TZ, dayStart: DAY_START });
  const r = s.reconstructStreaks(s.mergeDays(s.historyToDays(t, a), [{ day: '2026-10-31', completed: true, isDue: true }], '2026-10-31'));
  assert.equal(r.current, 4);
  assert.equal(r.best, 4);
});

test('multi-day app absence follows Habitica cron semantics', () => {
  const run = (pattern) => {
    const t = makeDaily('x', 'Gap', pattern, 'due', '2026-10-31', new Set([3, 4]));
    const other = makeDaily('y', 'Other', '-------', 'notdue', '2026-10-31', new Set([3, 4]));
    const a = s.analyzeHistory([t, other], { tzOffsetMin: TZ, dayStart: DAY_START });
    const days = s.historyToDays(t, a);
    return { habitica: t.streak, recon: s.reconstructStreaks(days).current };
  };
  // Done on the last active day before the absence: Habitica keeps the streak.
  let r = run('xxx..xx');
  assert.equal(r.habitica, 5);
  assert.equal(r.recon, 5);
  // Missed on the last active day: streak resets.
  r = run('xx...xx');
  assert.equal(r.habitica, 2);
  assert.equal(r.recon, 2);
});

test('observed breaks and max streak across fetches', () => {
  const { user, dailies } = scenario();
  let { observed } = ingest(user, dailies, [], NOW);
  const later = structuredClone(dailies);
  later.find((d) => d.text === 'Stretch').streak = 0;
  const user2 = { ...user, lastCron: '2026-11-01T04:00:00Z' };
  ({ observed } = ingest(user2, later, observed, NOW + 86400000));
  const o = observed.find((x) => x.taskId === 'bbbb-2');
  assert.equal(o.breaks.length, 1);
  assert.equal(o.breaks[0].lost, 3);
  assert.equal(o.maxStreak, 3);
});

test('mergeObserved unions days and breaks', () => {
  const a = { taskId: 't', maxStreak: 5, breaks: [{ day: '2026-10-01', lost: 5 }], days: { '2026-10-01': 'missed' } };
  const b = { taskId: 't', maxStreak: 9, maxDay: '2026-09-01', breaks: [{ day: '2026-09-20', lost: 9 }], days: { '2026-10-01': 'done', '2026-10-02': 'done' } };
  const m = mergeObserved(a, b);
  assert.equal(m.maxStreak, 9);
  assert.equal(m.breaks.length, 2);
  assert.deepEqual(m.days, { '2026-10-01': 'done', '2026-10-02': 'done' });
});

test('sorting, hero, risk, milestones', () => {
  const tasks = [
    { text: 'B', streak: 3, isDue: true, completed: false },
    { text: 'A', streak: 10, isDue: false, completed: false },
    { text: 'C', streak: 0, isDue: true, completed: true },
  ];
  assert.deepEqual(s.sortTasks(tasks, 'streak').map((t) => t.text), ['A', 'B', 'C']);
  assert.deepEqual(s.sortTasks(tasks, 'name').map((t) => t.text), ['A', 'B', 'C']);
  assert.deepEqual(s.sortTasks(tasks, 'due').map((t) => t.text), ['B', 'C', 'A']);
  assert.deepEqual(s.heroStats(tasks), { top: tasks[1], active: 2, dueLeft: 1 });
  assert.equal(s.atRisk(tasks[0]), true);
  assert.equal(s.milestoneFor(6), 0);
  assert.equal(s.milestoneFor(30), 30);
  assert.equal(s.nextMilestone(30), 66);
  assert.equal(s.nextMilestone(400), null);
});

test('schedule description', () => {
  assert.equal(describeSchedule({ frequency: 'daily', everyX: 3 }), 'Every 3 days');
  assert.equal(describeSchedule({ frequency: 'weekly', everyX: 1, repeat: { su: true } }), 'Weekly · Sun');
});

test('insights: never miss twice, perfect days, period stats, weekdays', () => {
  const today = '2026-10-31';
  const t1 = { id: 'a', isDue: true, completed: false, days: { '2026-10-28': 'done', '2026-10-29': 'missed', '2026-10-30': 'notdue', '2026-10-31': 'due' } };
  const t2 = { id: 'b', isDue: true, completed: true, days: { '2026-10-28': 'done', '2026-10-29': 'done', '2026-10-30': 'done', '2026-10-31': 'done' } };
  assert.equal(I.missedLastTime(t1, today), true);
  assert.equal(I.missedLastTime(t2, today), false);
  const roll = I.dayRollup([t1, t2], today);
  assert.equal(roll['2026-10-29'].perfect, false);
  assert.equal(roll['2026-10-30'].perfect, true);
  assert.equal(roll['2026-10-31'].perfect, false); // t1 still open today
  assert.deepEqual(I.perfectStreak(roll, today), { current: 1, best: 1 });
  const p = I.periodStats([t1, t2], today, 7);
  assert.equal(p.done, 5);
  assert.equal(p.due, 6);
  const wd = I.weekdayStats([t1.days, t2.days]);
  assert.equal(wd[I.weekdayIndex('2026-10-29')].due, 2);
  assert.equal(I.weakestWeekday(wd).i, I.weekdayIndex('2026-10-29'));
});

test('insights: rollover time and milestones crossed', () => {
  // dayStart 5 in UTC+5:30 → next rollover 2026-11-01 05:00 local = 2026-10-31T23:30Z
  assert.equal(new Date(I.nextRollover('2026-10-31', TZ, DAY_START)).toISOString(), '2026-10-31T23:30:00.000Z');
  assert.deepEqual(I.crossedMilestones(6, 7), [7]);
  assert.deepEqual(I.crossedMilestones(7, 8), []);
  assert.deepEqual(I.crossedMilestones(0, 30), [7, 21, 30]);
  assert.equal(I.fmtDuration(3 * 3600000 + 5 * 60000), '3h 5m');
});

test('habit streaks by reset period', () => {
  const { habits } = scenario('2026-10-31');
  const water = I.habitStats(habits[0], TZ, DAY_START, '2026-10-31');
  assert.equal(water.thisPeriod, 0);
  assert.equal(water.streak, 4); // yesterday back 4 days; today not yet
  const gym = I.habitStats(habits[1], TZ, DAY_START, '2026-10-31');
  assert.equal(gym.unit, 'week');
  assert.equal(gym.thisPeriod, 1);
  assert.equal(gym.streak, 3);
});

test('unticking today is not remembered from history', () => {
  const { user, dailies } = scenario();
  let { observed, snapshots } = ingest(user, dailies, [], NOW);
  const t = structuredClone(dailies);
  const read = t.find((d) => d.text === 'Read 20 pages');
  read.history.pop(); read.completed = false; read.streak -= 1; // Habitica deletes the entry on untick
  ({ observed, snapshots } = ingest(user, t, observed, NOW + 60000));
  const v = buildView({ user, dailies: t, fetchedAt: NOW }, snapshots, observed, NOW + 60000);
  assert.equal(v.tasks.find((x) => x.text === 'Read 20 pages').days['2026-10-31'], 'due');
});

test('usual time of day from check-offs, excluding late ticks', () => {
  const at = (iso) => ({ date: Date.parse(iso), completed: true, isDue: true });
  const t = { history: [at('2026-10-27T14:30:00Z'), at('2026-10-28T14:45:00Z'), at('2026-10-29T15:00:00Z'), at('2026-10-31T03:20:00Z')] };
  // Last entry is a late tick at 08:50 local, made before the 2026-10-31 cron at 03:30Z.
  const cronStart = { '2026-10-31': Date.parse('2026-10-31T03:30:00Z') };
  const u = I.usualTime(t, { tz: TZ, dayStart: DAY_START, cronStart });
  assert.equal(I.fmtClock(u, DAY_START), '8:15 PM');
  assert.equal(I.usualTime({ history: t.history.slice(0, 2) }, { tz: TZ, dayStart: DAY_START }), null);
  assert.equal(I.pastUsualTime({ usual: u, isDue: true, completed: false }, u + 61), true);
  assert.equal(I.pastUsualTime({ usual: u, isDue: true, completed: true }, u + 61), false);
});

test('milestone forecast uses nextDue and extrapolates simple schedules', () => {
  const daily = { streak: 5, isDue: true, completed: false, frequency: 'daily', everyX: 1, nextDue: ['2026-10-31T18:30:00.000Z'] };
  assert.equal(I.milestoneForecast(daily, 7, '2026-10-31', TZ), '2026-11-01'); // today + Nov 1
  assert.equal(I.milestoneForecast({ ...daily, completed: true, streak: 6 }, 7, '2026-10-31', TZ), '2026-11-01');
  assert.equal(I.milestoneForecast(daily, 21, '2026-10-31', TZ), '2026-11-15');
  const weekly = { streak: 5, isDue: false, completed: false, frequency: 'weekly', nextDue: ['2026-11-07T18:30:00.000Z', '2026-11-14T18:30:00.000Z'] };
  assert.equal(I.milestoneForecast(weekly, 7, '2026-10-31', TZ), '2026-11-15');
  assert.equal(I.milestoneForecast(weekly, 21, '2026-10-31', TZ), null);
});

test('habit goals change what counts toward the streak', () => {
  const { habits } = scenario('2026-10-31');
  const gym = habits[1]; // one + in each of the last 3 weeks
  assert.equal(I.habitStats(gym, TZ, DAY_START, '2026-10-31', 1).streak, 3);
  assert.equal(I.habitStats(gym, TZ, DAY_START, '2026-10-31', 2).streak, 0);
});

test('miss reasons: unexplained misses and stats; prefs merge', async () => {
  const t = { days: { '2026-10-25': 'missed', '2026-10-28': 'missed', '2026-10-30': 'done', '2026-10-10': 'missed' } };
  assert.deepEqual(I.unexplainedMisses(t, { '2026-10-25': 'Tired' }, '2026-10-31'), ['2026-10-28']);
  const stats = I.reasonStats({ a: { '2026-10-25': 'Tired', '2026-10-28': 'Forgot' }, b: { '2026-10-29': 'Forgot', '2026-09-01': 'Sick' } }, '2026-10-01');
  assert.deepEqual(stats, [{ reason: 'Forgot', n: 2 }, { reason: 'Tired', n: 1 }]);
  const { mergePrefs } = await import('../js/model.js');
  const m = mergePrefs({ cues: { a: 'mine' }, reasons: { a: { d1: 'Tired' } } }, { cues: { a: 'theirs', b: 'x' }, reasons: { a: { d2: 'Sick' } }, targets: { h: 3 } });
  assert.deepEqual(m, { cues: { a: 'mine', b: 'x' }, minis: {}, focus: null, targets: { h: 3 }, reasons: { a: { d1: 'Tired', d2: 'Sick' } } });
});

test('weekly review: wins, slips with reasons, suggestion; focus progress', () => {
  const today = '2026-10-31';
  const a = { id: 'a', text: 'A', streak: 9, days: { '2026-10-25': 'done', '2026-10-30': 'done' } };
  const b = { id: 'b', text: 'B', streak: 0, days: { '2026-10-26': 'missed', '2026-10-27': 'done', '2026-10-29': 'missed', '2026-10-31': 'due' } };
  const c = { id: 'c', text: 'C', streak: 1, days: { '2026-10-28': 'missed', '2026-10-29': 'done', '2026-10-30': 'done' } };
  const r = I.weeklyReview([a, b, c], { b: { '2026-10-26': 'Tired', '2026-10-01': 'Old' } }, today);
  assert.deepEqual(r.wins.map((x) => x.task.id), ['a']);
  assert.deepEqual(r.slips.map((x) => x.task.id), ['b', 'c']);
  assert.deepEqual(r.slips[0].why, ['Tired']);
  assert.equal(r.suggestion.id, 'b');
  assert.equal(r.from, '2026-10-24');
  assert.deepEqual(I.focusProgress(b, '2026-10-27', today), { done: 1, missed: 1, due: 2, rate: 0.5 });
  assert.equal(I.focusExpired({ taskId: 'b', since: '2026-10-24' }, today), true);
  assert.equal(I.focusExpired({ taskId: 'b', since: '2026-10-25' }, today), false);
  assert.equal(I.focusExpired(null, today), true);
});
