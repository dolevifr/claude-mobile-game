// Push reminders: subscribes this phone with the push server and keeps the server's copy of
// upcoming reminders in sync, so they arrive even when the app is closed.

import { PUSH_SERVER } from './config.js';
import { DAY_MS, computeRemindAt, nextOccurrence, relativeDay } from './dates.js';

const PUSH_KEY = 'ozer:push';
const MAX_REMINDERS = 250;
const HORIZON_DAYS = 14;

let pushState = readPushState();
let prepared = null;
let syncTimer = null;

function readPushState() {
  try {
    return JSON.parse(localStorage.getItem(PUSH_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePushState(patch) {
  pushState = { ...pushState, ...patch };
  try { localStorage.setItem(PUSH_KEY, JSON.stringify(pushState)); } catch { /* kept in memory */ }
}

export const getPushState = () => pushState;
export const pushServerConfigured = () => !!PUSH_SERVER;
export const pushActive = () => !!(PUSH_SERVER && pushState.enabled && !pushState.gone);

export function pushSupport() {
  if (!PUSH_SERVER) return 'no-server';
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return 'ok';
}

// Every upcoming reminder, including the next two weeks of a repeating task, so reminders keep
// coming even on days the app is not opened.
export function buildSchedule(tasks, now = Date.now()) {
  const items = [];
  const horizon = now + HORIZON_DAYS * DAY_MS;
  const entry = (t, due, at) => {
    const label = relativeDay(due, new Date(at));
    return { id: `${t.id}:${due}`, taskId: t.id, at, title: t.title.slice(0, 150), body: t.time ? `${label} · ${t.time}` : label };
  };
  for (const t of tasks) {
    if (t.done || t.remind == null || !t.due) continue;
    if (t.remindAt && !t.notifiedAt && t.remindAt > now - 30000) items.push(entry(t, t.due, t.remindAt));
    if (t.repeat && t.repeat !== 'none') {
      let due = t.due;
      for (let i = 0; i < 60; i++) {
        due = nextOccurrence(due, t.repeat);
        const at = computeRemindAt({ ...t, due });
        if (at > horizon) break;
        if (at > now) items.push(entry(t, due, at));
      }
    }
  }
  return items.sort((a, b) => a.at - b.at).slice(0, MAX_REMINDERS);
}

async function api(path, options = {}) {
  const res = await fetch(`${PUSH_SERVER}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server error ${res.status}`);
  return data;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function keyBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
}

function sameKey(subscription, key) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

// Loads everything subscribing needs ahead of time, so the tap on "enable" goes straight to the
// permission prompt (Safari only shows it in direct response to a tap).
export async function preparePush() {
  if (pushSupport() !== 'ok') return null;
  const [reg, { publicKey }] = await Promise.all([withTimeout(navigator.serviceWorker.ready, 8000), api('/vapid-key')]);
  prepared = { reg, key: keyBytes(publicKey), existing: await reg.pushManager.getSubscription() };
  return prepared;
}

export async function enablePush(tasks) {
  if (!prepared) await preparePush();
  if (!prepared) return { ok: false, reason: 'unsupported' };
  const { reg, key, existing } = prepared;
  let subscription = existing && sameKey(existing, key) ? existing : null;
  try {
    if (existing && !subscription) await existing.unsubscribe();
    if (!subscription) subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (err) {
    prepared = null;
    const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
    return { ok: false, reason: denied ? 'denied' : 'failed', message: err.message };
  }
  const deviceId = pushState.deviceId || crypto.randomUUID();
  await api(`/devices/${deviceId}/subscription`, { method: 'PUT', body: JSON.stringify(subscription.toJSON()) });
  savePushState({ deviceId, enabled: true, gone: false, error: null, lastHash: null });
  prepared = { ...prepared, existing: subscription };
  await syncNow(tasks, { force: true });
  return { ok: true };
}

export async function disablePush() {
  const { deviceId } = pushState;
  savePushState({ enabled: false, lastHash: null, scheduled: 0, next: null });
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 5000);
    await (await reg.pushManager.getSubscription())?.unsubscribe();
  } catch { /* already gone */ }
  if (deviceId) await api(`/devices/${deviceId}`, { method: 'DELETE' }).catch(() => {});
}

export async function sendTestPush() {
  return api(`/devices/${pushState.deviceId}/test`, { method: 'POST' });
}

function applyStatus(status, extra = {}) {
  savePushState({
    scheduled: status.scheduled,
    next: status.next,
    gone: status.gone || !status.subscribed,
    error: null,
    lastSync: Date.now(),
    ...extra,
  });
}

export async function syncNow(tasks, { force = false } = {}) {
  if (!pushActive() || !pushState.deviceId) return pushState;
  const reminders = buildSchedule(tasks);
  const hash = JSON.stringify(reminders.map((r) => [r.id, r.at, r.title, r.body]));
  if (!force && hash === pushState.lastHash && !pushState.error) return pushState;
  try {
    const status = await api(`/devices/${pushState.deviceId}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders }) });
    applyStatus(status, { lastHash: hash });
  } catch {
    savePushState({ error: 'offline', lastHash: null });
  }
  return pushState;
}

export function scheduleSync(getTasks, onDone) {
  if (!pushActive()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => onDone?.(await syncNow(getTasks())), 1200);
}

// On app start: make sure the phone is still subscribed and the server has its current subscription.
export async function refreshPush(tasks) {
  if (!PUSH_SERVER || !pushState.enabled || pushSupport() !== 'ok') return pushState;
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 8000);
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      savePushState({ gone: true });
      return pushState;
    }
    applyStatus(await api(`/devices/${pushState.deviceId}/subscription`, { method: 'PUT', body: JSON.stringify(subscription.toJSON()) }));
    return await syncNow(tasks, { force: true });
  } catch {
    savePushState({ error: 'offline' });
    return pushState;
  }
}
