// Date helpers. Dates are stored as local 'YYYY-MM-DD' strings and times as 'HH:MM'.

export const DAY_MS = 86400000;
export const DEFAULT_TIME = '09:00';
export const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export const REPEATS = {
  none: 'לא חוזרת',
  daily: 'כל יום',
  weekdays: 'ימי חול (א׳–ה׳)',
  weekly: 'כל שבוע',
  monthly: 'כל חודש',
  yearly: 'כל שנה',
};

// [minutes before, label]. null = no reminder.
export const REMIND_OPTIONS = [
  [null, 'ללא תזכורת'],
  [0, 'בזמן המשימה'],
  [10, '10 דקות לפני'],
  [30, 'חצי שעה לפני'],
  [60, 'שעה לפני'],
  [1440, 'יום לפני'],
];

export const pad2 = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fromISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(now = new Date()) {
  return toISODate(now);
}

export function addDays(iso, n) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

// Keeps the day of month, clamped to the last day of the target month.
export function addMonths(iso, n) {
  const d = fromISODate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

export function diffDays(fromIso, toIso) {
  return Math.round((fromISODate(toIso) - fromISODate(fromIso)) / DAY_MS);
}

export function toTimestamp(iso, time = DEFAULT_TIME) {
  const d = fromISODate(iso);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function timeFromDate(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function computeRemindAt(task) {
  if (task.remind == null || task.remind === '' || !task.due) return null;
  return toTimestamp(task.due, task.time || DEFAULT_TIME) - Number(task.remind) * 60000;
}

export function nextOccurrence(iso, repeat) {
  switch (repeat) {
    case 'daily': return addDays(iso, 1);
    case 'weekdays': {
      // Israeli work week: Sunday to Thursday.
      let next = addDays(iso, 1);
      while (fromISODate(next).getDay() > 4) next = addDays(next, 1);
      return next;
    }
    case 'weekly': return addDays(iso, 7);
    case 'monthly': return addMonths(iso, 1);
    case 'yearly': return addMonths(iso, 12);
    default: return null;
  }
}

// Next occurrence that falls after today, so finishing an overdue repeating task never leaves it overdue.
export function advanceRepeat(iso, repeat, today) {
  let next = nextOccurrence(iso, repeat);
  if (!next) return null;
  while (next <= today) next = nextOccurrence(next, repeat);
  return next;
}

export function shortDate(iso, now = new Date()) {
  const d = fromISODate(iso);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('he-IL', opts);
}

export function relativeDay(iso, now = new Date()) {
  const diff = diffDays(todayISO(now), iso);
  if (diff === 0) return 'היום';
  if (diff === 1) return 'מחר';
  if (diff === -1) return 'אתמול';
  if (diff > 1 && diff < 7) return `יום ${WEEKDAYS[fromISODate(iso).getDay()]}`;
  return shortDate(iso, now);
}

export function longDate(d) {
  return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}

const HEB_ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const HEB_TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HEB_HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];

// 20 -> כ׳, 15 -> ט״ו, 5787 -> תשפ״ז (thousands are dropped, as on a calendar).
export function gematria(n) {
  n %= 1000;
  const rest = n % 100;
  let s = HEB_HUNDREDS[Math.floor(n / 100)];
  if (rest === 15) s += 'טו';
  else if (rest === 16) s += 'טז';
  else s += HEB_TENS[Math.floor(rest / 10)] + HEB_ONES[rest % 10];
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

export function hebrewDate(d) {
  try {
    const parts = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d);
    const part = (type) => parts.find((p) => p.type === type)?.value;
    const day = parseInt(part('day'), 10);
    const year = parseInt(part('year'), 10);
    const month = part('month');
    // Some engines already print Hebrew numerals; keep their output then.
    if (!day || !year || !month) return parts.map((p) => p.value).join('');
    return `${gematria(day)} ב${month} ${gematria(year)}`;
  } catch {
    return '';
  }
}

export function greetingFor(d) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'בוקר טוב';
  if (h >= 12 && h < 16) return 'צהריים טובים';
  if (h >= 16 && h < 21) return 'ערב טוב';
  return 'לילה טוב';
}
