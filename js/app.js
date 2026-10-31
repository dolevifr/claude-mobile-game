import { icon } from './icons.js';
import {
  REPEATS, REMIND_OPTIONS, todayISO, addDays, relativeDay, shortDate, longDate, hebrewDate, greetingFor,
  toTimestamp, fromISODate, WEEKDAYS,
} from './dates.js';
import { parseQuickAdd } from './parse.js';
import {
  loadState, reloadFromStorage, subscribe, getState, getTask, createTask, updateTask, completeTask, reopenTask,
  restoreTask, restoreTasks, deleteTask, toggleSubtask, deleteSamples, clearCompleted, snoozeTask, markNotified,
  getList, addList, findList, updateList, deleteList, updateSettings, exportData, importData, isStorageAvailable,
  selectToday, selectUpcoming, selectImportant, selectList, searchTasks, openCountByList, dueCount,
  LIST_COLORS, STORAGE_KEY_NAME,
} from './store.js';
import {
  setServiceWorker, notificationState, requestNotifications, showSystemNotification, startReminderLoop,
  setBadge, unlockAudio, chime, vibrate, buildICS, googleCalendarUrl,
} from './reminders.js';

const VIEWS = { today: 'היום', upcoming: 'בקרוב', important: 'חשוב', lists: 'רשימות' };
const COLOR_NAMES = { blue: 'כחול', violet: 'סגול', green: 'ירוק', orange: 'כתום', pink: 'ורוד', teal: 'טורקיז' };
const UI_KEY = 'ozer:ui';

const ui = {
  view: 'today',
  query: '',
  listFilter: 'all',
  showDone: false,
  expanded: new Set(),
  alerts: [],
};

let installPrompt = null;
let reminderLoop = null;
let renderedDay = todayISO();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isEmbedded = (() => { try { return window.self !== window.top; } catch { return true; } })();

function loadUiPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    if (saved.listFilter) ui.listFilter = saved.listFilter;
  } catch {
    // Preferences are optional.
  }
}

function saveUiPrefs() {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ listFilter: ui.listFilter })); } catch { /* optional */ }
}

// ---------- Rendering ----------

function dueText(t, now = new Date()) {
  const day = relativeDay(t.due, now);
  return t.time ? `${day} · <span class="num">${t.time}</span>` : day;
}

function isOverdue(t, now) {
  if (t.done || !t.due) return false;
  const today = todayISO(now);
  return t.due < today || (t.due === today && !!t.time && toTimestamp(t.due, t.time) < now.getTime());
}

function taskRow(t, now, opts = {}) {
  const list = getList(t.listId);
  const meta = [];
  if (t.due && !opts.hideDate) {
    meta.push(`<span class="meta ${isOverdue(t, now) ? 'is-overdue' : ''}">${icon('calendar')}${dueText(t, now)}</span>`);
  } else if (t.time && opts.hideDate) {
    meta.push(`<span class="meta ${isOverdue(t, now) ? 'is-overdue' : ''}">${icon('clock')}<span class="num">${t.time}</span></span>`);
  }
  if (t.remindAt && !t.done) meta.push(`<span class="meta" title="יש תזכורת">${icon('bell')}<span class="sr-only">יש תזכורת</span></span>`);
  if (t.repeat !== 'none') meta.push(`<span class="meta" title="${REPEATS[t.repeat]}">${icon('repeat')}<span class="sr-only">${REPEATS[t.repeat]}</span></span>`);
  const expanded = ui.expanded.has(t.id);
  if (t.subtasks.length) {
    const done = t.subtasks.filter((s) => s.done).length;
    meta.push(`<button type="button" class="chip-sub" data-act="expand" aria-expanded="${expanded}" aria-label="תתי-משימות: ${done} מתוך ${t.subtasks.length}">${icon('subtasks')}<span class="num">${done}/${t.subtasks.length}</span></button>`);
  }
  if (t.notes) meta.push(`<span class="meta" title="יש הערות">${icon('note')}<span class="sr-only">יש הערות</span></span>`);
  if (!opts.hideList) meta.push(`<span class="meta meta-list" style="--dot: var(--c-${list.color})">${esc(list.name)}</span>`);

  const subs = expanded && t.subtasks.length
    ? `<ul class="subtasks">${t.subtasks.map((s) => `
        <li class="${s.done ? 'is-sub-done' : ''}"><label>
          <input type="checkbox" class="check check-sm" data-act="subtoggle" data-sub="${s.id}" ${s.done ? 'checked' : ''}>
          <span>${esc(s.title)}</span>
        </label></li>`).join('')}</ul>`
    : '';

  return `<li class="task ${t.done ? 'is-done' : ''} ${t.important ? 'is-important' : ''}" data-id="${t.id}">
    <label class="check-wrap"><input type="checkbox" class="check" data-act="toggle" ${t.done ? 'checked' : ''} aria-label="${esc(t.title)}"></label>
    <div class="task-main" data-act="open" role="button" tabindex="0" aria-label="עריכה: ${esc(t.title)}">
      <span class="task-title"><span class="title-text">${esc(t.title)}</span></span>
      ${meta.length ? `<span class="task-meta">${meta.join('')}</span>` : ''}
    </div>
    <button type="button" class="star" data-act="star" aria-pressed="${t.important}" aria-label="חשוב">${icon('star')}</button>
    ${subs}
  </li>`;
}

function group(title, tasks, now, opts = {}) {
  return `<section class="group ${opts.tone ? `tone-${opts.tone}` : ''}">
    <h3 class="group-title"><span>${esc(title)}</span>${opts.sub ? `<span class="sub">${esc(opts.sub)}</span>` : ''}<span class="count">${tasks.length}</span></h3>
    <ul class="tasks">${tasks.map((t) => taskRow(t, now, opts)).join('')}</ul>
  </section>`;
}

function doneGroup(tasks, now, label) {
  if (!tasks.length) return '';
  return `<section class="group">
    <button type="button" class="done-toggle" data-act="toggle-done" aria-expanded="${ui.showDone}">${icon('chevron')}<span>${esc(label)} (${tasks.length})</span></button>
    ${ui.showDone ? `<ul class="tasks">${tasks.map((t) => taskRow(t, now)).join('')}</ul>` : ''}
  </section>`;
}

