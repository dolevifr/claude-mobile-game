// App state, persisted to localStorage, plus pure selectors used by the views.

import { computeRemindAt, todayISO, addDays, advanceRepeat, toISODate } from './dates.js';

const STORAGE_KEY = 'ozer:v1';

export const LIST_COLORS = ['blue', 'violet', 'green', 'orange', 'pink', 'teal'];

const DEFAULT_LISTS = [
  { id: 'personal', name: 'אישי', color: 'blue' },
  { id: 'work', name: 'עבודה', color: 'violet' },
  { id: 'home', name: 'בית', color: 'green' },
  { id: 'shopping', name: 'קניות', color: 'orange' },
];

let seq = 0;
export function uid() {
  seq = (seq + 1) % 1296;
  return Date.now().toString(36) + seq.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function defaultState() {
  return {
    version: 1,
    tasks: [],
    lists: clone(DEFAULT_LISTS),
    settings: { theme: 'auto', defaultRemind: 0, sound: true },
  };
}

function normalizeTask(t) {
  const task = {
    id: t.id || uid(),
    title: String(t.title || '').trim(),
    notes: String(t.notes || ''),
    done: !!t.done,
    doneAt: t.doneAt || null,
    lastDoneAt: t.lastDoneAt || null,
    createdAt: t.createdAt || Date.now(),
    due: t.due || null,
    time: t.time || null,
    remind: t.remind === '' || t.remind == null ? null : Number(t.remind),
    remindAt: null,
    notifiedAt: t.notifiedAt || null,
    important: !!t.important,
    listId: t.listId || 'personal',
    repeat: t.repeat || 'none',
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks.map((s) => ({ id: s.id || uid(), title: String(s.title || ''), done: !!s.done }))
      : [],
    sample: !!t.sample,
  };
  if (task.repeat !== 'none' && !task.due) task.due = todayISO();
  task.remindAt = t.remindAt && t.notifiedAt == null && t.remindAt !== computeRemindAt(task)
    ? t.remindAt // a snoozed reminder keeps its own time
    : computeRemindAt(task);
  return task;
}

function normalize(data) {
  const base = defaultState();
  return {
    ...base,
    settings: { ...base.settings, ...(data.settings || {}) },
    lists: Array.isArray(data.lists) && data.lists.length ? data.lists : base.lists,
    tasks: Array.isArray(data.tasks) ? data.tasks.map(normalizeTask) : [],
  };
}

function sampleTasks(now = new Date()) {
  const today = todayISO(now);
  const daysToFriday = ((5 - now.getDay() + 7) % 7) || 7;
  const sample = (fields) => normalizeTask({ sample: true, createdAt: Date.now(), ...fields });
  return [
    sample({ title: 'לסמן את המשימה הזו כבוצעה', due: today, notes: 'לחיצה על התיבה מסמנת משימה כבוצעה. לחיצה על הטקסט פותחת אותה לעריכה.' }),
    sample({ title: 'להוסיף משימה במשפט אחד', due: today, notes: 'לחצו על "משימה חדשה" וכתבו למשל: להתקשר לאמא מחר ב-18:00 !\nהתאריך, השעה, התזכורת והחשיבות יזוהו לבד.' }),
    sample({ title: 'להפעיל התראות לתזכורות', due: today, important: true, notes: 'בהגדרות (הכפתור בפינה העליונה) אפשר לאשר התראות.' }),
    sample({ title: 'לשלם חשבון חשמל', due: addDays(today, -1), listId: 'home', important: true }),
    sample({ title: 'פגישת צוות שבועית', due: addDays(today, 1), time: '10:00', remind: 10, repeat: 'weekly', listId: 'work' }),
    sample({
      title: 'קניות לשבת',
      due: addDays(today, daysToFriday),
      listId: 'shopping',
      subtasks: [{ title: 'חלה' }, { title: 'יין' }, { title: 'פירות', done: true }],
    }),
  ];
}

let state = defaultState();
let storageOk = true;
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageOk = true;
  } catch {
    storageOk = false;
  }
}

