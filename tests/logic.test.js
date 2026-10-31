import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, nextOccurrence, advanceRepeat, computeRemindAt, relativeDay, hebrewDate, gematria } from '../js/dates.js';
import { buildICS, icsDuration, dueReminders, nextReminderAt, googleCalendarUrl } from '../js/reminders.js';
import { createTask, completeTask, getState, selectToday, selectUpcoming, dueCount } from '../js/store.js';

test('addMonths clamps to the end of shorter months', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});

test('weekday repeat skips Friday and Saturday', () => {
  assert.equal(nextOccurrence('2026-11-05', 'weekdays'), '2026-11-08'); // Thu -> Sun
  assert.equal(nextOccurrence('2026-11-08', 'weekdays'), '2026-11-09'); // Sun -> Mon
});

test('finishing an overdue repeating task lands after today', () => {
  assert.equal(advanceRepeat('2026-10-26', 'weekly', '2026-11-02'), '2026-11-09');
  assert.equal(advanceRepeat('2026-10-30', 'daily', '2026-11-02'), '2026-11-03');
  assert.equal(advanceRepeat('2026-11-09', 'weekly', '2026-11-02'), '2026-11-16');
});

test('reminder time uses 09:00 for tasks without a time', () => {
  const at = computeRemindAt({ due: '2026-11-03', time: null, remind: 0 });
  assert.equal(new Date(at).getHours(), 9);
  const before = computeRemindAt({ due: '2026-11-03', time: '18:00', remind: 30 });
  assert.equal(new Date(before).getHours(), 17);
  assert.equal(new Date(before).getMinutes(), 30);
  assert.equal(computeRemindAt({ due: null, remind: 0 }), null);
});

test('relative day labels', () => {
  const now = new Date(2026, 10, 2, 12);
  assert.equal(relativeDay('2026-11-02', now), 'היום');
  assert.equal(relativeDay('2026-11-03', now), 'מחר');
  assert.equal(relativeDay('2026-11-01', now), 'אתמול');
  assert.equal(relativeDay('2026-11-05', now), 'יום חמישי');
});

test('hebrew calendar date in Hebrew numerals', () => {
  assert.match(hebrewDate(new Date(2026, 9, 31)), /^כ׳ בחשו?ון תשפ״ז$/);
  assert.equal(gematria(15), 'ט״ו');
  assert.equal(gematria(16), 'ט״ז');
  assert.equal(gematria(1), 'א׳');
  assert.equal(gematria(30), 'ל׳');
  assert.equal(gematria(5790), 'תש״צ');
});

test('ics export has the event, repeat rule and alarm', () => {
  const ics = buildICS({
    id: 'a1', title: 'פגישה, חשובה', notes: 'שורה\nשנייה', due: '2026-11-03', time: '10:00',
    remind: 10, repeat: 'weekly', subtasks: [],
  }, new Date(Date.UTC(2026, 10, 2, 12)));
  assert.match(ics, /DTSTART:20261103T100000\r\n/);
  assert.match(ics, /DTEND:20261103T103000\r\n/);
  assert.match(ics, /SUMMARY:פגישה\\, חשובה/);
  assert.match(ics, /RRULE:FREQ=WEEKLY/);
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.ok(ics.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75));
});

test('all-day ics alarm is offset to 09:00', () => {
  const ics = buildICS({ id: 'b', title: 'x', notes: '', due: '2026-11-03', time: null, remind: 1440, repeat: 'none', subtasks: [] });
  assert.match(ics, /DTSTART;VALUE=DATE:20261103/);
  assert.match(ics, /TRIGGER:-PT15H/);
  assert.equal(icsDuration(0), 'PT0M');
  assert.equal(icsDuration(540), 'PT9H');
  assert.equal(icsDuration(-1440), '-P1D');
});

test('google calendar link', () => {
  const url = googleCalendarUrl({ title: 'ריצה', notes: '', due: '2026-11-03', time: null, repeat: 'daily' });
  assert.match(url, /dates=20261103%2F20261104/);
  assert.match(url, /recur=RRULE%3AFREQ%3DDAILY/);
});

test('due and next reminders', () => {
  const tasks = [
    { id: 1, done: false, remindAt: 100, notifiedAt: null },
    { id: 2, done: false, remindAt: 100, notifiedAt: 101 },
    { id: 3, done: true, remindAt: 50, notifiedAt: null },
    { id: 4, done: false, remindAt: 500, notifiedAt: null },
  ];
  assert.deepEqual(dueReminders(tasks, 200).map((t) => t.id), [1]);
  assert.equal(nextReminderAt(tasks, 200), 500);
});

test('completing a repeating task moves it forward and counts as done today', () => {
  const now = new Date(2026, 10, 2, 12);
  const t = createTask({ title: 'ריצה', due: '2026-11-02', repeat: 'daily', remind: 0 });
  const res = completeTask(t.id, now);
  assert.equal(res.rolled, true);
  assert.equal(res.task.due, '2026-11-03');
  assert.equal(res.task.done, false);
  const today = selectToday(getState().tasks, '2026-11-02');
  assert.equal(today.completedCount, 1);
  assert.equal(selectUpcoming(getState().tasks, '2026-11-02')[0].iso, '2026-11-03');
  assert.equal(dueCount(getState().tasks, '2026-11-02'), 0);
});