function empty(title, text, cta, preset) {
  return `<div class="empty">
    <div class="empty-mark">${icon('check')}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${cta ? `<button type="button" class="btn btn-soft" data-act="add" data-preset="${esc(JSON.stringify(preset || {}))}">${icon('plus')}${esc(cta)}</button>` : ''}
  </div>`;
}

function ring(done, total) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - (total ? done / total : 0));
  const label = total === 0
    ? '<strong>—</strong><small>ריק</small>'
    : `<strong class="num">${done}/${total}</strong><small>${done === total ? 'הכל בוצע' : 'בוצעו'}</small>`;
  return `<div class="ring" role="img" aria-label="${total ? `בוצעו ${done} מתוך ${total} משימות היום` : 'אין משימות להיום'}">
    <svg viewBox="0 0 92 92" aria-hidden="true">
      <circle class="ring-track" cx="46" cy="46" r="${r}" fill="none" stroke-width="8"/>
      <circle class="ring-bar" cx="46" cy="46" r="${r}" fill="none" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(total ? offset : c).toFixed(1)}"/>
    </svg>
    <span class="ring-label">${label}</span>
  </div>`;
}

function renderToday(s, now) {
  const today = todayISO(now);
  const { overdue, due, doneToday, completedCount } = selectToday(s.tasks, today);
  const total = overdue.length + due.length + completedCount;
  let html = `<section class="hero">
    <div class="hero-text">
      <p class="hero-greet">${greetingFor(now)}</p>
      <h2 class="hero-date">${esc(longDate(now))}</h2>
      <p class="hero-heb">${esc(hebrewDate(now))}</p>
    </div>
    ${ring(completedCount, total)}
  </section>`;
  if (overdue.length) html += group('באיחור', overdue, now, { tone: 'danger' });
  if (due.length) html += group('להיום', due, now, { hideDate: true });
  if (!overdue.length && !due.length) {
    html += completedCount
      ? empty('סיימת את כל המשימות להיום', 'אפשר לנוח, או להציץ במה שמחכה בימים הקרובים.', null)
      : empty('אין משימות להיום', 'מה צריך לעשות היום? אפשר לכתוב במשפט אחד, כולל שעה ותזכורת.', 'הוספת משימה להיום', { due: today });
  }
  html += doneGroup(doneToday, now, 'הושלמו היום');
  return html;
}

function renderUpcoming(s, now) {
  const today = todayISO(now);
  const groups = selectUpcoming(s.tasks, today);
  if (!groups.length) {
    return empty('שום דבר לא מתוכנן', 'משימות עם תאריך עתידי יופיעו כאן, מסודרות לפי ימים.', 'משימה למחר', { due: addDays(today, 1) });
  }
  return groups.map((g) => {
    if (g.kind === 'day') {
      const title = g.iso === addDays(today, 1) ? 'מחר' : `יום ${WEEKDAYS[fromISODate(g.iso).getDay()]}`;
      return group(title, g.tasks, now, { hideDate: true, sub: shortDate(g.iso, now) });
    }
    if (g.kind === 'later') return group('מאוחר יותר', g.tasks, now);
    return group('ללא תאריך', g.tasks, now);
  }).join('');
}

function renderImportant(s, now) {
  const tasks = selectImportant(s.tasks);
  if (!tasks.length) return empty('אין משימות חשובות', 'סמנו משימה בכוכב, או כתבו ! בסוף המשפט כשמוסיפים אותה.', 'משימה חשובה', { important: true });
  return group('מסומנות בכוכב', tasks, now);
}

function renderLists(s, now) {
  const counts = openCountByList(s.tasks);
  if (ui.listFilter !== 'all' && !s.lists.some((l) => l.id === ui.listFilter)) ui.listFilter = 'all';
  const total = s.tasks.filter((t) => !t.done).length;
  const pills = [
    `<button type="button" class="pill" data-act="list-filter" data-list="all" aria-pressed="${ui.listFilter === 'all'}">הכל <span class="num">${total}</span></button>`,
    ...s.lists.map((l) => `<button type="button" class="pill" data-act="list-filter" data-list="${l.id}" aria-pressed="${ui.listFilter === l.id}" style="--dot: var(--c-${l.color})"><span class="dot"></span>${esc(l.name)} <span class="num">${counts[l.id] || 0}</span></button>`),
    `<button type="button" class="pill pill-add" data-act="list-add">${icon('plus')}רשימה חדשה</button>`,
  ];
  let html = `<div class="pills">${pills.join('')}</div>`;
  const { open, done } = selectList(s.tasks, ui.listFilter);
  const list = ui.listFilter === 'all' ? null : getList(ui.listFilter);
  if (list) {
    html += `<div class="list-head" style="--dot: var(--c-${list.color})">
      <h2>${esc(list.name)}</h2>
      <button type="button" class="btn btn-ghost btn-sm" data-act="list-edit" data-list="${list.id}">${icon('edit')}עריכת רשימה</button>
    </div>`;
  }
  if (open.length) {
    html += list
      ? `<ul class="tasks">${open.map((t) => taskRow(t, now, { hideList: true })).join('')}</ul>`
      : group('כל המשימות הפתוחות', open, now);
  } else {
    html += empty(list ? `הרשימה "${list.name}" ריקה` : 'אין משימות פתוחות', 'משימה חדשה שתוסיפו מכאן תיכנס לרשימה הזו.', 'הוספת משימה', list ? { listId: list.id } : {});
  }
  html += doneGroup(done, now, 'הושלמו');
  return html;
}

function renderSearch(s, now) {
  const results = searchTasks(s.tasks, ui.query);
  if (!results.length) return empty('לא נמצאו משימות', `אין משימה שמכילה "${ui.query}". נסו מילה אחרת.`, null);
  return group(`תוצאות עבור "${ui.query}"`, results, now);
}

