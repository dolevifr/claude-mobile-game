// Reminders: the in-page scheduler, system notifications, app badge and calendar export.
//
// A web app cannot schedule a notification for a time when it is fully closed (that needs a push
// server). Reminders fire while the app is open or in the background; calendar export covers the rest.

import { DEFAULT_TIME, addDays, toISODate, toTimestamp, timeFromDate } from './dates.js';

let swRegistration = null;
let audioCtx = null;

export function setServiceWorker(reg) {
  swRegistration = reg;
}

export function notificationState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function showSystemNotification(title, options = {}) {
  if (notificationState() !== 'granted') return false;
  try {
    const reg = swRegistration || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
    const { actions, ...plain } = options; // actions are only allowed on service worker notifications
    new Notification(title, plain);
    return true;
  } catch {
    return false;
  }
}

export function dueReminders(tasks, now) {
  return tasks.filter((t) => !t.done && t.remindAt && !t.notifiedAt && t.remindAt <= now);
}

export function nextReminderAt(tasks, now) {
  let next = null;
  tasks.forEach((t) => {
    if (!t.done && t.remindAt && !t.notifiedAt && t.remindAt > now && (next == null || t.remindAt < next)) next = t.remindAt;
  });
  return next;
}

// Checks on an interval, on a timer aimed at the next reminder, and whenever the app comes back into view.
export function startReminderLoop({ getTasks, onDue }) {
  let timer = null;
  const check = () => {
    const now = Date.now();
    const due = dueReminders(getTasks(), now);
    if (due.length) onDue(due, now);
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    const next = nextReminderAt(getTasks(), Date.now());
    if (next == null) return;
    const delay = Math.min(Math.max(next - Date.now() + 200, 0), 6 * 3600 * 1000);
    timer = setTimeout(check, delay);
  };
  setInterval(check, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
  return { check, schedule };
}

export function setBadge(count) {
  try {
    if (!('setAppBadge' in navigator)) return;
    const p = count ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    p?.catch?.(() => {});
  } catch {
    // Badges are optional.
  }
}

// Browsers only allow sound after the person has interacted with the page.
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

export function chime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [[0, 784], [0.16, 1046.5]].forEach(([offset, freq]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + offset);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + 0.45);
  });
}

export function vibrate(pattern) {
  try {
    // Browsers block vibration until the person has tapped the page once.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(pattern);
  } catch {
    // Not available on every device.
  }
}

// ---- Calendar export ----

const RRULES = {
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH',
  weekly: 'FREQ=WEEKLY',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY',
};

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDate = (iso) => iso.replace(/-/g, '');
const icsDateTime = (iso, time) => `${icsDate(iso)}T${time.replace(':', '')}00`;

// Lines longer than 75 bytes are folded, as RFC 5545 asks. Hebrew letters are 2 bytes each.
function foldLine(line) {
  const enc = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 74) {
      out += '\r\n ';
      bytes = 1;
    }
    out += ch;
    bytes += n;
  }
  return out;
}

export function icsDuration(minutes) {
  const sign = minutes < 0 ? '-' : '';
  let m = Math.abs(minutes);
  const days = Math.floor(m / 1440);
  m %= 1440;
  const hours = Math.floor(m / 60);
  m %= 60;
  let out = `${sign}P`;
  if (days) out += `${days}D`;
  if (hours || m || !days) {
    out += 'T';
    if (hours) out += `${hours}H`;
    if (m || !hours) out += `${m}M`;
  }
  return out;
}

function eventRange(task) {
  if (task.time) {
    const end = new Date(toTimestamp(task.due, task.time) + 30 * 60000);
    return { start: icsDateTime(task.due, task.time), end: icsDateTime(toISODate(end), timeFromDate(end)), allDay: false };
  }
  return { start: icsDate(task.due), end: icsDate(addDays(task.due, 1)), allDay: true };
}

export function buildICS(task, now = new Date()) {
  if (!task.due) return null;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const range = eventRange(task);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ozer//Personal Assistant//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${task.id}@ozer.app`,
    `DTSTAMP:${stamp}`,
    range.allDay ? `DTSTART;VALUE=DATE:${range.start}` : `DTSTART:${range.start}`,
    range.allDay ? `DTEND;VALUE=DATE:${range.end}` : `DTEND:${range.end}`,
    `SUMMARY:${icsEscape(task.title)}`,
  ];
  const description = [task.notes, ...task.subtasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`)].filter(Boolean).join('\n');
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (RRULES[task.repeat]) lines.push(`RRULE:${RRULES[task.repeat]}`);
  if (task.remind != null) {
    // All-day events start at midnight, so the alarm is offset to the default reminder time.
    const [h, m] = DEFAULT_TIME.split(':').map(Number);
    const offset = task.time ? -task.remind : h * 60 + m - task.remind;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(task.title)}`, `TRIGGER:${icsDuration(offset)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export function googleCalendarUrl(task) {
  if (!task.due) return null;
  const range = eventRange(task);
  const params = new URLSearchParams({ action: 'TEMPLATE', text: task.title, dates: `${range.start}/${range.end}` });
  if (task.notes) params.set('details', task.notes);
  if (RRULES[task.repeat]) params.set('recur', `RRULE:${RRULES[task.repeat]}`);
  return `https://calendar.google.com/calendar/render?${params}`;
}
