/* Sync service for the Azur Lane Story Reader.

   One record of reading progress per sync key. The key is the only credential:
   the server stores a SHA-256 hash of it (with an optional secret pepper), never the key.

   GET    /v1/progress/<KEY>   -> 200 { data, rev, at } | 404
   PUT    /v1/progress/<KEY>   body: progress state  -> 200 { data, rev, at } (server copy merged with yours)
   DELETE /v1/progress/<KEY>   -> 204 (forget everything stored for this key)
   GET    /v1/health           -> 200

   Bindings (wrangler.toml): DB (D1), ALLOWED_ORIGINS (comma list, e.g. https://you.github.io),
   KEY_PEPPER (secret, optional). Schema: schema.sql. */
import SyncCoreModule from '../../site/sync-core.js';

const SyncCore = SyncCoreModule.default || SyncCoreModule;
const MAX_BODY = 256 * 1024;        // a fully read library is ~100 KB
const MIN_GAP_MS = 1000;             // one write per key per second
const NEW_KEYS_PER_IP_PER_DAY = 20;  // slows down anyone filling the database

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || allowed.includes('*'));
  return ok ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  } : { 'Vary': 'Origin' };
}

function json(body, status, cors) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors),
  });
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function allowNewKey(env, req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const day = Math.floor(Date.now() / 86400000);
  const ipHash = await sha256hex('ip:' + ip + (env.KEY_PEPPER || ''));
  const row = await env.DB.prepare(
    'INSERT INTO creates (ip, day, n) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(ipHash, day).first();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM creates WHERE day < ?').bind(day - 2).run();
  return !row || row.n <= NEW_KEYS_PER_IP_PER_DAY;
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/v1/health') return json({ ok: true }, 200, cors);
    const m = url.pathname.match(/^\/v1\/progress\/([A-Z2-7]{24})$/);
    if (!m) return json({ error: 'not_found' }, 404, cors);
    const id = await sha256hex(m[1] + (env.KEY_PEPPER || ''));
    const read = () => env.DB.prepare('SELECT data, rev, updated_at FROM progress WHERE id = ?').bind(id).first();

    if (req.method === 'GET') {
      const row = await read();
      if (!row) return json({ error: 'unknown_key' }, 404, cors);
      return json({ data: JSON.parse(row.data), rev: row.rev, at: row.updated_at }, 200, cors);
    }

    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM progress WHERE id = ?').bind(id).run();
      return json(null, 204, cors);
    }

    if (req.method === 'PUT') {
      if (Number(req.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'too_large' }, 413, cors);
      const text = await req.text();
      if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413, cors);
      let incoming;
      try { incoming = SyncCore.cleanState(JSON.parse(text)); } catch { return json({ error: 'bad_json' }, 400, cors); }

      for (let attempt = 0; attempt < 4; attempt++) {
        const row = await read();
        const now = Date.now();
        if (!row) {
          if (!(await allowNewKey(env, req))) return json({ error: 'too_many_new_keys' }, 429, cors);
          const r = await env.DB.prepare(
            'INSERT OR IGNORE INTO progress (id, data, rev, updated_at, created_at) VALUES (?, ?, 1, ?, ?)'
          ).bind(id, JSON.stringify(incoming), now, now).run();
          if (r.meta.changes === 1) return json({ data: incoming, rev: 1, at: now }, 200, cors);
          continue;   // another device created it a moment ago: merge into theirs
        }
        if (now - row.updated_at < MIN_GAP_MS) {
          return json({ error: 'too_soon', data: JSON.parse(row.data), rev: row.rev, at: row.updated_at }, 429, cors);
        }
        const merged = SyncCore.mergeState(JSON.parse(row.data), incoming);
        const data = JSON.stringify(merged);
        if (data.length > MAX_BODY) return json({ error: 'too_large' }, 413, cors);
        const r = await env.DB.prepare(
          'UPDATE progress SET data = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?'
        ).bind(data, now, id, row.rev).run();
        if (r.meta.changes === 1) return json({ data: merged, rev: row.rev + 1, at: now }, 200, cors);
      }
      return json({ error: 'busy' }, 409, cors);
    }

    return json({ error: 'method_not_allowed' }, 405, cors);
  },
};