function render() {
  const s = getState();
  const now = new Date();
  renderedDay = todayISO(now);
  $('#viewTitle').textContent = ui.query ? 'חיפוש' : (ui.view === 'today' ? 'העוזר שלי' : VIEWS[ui.view]);
  $$('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.view === ui.view && !ui.query ? 'page' : 'false'));

  let html = '';
  if (!isStorageAvailable()) {
    html += `<div class="banner is-warning"><p>הדפדפן לא מאפשר לשמור נתונים, כך שהמשימות יימחקו כשהדף ייסגר. בדפדפן רגיל (לא גלישה בסתר) הן נשמרות.</p></div>`;
  }
  if (!ui.query && s.tasks.some((t) => t.sample)) {
    html += `<div class="banner"><p>אלה משימות לדוגמה שמראות מה אפשר לעשות. כשתסיימו להתנסות אפשר למחוק את כולן.</p>
      <button type="button" class="btn btn-soft btn-sm" data-act="delete-samples">מחיקת הדוגמאות</button></div>`;
  }
  const views = { today: renderToday, upcoming: renderUpcoming, important: renderImportant, lists: renderLists };
  html += ui.query ? renderSearch(s, now) : views[ui.view](s, now);
  $('#main').innerHTML = html;

  const badge = dueCount(s.tasks, renderedDay);
  const overdue = s.tasks.filter((t) => !t.done && t.due && t.due < renderedDay).length;
  const todayBadge = $('#todayBadge');
  todayBadge.hidden = !overdue;
  todayBadge.textContent = overdue;
  todayBadge.setAttribute('aria-label', `${overdue} באיחור`);
  setBadge(badge);
  renderAlerts();
}

// ---------- Toast ----------

let toastTimer = null;
function toast(message, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" class="toast-btn">ביטול</button>' : ''}`;
  if (undo) {
    el.querySelector('button').addEventListener('click', () => {
      undo();
      hideToast();
    }, { once: true });
  }
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 5000 : 3200);
}
function hideToast() {
  $('#toast').classList.remove('is-on');
}

// ---------- Reminder alerts ----------

function renderAlerts() {
  const box = $('#alerts');
  const tasks = ui.alerts.map(getTask).filter((t) => t && !t.done);
  ui.alerts = tasks.map((t) => t.id);
  const now = new Date();
  box.innerHTML = tasks.slice(0, 3).map((t) => `
    <div class="alert" data-id="${t.id}">
      <span class="alert-ico">${icon('bell')}</span>
      <div class="alert-body">
        <small>תזכורת</small>
        <p>${esc(t.title)}</p>
        ${t.due ? `<span class="when">${dueText(t, now)}</span>` : ''}
      </div>
      <button type="button" class="icon-btn" data-alert="dismiss" aria-label="סגירת התזכורת">${icon('x')}</button>
      <div class="alert-actions">
        <button type="button" class="btn btn-primary btn-sm" data-alert="done">${icon('check')}בוצע</button>
        <button type="button" class="btn btn-soft btn-sm" data-alert="snooze">${icon('clock')}עוד 10 דקות</button>
      </div>
    </div>`).join('') + (tasks.length > 3 ? `<p class="alert-more">ועוד ${tasks.length - 3} תזכורות</p>` : '');
}

function handleReminderAction(action, id) {
  const t = getTask(id);
  if (!t) return;
  ui.alerts = ui.alerts.filter((x) => x !== id);
  if (action === 'done') finishTask(id);
  else if (action === 'snooze') {
    snoozeTask(id, 10);
    toast('אזכיר שוב בעוד 10 דקות');
  } else if (action === 'open') {
    openTaskSheet(id);
  }
  renderAlerts();
  reminderLoop?.schedule();
}

function onRemindersDue(due, now) {
  const visible = !document.hidden;
  const notified = [];
  due.forEach((t) => {
    if (visible) {
      if (!ui.alerts.includes(t.id)) ui.alerts.unshift(t.id);
      notified.push(t.id);
    } else if (notificationState() === 'granted' && now - t.remindAt < 2 * 3600 * 1000) {
      showSystemNotification(t.title, {
        body: t.due ? `תזכורת · ${relativeDay(t.due)}${t.time ? ` ${t.time}` : ''}` : 'תזכורת',
        tag: `task-${t.id}`,
        renotify: true,
        requireInteraction: true,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-96.png',
        lang: 'he',
        dir: 'rtl',
        vibrate: [200, 100, 200],
        data: { id: t.id },
        actions: [{ action: 'done', title: 'בוצע' }, { action: 'snooze', title: 'עוד 10 דקות' }],
      });
      notified.push(t.id);
    }
    // Otherwise wait until the app is visible again.
  });
  if (visible && notified.length) {
    if (getState().settings.sound) chime();
    vibrate([200, 100, 200]);
  }
  markNotified(notified, now);
}

// ---------- Actions ----------

function finishTask(id) {
  const res = completeTask(id);
  if (!res) return;
  vibrate(12);
  if (res.rolled) toast(`יפה! הפעם הבאה: ${relativeDay(res.task.due)}`, () => restoreTask(res.snapshot));
  else toast('המשימה הושלמה', () => restoreTask(res.snapshot));
}

function onToggle(checkbox) {
  const li = checkbox.closest('.task');
  const id = li.dataset.id;
  if (checkbox.checked) {
    li.classList.add('is-completing');
    setTimeout(() => finishTask(id), 380);
  } else {
    reopenTask(id);
  }
}

function setView(view, { fromHash = false } = {}) {
  if (!VIEWS[view]) view = 'today';
  ui.view = view;
  if (ui.query) closeSearch(false);
  if (!fromHash) {
    try { history.replaceState(null, '', `#${view}`); } catch { /* sandboxed */ }
  }
  render();
  window.scrollTo({ top: 0 });
}

function closeSearch(rerender = true) {
  ui.query = '';
  $('#searchInput').value = '';
  $('#searchRow').hidden = true;
  $('#searchBtn').setAttribute('aria-expanded', 'false');
  if (rerender) render();
}