function commit() {
  persist();
  listeners.forEach((fn) => fn(state));
}

export function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    storageOk = false;
  }
  if (raw) {
    try {
      state = normalize(JSON.parse(raw));
      return { fresh: false };
    } catch {
      // Unreadable data falls through to a fresh start.
    }
  }
  state = defaultState();
  state.tasks = sampleTasks();
  persist();
  return { fresh: true };
}

// Another tab changed the data.
export function reloadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = normalize(JSON.parse(raw));
      listeners.forEach((fn) => fn(state));
    }
  } catch {
    // Keep the in-memory state.
  }
}

export const STORAGE_KEY_NAME = STORAGE_KEY;
export const subscribe = (fn) => listeners.add(fn);
export const getState = () => state;
export const isStorageAvailable = () => storageOk;
export const getTask = (id) => state.tasks.find((t) => t.id === id) || null;

export function createTask(fields) {
  const task = normalizeTask({ ...fields, id: uid(), createdAt: Date.now(), sample: false });
  state.tasks.push(task);
  commit();
  return task;
}

export function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  const previous = t.remindAt;
  Object.assign(t, patch);
  if (t.repeat !== 'none' && !t.due) t.due = todayISO();
  if ('due' in patch || 'time' in patch || 'remind' in patch || 'repeat' in patch) {
    t.remindAt = computeRemindAt(t);
    if (t.remindAt !== previous) t.notifiedAt = null;
  }
  commit();
  return t;
}

// Repeating tasks move to their next date instead of being marked done.
export function completeTask(id, now = new Date()) {
  const t = getTask(id);
  if (!t) return null;
  const snapshot = clone(t);
  if (t.repeat !== 'none' && t.due) {
    t.due = advanceRepeat(t.due, t.repeat, todayISO(now));
    t.lastDoneAt = now.getTime();
    t.subtasks.forEach((s) => { s.done = false; });
    t.remindAt = computeRemindAt(t);
    t.notifiedAt = null;
    commit();
    return { snapshot, rolled: true, task: t };
  }
  t.done = true;
  t.doneAt = now.getTime();
  commit();
  return { snapshot, rolled: false, task: t };
}

export function reopenTask(id) {
  return updateTask(id, { done: false, doneAt: null });
}

export function restoreTask(snapshot) {
  const i = state.tasks.findIndex((t) => t.id === snapshot.id);
  if (i >= 0) state.tasks[i] = snapshot;
  else state.tasks.push(snapshot);
  commit();
}

export function restoreTasks(snapshots) {
  snapshots.forEach((s) => {
    const i = state.tasks.findIndex((t) => t.id === s.id);
    if (i >= 0) state.tasks[i] = s;
    else state.tasks.push(s);
  });
  commit();
}

export function deleteTask(id) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const [removed] = state.tasks.splice(i, 1);
  commit();
  return removed;
}

export function toggleSubtask(taskId, subId) {
  const t = getTask(taskId);
  const s = t && t.subtasks.find((x) => x.id === subId);
  if (!s) return;
  s.done = !s.done;
  commit();
}

export function deleteSamples() {
  const removed = state.tasks.filter((t) => t.sample);
  state.tasks = state.tasks.filter((t) => !t.sample);
  commit();
  return removed;
}

export function clearCompleted() {
  const removed = state.tasks.filter((t) => t.done);
  state.tasks = state.tasks.filter((t) => !t.done);
  commit();
  return removed;
}

export function snoozeTask(id, minutes = 10) {
  const t = getTask(id);
  if (!t) return;
  t.remindAt = Date.now() + minutes * 60000;
  t.notifiedAt = null;
  commit();
}

export function markNotified(ids, at = Date.now()) {
  if (!ids.length) return;
  ids.forEach((id) => {
    const t = getTask(id);
    if (t) t.notifiedAt = at;
  });
  commit();
}

export const getList = (id) => state.lists.find((l) => l.id === id) || state.lists[0];

