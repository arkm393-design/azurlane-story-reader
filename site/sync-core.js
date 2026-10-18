/* Reading progress: the saved shape, validation, and how two copies merge.
   Shared by the site (window.SyncCore) and the sync Worker (imported as a module),
   so a device and the server always merge the same way.

   state = {
     v: 1,
     prefs: { name, speed, music, sfx, style }, prefsAt,
     events: { "<event id>": {
       last, lastAt,            // chapter index read most recently, and when
       resetAt,                 // "reset progress": chapter records older than this are dropped
       ch: { "<chapter id>": { i, choices, at, max, done } }
     } }
   }
   Merge rules: per chapter, keep the furthest progress (max), done if either copy is done,
   and the reading position from whichever copy saw it last. Settings: newest wins. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SyncCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const LIMITS = { events: 2000, chapters: 400, choices: 64, name: 24 };
  const SPEEDS = ['normal', 'fast', 'instant'];
  const STYLES = ['story', 'script'];

  const time = x => (typeof x === 'number' && isFinite(x) && x > 0 && x < 1e13 ? Math.floor(x) : 0);
  const int = (x, lo, hi) => (Number.isInteger(x) && x >= lo && x <= hi ? x : null);
  const frac = x => (typeof x === 'number' && isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
  const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

  function emptyState() { return { v: 1, prefs: {}, prefsAt: 0, events: {} }; }

  function cleanState(s) {
    const out = emptyState();
    if (!isObj(s)) return out;
    const p = isObj(s.prefs) ? s.prefs : {};
    if (typeof p.name === 'string') out.prefs.name = p.name.slice(0, LIMITS.name);
    if (SPEEDS.includes(p.speed)) out.prefs.speed = p.speed;
    if (typeof p.music === 'boolean') out.prefs.music = p.music;
    if (typeof p.sfx === 'boolean') out.prefs.sfx = p.sfx;
    if (STYLES.includes(p.style)) out.prefs.style = p.style;
    out.prefsAt = time(s.prefsAt);
    let ne = 0;
    for (const [id, e] of Object.entries(isObj(s.events) ? s.events : {})) {
      if (!/^\d{1,9}$/.test(id) || !isObj(e)) continue;
      if (++ne > LIMITS.events) break;
      const ev = { last: int(e.last, 0, 999), lastAt: time(e.lastAt), resetAt: time(e.resetAt), ch: {} };
      let nc = 0;
      for (const [cid, c] of Object.entries(isObj(e.ch) ? e.ch : {})) {
        if (!/^[\w-]{1,64}$/.test(cid) || !isObj(c)) continue;
        const at = time(c.at);
        if (!at || at <= ev.resetAt) continue;
        if (++nc > LIMITS.chapters) break;
        const choices = {};
        let n = 0;
        for (const [k, v] of Object.entries(isObj(c.choices) ? c.choices : {})) {
          if (/^\d{1,6}$/.test(k) && int(v, 0, 99) !== null && ++n <= LIMITS.choices) choices[k] = v;
        }
        ev.ch[cid] = { i: int(c.i, 0, 100000) ?? 0, choices, at, max: frac(c.max), done: c.done === true };
      }
      out.events[id] = ev;
    }
    return out;
  }

  function mergeState(a, b) {
    a = cleanState(a); b = cleanState(b);
    const out = emptyState();
    const pa = a.prefsAt >= b.prefsAt ? a : b;
    out.prefs = Object.assign({}, pa.prefs);
    out.prefsAt = pa.prefsAt;
    const none = { last: null, lastAt: 0, resetAt: 0, ch: {} };
    for (const id of new Set([...Object.keys(a.events), ...Object.keys(b.events)])) {
      const ea = a.events[id] || none, eb = b.events[id] || none;
      const resetAt = Math.max(ea.resetAt, eb.resetAt);
      const recent = ea.lastAt >= eb.lastAt ? ea : eb;
      const ev = { last: recent.last, lastAt: recent.lastAt, resetAt, ch: {} };
      for (const cid of new Set([...Object.keys(ea.ch), ...Object.keys(eb.ch)])) {
        const recs = [ea.ch[cid], eb.ch[cid]].filter(c => c && c.at > resetAt);
        if (!recs.length) continue;
        if (recs.length === 1) { ev.ch[cid] = Object.assign({}, recs[0], { choices: Object.assign({}, recs[0].choices) }); continue; }
        const [x, y] = recs, newer = x.at >= y.at ? x : y;
        ev.ch[cid] = { i: newer.i, choices: Object.assign({}, newer.choices), at: newer.at,
                       max: Math.max(x.max, y.max), done: x.done || y.done };
      }
      out.events[id] = ev;
    }
    return out;
  }

  // Sync keys: 24 characters of base32 (120 random bits), shown in groups of four.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const KEY_RE = /^[A-Z2-7]{24}$/;
  function normalizeKey(s) {
    const k = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
    return KEY_RE.test(k) ? k : null;
  }
  function formatKey(k) { return k.match(/.{1,4}/g).join('-'); }
  function newKey(randomBytes) {
    const bytes = randomBytes(15);
    let bits = 0, val = 0, out = '';
    for (const b of bytes) {
      val = (val << 8) | b; bits += 8;
      while (bits >= 5) { out += ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
      val &= (1 << bits) - 1;
    }
    return out;
  }

  return { emptyState, cleanState, mergeState, normalizeKey, formatKey, newKey, KEY_RE, LIMITS };
});