function presetForView() {
  if (ui.view === 'today') return { due: todayISO() };
  if (ui.view === 'important') return { important: true };
  if (ui.view === 'lists' && ui.listFilter !== 'all') return { listId: ui.listFilter };
  return {};
}

// ---------- Sheets ----------

let lastFocus = null;

function openSheet(html, label) {
  const root = $('#sheetRoot');
  lastFocus = document.activeElement;
  hideToast();
  root.innerHTML = `<div class="scrim" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="sheet-grip" aria-hidden="true"></div>${html}</div>`;
  root.hidden = false;
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')));
  return root.querySelector('.sheet');
}

function closeSheet() {
  const root = $('#sheetRoot');
  if (root.hidden) return;
  root.classList.remove('is-open');
  setTimeout(() => {
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('no-scroll');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }, 230);
}

function remindOptions(selected) {
  return REMIND_OPTIONS.map(([v, label]) => {
    const value = v == null ? '' : String(v);
    return `<option value="${value}" ${value === (selected == null ? '' : String(selected)) ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

function openTaskSheet(id, preset = {}) {
  const s = getState();
  const existing = id ? getTask(id) : null;
  if (id && !existing) return;
  const base = existing || {
    title: '', notes: '', due: null, time: null, remind: null, important: false,
    listId: s.lists[0].id, repeat: 'none', subtasks: [], ...preset,
  };
  const draft = JSON.parse(JSON.stringify(base));
  const touched = new Set();
  let parsed = null;
  let parsingOn = !existing;

  const sheet = openSheet(`
    <form class="task-form" id="taskForm" novalidate>
      <div class="sheet-head">
        <h2>${existing ? 'עריכת משימה' : 'משימה חדשה'}</h2>
        <button type="button" class="icon-btn" data-close aria-label="סגירה">${icon('x')}</button>
      </div>
      <label class="sr-only" for="fTitle">מה צריך לעשות</label>
      <input id="fTitle" class="title-input" autocomplete="off" enterkeyhint="done" maxlength="200" placeholder="מה צריך לעשות?" value="${esc(draft.title)}">
      ${existing ? '' : `<p class="hint" id="parseHint">אפשר לכתוב הכל במשפט אחד, למשל: <b>להתקשר לרופא מחר ב-10:00 !</b></p>
        <div class="parse-chips" id="parseChips" aria-live="polite"></div>`}

      <div class="field-grid">
        <div class="field field-wide">
          <label for="fDue">${icon('calendar')}תאריך ושעה</label>
          <div class="date-row">
            <input type="date" id="fDue" value="${draft.due || ''}" aria-label="תאריך">
            <input type="time" id="fTime" value="${draft.time || ''}" aria-label="שעה">
          </div>
          <div class="quick" id="quickDue">
            <button type="button" data-due="today">היום</button>
            <button type="button" data-due="tomorrow">מחר</button>
            <button type="button" data-due="nextweek">שבוע הבא</button>
            <button type="button" data-due="none">ללא תאריך</button>
          </div>
        </div>
        <div class="field">
          <label for="fRemind">${icon('bell')}תזכורת</label>
          <select id="fRemind">${remindOptions(draft.remind)}</select>
        </div>
        <div class="field">
          <label for="fRepeat">${icon('repeat')}חזרה</label>
          <select id="fRepeat">${Object.entries(REPEATS).map(([v, l]) => `<option value="${v}" ${v === draft.repeat ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="fList">${icon('list')}רשימה</label>
          <select id="fList">${s.lists.map((l) => `<option value="${l.id}" ${l.id === draft.listId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        </div>
        <div class="field" style="justify-content:flex-end">
          <label class="switch" for="fImportant"><input type="checkbox" id="fImportant" role="switch" ${draft.important ? 'checked' : ''}>${icon('star')}חשוב</label>
        </div>
      </div>
      <p class="form-note" id="remindNote" hidden></p>

      <div class="field">
        <span class="field-label">${icon('subtasks')}תתי-משימות</span>
        <ul class="sub-edit" id="subEdit"></ul>
        <div class="sub-add">
          <label class="sr-only" for="fSubNew">תת-משימה חדשה</label>
          <input id="fSubNew" type="text" autocomplete="off" enterkeyhint="enter" placeholder="פריט חדש ברשימה">
          <button type="button" class="btn btn-soft btn-sm" id="subAddBtn">${icon('plus')}הוספה</button>
        </div>
      </div>

      <div class="field">
        <label for="fNotes">${icon('note')}הערות</label>
        <textarea id="fNotes" rows="3" placeholder="פרטים, קישורים, מספרי טלפון">${esc(draft.notes)}</textarea>
      </div>

      ${existing ? `<div class="sheet-tools">
        <button type="button" class="btn btn-ghost btn-sm" id="calBtn" aria-expanded="false">${icon('calendar')}הוספה ליומן</button>
        <button type="button" class="btn btn-ghost btn-sm is-danger-text" id="delBtn">${icon('trash')}מחיקה</button>
      </div>
      <div class="cal-menu" id="calMenu" hidden></div>` : ''}

      <div class="sheet-actions">
        <button type="button" class="btn btn-primary" data-save>${existing ? 'שמירה' : 'הוספת משימה'}</button>
      </div>
    </form>`, existing ? 'עריכת משימה' : 'משימה חדשה');

  const f = {
    title: $('#fTitle', sheet), due: $('#fDue', sheet), time: $('#fTime', sheet), remind: $('#fRemind', sheet),
    repeat: $('#fRepeat', sheet), list: $('#fList', sheet), important: $('#fImportant', sheet), notes: $('#fNotes', sheet),
  };

  const syncQuick = () => {
    const today = todayISO();
    const map = { today, tomorrow: addDays(today, 1), none: '' };
    $$('#quickDue button', sheet).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.due in map && map[b.dataset.due] === f.due.value)));
  };

  const syncNote = () => {
    const note = $('#remindNote', sheet);
    const remind = f.remind.value;
    let html = '';
    if (remind !== '' && !f.due.value) {
      html = 'כדי שהתזכורת תפעל צריך לבחור תאריך.';
    } else if (remind !== '' && !f.time.value) {
      html = 'בלי שעה, התזכורת תגיע ב-09:00.';
    }
    if (remind !== '' && f.due.value && notificationState() === 'default' && !isEmbedded) {
      html += `${html ? ' ' : ''}כדי לקבל התראה גם כשהאפליקציה ברקע, צריך לאשר התראות. <button type="button" class="btn btn-soft btn-sm" id="noteEnable">${icon('bell')}הפעלת התראות</button>`;
    }
    note.innerHTML = html;
    note.hidden = !html;
    $('#noteEnable', sheet)?.addEventListener('click', async () => {
      const result = await requestNotifications();
      toast(result === 'granted' ? 'ההתראות הופעלו' : 'ההתראות לא אושרו');
      syncNote();
    });
  };

  const renderSubs = () => {
    $('#subEdit', sheet).innerHTML = draft.subtasks.map((st, i) => `
      <li class="${st.done ? 'is-sub-done' : ''}" data-i="${i}">
        <input type="checkbox" class="check check-sm" data-sub-check ${st.done ? 'checked' : ''} aria-label="בוצע: ${esc(st.title)}">
        <input type="text" value="${esc(st.title)}" data-sub-title aria-label="תת-משימה ${i + 1}">
        <button type="button" class="icon-btn" data-sub-del aria-label="הסרת ${esc(st.title)}">${icon('x')}</button>
      </li>`).join('');
  };

  const addSub = () => {
    const input = $('#fSubNew', sheet);
    const title = input.value.trim();
    if (!title) return;
    draft.subtasks.push({ title, done: false });
    input.value = '';
    renderSubs();
    input.focus();
  };

  const listNameChip = (name) => (findList(name) ? `#${esc(findList(name).name)}` : `#${esc(name)} (רשימה חדשה)`);

  const applyParse = () => {
    if (!parsingOn) return;
    parsed = parseQuickAdd(f.title.value);
    const chips = [];
    if (parsed.due && !touched.has('due')) {
      f.due.value = parsed.due;
      chips.push(`${icon('calendar')}${relativeDay(parsed.due)}`);
    } else if (!touched.has('due')) f.due.value = draft.due || '';
    if (parsed.time && !touched.has('time')) {
      f.time.value = parsed.time;
      chips.push(`${icon('clock')}<span class="num">${parsed.time}</span>`);
    } else if (!touched.has('time')) f.time.value = draft.time || '';
    if (!touched.has('remind')) {
      const remind = parsed.remind ?? (f.time.value ? s.settings.defaultRemind : draft.remind);
      f.remind.value = remind == null ? '' : String(remind);
      if (parsed.remind != null || (parsed.time && remind != null)) chips.push(`${icon('bell')}תזכורת`);
    }
    if (!touched.has('repeat')) {
      f.repeat.value = parsed.repeat || draft.repeat;
      if (parsed.repeat) chips.push(`${icon('repeat')}${REPEATS[parsed.repeat]}`);
    }
    if (!touched.has('important')) {
      f.important.checked = !!parsed.important || draft.important;
      if (parsed.important) chips.push(`${icon('star')}חשוב`);
    }
    if (parsed.listName && !touched.has('list')) {
      const found = findList(parsed.listName);
      if (found) f.list.value = found.id;
      chips.push(`${icon('list')}${listNameChip(parsed.listName)}`);
    } else if (!touched.has('list')) f.list.value = draft.listId;
    const box = $('#parseChips', sheet);
    box.innerHTML = chips.length
      ? `${chips.map((c) => `<span class="parse-chip">${c}</span>`).join('')}<button type="button" class="link-btn" id="keepLiteral">להשאיר את הטקסט כמו שהוא</button>`
      : '';
    $('#keepLiteral', sheet)?.addEventListener('click', () => {
      parsingOn = false;
      parsed = null;
      box.innerHTML = '';
      $('#parseHint', sheet).hidden = true;
      f.due.value = touched.has('due') ? f.due.value : (draft.due || '');
      f.time.value = touched.has('time') ? f.time.value : (draft.time || '');
      f.title.focus();
      syncQuick();
      syncNote();
    });
    syncQuick();
    syncNote();
  };

  // Field wiring
  f.title.addEventListener('input', () => {
    f.title.classList.remove('is-invalid');
    applyParse();
  });
  [['due', f.due], ['time', f.time], ['remind', f.remind], ['repeat', f.repeat], ['list', f.list], ['important', f.important]].forEach(([key, el]) => {
    el.addEventListener('change', () => {
      touched.add(key);
      if (key === 'time' && !existing && !touched.has('remind') && f.time.value && f.remind.value === '') {
        f.remind.value = s.settings.defaultRemind == null ? '' : String(s.settings.defaultRemind);
      }
      if (key === 'repeat' && f.repeat.value !== 'none' && !f.due.value) {
        f.due.value = todayISO();
        touched.add('due');
      }
      syncQuick();
      syncNote();
    });
  });
  $('#quickDue', sheet).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-due]');
    if (!b) return;
    const today = todayISO();
    const value = { today, tomorrow: addDays(today, 1), nextweek: addDays(today, ((7 - new Date().getDay()) % 7) || 7), none: '' }[b.dataset.due];
    f.due.value = value;
    if (!value) f.time.value = '';
    touched.add('due');
    touched.add('time');
    syncQuick();
    syncNote();
  });

  $('#subEdit', sheet).addEventListener('input', (e) => {
    const li = e.target.closest('li');
    if (li && e.target.matches('[data-sub-title]')) draft.subtasks[li.dataset.i].title = e.target.value;
  });
  $('#subEdit', sheet).addEventListener('change', (e) => {
    const li = e.target.closest('li');
    if (li && e.target.matches('[data-sub-check]')) {
      draft.subtasks[li.dataset.i].done = e.target.checked;
      li.classList.toggle('is-sub-done', e.target.checked);
    }
  });
  $('#subEdit', sheet).addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li && e.target.closest('[data-sub-del]')) {
      draft.subtasks.splice(Number(li.dataset.i), 1);
      renderSubs();
    }
  });
  $('#subAddBtn', sheet).addEventListener('click', addSub);
  $('#fSubNew', sheet).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSub();
    }
  });

  if (existing) {
    $('#delBtn', sheet).addEventListener('click', () => {
      const removed = deleteTask(existing.id);
      closeSheet();
      if (removed) toast('המשימה נמחקה', () => restoreTask(removed));
    });
    $('#calBtn', sheet).addEventListener('click', () => {
      const menu = $('#calMenu', sheet);
      const btn = $('#calBtn', sheet);
      const current = { ...existing, ...collect() };
      if (!current.due) {
        menu.innerHTML = '<p>כדי להוסיף ליומן צריך לבחור תאריך.</p>';
      } else {
        const gUrl = googleCalendarUrl(current);
        menu.innerHTML = `<p>היומן של הטלפון ישלח את התזכורת גם כשהאפליקציה סגורה.</p>
          ${isEmbedded ? '' : `<button type="button" class="btn btn-ghost btn-sm" id="icsBtn">${icon('download')}קובץ ליומן הטלפון (iPhone, Outlook ועוד)</button>`}
          <a class="btn btn-ghost btn-sm" href="${esc(gUrl)}" target="_blank" rel="noopener">${icon('calendar')}פתיחה ב-Google Calendar</a>`;
        $('#icsBtn', sheet)?.addEventListener('click', () => {
          downloadFile(`${current.title.slice(0, 40) || 'task'}.ics`, buildICS(current), 'text/calendar;charset=utf-8');
        });
      }
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
  }

  function collect() {
    let title = f.title.value.trim();
    if (parsingOn && parsed && parsed.title) title = parsed.title;
    return {
      title,
      due: f.due.value || null,
      time: f.due.value ? (f.time.value || null) : null,
      remind: f.remind.value === '' ? null : Number(f.remind.value),
      repeat: f.repeat.value,
      listId: f.list.value,
      important: f.important.checked,
      notes: f.notes.value.trim(),
      subtasks: draft.subtasks.filter((st) => st.title.trim()).map((st) => ({ ...st, title: st.title.trim() })),
    };
  }

  onSave(sheet, f.title, () => {
    const pendingSub = $('#fSubNew', sheet).value.trim();
    if (pendingSub) draft.subtasks.push({ title: pendingSub, done: false });
    const data = collect();
    if (!data.title) {
      f.title.classList.add('is-invalid');
      f.title.focus();
      return;
    }
    if (parsingOn && parsed?.listName && !touched.has('list') && !findList(parsed.listName)) {
      data.listId = addList(parsed.listName).id;
    }
    if (existing) {
      updateTask(existing.id, { ...data, sample: false });
      toast('השינויים נשמרו');
    } else {
      const task = createTask(data);
      const day = task.due ? relativeDay(task.due) : '';
      toast(day ? `נוספה ל${/^\d/.test(day) ? '-' : ''}${day}` : 'המשימה נוספה');
    }
    closeSheet();
    reminderLoop?.schedule();
  });

  renderSubs();
  syncQuick();
  syncNote();
  if (!existing) setTimeout(() => f.title.focus(), 60);
}

// Saving runs from the button and from Enter in the main field, without relying on native form
// submission, which locked-down embedded frames can block.
function onSave(sheet, input, save) {
  $('form', sheet).addEventListener('submit', (e) => e.preventDefault());
  $('[data-save]', sheet).addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });
}