export function addList(name, color) {
  const list = {
    id: uid(),
    name: name.trim(),
    color: color || LIST_COLORS[state.lists.length % LIST_COLORS.length],
  };
  state.lists.push(list);
  commit();
  return list;
}

export function findList(name) {
  const n = name.trim();
  return state.lists.find((l) => l.name === n) || state.lists.find((l) => l.name.startsWith(n)) || null;
}

export function updateList(id, patch) {
  const list = state.lists.find((l) => l.id === id);
  if (!list) return;
  Object.assign(list, patch);
  commit();
}

// Tasks of a deleted list move to the first remaining list.
export function deleteList(id) {
  if (state.lists.length <= 1) return false;
  const fallback = state.lists.find((l) => l.id !== id).id;
  state.tasks.forEach((t) => { if (t.listId === id) t.listId = fallback; });
  state.lists = state.lists.filter((l) => l.id !== id);
  commit();
  return true;
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  commit();
}

export function exportData() {
  return JSON.stringify({ app: 'ozer', exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function importData(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.tasks)) throw new Error('הקובץ לא נראה כמו גיבוי של העוזר.');
  state = normalize(data);
  commit();
  return state.tasks.length;
}

// ---- Selectors ----

export function compareTasks(a, b) {
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  if (a.time !== b.time) {
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time < b.time ? -1 : 1;
  }
  if (a.important !== b.important) return a.important ? -1 : 1;
  return a.createdAt - b.createdAt;
}

const onDay = (ts, iso) => !!ts && toISODate(new Date(ts)) === iso;

export function selectToday(tasks, today) {
  const open = tasks.filter((t) => !t.done);
  const doneToday = tasks.filter((t) => t.done && onDay(t.doneAt, today)).sort((a, b) => b.doneAt - a.doneAt);
  const rolledToday = open.filter((t) => t.repeat !== 'none' && onDay(t.lastDoneAt, today));
  return {
    overdue: open.filter((t) => t.due && t.due < today).sort(compareTasks),
    due: open.filter((t) => t.due === today).sort(compareTasks),
    doneToday,
    completedCount: doneToday.length + rolledToday.length,
  };
}

export function selectUpcoming(tasks, today) {
  const open = tasks.filter((t) => !t.done).sort(compareTasks);
  const groups = [];
  for (let i = 1; i <= 7; i++) {
    const iso = addDays(today, i);
    const items = open.filter((t) => t.due === iso);
    if (items.length) groups.push({ kind: 'day', iso, tasks: items });
  }
  const weekEnd = addDays(today, 7);
  const later = open.filter((t) => t.due && t.due > weekEnd);
  if (later.length) groups.push({ kind: 'later', tasks: later });
  const undated = open.filter((t) => !t.due);
  if (undated.length) groups.push({ kind: 'undated', tasks: undated });
  return groups;
}

export function selectImportant(tasks) {
  return tasks.filter((t) => !t.done && t.important).sort(compareTasks);
}

export function selectList(tasks, listId) {
  const inList = listId === 'all' ? tasks : tasks.filter((t) => t.listId === listId);
  return {
    open: inList.filter((t) => !t.done).sort(compareTasks),
    done: inList.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt),
  };
}

export function searchTasks(tasks, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hit = (t) => t.title.toLowerCase().includes(q)
    || t.notes.toLowerCase().includes(q)
    || t.subtasks.some((s) => s.title.toLowerCase().includes(q));
  const found = tasks.filter(hit);
  return [...found.filter((t) => !t.done).sort(compareTasks), ...found.filter((t) => t.done)];
}

export function openCountByList(tasks) {
  const counts = {};
  tasks.forEach((t) => { if (!t.done) counts[t.listId] = (counts[t.listId] || 0) + 1; });
  return counts;
}

// Open tasks due today or earlier: the number on the app icon.
export function dueCount(tasks, today) {
  return tasks.filter((t) => !t.done && t.due && t.due <= today).length;
}
