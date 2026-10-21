import { buildPushPayload } from '@block65/webcrypto-web-push';

// Multi-user background worker.
// Each device registers with its own random secret (sent as a Bearer token). The worker stores
// one record per secret (hashed) holding that user's watchlist and push subscription(s), so users
// never see or overwrite each other's data. Stock prices are public, so one Torn API call
// (using the owner's TORN_API_KEY) serves every user on each cron run.

const LEGACY_KEY = 'background-config'; // single-user record from the old version of this worker
const USER_PREFIX = 'u:';
const DEFAULT_MAX_USERS = 100;
const MAX_SUBSCRIPTIONS = 5;
const MAX_BODY_BYTES = 64 * 1024;
const INACTIVE_MS = 90 * 24 * 60 * 60 * 1000;
// Only real browser push services are allowed, so nobody can make this worker POST to arbitrary URLs.
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), env);
    if (route === 'GET /api/push-key') return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, env);
    if (!['PUT /api/watchlist', 'POST /api/subscription', 'DELETE /api/background'].includes(route)) {
      return json({ error: 'Not found' }, 404, env);
    }

    const secret = getSecret(request);
    if (!secret) return json({ error: 'Unauthorized' }, 401, env);
    const key = await userKey(secret);

    if (route === 'DELETE /api/background') {
      await env.BACKGROUND_STATE.delete(key);
      if (await isOwnerSecret(secret, env)) await env.BACKGROUND_STATE.delete(LEGACY_KEY);
      return json({ disabled: true }, 200, env);
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413, env);
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Invalid JSON' }, 400, env);
    }

    let user = await loadUser(env, key, secret);
    if (!user) {
      if (!await hasRoomForNewUser(env)) {
        return json({ error: 'Background alerts are full right now. Try again later, or deploy your own worker.' }, 503, env);
      }
      user = { watches: [], subscriptions: [], lastSeen: Date.now() };
    }
    user.lastSeen = Date.now();

    if (route === 'PUT /api/watchlist') {
      if (!body || !Array.isArray(body.watches)) return json({ error: 'watches must be an array' }, 400, env);
      user.watches = sanitizeWatches(body.watches, user.watches);
      await saveUser(env, key, user);
      return json({ saved: user.watches.length }, 200, env);
    }

    // POST /api/subscription
    if (!validSubscription(body)) return json({ error: 'Invalid push subscription' }, 400, env);
    const clean = { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } };
    user.subscriptions = (user.subscriptions || []).filter(item => item.endpoint !== clean.endpoint);
    user.subscriptions.push(clean);
    user.subscriptions = user.subscriptions.slice(-MAX_SUBSCRIPTIONS);
    await saveUser(env, key, user);
    return json({ subscribed: true }, 200, env);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkStocks(env));
  }
};

async function checkStocks(env) {
  if (!env.TORN_API_KEY) throw new Error('TORN_API_KEY is not configured');
  const entries = await loadAllUsers(env);
  const now = Date.now();
  const active = [];
  for (const entry of entries) {
    if (entry.key !== LEGACY_KEY && now - (Number(entry.user.lastSeen) || 0) > INACTIVE_MS) {
      await env.BACKGROUND_STATE.delete(entry.key); // abandoned device: clean it up
      continue;
    }
    if (entry.user.watches?.length) active.push(entry);
  }
  if (!active.length) return;

  const response = await fetch(`https://api.torn.com/torn/?selections=stocks&key=${encodeURIComponent(env.TORN_API_KEY)}`);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.error || `Torn API returned ${response.status}`);

  for (const entry of active) {
    try {
      if (await evaluateUser(env, entry.user, data.stocks)) await saveUser(env, entry.key, entry.user);
    } catch (error) {
      console.error('Failed to process one user', error); // one bad record must not block everyone else
    }
  }
}

async function evaluateUser(env, user, stocks) {
  let changed = false;
  const subscriptionsBefore = user.subscriptions?.length || 0;
  for (const watch of user.watches) {
    const stock = stocks?.[watch.stockId];
    if (!stock) continue;
    const price = Number(stock.current_price);
    if (!Number.isFinite(price)) continue;
    const snoozed = Number(watch.snoozedUntil) > Date.now();
    const rules = [];
    if (watch.low !== null) rules.push({ name: 'Low', target: watch.low, hit: price <= watch.low, reset: price > watch.low, title: 'hit your low', body: `Now $${price.toFixed(2)}, at or below $${watch.low}.` });
    if (watch.high !== null) rules.push({ name: 'High', target: watch.high, hit: price >= watch.high, reset: price < watch.high, title: 'hit your high', body: `Now $${price.toFixed(2)}, at or above $${watch.high}.` });
    if (watch.pctDropBase !== null && watch.pctDropPct !== null) {
      const target = watch.pctDropBase * (1 - watch.pctDropPct / 100);
      rules.push({ name: 'PctDrop', target, hit: price <= target, reset: price > target, title: `dropped ${watch.pctDropPct}%`, body: `Now $${price.toFixed(2)}, down from $${watch.pctDropBase.toFixed(2)}.` });
    }
    if (watch.pctRiseBase !== null && watch.pctRisePct !== null) {
      const target = watch.pctRiseBase * (1 + watch.pctRisePct / 100);
      rules.push({ name: 'PctRise', target, hit: price >= target, reset: price < target, title: `rose ${watch.pctRisePct}%`, body: `Now $${price.toFixed(2)}, up from $${watch.pctRiseBase.toFixed(2)}.` });
    }

    for (const rule of rules) {
      const armedName = `armed${rule.name}`;
      if (rule.reset && !watch[armedName]) {
        watch[armedName] = true;
        changed = true;
      } else if (rule.hit && watch[armedName] && (snoozed || await sendPush(user, env, `${watch.acronym} ${rule.title}`, rule.body))) {
        watch[armedName] = false;
        changed = true;
      }
    }
  }
  if ((user.subscriptions?.length || 0) !== subscriptionsBefore) changed = true; // expired subscriptions were pruned
  return changed;
}