function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function openListSheet(id) {
  const list = id ? getList(id) : null;
  const s = getState();
  const color = list ? list.color : LIST_COLORS[s.lists.length % LIST_COLORS.length];
  const sheet = openSheet(`
    <form id="listForm" novalidate>
      <div class="sheet-head">
        <h2>${list ? 'עריכת רשימה' : 'רשימה חדשה'}</h2>
        <button type="button" class="icon-btn" data-close aria-label="סגירה">${icon('x')}</button>
      </div>
      <label class="sr-only" for="lName">שם הרשימה</label>
      <input id="lName" class="title-input" autocomplete="off" maxlength="40" placeholder="שם הרשימה, למשל: לימודים" value="${esc(list?.name || '')}">
      <div class="field" style="margin-top:18px">
        <span class="field-label">צבע</span>
        <div class="swatches">${LIST_COLORS.map((c) => `
          <label class="swatch" style="--dot: var(--c-${c})"><input type="radio" name="lColor" value="${c}" ${c === color ? 'checked' : ''} aria-label="${COLOR_NAMES[c] || c}"><span></span></label>`).join('')}
        </div>
      </div>
      ${list && s.lists.length > 1 ? `<div class="sheet-tools"><button type="button" class="btn btn-ghost btn-sm is-danger-text" id="lDelete">${icon('trash')}מחיקת הרשימה</button></div>` : ''}
      <div class="sheet-actions"><button type="button" class="btn btn-primary" data-save>${list ? 'שמירה' : 'יצירת רשימה'}</button></div>
    </form>`, list ? 'עריכת רשימה' : 'רשימה חדשה');

  const nameInput = $('#lName', sheet);
  setTimeout(() => nameInput.focus(), 60);
  $('#lDelete', sheet)?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const count = s.tasks.filter((t) => t.listId === list.id).length;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      const target = s.lists.find((l) => l.id !== list.id).name;
      btn.innerHTML = `${icon('trash')}${count ? `למחוק? ${count} המשימות יעברו ל"${esc(target)}"` : 'ללחוץ שוב כדי למחוק'}`;
      btn.classList.add('btn-danger');
      btn.classList.remove('btn-ghost', 'is-danger-text');
      return;
    }
    deleteList(list.id);
    ui.listFilter = 'all';
    saveUiPrefs();
    closeSheet();
    toast('הרשימה נמחקה');
  });
  onSave(sheet, nameInput, () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.classList.add('is-invalid');
      nameInput.focus();
      return;
    }
    const chosen = $('input[name="lColor"]:checked', sheet)?.value;
    if (list) updateList(list.id, { name, color: chosen });
    else {
      const created = addList(name, chosen);
      ui.listFilter = created.id;
      saveUiPrefs();
      render();
    }
    closeSheet();
  });
}

