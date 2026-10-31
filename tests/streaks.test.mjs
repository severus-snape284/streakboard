import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../js/streaks.js';
import { ingest, buildView, mergeObserved, describeSchedule } from '../js/model.js';
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
