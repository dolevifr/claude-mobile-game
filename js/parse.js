// Quick add: pulls a date, time, repeat, list and importance out of a single Hebrew sentence.
// "להתקשר לאמא מחר ב-18:00 !" -> { title: 'להתקשר לאמא', due: <tomorrow>, time: '18:00', important: true }

import { WEEKDAYS, pad2, todayISO, addDays, addMonths, toISODate, fromISODate, toTimestamp, timeFromDate } from './dates.js';

// JS \b does not work with Hebrew letters, so words are delimited by whitespace and punctuation.
const WORD_START = '(?:^|\\s)';
const WORD_END = '(?=$|[\\s,.!?])';
const WEEKDAY_ALT = WEEKDAYS.join('|');

const PARTS_OF_DAY = [
  ['בבוקר', 9],
  ['בצהריים|בצהרים', 12],
  ['אחה["״]צ|אחר הצהריים', 16],
  ['בערב', 19],
  ['בלילה', 21],
];

const RELATIVE_UNITS = {
  'דקה': ['min', 1], 'דקות': ['min', 1],
  'חצי שעה': ['min', 30, true], 'שעה': ['min', 60], 'שעות': ['min', 60], 'שעתיים': ['min', 120, true],
  'יום': ['day', 1], 'ימים': ['day', 1], 'יומיים': ['day', 2, true],
  'שבוע': ['day', 7], 'שבועות': ['day', 7], 'שבועיים': ['day', 14, true],
  'חודש': ['month', 1], 'חודשים': ['month', 1],
};

function grab(state, pattern) {
  const m = state.text.match(new RegExp(WORD_START + pattern + WORD_END));
  if (!m) return null;
  state.text = `${state.text.slice(0, m.index)} ${state.text.slice(m.index + m[0].length)}`;
  return m;
}

function upcomingWeekday(today, dow, allowToday) {
  let diff = (dow - fromISODate(today).getDay() + 7) % 7;
  if (diff === 0 && !allowToday) diff = 7;
  return addDays(today, diff);
}

function explicitDate(today, day, month, year) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const thisYear = fromISODate(today).getFullYear();
  let y = year ? (year < 100 ? 2000 + year : year) : thisYear;
  let d = new Date(y, month - 1, day);
  if (d.getMonth() !== month - 1) return null;
  if (!year && toISODate(d) < today) d = new Date(y + 1, month - 1, day);
  return toISODate(d);
}

export function parseQuickAdd(input, now = new Date()) {
  const today = todayISO(now);
  const state = { text: String(input) };
  const out = {};
  let partHour = null;
  let m;

  if (grab(state, '(?:תזכיר(?:י)? לי|להזכיר לי|תזכורת:?)')) out.remind = 0;

  if (grab(state, '(?:!חשוב|!+|דחוף)')) out.important = true;
  else if (/!+\s*$/.test(state.text)) {
    state.text = state.text.replace(/!+\s*$/, ' ');
    out.important = true;
  }

  if ((m = grab(state, '#([^\\s#]+)'))) out.listName = m[1];

  // Repeats. "כל יום ראשון" has to be tried before "כל יום".
  if ((m = grab(state, `כל (?:יום )?(${WEEKDAY_ALT})`))) {
    out.repeat = 'weekly';
    out.due = upcomingWeekday(today, WEEKDAYS.indexOf(m[1]), true);
  } else if (grab(state, '(?:בימי חול|כל יום חול)')) {
    out.repeat = 'weekdays';
  } else if ((m = grab(state, 'כל (יום|בוקר|ערב|לילה)'))) {
    out.repeat = 'daily';
    partHour = { 'בוקר': 9, 'ערב': 19, 'לילה': 21 }[m[1]] ?? null;
  } else if (grab(state, 'כל שבוע')) out.repeat = 'weekly';
  else if (grab(state, 'כל חודש')) out.repeat = 'monthly';
  else if (grab(state, 'כל שנה')) out.repeat = 'yearly';

  // "בעוד 20 דקות", "בעוד שעתיים", "בעוד 3 ימים"
  const units = Object.keys(RELATIVE_UNITS).sort((a, b) => b.length - a.length).join('|');
  if (!out.due && (m = grab(state, `בעוד (?:(\\d+) )?(${units})`))) {
    const [kind, size, fixed] = RELATIVE_UNITS[m[2]];
    const amount = fixed ? size : (m[1] ? Number(m[1]) : 1) * size;
    if (kind === 'min') {
      const at = new Date(Math.ceil((now.getTime() + amount * 60000) / 60000) * 60000);
      out.due = toISODate(at);
      out.time = timeFromDate(at);
      if (out.remind == null) out.remind = 0;
    } else if (kind === 'day') {
      out.due = addDays(today, amount);
    } else {
      out.due = addMonths(today, amount);
    }
  }

  if (!out.due) {
    if (grab(state, 'מחרתיים')) out.due = addDays(today, 2);
    else if (grab(state, 'ו?מחר')) out.due = addDays(today, 1);
    else if (grab(state, 'היום')) out.due = today;
    else if (grab(state, 'הערב')) { out.due = today; partHour = 19; }
    else if ((m = grab(state, `ב?יום (${WEEKDAY_ALT})(?: הבא)?`))) out.due = upcomingWeekday(today, WEEKDAYS.indexOf(m[1]), false);
    else if ((m = grab(state, `ב?(${WEEKDAY_ALT}) הבא`))) out.due = upcomingWeekday(today, WEEKDAYS.indexOf(m[1]), false);
    else if (grab(state, 'בשבת')) out.due = upcomingWeekday(today, 6, false);
    else if (grab(state, 'ב?שבוע הבא')) out.due = upcomingWeekday(today, 0, false);
    else {
      const before = state.text;
      m = grab(state, '(?:ב-?)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?')
        || grab(state, 'ב-?(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?');
      if (m) {
        const date = explicitDate(today, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
        if (date) out.due = date;
        else state.text = before;
      }
    }
  }

  if (!out.time) {
    const before = state.text;
    let hour = null;
    let minute = 0;
    let hourOnly = false;
    if ((m = grab(state, '(?:בשעה ?|ב-?)?(\\d{1,2}):(\\d{2})'))) {
      hour = Number(m[1]);
      minute = Number(m[2]);
    } else if ((m = grab(state, '(?:בשעה ?|ב-|ב)(\\d{1,2})'))) {
      hour = Number(m[1]);
      hourOnly = true;
    }
    for (const [pattern, h] of PARTS_OF_DAY) {
      if (grab(state, `(?:${pattern})`)) { partHour = h; break; }
    }
    if (hour != null) {
      if (partHour != null && partHour >= 12 && hour < 12 && !(partHour === 21 && hour <= 4)) hour += 12;
      else if (partHour == null && hourOnly && hour >= 1 && hour <= 6) hour += 12;
      if (hour > 23 || minute > 59) {
        state.text = before;
        hour = null;
      }
    } else if (partHour != null) {
      hour = partHour;
    }
    if (hour != null) out.time = `${pad2(hour)}:${pad2(minute)}`;
  }

  if (out.time && !out.due) {
    out.due = toTimestamp(today, out.time) > now.getTime() ? today : addDays(today, 1);
  }
  if (out.repeat && !out.due) out.due = today;
  if (out.remind != null && !out.due) delete out.remind;

  let title = state.text.replace(/\s+/g, ' ').trim();
  title = title.replace(/(?:^|\s)(?:ב-?|ל|ו|-|,)$/, '').trim();
  out.title = title || String(input).trim();
  return out;
}