// ---------- Settings ----------

function notificationSection() {
  const state = notificationState();
  if (isEmbedded) {
    return `<p class="set-note">כאן זו תצוגה מקדימה. התראות עובדות כשפותחים את העוזר ישירות בדפדפן או מהמסך הבית. בינתיים תזכורות יופיעו בתוך הדף עם צליל.</p>`;
  }
  if (state === 'unsupported') {
    return isIOS && !isStandalone()
      ? '<p class="set-note">ב-iPhone ההתראות עובדות אחרי שמוסיפים את העוזר למסך הבית (ראו "התקנה" למטה).</p>'
      : '<p class="set-note">הדפדפן הזה לא תומך בהתראות. תזכורות יופיעו בתוך האפליקציה עם צליל.</p>';
  }
  if (state === 'granted') {
    return `<div class="set-row"><span class="status is-on">ההתראות פעילות</span>
      <button type="button" class="btn btn-ghost btn-sm" id="testNotif">${icon('bell')}התראת ניסיון</button></div>`;
  }
  if (state === 'denied') {
    return `<div class="set-row"><span class="status is-off">ההתראות חסומות</span></div>
      <p class="set-note">כדי לאפשר אותן, פתחו את הגדרות האתר בדפדפן (סמל המנעול ליד הכתובת) ואשרו התראות.</p>`;
  }
  return `<div class="set-row"><p>קבלו התראה על הטלפון כשמגיע זמן של תזכורת.</p>
    <button type="button" class="btn btn-primary btn-sm" id="enableNotif">${icon('bell')}הפעלת התראות</button></div>`;
}

