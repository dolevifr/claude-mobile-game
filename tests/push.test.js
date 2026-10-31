import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from '../js/push.js';
import { computeRemindAt } from '../js/dates.js';

// Monday, 2 November 2026, 14:00
const NOW = new Date(2026, 10, 2, 14, 0).getTime();

const task = (fields) => {
  const t = { id: 'x', title: 'משימה', done: false, due: null, time: null, remind: null, repeat: 'none', notifiedAt: null, ...fields };
  t.remindAt = t.remindAt ?? computeRemindAt(t);
  return t;
};

test('one-off reminders are sent with a body relative to when they arrive', () => {
  const items = buildSchedule([
    task({ id: 'a', title: 'להתקשר לאמא', due: '2026-11-02', time: '18:00', remind: 0 }),
    task({ id: 'b', title: 'טיסה', due: '2026-11-04', time: '07:00', remind: 1440 }),
  ], NOW);
  assert.deepEqual(items.map((i) => [i.id, i.title, i.body]), [
    ['a:2026-11-02', 'להתקשר לאמא', 'היום · 18:00'],
    ['b:2026-11-04', 'טיסה', 'מחר · 07:00'],
  ]);
  assert.equal(new Date(items[1].at).getDate(), 3);
});

test('done, past, already-shown and reminder-less tasks are left out', () => {
  const items = buildSchedule([
    task({ id: 'done', due: '2026-11-03', time: '10:00', remind: 0, done: true }),
    task({ id: 'past', due: '2026-11-02', time: '09:00', remind: 0 }),
    task({ id: 'shown', due: '2026-11-02', time: '18:00', remind: 0, notifiedAt: NOW - 1000 }),
    task({ id: 'none', due: '2026-11-03', time: '10:00' }),
  ], NOW);
  assert.deepEqual(items, []);
});

test('a snoozed reminder keeps its own time', () => {
  const items = buildSchedule([task({ id: 's', due: '2026-11-02', time: '13:50', remind: 0, remindAt: NOW + 10 * 60000 })], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].at, NOW + 10 * 60000);
});

test('repeating tasks schedule two weeks ahead, even when the current one is overdue', () => {
  const items = buildSchedule([task({ id: 'pill', title: 'תרופה', due: '2026-10-30', time: '09:00', remind: 0, repeat: 'daily' })], NOW);
  assert.equal(items[0].id, 'pill:2026-11-03');
  assert.equal(items.length, 14);
  assert.equal(items[0].body, 'היום · 09:00');
  const weekdays = buildSchedule([task({ id: 'w', due: '2026-11-02', time: '20:00', remind: 0, repeat: 'weekdays' })], NOW);
  assert.ok(weekdays.every((i) => new Date(i.at).getDay() <= 4), 'no Friday or Saturday');
  assert.equal(weekdays[0].id, 'w:2026-11-02');
});
