import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from '../js/parse.js';

// Monday, 2 November 2026, 14:00
const NOW = new Date(2026, 10, 2, 14, 0);
const parse = (s) => parseQuickAdd(s, NOW);

test('date, time and importance in one sentence', () => {
  assert.deepEqual(parse('להתקשר לאמא מחר ב-18:00 !'), {
    title: 'להתקשר לאמא', due: '2026-11-03', time: '18:00', important: true,
  });
});

test('weekday, hour with part of day and list tag', () => {
  const r = parse('פגישה ביום חמישי בשעה 9 בבוקר #עבודה');
  assert.equal(r.title, 'פגישה');
  assert.equal(r.due, '2026-11-05');
  assert.equal(r.time, '09:00');
  assert.equal(r.listName, 'עבודה');
});

test('relative minutes set a reminder', () => {
  assert.deepEqual(parse('להוציא כביסה בעוד 20 דקות'), {
    title: 'להוציא כביסה', due: '2026-11-02', time: '14:20', remind: 0,
  });
  assert.equal(parse('לבדוק את התנור בעוד חצי שעה').time, '14:30');
  assert.equal(parse('לחזור ללקוח בעוד שעתיים').time, '16:00');
});

test('relative days and weeks', () => {
  assert.equal(parse('לשלוח דוח בעוד 3 ימים').due, '2026-11-05');
  assert.equal(parse('ביקורת בעוד שבועיים').due, '2026-11-16');
});

test('weekly repeat on a weekday in the evening', () => {
  assert.deepEqual(parse('חוג ספורט כל יום ראשון בערב'), {
    title: 'חוג ספורט', repeat: 'weekly', due: '2026-11-08', time: '19:00',
  });
});

test('remind-me phrasing and afternoon hour heuristic', () => {
  assert.deepEqual(parse('תזכיר לי לקנות חלב היום ב-5'), {
    title: 'לקנות חלב', remind: 0, due: '2026-11-02', time: '17:00',
  });
});

test('explicit day/month rolls to next year when already past', () => {
  assert.equal(parse('יום הולדת לדני ב-12/3').due, '2027-03-12');
  assert.equal(parse('יום הולדת לדני ב-12/3').title, 'יום הולדת לדני');
  assert.equal(parse('תור לרופא ב-20.11').due, '2026-11-20');
});

test('numbers and words that are not dates stay in the title', () => {
  assert.deepEqual(parse('לקנות 1.5 ליטר חלב'), { title: 'לקנות 1.5 ליטר חלב' });
  assert.deepEqual(parse('ארוחת ערב עם חברים מחרתיים'), { title: 'ארוחת ערב עם חברים', due: '2026-11-04' });
  assert.deepEqual(parse('להיום יש מספיק'), { title: 'להיום יש מספיק' });
});

test('a time that already passed today moves to tomorrow', () => {
  assert.equal(parse('ריצה ב-07:30').due, '2026-11-03');
  assert.equal(parse('ריצה ב-20:30').due, '2026-11-02');
});

test('daily repeats start at the next matching time', () => {
  // 09:00 already passed at 14:00, so the first one is tomorrow.
  assert.deepEqual(parse('לקחת ויטמינים כל בוקר'), {
    title: 'לקחת ויטמינים', repeat: 'daily', due: '2026-11-03', time: '09:00',
  });
  assert.equal(parse('להשקות עציצים כל יום').due, '2026-11-02');
  assert.equal(parse('דיילי צוות בימי חול ב-9:30').repeat, 'weekdays');
});

test('invalid times are ignored', () => {
  const r = parse('משהו ב-25:00');
  assert.equal(r.time, undefined);
  assert.equal(r.title, 'משהו ב-25:00');
});

test('plain text passes through', () => {
  assert.deepEqual(parse('  לסדר את הארון  '), { title: 'לסדר את הארון' });
});