function installSection() {
  if (isStandalone()) return '<p class="set-note"><span class="status is-on">העוזר מותקן במכשיר</span></p>';
  if (installPrompt) {
    return `<div class="set-row"><p>התקנה מוסיפה אייקון למסך הבית ופותחת את העוזר כמו אפליקציה רגילה.</p>
      <button type="button" class="btn btn-primary btn-sm" id="installBtn">${icon('phone')}התקנה</button></div>`;
  }
  if (isIOS) return '<p class="set-note">ב-Safari: לחצו על כפתור השיתוף (ריבוע עם חץ למעלה) ואז על "הוספה למסך הבית".</p>';
  return '<p class="set-note">בתפריט הדפדפן בחרו "התקנת אפליקציה" או "הוספה למסך הבית".</p>';
}

function openSettings() {
  const sheet = openSheet('<div id="settingsBody"></div>', 'הגדרות');
  const draw = () => {
    const s = getState();
    const doneCount = s.tasks.filter((t) => t.done).length;
    $('#settingsBody', sheet).innerHTML = `
      <div class="sheet-head">
        <h2>הגדרות</h2>
        <button type="button" class="icon-btn" data-close aria-label="סגירה">${icon('x')}</button>
      </div>
      <section class="set-section">
        <h3>התראות</h3>
        ${notificationSection()}
        <div class="set-row">
          <label for="sDefaultRemind">תזכורת אוטומטית למשימה עם שעה</label>
          <select id="sDefaultRemind" class="text-input">${remindOptions(s.settings.defaultRemind)}</select>
        </div>
        <label class="switch" for="sSound"><input type="checkbox" id="sSound" role="switch" ${s.settings.sound ? 'checked' : ''}>צליל כשתזכורת מופיעה</label>
        <p class="set-note">תזכורות מגיעות כשהעוזר פתוח או ברקע. כדי שתזכורת תגיע גם כשהוא סגור לגמרי, אפשר להוסיף את המשימה ליומן של הטלפון מתוך מסך העריכה שלה.</p>
      </section>
      <section class="set-section">
        <h3>מראה</h3>
        <div class="segmented" role="radiogroup" aria-label="ערכת צבעים">
          ${[['auto', 'לפי המכשיר'], ['light', 'בהיר'], ['dark', 'כהה']].map(([v, l]) => `
            <label><input type="radio" name="sTheme" value="${v}" ${s.settings.theme === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
      </section>
      <section class="set-section">
        <h3>התקנה</h3>
        ${installSection()}
      </section>
      <section class="set-section">
        <h3>גיבוי</h3>
        <p class="set-note">המשימות נשמרות רק במכשיר הזה. כדאי לשמור גיבוי מדי פעם, או כדי להעביר אותן לטלפון אחר.</p>
        ${isEmbedded ? '<p class="set-note">שמירת גיבוי לקובץ זמינה כשפותחים את העוזר ישירות בדפדפן.</p>' : `<div class="set-row" style="justify-content:flex-start">
          <button type="button" class="btn btn-ghost btn-sm" id="exportBtn">${icon('download')}שמירת גיבוי</button>
          <label class="btn btn-ghost btn-sm" for="importFile">${icon('upload')}שחזור מגיבוי</label>
          <input type="file" id="importFile" accept="application/json,.json" hidden>
        </div>`}
      </section>
      <section class="set-section">
        <h3>ניקוי</h3>
        <div class="set-row">
          <p>${doneCount ? `${doneCount} משימות שהושלמו שמורות כרגע.` : 'אין משימות שהושלמו.'}</p>
          <button type="button" class="btn btn-ghost btn-sm is-danger-text" id="clearDone" ${doneCount ? '' : 'disabled'}>${icon('trash')}מחיקת המשימות שהושלמו</button>
        </div>
      </section>`;
    wire();
  };

  const wire = () => {
    $('#enableNotif', sheet)?.addEventListener('click', async () => {
      const result = await requestNotifications();
      toast(result === 'granted' ? 'ההתראות הופעלו' : 'ההתראות לא אושרו');
      draw();
    });
    $('#testNotif', sheet)?.addEventListener('click', async () => {
      const ok = await showSystemNotification('התראת ניסיון מהעוזר', { body: 'ככה ייראו התזכורות שלך.', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', lang: 'he', dir: 'rtl', tag: 'test' });
      if (!ok) toast('לא הצלחתי להציג התראה במכשיר הזה');
    });
    $('#installBtn', sheet)?.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      draw();
    });
    $('#sDefaultRemind', sheet).addEventListener('change', (e) => {
      updateSettings({ defaultRemind: e.target.value === '' ? null : Number(e.target.value) });
    });
    $('#sSound', sheet).addEventListener('change', (e) => {
      updateSettings({ sound: e.target.checked });
      if (e.target.checked) {
        unlockAudio();
        chime();
      }
    });
    $$('input[name="sTheme"]', sheet).forEach((r) => r.addEventListener('change', () => {
      updateSettings({ theme: r.value });
      applyTheme();
    }));
    $('#exportBtn', sheet)?.addEventListener('click', () => {
      downloadFile(`ozer-backup-${todayISO()}.json`, exportData(), 'application/json');
      toast('קובץ הגיבוי נשמר');
    });
    $('#importFile', sheet)?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const count = importData(await file.text());
        toast(`שוחזרו ${count} משימות`);
        draw();
      } catch (err) {
        toast(err.message && /[א-ת]/.test(err.message) ? err.message : 'לא הצלחתי לקרוא את הקובץ. צריך לבחור קובץ גיבוי של העוזר.');
      }
    });
    $('#clearDone', sheet).addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = 'ללחוץ שוב כדי למחוק';
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-ghost', 'is-danger-text');
        return;
      }
      const removed = clearCompleted();
      toast(`נמחקו ${removed.length} משימות`, () => restoreTasks(removed));
      draw();
    });
  };

  draw();
}

// ---------- Theme ----------

let themeOwned = false;
function applyTheme() {
  const theme = getState().settings.theme;
  const root = document.documentElement;
  if (theme === 'auto') {
    if (themeOwned) root.removeAttribute('data-theme');
    themeOwned = false;
  } else {
    root.setAttribute('data-theme', theme);
    themeOwned = true;
  }
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  $$('meta[name="theme-color"]').forEach((m) => {
    if (!m.dataset.original) m.dataset.original = m.content;
    m.content = theme === 'auto' ? m.dataset.original : bg;
  });
}

// ---------- Events ----------

function wireEvents() {
  const main = $('#main');

  main.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.matches('input')) return;
    const id = el.closest('.task')?.dataset.id;
    switch (el.dataset.act) {
      case 'open': openTaskSheet(id); break;
      case 'star': {
        const t = getTask(id);
        if (t) updateTask(id, { important: !t.important });
        break;
      }
      case 'expand':
        if (ui.expanded.has(id)) ui.expanded.delete(id);
        else ui.expanded.add(id);
        render();
        break;
      case 'toggle-done':
        ui.showDone = !ui.showDone;
        render();
        break;
      case 'add': {
        let preset = {};
        try { preset = JSON.parse(el.dataset.preset || '{}'); } catch { /* keep empty */ }
        openTaskSheet(null, preset);
        break;
      }
      case 'delete-samples': {
        const removed = deleteSamples();
        toast('הדוגמאות נמחקו', () => restoreTasks(removed));
        break;
      }
      case 'list-filter':
        ui.listFilter = el.dataset.list;
        saveUiPrefs();
        render();
        break;
      case 'list-add': openListSheet(null); break;
      case 'list-edit': openListSheet(el.dataset.list); break;
      default: break;
    }
  });

  main.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act === 'toggle') onToggle(el);
    if (el.dataset.act === 'subtoggle') toggleSubtask(el.closest('.task').dataset.id, el.dataset.sub);
  });

  main.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.task-main')) {
      e.preventDefault();
      openTaskSheet(e.target.closest('.task').dataset.id);
    }
  });

  $$('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#fab').addEventListener('click', () => openTaskSheet(null, presetForView()));
  $('#settingsBtn').addEventListener('click', openSettings);

  $('#searchBtn').addEventListener('click', () => {
    const row = $('#searchRow');
    if (row.hidden) {
      row.hidden = false;
      $('#searchBtn').setAttribute('aria-expanded', 'true');
      $('#searchInput').focus();
    } else {
      closeSearch();
    }
  });
  $('#searchInput').addEventListener('input', (e) => {
    ui.query = e.target.value.trim();
    render();
  });
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
  });

  $('#sheetRoot').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#sheetRoot').hidden) closeSheet();
  });

  $('#alerts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-alert]');
    if (!btn) return;
    const id = btn.closest('.alert').dataset.id;
    if (btn.dataset.alert === 'dismiss') {
      ui.alerts = ui.alerts.filter((x) => x !== id);
      renderAlerts();
    } else {
      handleReminderAction(btn.dataset.alert, id);
    }
  });

  window.addEventListener('scroll', () => {
    $('#topbar').classList.toggle('is-scrolled', window.scrollY > 4);
  }, { passive: true });

  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { fromHash: true }));

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY_NAME) reloadFromStorage();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });

  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // Re-render when the date changes while the app stays open.
  setInterval(() => {
    if (todayISO() !== renderedDay) render();
  }, 30000);

  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
}

function registerServiceWorker() {
  try {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('./sw.js').then(setServiceWorker).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'reminder-action') handleReminderAction(e.data.action, e.data.id);
    });
  } catch {
    // Service workers are unavailable in some embedded views.
  }
}

function handleLaunchParams() {
  let params;
  try { params = new URLSearchParams(location.search); } catch { return; }
  const action = params.get('action');
  const taskId = params.get('task');
  if (!params.has('new') && !action) return;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* sandboxed */ }
  if (params.has('new')) openTaskSheet(null, presetForView());
  else if (action && taskId) handleReminderAction(action, taskId);
}

function boot() {
  $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  loadState();
  loadUiPrefs();
  applyTheme();
  const hashView = location.hash.slice(1);
  if (VIEWS[hashView]) ui.view = hashView;
  subscribe(() => {
    render();
    reminderLoop?.schedule();
  });
  wireEvents();
  render();
  registerServiceWorker();
  reminderLoop = startReminderLoop({ getTasks: () => getState().tasks, onDue: onRemindersDue });
  handleLaunchParams();
}

boot();
