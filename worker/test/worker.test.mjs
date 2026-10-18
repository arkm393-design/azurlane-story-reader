// node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import worker from '../src/index.mjs';
import { makeD1 } from './d1-shim.mjs';
import SyncCoreModule from '../../site/sync-core.js';

const SyncCore = SyncCoreModule.default || SyncCoreModule;
const here = path.dirname(fileURLToPath(import.meta.url));
let clock = 1_800_000_000_000;
Date.now = () => clock;
const tick = (ms = 1500) => { clock += ms; };

function setup() {
  return { DB: makeD1(path.join(here, '..', 'schema.sql')), ALLOWED_ORIGINS: 'https://reader.example', KEY_PEPPER: 'pepper' };
}
const key = () => SyncCore.newKey(n => randomBytes(n));
async function call(env, method, p, body, headers = {}) {
  const res = await worker.fetch(new Request('https://sync.example' + p, {
    method, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: Object.assign({ 'Content-Type': 'application/json', Origin: 'https://reader.example', 'CF-Connecting-IP': '1.2.3.4' }, headers),
  }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const state = (events, prefs = {}, prefsAt = 0) => ({ v: 1, prefs, prefsAt, events });

test('keys: 24 base32 characters, tolerant input', () => {
  const k = key();
  assert.match(k, /^[A-Z2-7]{24}$/);
  assert.equal(SyncCore.normalizeKey(SyncCore.formatKey(k).toLowerCase()), k);
  assert.equal(SyncCore.normalizeKey('too-short'), null);
  const many = new Set(Array.from({ length: 500 }, key));
  assert.equal(many.size, 500);
});

test('first PUT creates the record; GET returns it; the key is not stored', async () => {
  const env = setup(), k = key();
  const s = state({ 312: { last: 2, lastAt: clock, ch: { abc1: { i: 5, at: clock, max: 0.3, done: false, choices: { 7: 2 } } } } });
  const put = await call(env, 'PUT', `/v1/progress/${k}`, s);
  assert.equal(put.status, 200);
  assert.equal(put.body.rev, 1);
  const get = await call(env, 'GET', `/v1/progress/${k}`);
  assert.equal(get.status, 200);
  assert.equal(get.body.data.events['312'].ch.abc1.i, 5);
  const row = env.DB.raw.prepare('SELECT id, data FROM progress').get();
  assert.notEqual(row.id, k);
  assert.ok(!row.data.includes(k));
});

test('two devices merge per chapter: furthest progress, newest position, done sticks', async () => {
  const env = setup(), k = key();
  const t1 = clock;
  await call(env, 'PUT', `/v1/progress/${k}`, state({ 148: { last: 0, lastAt: t1, ch: {
    a: { i: 30, at: t1, max: 0.9, done: false }, b: { i: 9, at: t1, max: 1, done: true } } } }));
  tick();
  const t2 = clock;
  const res = await call(env, 'PUT', `/v1/progress/${k}`, state({ 148: { last: 3, lastAt: t2, ch: {
    a: { i: 4, at: t2, max: 0.1, done: false }, c: { i: 2, at: t2, max: 0.2, done: false } } } }, { name: 'Ayanami' }, t2));
  assert.equal(res.status, 200);
  const ev = res.body.data.events['148'];
  assert.deepEqual([ev.ch.a.i, ev.ch.a.max, ev.ch.a.done], [4, 0.9, false]);
  assert.equal(ev.ch.b.done, true);
  assert.equal(ev.ch.c.i, 2);
  assert.equal(ev.last, 3);
  assert.equal(res.body.data.prefs.name, 'Ayanami');
  assert.equal(res.body.rev, 2);
});

test('resetting an event drops older progress on every device', async () => {
  const env = setup(), k = key();
  await call(env, 'PUT', `/v1/progress/${k}`, state({ 312: { ch: { a: { i: 9, at: clock, max: 1, done: true } } } }));
  tick();
  const res = await call(env, 'PUT', `/v1/progress/${k}`, state({ 312: { resetAt: clock, ch: {} } }));
  assert.deepEqual(res.body.data.events['312'].ch, {});
  tick();
  const old = await call(env, 'PUT', `/v1/progress/${k}`, state({ 312: { ch: { a: { i: 9, at: clock - 5000, max: 1, done: true } } } }));
  assert.deepEqual(old.body.data.events['312'].ch, {}, 'a stale device cannot bring reset progress back');
});

test('writes faster than once a second get the current copy back', async () => {
  const env = setup(), k = key();
  await call(env, 'PUT', `/v1/progress/${k}`, state({}));
  const again = await call(env, 'PUT', `/v1/progress/${k}`, state({}));
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'too_soon');
  assert.ok(again.body.data);
});

test('bad requests are refused', async () => {
  const env = setup(), k = key();
  assert.equal((await call(env, 'GET', '/v1/progress/not-a-key')).status, 404);
  assert.equal((await call(env, 'GET', `/v1/progress/${k}`)).status, 404);
  assert.equal((await call(env, 'PUT', `/v1/progress/${k}`, '{oops')).status, 400);
  assert.equal((await call(env, 'PUT', `/v1/progress/${k}`, 'x'.repeat(300 * 1024))).status, 413);
  assert.equal((await call(env, 'POST', `/v1/progress/${k}`, {})).status, 405);
  const junk = await call(env, 'PUT', `/v1/progress/${k}`, { events: { '<script>': {}, 5: { ch: { 'a b': {} } } }, prefs: { speed: 'warp', name: 7 } });
  assert.equal(junk.status, 200);
  assert.deepEqual(junk.body.data, { v: 1, prefs: {}, prefsAt: 0, events: { 5: { last: null, lastAt: 0, resetAt: 0, ch: {} } } });
});

test('CORS only for the site origin', async () => {
  const env = setup(), k = key();
  const ok = await call(env, 'OPTIONS', `/v1/progress/${k}`);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://reader.example');
  const other = await call(env, 'GET', '/v1/health', undefined, { Origin: 'https://elsewhere.example' });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});

test('new keys are limited per address per day', async () => {
  const env = setup();
  for (let i = 0; i < 20; i++) assert.equal((await call(env, 'PUT', `/v1/progress/${key()}`, state({}))).status, 200);
  assert.equal((await call(env, 'PUT', `/v1/progress/${key()}`, state({}))).status, 429);
  assert.equal((await call(env, 'PUT', `/v1/progress/${key()}`, state({}), { 'CF-Connecting-IP': '5.6.7.8' })).status, 200);
});

test('DELETE forgets the key', async () => {
  const env = setup(), k = key();
  await call(env, 'PUT', `/v1/progress/${k}`, state({}));
  assert.equal((await call(env, 'DELETE', `/v1/progress/${k}`)).status, 204);
  assert.equal((await call(env, 'GET', `/v1/progress/${k}`)).status, 404);
});
