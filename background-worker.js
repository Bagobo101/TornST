import { buildPushPayload } from '@block65/webcrypto-web-push';

const CONFIG_KEY = 'background-config';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), env);
    if (url.pathname === '/api/push-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, env);
    }
    if (url.pathname === '/api/watchlist' && request.method === 'PUT') {
      if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401, env);
      let incoming;
      try {
        incoming = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, env);
      }
      if (!Array.isArray(incoming.watches)) return json({ error: 'watches must be an array' }, 400, env);
      const config = await loadConfig(env);
      config.watches = sanitizeWatches(incoming.watches, config.watches);
      await saveConfig(env, config);
      return json({ saved: config.watches.length }, 200, env);
    }
    if (url.pathname === '/api/subscription' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401, env);
      let subscription;
      try {
        subscription = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, env);
      }
      if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return json({ error: 'Invalid push subscription' }, 400, env);
      }
      const config = await loadConfig(env);
      config.subscriptions = (config.subscriptions || []).filter(item => item.endpoint !== subscription.endpoint);
      config.subscriptions.push(subscription);
      await saveConfig(env, config);
      return json({ subscribed: true }, 200, env);
    }
    if (url.pathname === '/api/background' && request.method === 'DELETE') {
      if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401, env);
      await saveConfig(env, { watches: [], subscriptions: [] });
      return json({ disabled: true }, 200, env);
    }
    return json({ error: 'Not found' }, 404, env);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkStocks(env));
  }
};

async function checkStocks(env) {
  if (!env.TORN_API_KEY) throw new Error('TORN_API_KEY is not configured');
  const config = await loadConfig(env);
  if (!config.watches?.length) return;

  const response = await fetch(`https://api.torn.com/torn/?selections=stocks&key=${encodeURIComponent(env.TORN_API_KEY)}`);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.error || `Torn API returned ${response.status}`);

  let changed = false;
  for (const watch of config.watches) {
    const stock = data.stocks?.[watch.stockId];
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
      } else if (rule.hit && watch[armedName] && (snoozed || await sendPush(config, env, `${watch.acronym} ${rule.title}`, rule.body))) {
        watch[armedName] = false;
        changed = true;
      }
    }
  }

  if (changed) await saveConfig(env, config);
}

async function sendPush(config, env, title, body) {
  if (!config.subscriptions?.length) return false;
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  let delivered = false;
  const remaining = [];
  for (const subscription of config.subscriptions) {
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
  config.subscriptions = remaining;
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

async function loadConfig(env) {
  return await env.BACKGROUND_STATE.get(CONFIG_KEY, 'json') || { watches: [], subscriptions: [] };
}

async function saveConfig(env, config) {
  await env.BACKGROUND_STATE.put(CONFIG_KEY, JSON.stringify(config));
}

function authorized(request, env) {
  return !!env.BACKGROUND_TOKEN && request.headers.get('Authorization') === `Bearer ${env.BACKGROUND_TOKEN}`;
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