async function sendPush(user, env, title, body) {
  if (!user.subscriptions?.length) return false;
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  let delivered = false;
  const remaining = [];
  for (const subscription of user.subscriptions) {
    try {
      const payload = await buildPushPayload({ data: JSON.stringify({ title, body }), options: { ttl: 300 } }, subscription, vapid);
      const pushResponse = await fetch(subscription.endpoint, payload);
      if (pushResponse.status === 404 || pushResponse.status === 410) continue;
      if (pushResponse.ok) delivered = true;
      remaining.push(subscription);
    } catch {
      remaining.push(subscription);
    }
  }
  user.subscriptions = remaining;
  return delivered;
}

function sanitizeWatches(incoming, previous) {
  const oldById = new Map((previous || []).map(watch => [watch.stockId, watch]));
  return incoming.slice(0, 100).flatMap(item => {
    const stockId = String(item.stockId || '');
    if (!/^\d+$/.test(stockId)) return [];
    const old = oldById.get(stockId);
    const watch = { stockId, acronym: String(item.acronym || stockId).slice(0, 12) };
    for (const field of ['low', 'high', 'pctDropPct', 'pctDropBase', 'pctRisePct', 'pctRiseBase', 'snoozedUntil']) {
      const value = item[field];
      watch[field] = value === null || value === undefined || value === '' ? null : Number(value);
      if (watch[field] !== null && !Number.isFinite(watch[field])) watch[field] = null;
    }
    for (const [armedName, fields] of Object.entries({
      armedLow: ['low'],
      armedHigh: ['high'],
      armedPctDrop: ['pctDropPct', 'pctDropBase'],
      armedPctRise: ['pctRisePct', 'pctRiseBase']
    })) {
      const unchanged = old && fields.every(field => old[field] === watch[field]);
      watch[armedName] = unchanged ? old[armedName] !== false : true;
    }
    return [watch];
  });
}

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return false;
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
  if (sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100) return false;
  let endpoint;
  try { endpoint = new URL(sub.endpoint); } catch { return false; }
  if (endpoint.protocol !== 'https:') return false;
  return PUSH_HOST_SUFFIXES.some(suffix => endpoint.hostname === suffix || endpoint.hostname.endsWith(`.${suffix}`));
}

function getSecret(request) {
  const match = /^Bearer (\S{16,200})$/.exec(request.headers.get('Authorization') || '');
  return match ? match[1] : null;
}

async function userKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return USER_PREFIX + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// The owner's original BACKGROUND_TOKEN keeps working as their personal secret, and their
// existing single-user watchlist/subscriptions are migrated to a normal user record on first use.
async function isOwnerSecret(secret, env) {
  return !!env.BACKGROUND_TOKEN && await userKey(secret) === await userKey(env.BACKGROUND_TOKEN);
}

async function loadUser(env, key, secret) {
  const existing = await env.BACKGROUND_STATE.get(key, 'json');
  if (existing) return existing;
  if (!await isOwnerSecret(secret, env)) return null;
  const legacy = await env.BACKGROUND_STATE.get(LEGACY_KEY, 'json');
  if (!legacy) return null;
  const user = { watches: legacy.watches || [], subscriptions: legacy.subscriptions || [], lastSeen: Date.now() };
  await saveUser(env, key, user);
  await env.BACKGROUND_STATE.delete(LEGACY_KEY);
  return user;
}

async function saveUser(env, key, user) {
  await env.BACKGROUND_STATE.put(key, JSON.stringify(user));
}

async function loadAllUsers(env) {
  const names = [];
  let cursor;
  do {
    const page = await env.BACKGROUND_STATE.list({ prefix: USER_PREFIX, cursor });
    names.push(...page.keys.map(item => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const entries = await Promise.all(names.map(async key => ({ key, user: await env.BACKGROUND_STATE.get(key, 'json') })));
  const legacy = await env.BACKGROUND_STATE.get(LEGACY_KEY, 'json');
  if (legacy) entries.push({ key: LEGACY_KEY, user: { watches: legacy.watches || [], subscriptions: legacy.subscriptions || [], lastSeen: Date.now() } });
  return entries.filter(entry => entry.user);
}

async function hasRoomForNewUser(env) {
  const max = Math.min(Number(env.MAX_USERS) || DEFAULT_MAX_USERS, 1000);
  const page = await env.BACKGROUND_STATE.list({ prefix: USER_PREFIX, limit: max });
  return page.keys.length < max;
}

function json(value, status, env) {
  return withCors(new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }), env);
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.APP_ORIGIN || 'https://tornstockalert.duckdns.org');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
