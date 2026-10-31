// Reminder push server. Each phone gets a Durable Object that stores its push subscription and its
// upcoming reminders, and sets an alarm for the next one, so notifications go out on time even
// when the app is closed.

import { DurableObject } from 'cloudflare:workers';
import { generateVapidKeys, sendPush } from './webpush.js';

const MAX_REMINDERS = 300;
const MAX_BODY_BYTES = 256 * 1024;
const LATE_LIMIT_MS = 6 * 3600 * 1000; // reminders older than this (after an outage) are dropped
const RETRY_MS = 60 * 1000;
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.googleapis\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validSubscription(sub, env) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  let url;
  try { url = new URL(sub.endpoint); } catch { return false; }
  if (env.ALLOW_ANY_PUSH_ENDPOINT === '1') return true; // local testing against a mock push service
  return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

function cleanReminder(r) {
  if (!r || typeof r.id !== 'string' || !Number.isFinite(r.at)) return null;
  return {
    id: r.id.slice(0, 100),
    taskId: String(r.taskId || '').slice(0, 60),
    at: Math.round(r.at),
    title: String(r.title || 'תזכורת').slice(0, 200),
    body: String(r.body || '').slice(0, 200),
  };
}

export class VapidKeys extends DurableObject {
  async get() {
    return this.ctx.blockConcurrencyWhile(async () => {
      let keys = await this.ctx.storage.get('keys');
      if (!keys) {
        keys = await generateVapidKeys();
        await this.ctx.storage.put('keys', keys);
      }
      return keys;
    });
  }
}

const vapidKeys = (env) => env.KEYS.get(env.KEYS.idFromName('global')).get();

export class Device extends DurableObject {
  async setSubscription(subscription) {
    if (!validSubscription(subscription, this.env)) throw new HttpError(400, 'invalid subscription');
    await this.ctx.storage.put('subscription', { endpoint: subscription.endpoint, keys: subscription.keys });
    await this.ctx.storage.delete('gone');
    return this.status();
  }

  async setReminders(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'reminders must be a list');
    const now = Date.now();
    const sent = await this.recentlySent(now);
    const reminders = list.map(cleanReminder)
      .filter((r) => r && r.at > now - LATE_LIMIT_MS && !sent[`${r.id}@${r.at}`])
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_REMINDERS);
    await this.ctx.storage.put('reminders', reminders);
    await this.armAlarm(reminders);
    return this.status();
  }

  async alarm() {
    const now = Date.now();
    const reminders = (await this.ctx.storage.get('reminders')) || [];
    const due = reminders.filter((r) => r.at <= now + 1000);
    const rest = reminders.filter((r) => r.at > now + 1000);
    const sent = await this.recentlySent(now);
    for (const r of due) {
      if (now - r.at > LATE_LIMIT_MS) continue;
      const result = await this.push({ type: 'reminder', id: r.id, taskId: r.taskId, title: r.title, body: r.body });
      if (result.ok || result.gone) {
        sent[`${r.id}@${r.at}`] = now;
      } else if ((r.attempts || 0) < 3) {
        rest.push({ ...r, at: now + RETRY_MS, attempts: (r.attempts || 0) + 1 });
      }
      if (result.gone) break;
    }
    rest.sort((a, b) => a.at - b.at);
    await this.ctx.storage.put({ reminders: rest, sent });
    await this.armAlarm(rest);
  }

  async push(payload) {
    const subscription = await this.ctx.storage.get('subscription');
    if (!subscription) return { ok: false, reason: 'no-subscription' };
    let res;
    try {
      res = await sendPush(subscription, JSON.stringify(payload), {
        keys: await vapidKeys(this.env),
        subject: this.env.VAPID_SUBJECT,
      });
    } catch (err) {
      await this.ctx.storage.put('lastError', { message: String(err.message || err), at: Date.now() });
      return { ok: false, reason: 'network' };
    }
    if (res.status === 404 || res.status === 410) {
      // The phone revoked permission or the subscription expired; the app re-subscribes on next open.
      await this.ctx.storage.delete('subscription');
      await this.ctx.storage.put('gone', true);
      return { ok: false, gone: true, status: res.status };
    }
    if (!res.ok) {
      await this.ctx.storage.put('lastError', { status: res.status, message: (await res.text()).slice(0, 300), at: Date.now() });
      return { ok: false, status: res.status };
    }
    await this.ctx.storage.put('lastSent', Date.now());
    await this.ctx.storage.delete('lastError');
    return { ok: true, status: res.status };
  }

  async test() {
    const result = await this.push({ type: 'test', title: 'התראת ניסיון מהעוזר', body: 'מעולה! התזכורות יגיעו גם כשהאפליקציה סגורה.' });
    return { ...result, ...(await this.status()) };
  }

  async status() {
    const [subscription, reminders, gone, lastError, lastSent] = await Promise.all(
      ['subscription', 'reminders', 'gone', 'lastError', 'lastSent'].map((k) => this.ctx.storage.get(k)),
    );
    const list = reminders || [];
    return {
      subscribed: !!subscription,
      gone: !!gone,
      scheduled: list.length,
      next: list[0]?.at ?? null,
      lastSent: lastSent || null,
      lastError: lastError || null,
    };
  }

  async remove() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  async armAlarm(reminders) {
    if (reminders.length) await this.ctx.storage.setAlarm(Math.max(reminders[0].at, Date.now()));
    else await this.ctx.storage.deleteAlarm();
  }

  // Delivered reminders are remembered for two days so a re-sync from the app cannot send them twice.
  async recentlySent(now) {
    const sent = (await this.ctx.storage.get('sent')) || {};
    for (const [key, at] of Object.entries(sent)) if (now - at > 2 * 86400 * 1000) delete sent[key];
    return sent;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (allowed.includes('*') || allowed.includes(origin))) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/') return json({ ok: true, service: 'ozer-push' });
      if (pathname === '/api/vapid-key' && request.method === 'GET') {
        return json({ publicKey: (await vapidKeys(env)).publicKey });
      }
      // The device id is a random UUID made on the phone; knowing it is what grants access.
      const m = pathname.match(/^\/api\/devices\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(subscription|reminders|test|status))?$/i);
      if (m) {
        const device = env.DEVICES.get(env.DEVICES.idFromName(m[1].toLowerCase()));
        const action = m[2] || '';
        const route = `${request.method} ${action}`;
        if (route === 'PUT subscription') return json(await device.setSubscription(await readJson(request)));
        if (route === 'PUT reminders') return json(await device.setReminders((await readJson(request)).reminders));
        if (route === 'POST test') return json(await device.test());
        if (route === 'GET status') return json(await device.status());
        if (route === 'DELETE ') return json(await device.remove());
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      const status = err.status || (/invalid|must be/.test(err.message) ? 400 : 500);
      return json({ error: err.message || 'server error' }, status);
    }
  },
};
