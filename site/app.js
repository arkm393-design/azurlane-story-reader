/* Azur Lane Story Reader: library, event home, reader, sync.
   Built with Claude (Anthropic). Data: site/data (catalog + one file per story), art and music under config.assetBase. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const DEFAULT_NAME_COLOR = '#A9F548';
const SPEED = { normal: 48, fast: 140, instant: 0 };
const KIND_LABEL = { major: 'Major event', minor: 'Minor event', festive: 'Festive event', character: 'Character story', main: 'Main story', other: 'Story' };
const KIND_ORDER = ['main', 'major', 'minor', 'festive', 'character', 'other'];
const KIND_PLURAL = { major: 'Major events', minor: 'Minor events', festive: 'Festive events', character: 'Character stories', main: 'Main story', other: 'Other stories' };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SC = window.SyncCore;

let CFG = { title: 'Azur Lane Story Reader', assetBase: 'assets/', syncApi: '', repoUrl: '' };
let CATALOG = { events: [] };
let EV = null, AS = null, EVID = null;     // the open story and its art manifest
const A = p => CFG.assetBase + p;

// ---------- saved progress (this device; synced when a key is set) ----------
const STORE = 'alsr:v1', SYNC_STORE = 'alsr:sync';
const readLS = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const DEFAULT_PREFS = { name: 'Commander', speed: 'normal', music: true, sfx: true, style: 'story' };
let S = SC.cleanState(readLS(STORE));
let prefs = Object.assign({}, DEFAULT_PREFS, S.prefs);
function save() { writeLS(STORE, S); scheduleSync(); }
function setPref(k, v) { prefs[k] = v; S.prefs = Object.assign({}, prefs); S.prefsAt = Date.now(); save(); }
function evState(id) { return S.events[id] || (S.events[id] = { last: null, lastAt: 0, resetAt: 0, ch: {} }); }
const chRead = chId => (S.events[EVID] && S.events[EVID].ch[chId]) || {};
function chWrite(chId) {
  const e = evState(EVID);
  return e.ch[chId] || (e.ch[chId] = { i: 0, choices: {}, at: Date.now(), max: 0, done: false });
}

// ---------- text ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fill = s => String(s || '').replace(/\{playername\}/g, prefs.name || 'Commander').replace(/\{tb\}/g, 'TB');
function rich(s, xhtml) {
  let h = esc(fill(s));
  h = h.replace(/&lt;size=(\d+)&gt;([\s\S]*?)&lt;\/size&gt;/g, (m, n, t) => `<span style="font-size:${Math.max(.7, Math.min(2, n / 30)).toFixed(2)}em">${t}</span>`);
  h = h.replace(/&lt;color=(#[0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?&gt;([\s\S]*?)&lt;\/color&gt;/g, (m, c, t) => `<span style="color:${c}">${t}</span>`);
  h = h.replace(/&lt;i&gt;([\s\S]*?)&lt;\/i&gt;/g, '<em>$1</em>').replace(/&lt;b&gt;([\s\S]*?)&lt;\/b&gt;/g, '<strong>$1</strong>');
  return h.replace(/\n/g, xhtml ? '<br/>' : '<br>');
}
const nameOf = l => l.w ? fill(l.w) : null;
const nameColor = l => (l.c && l.c.toUpperCase() !== DEFAULT_NAME_COLOR) ? `color-mix(in srgb, ${l.c} 76%, #fff)` : null;
function dayLabel(ch, i) {
  if (ch.lab != null) return ch.lab || (i === 0 ? 'Opening' : '');
  const m = /Day\s*(\d+)/i.exec(ch.sub || ''); return m ? 'Day ' + m[1] : (i === 0 ? 'Opening' : '');
}
const two = n => String(n).padStart(2, '0');
const cardText = (t, xhtml) => rich(String(t).replace(/<\/?size(?:=\d+)?>/g, '').trim(), xhtml);

// ---------- chapter logic ----------
let cur = { ch: 0, i: 0, choices: {} };
let hist = [];
const lines = () => EV.chapters[cur.ch].lines;
function branchOf(L, i) { for (let j = i - 1; j >= 0; j--) if (L[j].opts) return j; return -1; }
function visible(L, i, choices) {
  const l = L[i];
  if (l.k === 'fx') return false;
  if (l.of == null) return true;
  const j = branchOf(L, i);
  const pick = j >= 0 ? (choices[j] ?? L[j].opts[0].f) : l.of;
  return pick === l.of;
}
function nextVisible(L, i, choices) { for (let j = i + 1; j < L.length; j++) if (visible(L, j, choices)) return j; return -1; }
function sceneAt(L, i) {
  let bg = null, bgm = null;
  for (let j = 0; j <= i; j++) { const l = L[j]; if (l.bg) bg = l.bg; if (l.stop) bgm = null; if (l.bgm) bgm = l.bgm; }
  return { bg, bgm };
}
const firstBg = L => (L.find(l => l.bg) || {}).bg || EV.cover;
function effectsAt(L, i) {
  const on = {};
  for (let j = 0; j <= i; j++) for (const [n, a] of L[j].fx || []) on[n] = a;
  const act = Object.keys(on).filter(n => on[n]);
  return { fog: act.some(n => /fog|miwu/i.test(n) && !/dark/i.test(n)), dark: act.some(n => /miwu.*dark|fog.*dark/i.test(n)),
    sparks: act.some(n => /huohua|spark|ember/i.test(n)) };   // huohua: the game's drifting sparks over fire
}
function counts(L, i, choices) { let n = 0, at = 0; for (let j = 0; j < L.length; j++) if (visible(L, j, choices)) { n++; if (j <= i) at++; } return [at, n]; }

// ---------- assets ----------
const url = {
  bg: n => (AS.bg[n] ? A(AS.bg[n]) : null),
  paint: n => (AS.paint[n] ? A('p/' + n + '.webp') : null),
  face: (n, e) => A('f/' + n + '/' + e + '.webp'),
  av: n => A('a/' + n + '.webp'),
};
const actorPaint = a => (EV.actors[a] || {}).paint;
function avatarCss(p, e) {
  const meta = p && AS.paint[p];
  if (!meta || !meta.av) return null;
  const n = meta.av.length, idx = Math.max(0, meta.av.indexOf(e || '0'));
  return `background-image:url('${url.av(p)}');background-size:${n * 100}% 100%;background-position:${n > 1 ? idx / (n - 1) * 100 : 0}% 0`;
}
const hasArt = a => { const p = a && actorPaint(a), m = p && AS.paint[p]; return !!(m && !m.po && url.paint(p)); };
function preload(i) {
  const L = lines(); let j = i, n = 0;
  while (n < 4 && (j = nextVisible(L, j, cur.choices)) >= 0) {
    const l = L[j]; n++;
    if (l.bg && url.bg(l.bg)) new Image().src = url.bg(l.bg);
    for (const w of [l.a ? { a: l.a, e: l.e } : null, ...(l.sub || [])]) {
      if (!w || !hasArt(w.a)) continue;
      const p = actorPaint(w.a), m = AS.paint[p];
      new Image().src = url.paint(p); const e = w.e || (m.face && m.face.def); if (e && m.face) new Image().src = url.face(p, e);
    }
  }
}

// ---------- stage ----------
const stage = $('stage');
let bgShown = null, bgFront = $('bgA'), bgBack = $('bgB');
function setBg(name) {
  if (name === bgShown) return;
  bgShown = name;
  const src = name && url.bg(name);
  if (!src) { bgFront.classList.remove('on'); return; }
  const nx = bgBack; bgBack = bgFront; bgFront = nx;
  nx.onload = () => { nx.classList.add('on'); bgBack.classList.remove('on'); };
  nx.src = src;
  if (nx.complete && nx.naturalWidth) nx.onload();
}

// A cut-in panel over the background, for the line that calls for it (the game's subBgName).
let ovShown = null;
function setOverlay(name) {
  const ov = $('ov'), src = name && url.bg(name);
  if ((src || null) === ovShown) return;
  ovShown = src || null;
  if (!src) { ov.classList.remove('on'); return; }
  ov.onload = () => { ov.style.width = Math.min(100, ov.naturalWidth / 1280 * 100) + '%'; ov.classList.add('on'); };
  ov.classList.remove('on'); ov.src = src;
  if (ov.complete && ov.naturalWidth) ov.onload();
}

// Figures: a centre slot, plus left and right slots for the two-person staging older events use.
// What stands where is replayed from the start of the chapter, so Back, the log and jumps stay right.
const SLOTS = {};
for (const k of ['L', 'R', 'C']) {
  const el = document.createElement('div'); el.className = 'fig'; el.dataset.slot = k;
  el.innerHTML = '<div class="mv"><div class="in"><img class="paint" alt=""><img class="face" alt="" hidden></div></div>';
  $('figs').appendChild(el);
  SLOTS[k] = { k, el, mv: el.querySelector('.mv'), paint: el.querySelector('.paint'), face: el.querySelector('.face'), p: null, flip: false, tok: 0 };
}
const narrow = () => stage.clientWidth < 700 && stage.clientWidth < stage.clientHeight * 1.1;

function staging(L, i, choices) {
  const st = { L: null, R: null, C: null, lit: new Set() };
  let bg;
  for (let j = 0; j <= i; j++) {
    const l = L[j];
    const vis = visible(L, j, choices);
    if (l.bg && (vis || l.k === 'fx')) { if (bg !== undefined && l.bg !== bg) st.L = st.R = st.C = null; bg = l.bg; }
    if (!vis) continue;
    if (l.k === 'card' || l.cin) { st.L = st.R = st.C = null; st.lit = new Set(); continue; }   // cin: scene art alone
    const lit = new Set();
    const art = hasArt(l.a) ? { a: l.a, e: l.e, flip: !!l.flip } : null;
    const commander = !l.a && l.w === '{playername}';
    if (l.sd === 0 || l.sd === 1) {
      const slot = l.sd === 0 ? 'L' : 'R', other = slot === 'L' ? 'R' : 'L';
      st.C = null;
      if (art) { st[slot] = art; lit.add(slot); }
      if (l.ho) st[other] = null;
      if (l.pfo === 0 || l.pfo === 1) { const k = l.pfo === 0 ? 'L' : 'R'; if (k !== slot || !art) st[k] = null; }
      for (const sub of l.sub || []) {
        if (!hasArt(sub.a)) continue;
        let k = sub.left ? 'L' : 'R'; if (k === slot && art) k = other;
        st[k] = { a: sub.a, e: sub.e, flip: !!sub.flip }; lit.add(k);
      }
    } else {
      st.L = st.R = null;
      if (art) { st.C = art; lit.add('C'); }
      else if (!commander) st.C = null;
      for (const sub of l.sub || []) {   // characters reacting alongside the speaker
        if (!hasArt(sub.a)) continue;
        const k = sub.left ? 'L' : 'R';
        st[k] = { a: sub.a, e: sub.e, flip: !!sub.flip }; lit.add(k);
      }
    }
    st.lit = lit;
  }
  return st;
}

function layoutSlot(s) {
  if (!s.p) return;
  const meta = AS.paint[s.p]; if (!meta) return;
  const W = stage.clientWidth, H = stage.clientHeight, ar = meta.h / meta.w;
  const side = s.k !== 'C';
  const spread = s.wide ? 0.19 : 0.31;   // wider apart when someone also stands in the centre
  const cx = !side || narrow() ? W / 2 : W * (s.k === 'L' ? spread : 1 - spread);
  const k = side && !narrow() ? 0.9 : 1;
  let pw, left, top;
  if (meta.face || meta.frame) {
    const f = meta.face || meta.frame;
    const faceW = Math.max(H * 0.13, Math.min(H * 0.19, W * 0.15)) * (f.head ? 2.1 : 1) * k;
    pw = faceW / f.w;
    const ph = pw * ar;
    const fx = s.flip ? 1 - (f.x + f.w / 2) : f.x + f.w / 2;   // a mirrored figure's face sits mirrored too
    left = cx - fx * pw;
    top = H * 0.25 - (f.y + f.h / 2) * ph;
    if (top + ph < H) top = Math.min(top + H * 0.12, H - ph);
  } else {
    const ph = H * 1.45 * k; pw = ph / ar; left = cx - pw / 2; top = H * 0.04;
  }
  s.el.style.width = pw + 'px'; s.el.style.height = pw * ar + 'px';
  s.el.style.transform = `translate(${left}px, ${top}px)`;
}
const layoutFig = () => Object.values(SLOTS).forEach(layoutSlot);
new ResizeObserver(layoutFig).observe(stage);

function hideSlot(s) { s.el.classList.remove('on', 'dim', 'noise'); s.p = null; s.tok++; }
function hideFigure() { Object.values(SLOTS).forEach(hideSlot); }
function enter(s) {
  if (reduced() || !s.mv.animate) return;
  const dx = s.k === 'L' ? -26 : 26;
  s.mv.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' });
}
function runActs(s, l) {
  if (!l.act || reduced() || !s.mv.animate) return;
  const k = stage.clientHeight / 1080;
  for (const a of l.act) {
    const dx = (a.x || 0) * k, dy = (a.y || 0) * k, delay = (a.delay || 0) * 1000;
    if (a.type === 'shake') {
      s.mv.animate([{ transform: 'none' }, { transform: `translate(${dx}px,${dy}px)` }, { transform: `translate(${-dx}px,${-dy}px)` }, { transform: 'none' }],
        { duration: Math.max(60, (a.dur || .1) * 2000), iterations: Math.max(1, a.n || 1), delay });
    } else if (a.type === 'move') {
      s.mv.animate([{ transform: 'none' }, { transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }],
        { duration: Math.max(200, (a.dur || .3) * 2000), delay, easing: 'ease-in-out' });
    }
  }
}
function showSlot(s, w, lit, line) {
  const p = actorPaint(w.a), meta = AS.paint[p];
  s.el.classList.toggle('dim', !lit);
  s.el.classList.toggle('noise', !!(line && line.noise));
  const setFace = () => {
    const e = w.e || (meta.face && meta.face.def);
    if (e && meta.face) {
      const f = meta.face;
      Object.assign(s.face.style, { left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: 'auto' });
      if (s.face.getAttribute('src') !== url.face(p, e)) s.face.src = url.face(p, e);
      s.face.hidden = false;
    } else s.face.hidden = true;
  };
  if (s.p === p && s.flip === !!w.flip && s.el.classList.contains('on')) { setFace(); layoutSlot(s); if (line) runActs(s, line); return; }
  const isNew = s.p !== p;
  s.p = p; s.flip = !!w.flip; s.el.classList.toggle('flip', s.flip);
  const tok = ++s.tok, src = url.paint(p);
  const swap = () => {
    if (s.tok !== tok) return;
    s.paint.src = src; setFace(); layoutSlot(s); s.el.classList.add('on');
    if (isNew) enter(s);
    if (line) runActs(s, line);
  };
  const pre = new Image(); pre.src = src;
  (pre.decode ? pre.decode() : Promise.resolve()).then(swap, swap);
}
function showFigure(l) {
  const st = staging(lines(), cur.i, cur.choices);
  const both = st.L && st.R;
  const primary = l.sd === 0 ? 'L' : l.sd === 1 ? 'R' : 'C';
  for (const k of ['L', 'R', 'C']) {
    const s = SLOTS[k], w = st[k];
    if (!w) { hideSlot(s); continue; }
    const lit = st.lit.has(k);
    // on a phone only the speaker (or the centre figure) stands on stage; more would crowd it
    if (k !== 'C' && narrow() && (st.C || (both && !lit && st.lit.size))) { hideSlot(s); continue; }
    s.wide = k !== 'C' && !!st.C;
    showSlot(s, w, lit, k === primary ? l : null);
  }
}
function showPortrait(l) {
  if (l.cin) { $('port').hidden = true; $('dlg').classList.remove('hasport'); return; }
  const p = l.a ? actorPaint(l.a) : null, meta = p && AS.paint[p];
  const port = $('port');
  const css = meta && meta.po ? avatarCss(p, l.e && meta.po.e.includes(l.e) ? l.e : meta.po.e[0]) : null;
  port.hidden = !css; $('dlg').classList.toggle('hasport', !!css);
  if (css) port.setAttribute('style', css);
}

// ---------- sound ----------
const audio = new Audio(); audio.loop = true; audio.volume = 0; audio.preload = 'auto';
let track = null, fadeTimer = null;
function fadeTo(target, done) {
  clearInterval(fadeTimer);
  fadeTimer = setInterval(() => {
    const d = target - audio.volume;
    if (Math.abs(d) <= 0.05) { audio.volume = target; clearInterval(fadeTimer); done && done(); return; }
    audio.volume = Math.max(0, Math.min(1, audio.volume + Math.sign(d) * 0.05));
  }, 40);
}
function setMusic(name) {
  if (!prefs.music || !readerOpen) { if (!audio.paused) fadeTo(0, () => audio.pause()); track = name; return; }
  const src = name && AS.bgm[name] ? A(AS.bgm[name]) : null;
  if (name === track && !audio.paused) return;
  track = name;
  if (!src) { fadeTo(0, () => audio.pause()); return; }
  const start = () => { audio.src = src; audio.currentTime = 0; audio.play().then(() => fadeTo(0.55)).catch(() => {}); };
  if (!audio.paused && audio.volume > 0) fadeTo(0, start); else start();
}
let sePool = {};
function playSe(name) {
  if (!prefs.sfx || !name || !AS.se || !AS.se[name]) return;
  const a = sePool[name] || (sePool[name] = new Audio(A(AS.se[name])));
  try { a.currentTime = 0; a.volume = 0.7; a.play().catch(() => {}); } catch {}
}
function preloadSe(L) { for (const l of L) if (l.se && AS.se && AS.se[l.se] && !sePool[l.se]) { const a = new Audio(A(AS.se[l.se])); a.preload = 'auto'; sePool[l.se] = a; } }

// ---------- typing ----------
let typing = null;
function typeInto(el, html) {
  if (typing) { cancelAnimationFrame(typing.raf); typing = null; }
  el.innerHTML = html;
  const cps = SPEED[prefs.speed] ?? 48;
  if (!cps || reduced()) { onTyped(); return; }
  const nodes = []; const walk = n => { for (const c of n.childNodes) c.nodeType === 3 ? nodes.push([c, c.nodeValue]) : walk(c); };
  walk(el);
  const total = nodes.reduce((a, [, t]) => a + t.length, 0);
  nodes.forEach(([n]) => n.nodeValue = '');
  const t0 = performance.now();
  const tick = now => {
    let shown = Math.floor((now - t0) / 1000 * cps);
    for (const [n, t] of nodes) { n.nodeValue = t.slice(0, Math.max(0, Math.min(t.length, shown))); shown -= t.length; }
    if ((now - t0) / 1000 * cps >= total) { typing = null; onTyped(); return; }
    typing.raf = requestAnimationFrame(tick);
  };
  typing = { raf: requestAnimationFrame(tick), finish() { cancelAnimationFrame(this.raf); nodes.forEach(([n, t]) => n.nodeValue = t); typing = null; onTyped(); } };
}
let autoTimer = null, autoOn = false, cardUntil = 0;
function onTyped() {
  const l = lines()[cur.i];
  $('more').hidden = !!(l && l.opts);
  if (l && l.opts) showChoices(l);
  if (autoOn && !(l && l.opts)) { clearTimeout(autoTimer); autoTimer = setTimeout(next, 1100 + $('txt').textContent.length * 35); }
}

// ---------- cards ----------
function renderCard(l) {
  const c = $('card'); c.className = 'card'; c.hidden = false;
  const ch = EV.chapters[cur.ch];
  let html = '', dur = 900;
  if (l.title) {
    c.classList.add('title');
    const bg = firstBg(ch.lines);
    html = `${bg && url.bg(bg) ? `<img class="back" src="${url.bg(bg)}" alt="">` : ''}<div class="c">
      <span class="t-ev mono">${esc(EV.title)}</span>
      <div class="t-row"><i></i><span class="t-num">${two(cur.ch + 1)}</span><i></i></div>
      <h2 class="t-name">${esc(ch.title)}</h2>
      <span class="t-day mono">${esc(dayLabel(ch, cur.ch))}</span></div>
      <span class="hint mono">${matchMedia('(hover: hover)').matches ? 'Click or press Space to begin' : 'Tap to begin'}</span>`;
    dur = 1500;
  } else if (l.at === 3) {
    c.classList.add('loc');
    html = `<div class="c">${l.t.map((t, k) => k === 0
      ? `<p class="l-main" style="animation-delay:.15s">${cardText(t)}</p>`
      : `<span class="l-sub mono" style="animation-delay:${.45 + k * .35}s">${cardText(t)}</span>`).join('')}</div>`;
    dur = 600 + l.t.length * 350;
  } else if (l.at === 1 || (l.at == null && l.t.length > 2)) {
    c.classList.add('mono-log');
    html = `<div class="c">${l.t.map((t, k) => `<p style="animation-delay:${.2 + k * .9}s">${cardText(t)}</p>`).join('')}</div>`;
    dur = 400 + l.t.length * 900;
  } else {
    c.classList.add('plain');
    html = `<div class="c">${l.t.map((t, k) => `<p style="animation-delay:${.2 + k * .5}s">${cardText(t)}</p>`).join('')}</div>`;
    dur = 500 + l.t.length * 500;
  }
  c.innerHTML = html;
  cardUntil = reduced() ? 0 : performance.now() + dur;
  if (autoOn) autoTimer = setTimeout(next, dur + 1600);
}

// ---------- rendering a line ----------
function show(i, { flash = false } = {}) {
  const L = lines(); cur.i = i;
  const l = L[i];
  const sc = sceneAt(L, i);
  stage.classList.toggle('black', !!(l.black && !l.bg) || !sc.bg);
  stage.classList.toggle('old', !!l.old);
  const fx = effectsAt(L, i);
  stage.classList.toggle('fx-fog', fx.fog); stage.classList.toggle('fx-fogdark', fx.dark); stage.classList.toggle('fx-sparks', fx.sparks);
  setOverlay(l.ov);
  setBg(sc.bg);
  setMusic(sc.bgm);
  playSe(l.se);
  $('end').hidden = true;
  $('choices').hidden = true; $('choices').innerHTML = '';
  clearTimeout(autoTimer);
  if (l.flash || flash) { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  if (l.k === 'card') {
    $('dlg').hidden = true; hideFigure();
    renderCard(l);
  } else {
    $('card').hidden = true; $('dlg').hidden = false;
    const name = l.cin ? null : nameOf(l), who = $('who');
    who.hidden = !name; who.textContent = name || ''; who.style.color = nameColor(l) || '';
    $('dlg').classList.toggle('narr', !name && !l.anon && !l.cin);
    const d = $('dlg'); d.classList.remove('shake'); if (l.shake) { void d.offsetWidth; d.classList.add('shake'); }
    showFigure(l); showPortrait(l);
    $('more').hidden = true;
    typeInto($('txt'), rich(l.t));
  }
  const [at, total] = counts(L, i, cur.choices);
  $('pos').textContent = `${String(at).padStart(3, '0')} / ${String(total).padStart(3, '0')}`;
  const rec = chWrite(EV.chapters[cur.ch].id), now = Date.now();
  rec.i = i; rec.choices = Object.assign({}, cur.choices); rec.max = Math.max(rec.max || 0, at / total); rec.at = now;
  const e = evState(EVID); e.last = cur.ch; e.lastAt = now;
  save(); preload(i);
  if (!$('script').hidden) markScript();
  if (!$('logSheet').hidden) renderLog();
}
function showChoices(l) {
  const box = $('choices'); box.innerHTML = '';
  l.opts.forEach(o => {
    const b = document.createElement('button');
    b.innerHTML = rich(o.t);
    b.addEventListener('click', e => { e.stopPropagation(); cur.choices[cur.i] = o.f; next(true); });
    box.appendChild(b);
  });
  box.hidden = false;
  box.querySelector('button')?.focus({ preventScroll: true });
}
function next(fromChoice) {
  if (!$('end').hidden || !readerOpen) return;
  if (typing) { typing.finish(); return; }
  const c = $('card');
  if (!c.hidden && performance.now() < cardUntil) { c.classList.add('instant'); cardUntil = 0; return; }
  const L = lines(), l = L[cur.i];
  if (l && l.opts && cur.choices[cur.i] == null && fromChoice !== true) return;
  const j = nextVisible(L, cur.i, cur.choices);
  if (j < 0) { finishChapter(); return; }
  hist.push(cur.i);
  show(j);
}
function back() {
  if (!$('end').hidden) { $('end').hidden = true; show(cur.i); return; }
  if (!hist.length) return;
  const i = hist.pop();
  if (lines()[i].opts) delete cur.choices[i];
  show(i);
}
function markDone(k) {
  const rec = chWrite(EV.chapters[k].id); rec.done = true; rec.max = 1; rec.at = Date.now();
  save(); scheduleSync(1500);
}
function finishChapter() {
  clearTimeout(autoTimer);
  const ch = EV.chapters[cur.ch];
  markDone(cur.ch);
  const nx = EV.chapters[cur.ch + 1];
  const e = $('end'); e.hidden = false; $('dlg').hidden = true; $('choices').hidden = true;
  e.innerHTML = `<span class="mono" style="color:var(--brass)">End of chapter ${cur.ch + 1}</span><h3>${esc(ch.title)}</h3>
    <div class="endrow">${nx ? `<button class="primary" id="goNext"><span>Next: ${esc(nx.title)}</span><small>Chapter ${cur.ch + 2}</small></button>` : '<span class="mono" style="color:var(--muted)">End of the story</span>'}
    <button class="ghost" id="toHome">Chapters</button></div>`;
  e.querySelector('#goNext')?.addEventListener('click', ev => { ev.stopPropagation(); readChapter(cur.ch + 1, true, true); });
  e.querySelector('#toHome').addEventListener('click', ev => { ev.stopPropagation(); leaveReader(); });
  e.querySelector('button').focus({ preventScroll: true });
}

// ---------- reader open/close ----------
let readerOpen = false;
function openChapter(k, fromStart) {
  cur.ch = k; hist = [];
  const ch = EV.chapters[k]; const p = chRead(ch.id);
  cur.choices = fromStart ? {} : Object.assign({}, p.choices || {});
  const L = ch.lines;
  const resume = !fromStart && typeof p.i === 'number' && !p.done && p.i > 0 && p.i < L.length;
  const i = resume ? p.i : nextVisible(L, -1, cur.choices);
  bgShown = undefined; hideFigure(); closeSheets();
  $('chLabel').textContent = `Ch. ${two(k + 1)} · ${ch.title}`;
  preloadSe(L);
  if (!readerOpen) {
    readerOpen = true; $('reader').hidden = false; document.documentElement.classList.add('reading');
    document.body.dataset.view = 'reader';
    $('home').inert = true; $('stage').focus({ preventScroll: true });
  }
  applyStyle();
  show(i, { flash: true });
  if (resume) toast(`Resumed chapter ${k + 1}.`, { label: 'Start over', fn: () => openChapter(k, true) });
}
function closeReader() {
  if (!readerOpen) return;
  readerOpen = false; clearTimeout(autoTimer); autoOn = false; $('autoBtn').setAttribute('aria-pressed', 'false');
  if (typing) typing.finish();
  setMusic(null); closeSheets();
  $('reader').hidden = true; document.documentElement.classList.remove('reading'); $('home').inert = false;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  scheduleSync(1000);
}

// ---------- navigation ----------
// #/ library · #/e/<id> a story's home · #/e/<id>/<n> reading chapter n · #/sync/<key> link a device
function nav(hash, { replace = false, from = null } = {}) {
  if (location.hash === hash) return route();
  history[replace ? 'replaceState' : 'pushState']({ from }, '', hash);
  route();
}
function readChapter(k, fromStart, replace) {
  openChapter(k, fromStart);
  const h = `#/e/${EVID}/${k + 1}`;
  if (location.hash !== h) history[replace || readerOpenFromHash() ? 'replaceState' : 'pushState']({ from: 'home' }, '', h);
}
const readerOpenFromHash = () => /^#\/e\/\d+\/\d+/.test(location.hash);
function leaveReader() {
  if (history.state && history.state.from === 'home') history.back();
  else nav(`#/e/${EVID}`, { replace: true });
}
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'sync' && parts[1]) {
    const key = SC.normalizeKey(parts[1]);
    history.replaceState(null, '', '#/');
    showLibrary();
    if (key) openSync({ offerKey: key });
    return;
  }
  if (parts[0] === 'e' && /^\d+$/.test(parts[1] || '')) {
    const id = +parts[1];
    if (EVID !== id && !(await loadEvent(id))) { history.replaceState(null, '', '#/'); showLibrary(); return; }
    const n = /^\d+$/.test(parts[2] || '') ? +parts[2] - 1 : null;
    if (n != null && n >= 0 && n < EV.chapters.length) {
      if (!readerOpen || cur.ch !== n) { showHome(); openChapter(n, false); }
      return;
    }
    closeReader(); showHome();
    return;
  }
  closeReader(); showLibrary();
}
addEventListener('popstate', route);
addEventListener('hashchange', route);

function setView(v) {
  document.body.dataset.view = v;
  $('library').hidden = v !== 'library';
  $('home').hidden = v === 'library';
  $('cover').hidden = v === 'library';
  if (v === 'library') $('feature').hidden = true;
  document.title = v === 'library' || !EV ? CFG.title : `${EV.title} · ${CFG.title}`;
}

// ---------- library ----------
let filter = 'all';
function eventProgress(ev) {
  const e = S.events[ev.id];
  const recs = e ? Object.values(e.ch) : [];
  return { started: recs.length > 0, done: recs.filter(r => r.done).length };
}
function showLibrary() {
  setView('library');
  renderLibrary();
}
function cardHtml(ev, pending) {
  const p = eventProgress(ev);
  const stat = p.done >= ev.chapters ? '<span class="done">Finished</span>'
    : p.done ? `Read ${p.done} of ${ev.chapters} chapters` : p.started ? 'In progress' : `${ev.chapters} chapters`;
  const pct = Math.min(1, p.done / ev.chapters);
  return `<button class="ev-card" type="button" data-id="${ev.id}">
    ${ev.cover ? `<img src="${esc(A(ev.cover))}" alt="" loading="lazy">` : ''}
    ${pending ? '<span class="tag mono">Unreviewed</span>' : ''}
    <span class="in"><span class="kind mono">${esc(KIND_LABEL[ev.kind] || 'Story')}</span>
    <h2>${esc(ev.title)}</h2><span class="stat mono">${stat}</span></span>
    ${pct > 0 ? `<span class="meter" style="width:${(pct * 100).toFixed(1)}%"></span>` : ''}</button>`;
}
// Reviewed stories fill the regular categories; the rest wait in their own section until the maintainer
// has compared them with the game.
function renderLibrary() {
  const evs = [...CATALOG.events].sort((a, b) => a.id - b.id);   // the game numbers stories in release order
  const done = evs.filter(e => e.reviewed), wait = evs.filter(e => !e.reviewed);
  const kinds = KIND_ORDER.filter(k => done.some(e => e.kind === k));
  const chips = [['all', 'All'], ...kinds.map(k => [k, KIND_PLURAL[k]]), ...(wait.length ? [['review', 'Awaiting human review']] : [])];
  if (!chips.some(([k]) => k === filter)) filter = 'all';
  const fl = $('filters');
  fl.hidden = chips.length < 3;
  if (!fl.hidden) {
    fl.innerHTML = chips.map(([k, label]) => `<button type="button" data-k="${k}" aria-pressed="${filter === k}">${esc(label)}</button>`).join('');
  }
  const grid = $('grid');
  if (!evs.length) {
    grid.hidden = false; $('pending').hidden = true;
    grid.innerHTML = `<p class="lib-empty">${CATALOG.error ? esc(CATALOG.error) : 'No stories are published yet.'}</p>`;
    return;
  }
  const showDone = filter === 'review' ? [] : done.filter(e => filter === 'all' || e.kind === filter);
  const showWait = filter === 'all' || filter === 'review' ? wait : [];
  grid.hidden = !showDone.length;
  grid.innerHTML = showDone.map(ev => cardHtml(ev, false)).join('');
  $('pending').hidden = !showWait.length;
  $('pendingGrid').innerHTML = showWait.map(ev => cardHtml(ev, true)).join('');
}
$('library').addEventListener('click', e => {
  const c = e.target.closest('.ev-card'); if (!c) return;
  nav(`#/e/${c.dataset.id}`, { from: 'library' });
});
$('filters').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; filter = b.dataset.k; renderLibrary(); });
$('toLibrary').addEventListener('click', e => {
  e.preventDefault();
  if (history.state && history.state.from === 'library') history.back(); else nav('#/', { replace: true });
});

// ---------- loading a story ----------
async function loadEvent(id) {
  try {
    const res = await fetch(`data/events/${id}.json`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    EV = data; AS = data.assets; EVID = id;
    sePool = {}; bgShown = undefined; track = null; hideFigure();
    return true;
  } catch {
    toast("That story couldn't be loaded. It may not be published yet.");
    return false;
  }
}

// ---------- story home ----------
function showHome() {
  setView('event');
  renderHome();
}
function renderHome() {
  if (!EV) return;
  $('evTitle').textContent = EV.title;
  $('evKind').textContent = KIND_LABEL[EV.kind] || 'Story';
  $('reviewNote').hidden = !!EV.reviewed;
  const total = EV.chapters.reduce((a, c) => a + c.lines.filter(l => l.k !== 'fx' && !l.title).length, 0);
  const days = EV.chapters.map((c, i) => dayLabel(c, i)).filter(d => d.startsWith('Day'));
  $('evMeta').textContent = [`${EV.chapters.length} chapters`, days.length ? `${days[0]} to ${days[days.length - 1]}` : '', `${total} lines`].filter(Boolean).join(' · ');
  const ol = $('chList'); ol.innerHTML = '';
  EV.chapters.forEach((ch, k) => {
    const p = chRead(ch.id);
    const badge = p.done ? '<span class="st done mono">Read</span>' : p.max ? `<span class="st cur mono">${Math.round(p.max * 100)}%</span>` : '<span class="st mono"></span>';
    const li = document.createElement('li');
    li.innerHTML = `<button><span class="num">${two(k + 1)}</span><span class="nm">${esc(ch.title)}</span>${badge}<span class="day mono">${esc(dayLabel(ch, k))}</span></button>`;
    li.firstChild.addEventListener('click', () => readChapter(k, !!p.done));
    ol.appendChild(li);
  });
  const st = c => chRead(c.id);
  const lastCh = (S.events[EVID] || {}).last;
  const inProg = EV.chapters.map((c, k) => k).filter(k => st(EV.chapters[k]).max && !st(EV.chapters[k]).done);
  let k, fromStart, label;
  if (inProg.length) { k = inProg.includes(lastCh) ? lastCh : inProg[0]; fromStart = false; label = 'Continue'; }
  else {
    const nk = EV.chapters.findIndex(c => !st(c).done);
    if (nk < 0) { k = 0; fromStart = true; label = 'Read again'; }
    else { k = nk; fromStart = true; label = EV.chapters.some(c => st(c).max) ? 'Next chapter' : 'Start reading'; }
  }
  $('startLbl').textContent = label;
  $('startSub').textContent = `Ch. ${two(k + 1)} · ${EV.chapters[k].title}`;
  $('startBtn').onclick = () => readChapter(k, fromStart);
  // backdrop: the story's most-used scene, and its lead character
  $('coverImg').src = EV.cover && url.bg(EV.cover) ? url.bg(EV.cover) : '';
  setFeature();
}
function setFeature() {
  const n = {};
  for (const ch of EV.chapters) for (const l of ch.lines) { const p = l.a && actorPaint(l.a); if (p && AS.paint[p] && AS.paint[p].face) n[p] = (n[p] || 0) + 1; }
  const lead = Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const meta = lead && AS.paint[lead];
  $('feature').hidden = !meta;
  if (!meta) return;
  $('fpaint').src = url.paint(lead);
  const f = meta.face, fe = $('fface');
  fe.hidden = !f.def;
  if (f.def) { Object.assign(fe.style, { left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%' }); fe.src = url.face(lead, f.def); }
  const W = innerWidth, H = innerHeight, ar = meta.h / meta.w;
  const pw = H * 0.17 * (f.head ? 2.1 : 1) / f.w, ph = pw * ar;
  const cx = W >= 900 ? W * 0.7 : W * 0.6;
  const left = cx - (f.x + f.w / 2) * pw;
  let top = H * 0.27 - (f.y + f.h / 2) * ph;
  if (top + ph < H) top = H - ph;
  Object.assign($('ffig').style, { width: pw + 'px', height: ph + 'px', transform: `translate(${left}px, ${top}px)` });
}
addEventListener('resize', () => { if (document.body.dataset.view === 'event' && EV) setFeature(); });

// ---------- backlog ----------
function avatarHtml(l) {
  const p = l.a ? actorPaint(l.a) : null, meta = p && AS.paint[p];
  const e = meta && meta.po ? (l.e && meta.po.e.includes(l.e) ? l.e : meta.po.e[0]) : l.e;
  const css = avatarCss(p, e);
  if (css) return `<div class="av" style="${css}"></div>`;
  const nm = nameOf(l);
  return nm ? `<div class="av ini">${esc(nm.replace(/[^\p{L}\p{N}]/gu, '').charAt(0) || '?')}</div>` : '<div></div>';
}
function lineRow(l, i) {
  if (l.k === 'card') return l.title ? '' : `<div class="cardrow" data-i="${i}">${l.t.map(t => `<div>${cardText(t)}</div>`).join('')}</div>`;
  const nm = nameOf(l);
  return `<div class="row${nm || l.anon ? '' : ' narr'}" data-i="${i}">${avatarHtml(l)}<div class="t">${nm ? `<div class="w2"${nameColor(l) ? ` style="color:${nameColor(l)}"` : ''}>${esc(nm)}</div>` : ''}${rich(l.t)}</div></div>`;
}
function renderLog() {
  const L = lines(); let html = '';
  for (let j = 0; j <= cur.i; j++) if (visible(L, j, cur.choices)) html += lineRow(L[j], j);
  const list = $('logList'); list.innerHTML = html;
  list.querySelector(`[data-i="${cur.i}"]`)?.classList.add('cur');
  list.scrollTop = list.scrollHeight;
}
$('logList').addEventListener('click', e => {
  const row = e.target.closest('[data-i]'); if (!row) return;
  const i = +row.dataset.i;
  while (hist.length && hist[hist.length - 1] >= i) hist.pop();
  closeSheets(); show(i);
});

// ---------- script reading style ----------
function renderScript() {
  const ch = EV.chapters[cur.ch], L = ch.lines;
  let html = `<span class="mono" style="color:var(--brass)">Chapter ${cur.ch + 1}${dayLabel(ch, cur.ch) ? ' · ' + esc(dayLabel(ch, cur.ch)) : ''}</span><h3>${esc(ch.title)}</h3>`;
  let bg = null;
  for (let k = 0; k < L.length; k++) {
    const l = L[k];
    if (l.bg && l.bg !== bg && url.bg(l.bg)) { bg = l.bg; html += `<div class="sc"><img loading="lazy" src="${url.bg(l.bg)}" alt=""><span class="mono">Scene change</span></div>`; }
    if (l.k === 'fx' || l.of != null) continue;
    html += lineRow(l, k);
    if (l.opts) {
      const picked = cur.choices[k] ?? null;
      html += `<div class="choice"><span class="mono" style="color:var(--muted)">Choice</span>${l.opts.map(o => `<button class="chip" data-j="${k}" data-f="${o.f}" aria-pressed="${picked === o.f}">${rich(o.t)}</button>`).join('')}</div>`;
      for (const o of l.opts) {
        const rows = [];
        for (let m = k + 1; m < L.length && (L[m].of != null || L[m].k === 'fx'); m++) if (L[m].of === o.f) rows.push(lineRow(L[m], m));
        if (rows.length) html += `<div class="branch-h mono">If you chose “${rich(o.t)}”</div><div class="branch">${rows.join('')}</div>`;
      }
    }
  }
  const nx = EV.chapters[cur.ch + 1];
  if (nx) html += `<div style="margin-top:28px"><button class="primary" id="scriptNext"><span>Next: ${esc(nx.title)}</span><small>Chapter ${cur.ch + 2}</small></button></div>`;
  $('scriptWrap').innerHTML = html;
  markScript(true);
}
function markScript(scroll) {
  const wrap = $('scriptWrap');
  wrap.querySelectorAll('.cur').forEach(n => n.classList.remove('cur'));
  const el = wrap.querySelector(`[data-i="${cur.i}"]`);
  if (el) { el.classList.add('cur'); if (scroll) el.scrollIntoView({ block: 'center' }); }
}
$('scriptWrap').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (chip) { cur.choices[+chip.dataset.j] = +chip.dataset.f; renderScript(); return; }
  if (e.target.closest('#scriptNext')) { markDone(cur.ch); readChapter(cur.ch + 1, true, true); return; }
  const row = e.target.closest('[data-i]'); if (!row) return;
  const i = +row.dataset.i, L = lines();
  if (L[i].of != null) { const j = branchOf(L, i); if (j >= 0) cur.choices[j] = L[i].of; }
  hist = []; setPref('style', 'story'); applyStyle(); show(i);
});
function applyStyle() {
  const script = prefs.style === 'script';
  $('stage').hidden = script; $('script').hidden = !script;
  $('logBtn').hidden = script; $('autoBtn').hidden = script;
  $('styleSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === prefs.style));
  if (script) { if (typing) typing.finish(); clearTimeout(autoTimer); renderScript(); } else layoutFig();
}

// ---------- sheets + menu ----------
function closeSheets() { $('logSheet').hidden = true; $('menu').hidden = true; }
$('logBtn').addEventListener('click', e => { e.stopPropagation(); const s = $('logSheet'); const open = s.hidden; closeSheets(); if (open) { s.hidden = false; renderLog(); } });
$('logClose').addEventListener('click', () => closeSheets());
$('menuBtn').addEventListener('click', e => { e.stopPropagation(); const m = $('menu'); const open = m.hidden; closeSheets(); m.hidden = !open; });
document.addEventListener('click', e => {
  const m = $('menu');
  if (!m.hidden && !m.contains(e.target) && !e.target.closest('#menuBtn')) { m.hidden = true; e.stopPropagation(); }
}, true);
function renderSwitches() {
  for (const [id, on] of [['musicSw', prefs.music], ['sfxSw', prefs.sfx]]) { $(id).setAttribute('aria-pressed', on); $(id).textContent = on ? 'On' : 'Off'; }
  $('speedSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === prefs.speed));
  $('styleSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === prefs.style));
  if (document.activeElement !== $('nameIn')) $('nameIn').value = prefs.name;
}
$('musicSw').addEventListener('click', () => { setPref('music', !prefs.music); renderSwitches(); track = null; if (readerOpen) setMusic(sceneAt(lines(), cur.i).bgm); });
$('sfxSw').addEventListener('click', () => { setPref('sfx', !prefs.sfx); renderSwitches(); });
$('speedSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setPref('speed', b.dataset.v); renderSwitches(); });
$('styleSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setPref('style', b.dataset.v); closeSheets(); applyStyle(); if (prefs.style === 'story') show(cur.i); });
$('nameIn').addEventListener('input', () => setPref('name', $('nameIn').value.trim() || 'Commander'));
$('nameIn').addEventListener('change', () => { if (prefs.style === 'script') renderScript(); else show(cur.i); });
if (!document.fullscreenEnabled) $('fsBtn').hidden = true;
$('fsBtn').addEventListener('click', () => {
  const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  Promise.resolve(p).catch(() => toast('Full screen is not available here.'));
});
$('menuSync').addEventListener('click', () => { closeSheets(); openSync(); });
let resetArmed = false;
$('resetBtn').addEventListener('click', () => {
  if (!resetArmed) { resetArmed = true; $('resetBtn').textContent = 'Click again to reset'; setTimeout(() => { resetArmed = false; $('resetBtn').textContent = "Reset this story's progress"; }, 3000); return; }
  const e = evState(EVID); e.resetAt = Date.now(); e.ch = {}; e.last = null; e.lastAt = e.resetAt;
  save(); scheduleSync(1000);
  resetArmed = false; $('resetBtn').textContent = "Reset this story's progress";
  leaveReader(); toast("This story's progress was cleared.");
});

// ---------- files (EPUB, backups) ----------
let downloads = null;
if (window.claude && typeof window.claude.use === 'function') window.claude.use('downloads').then(d => { downloads = d; }).catch(() => {});
async function saveFile(filename, blob) {
  if (downloads) { await downloads.save({ filename, data: blob }); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const X = s => esc(s);
function epubChapter(ch, k) {
  const L = ch.lines; let body = '', bg = null;
  const para = l => {
    if (l.k === 'card') return l.title ? '' : l.t.map(t => `<p class="card">${cardText(t, true)}</p>`).join('');
    const nm = nameOf(l);
    return nm ? `<p class="say"><span class="who">${X(nm)}</span><br/>${rich(l.t, true)}</p>` : `<p class="nar">${rich(l.t, true)}</p>`;
  };
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (l.bg && bg && l.bg !== bg) body += '<hr class="scene"/>';
    if (l.bg) bg = l.bg;
    if (l.k === 'fx' || l.of != null) continue;
    body += para(l);
    if (l.opts) {
      body += `<div class="choice"><p class="ch-h">Choice</p><ul>${l.opts.map(o => `<li>${rich(o.t, true)}</li>`).join('')}</ul></div>`;
      for (const o of l.opts) {
        let rows = '';
        for (let m = i + 1; m < L.length && (L[m].of != null || L[m].k === 'fx'); m++) if (L[m].of === o.f) rows += para(L[m]);
        if (rows) body += `<div class="branch"><p class="br-h">If you chose “${rich(o.t, true)}”</p>${rows}</div>`;
      }
    }
  }
  return xhtml(ch.title, `<section epub:type="chapter" id="c${k + 1}"><p class="kicker">Chapter ${k + 1}${dayLabel(ch, k) ? ' · ' + X(dayLabel(ch, k)) : ''}</p><h1>${X(ch.title)}</h1>
${body}</section>`);
}
const xhtml = (title, body, cls) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${X(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body${cls ? ` class="${cls}"` : ''}>${body}</body></html>`;
async function coverJpeg() {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 1800;
  const g = c.getContext('2d');
  g.fillStyle = '#0b111d'; g.fillRect(0, 0, 1200, 1800);
  if (EV.cover && url.bg(EV.cover)) {
    try {
      const im = new Image(); im.crossOrigin = 'anonymous'; im.src = url.bg(EV.cover); await im.decode();
      const s = Math.max(1200 / im.width, 1800 / im.height);
      g.drawImage(im, (1200 - im.width * s) / 2, (1800 - im.height * s) / 2, im.width * s, im.height * s);
    } catch {}
  }
  const grad = g.createLinearGradient(0, 700, 0, 1800); grad.addColorStop(0, '#0b111d00'); grad.addColorStop(.55, '#0b111ddd'); grad.addColorStop(1, '#0b111d');
  g.fillStyle = grad; g.fillRect(0, 0, 1200, 1800);
  try { await document.fonts.ready; } catch {}
  g.fillStyle = '#d6b06a'; g.font = '500 30px "IBM Plex Mono", monospace';
  g.fillText(('AZUR LANE  ·  ' + (KIND_LABEL[EV.kind] || 'Story')).toUpperCase(), 90, 1290);
  g.fillRect(90, 1316, 120, 3);
  g.fillStyle = '#eef1f6'; g.font = '800 104px "Shippori Mincho B1", Georgia, serif';
  const words = EV.title.split(' '); let line = '', y = 1450;
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > 1020 && line) { g.fillText(line, 90, y); y += 118; line = w; } else line = t; }
  g.fillText(line, 90, y);
  g.fillStyle = '#a6afc0'; g.font = '400 34px "Literata", Georgia, serif';
  g.fillText(`${EV.chapters.length} chapters`, 90, Math.min(1720, y + 90));
  return new Promise(r => { try { c.toBlob(r, 'image/jpeg', 0.86); } catch { r(null); } });
}
async function buildEpub() {
  const zip = new JSZip();
  const uid = (() => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const r = crypto.getRandomValues(new Uint8Array(16)); r[6] = (r[6] & 15) | 64; r[8] = (r[8] & 63) | 128;
    const h = Array.from(r, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  })();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/style.css', `body{font-family:serif;line-height:1.55;margin:0 4%}
h1{font-size:1.6em;margin:.2em 0 1.2em;line-height:1.2}
.kicker{font-size:.75em;letter-spacing:.12em;text-transform:uppercase;color:#7a6a45;margin:2em 0 0}
p{margin:0 0 .85em}
.who{font-weight:bold;font-variant:small-caps;letter-spacing:.03em}
.nar{font-style:italic}
.card{text-align:center;font-weight:bold;margin:1.6em 0}
hr.scene{border:0;text-align:center;margin:1.4em 0}
hr.scene:after{content:"⁂";font-size:1.1em}
.choice{margin:1em 0;padding:.5em .8em;border-left:3px solid #b8964f}
.choice ul{margin:.2em 0 0;padding-left:1.2em}
.ch-h,.br-h{font-size:.8em;letter-spacing:.08em;text-transform:uppercase;color:#7a6a45;margin:0 0 .3em}
.branch{margin:0 0 1em 1em;padding-left:.8em;border-left:1px solid #ccc}
.cover{margin:0;padding:0;text-align:center}.cover img{max-width:100%;max-height:100%}
.colophon{font-size:.9em}`);
  const cover = await coverJpeg();
  if (cover) zip.file('OEBPS/cover.jpg', cover);
  zip.file('OEBPS/cover.xhtml', xhtml('Cover', `<section epub:type="cover">${cover ? `<img src="cover.jpg" alt="${X(EV.title)}"/>` : `<h1>${X(EV.title)}</h1>`}</section>`, 'cover'));
  const items = [], spine = [], nav = [], ncx = [];
  EV.chapters.forEach((ch, k) => {
    const f = `c${two(k + 1)}.xhtml`;
    zip.file('OEBPS/' + f, epubChapter(ch, k));
    items.push(`<item id="c${k + 1}" href="${f}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${k + 1}"/>`);
    nav.push(`<li><a href="${f}">${k + 1}. ${X(ch.title)}</a></li>`);
    ncx.push(`<navPoint id="n${k + 1}" playOrder="${k + 1}"><navLabel><text>${k + 1}. ${X(ch.title)}</text></navLabel><content src="${f}"/></navPoint>`);
  });
  zip.file('OEBPS/about.xhtml', xhtml('About this book', `<section epub:type="colophon" class="colophon"><h1>About this book</h1>
<p>This book was compiled from the English text of the Azur Lane story "${X(EV.title)}" by ${X(CFG.title)}, an unofficial, non-commercial fan reader built with Claude, an AI model made by Anthropic.</p>
${EV.reviewed ? '' : '<p>When this book was made, the story had not yet been compared with the game by a person.</p>'}
<p>Azur Lane's story text belongs to Manjuu, Yongshi and Yostar. This book is not affiliated with them. Game data from the community projects AzurLaneData and AzurAssets.</p>
${location.protocol.startsWith('http') ? `<p>${X(location.origin + location.pathname)}</p>` : ''}</section>`));
  nav.push('<li><a href="about.xhtml">About this book</a></li>');
  ncx.push(`<navPoint id="n-about" playOrder="${EV.chapters.length + 1}"><navLabel><text>About this book</text></navLabel><content src="about.xhtml"/></navPoint>`);
  zip.file('OEBPS/nav.xhtml', xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${nav.join('')}</ol></nav>`));
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${uid}"/></head><docTitle><text>${X(EV.title)}</text></docTitle><navMap>${ncx.join('')}</navMap></ncx>`);
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${uid}</dc:identifier><dc:title>${X(EV.title)}</dc:title><dc:language>en</dc:language>
<dc:creator>Manjuu, Yongshi, Yostar</dc:creator>
<dc:contributor>${X(CFG.title)} (fan reader built with Claude, Anthropic's AI model)</dc:contributor>
<dc:subject>Azur Lane story</dc:subject>
<dc:description>Unofficial fan compilation of the Azur Lane story "${X(EV.title)}" (EN server text), made with an AI-built reader.</dc:description>
<meta property="dcterms:modified">${modified}</meta>${cover ? '<meta name="cover" content="cover-img"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${cover ? '<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>' : ''}
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
${items.join('\n')}
<item id="about" href="about.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="cover" linear="yes"/>${spine.join('')}<itemref idref="about"/></spine>
</package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}
async function exportEpub(btn) {
  btn.disabled = true;
  try {
    if (!window.JSZip) throw { code: 'nozip' };
    const blob = await buildEpub();
    await saveFile(EV.title.replace(/[^\w\s-]/g, '').trim() + '.epub', blob);
  } catch (e) {
    const code = e && e.code;
    if (code === 'declined') toast('Export cancelled.');
    else if (code === 'nozip') toast('The EPUB builder did not load. Check your connection and reload.');
    else if (code === 'rate_limited') toast('A save prompt is already open.');
    else toast('Export failed: ' + (e && e.message || 'unknown error'));
  } finally { btn.disabled = false; }
}
$('homeEpub').addEventListener('click', e => exportEpub(e.currentTarget));
$('menuEpub').addEventListener('click', e => exportEpub(e.currentTarget));

// ---------- sync ----------
let syncKey = SC.normalizeKey((readLS(SYNC_STORE) || {}).key);
const sync = { at: 0, err: null, busy: false, timer: null, offer: null, confirmDelete: false };
const syncAvailable = () => !!CFG.syncApi;
const syncOn = () => syncAvailable() && !!syncKey;
const api = k => `${CFG.syncApi.replace(/\/$/, '')}/v1/progress/${k}`;
function scheduleSync(delay = 30000) {
  if (!syncOn()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(), delay);
}
function applyRemote(remote) {
  S = SC.mergeState(S, remote);
  prefs = Object.assign({}, DEFAULT_PREFS, S.prefs);
  writeLS(STORE, S);
  renderSwitches();
  if (document.body.dataset.view === 'library') renderLibrary();
  else if (document.body.dataset.view === 'event') renderHome();
}
async function syncNow({ keepalive = false } = {}) {
  if (!syncOn() || sync.busy) return false;
  sync.busy = true; renderSyncUI();
  let ok = false;
  try {
    const body = JSON.stringify(S);
    const res = await fetch(api(syncKey), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
      keepalive: keepalive && body.length < 60000 });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.data) { applyRemote(data.data); sync.at = Date.now(); sync.err = null; ok = true; }
    else if (res.status === 429 && data && data.data) { applyRemote(data.data); scheduleSync(4000); sync.err = null; ok = true; }
    else if (res.status === 429) { sync.err = 'The sync service is busy. It will try again shortly.'; scheduleSync(60000); }
    else sync.err = `Sync failed (error ${res.status}). Your progress is still saved on this device.`;
  } catch {
    sync.err = "Couldn't reach the sync service. Your progress is still saved on this device.";
    scheduleSync(60000);
  } finally { sync.busy = false; renderSyncUI(); }
  return ok;
}
function setKey(k) { syncKey = k; writeLS(SYNC_STORE, k ? { key: k } : null); if (!k) clearTimeout(sync.timer); renderSyncUI(); }
async function turnOn() {
  setKey(SC.newKey(n => crypto.getRandomValues(new Uint8Array(n))));
  if (await syncNow()) toast('Sync is on. Use the key to link your other devices.');
}
async function linkKey(k) {
  sync.busy = true; renderSyncUI();
  try {
    const res = await fetch(api(k));
    if (res.status === 404) { sync.err = 'No synced progress uses that key. Check it and try again.'; return; }
    if (!res.ok) { sync.err = `Couldn't check the key (error ${res.status}).`; return; }
    const data = await res.json();
    applyRemote(data.data);
  } catch { sync.err = "Couldn't reach the sync service. Try again in a moment."; return; }
  finally { sync.busy = false; renderSyncUI(); }
  setKey(k); sync.offer = null;
  if (await syncNow()) toast('This device is linked. Progress from both devices is merged.');
}
async function forget(deleteRemote) {
  if (deleteRemote) {
    try { const r = await fetch(api(syncKey), { method: 'DELETE' }); if (!r.ok && r.status !== 204) throw 0; }
    catch { sync.err = "Couldn't delete the synced copy. Try again in a moment."; renderSyncUI(); return; }
  }
  setKey(null); sync.confirmDelete = false;
  toast(deleteRemote ? 'Synced copy deleted. Your progress stays on this device.' : 'Sync is off on this device. Your progress stays here.');
}
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 10 ? 'just now' : s < 60 ? `${s} seconds ago` : s < 3600 ? `${Math.round(s / 60)} minutes ago` : `${Math.round(s / 3600)} hours ago`; };
function renderSyncUI() {
  const dot = $('syncDot'), lbl = $('syncLbl');
  dot.className = 'dot' + (syncOn() ? (sync.err ? ' err' : ' on') : '');
  lbl.textContent = syncOn() ? 'Sync on' : 'Sync';
  if ($('syncDlg').hidden) return;
  const b = $('syncBody');
  const status = sync.busy ? '<p class="status">Syncing…</p>' : sync.err ? `<p class="status err">${esc(sync.err)}</p>` : '';
  if (!syncAvailable()) {
    b.innerHTML = `<p>Sync isn't available on this copy of the site yet. Your progress is saved in this browser; a backup file can move it to another device.</p>`;
    return;
  }
  if (sync.offer && sync.offer !== syncKey) {
    b.innerHTML = `<p>Link this device using the key below? Progress on this device and the synced copy are merged; nothing is lost.</p>
      <div class="keybox">${esc(SC.formatKey(sync.offer))}</div>
      <div class="row2"><button class="go" id="offerYes" type="button">Link this device</button><button id="offerNo" type="button">Cancel</button></div>${status}`;
    $('offerYes').onclick = () => linkKey(sync.offer);
    $('offerNo').onclick = () => { sync.offer = null; renderSyncUI(); };
    return;
  }
  if (!syncKey) {
    b.innerHTML = `<p>Turn on sync to continue reading on another device. You'll get a sync key to enter on your other devices.
      There are no accounts: anyone with the key can see and change your reading progress, so keep it private.</p>
      <div class="row2"><button class="go" id="syncOnBtn" type="button">Turn on sync</button></div>
      <h4>Already have a key?</h4>
      <div class="row2"><input type="text" id="keyIn" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" aria-label="Sync key">
        <button id="keyGo" type="button">Link</button></div>${status}`;
    $('syncOnBtn').onclick = turnOn;
    const go = () => { const k = SC.normalizeKey($('keyIn').value); if (!k) { sync.err = 'That key is incomplete. It has 24 letters and digits.'; renderSyncUI(); return; } sync.err = null; linkKey(k); };
    $('keyGo').onclick = go;
    $('keyIn').onkeydown = e => { if (e.key === 'Enter') go(); };
    return;
  }
  const link = `${location.origin}${location.pathname}#/sync/${SC.formatKey(syncKey)}`;
  b.innerHTML = `<p>Sync is on. Enter this key on your other devices, or open the link there. Keep it private.</p>
    <div class="keybox">${esc(SC.formatKey(syncKey))}</div>
    <div class="row2"><button id="copyKey" type="button">Copy key</button><button id="copyLink" type="button">Copy link</button><button id="syncNowBtn" type="button">Sync now</button></div>
    <p class="status">${sync.at ? 'Last synced ' + ago(sync.at) + '.' : 'Not synced yet.'}</p>${status}
    <div class="row2"><button id="stopBtn" type="button">Stop syncing on this device</button>
      <button id="delBtn" type="button" class="danger">${sync.confirmDelete ? 'Click again to delete' : 'Delete synced copy'}</button></div>`;
  $('copyKey').onclick = () => copy(SC.formatKey(syncKey), 'Key copied.');
  $('copyLink').onclick = () => copy(link, 'Link copied.');
  $('syncNowBtn').onclick = () => syncNow();
  $('stopBtn').onclick = () => forget(false);
  $('delBtn').onclick = () => {
    if (!sync.confirmDelete) { sync.confirmDelete = true; renderSyncUI(); setTimeout(() => { sync.confirmDelete = false; renderSyncUI(); }, 3000); return; }
    forget(true);
  };
}
function copy(text, done) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast(done))
    .catch(() => toast('Copy failed. Select the text and copy it instead.'));
}
function openSync(opts = {}) {
  sync.err = null;
  if (opts.offerKey) sync.offer = opts.offerKey;
  openDialog('syncDlg');
  renderSyncUI();
}
$('syncBtn').addEventListener('click', () => openSync());
$('backupBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
  saveFile(`azurlane-story-progress-${new Date().toISOString().slice(0, 10)}.json`, blob).catch(() => toast('The backup could not be saved.'));
});
$('restoreBtn').addEventListener('click', () => $('restoreIn').click());
$('restoreIn').addEventListener('change', async () => {
  const f = $('restoreIn').files[0]; $('restoreIn').value = '';
  if (!f) return;
  try { applyRemote(JSON.parse(await f.text())); save(); scheduleSync(1000); toast('Backup restored and merged.'); }
  catch { toast("That file isn't a reader backup."); }
});
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && syncOn()) syncNow({ keepalive: true }); });

// ---------- dialogs ----------
let lastFocus = null;
function openDialog(id) { lastFocus = document.activeElement; const d = $(id); d.hidden = false; d.querySelector('[data-close]').focus(); }
function closeDialog(d) { d.hidden = true; if (lastFocus) lastFocus.focus?.(); }
for (const d of document.querySelectorAll('.dialog')) {
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) closeDialog(d); });
}
$('aboutBtn').addEventListener('click', () => openDialog('aboutDlg'));

// ---------- misc ----------
let toastTimer = null;
function toast(msg, action) {
  const t = $('toast'); t.innerHTML = ''; t.append(document.createTextNode(msg));
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); t.hidden = true; }; t.append(b); }
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, action ? 6000 : 3000);
}
stage.addEventListener('click', e => {
  if (e.target.closest('button')) return;
  if (!$('logSheet').hidden) { closeSheets(); return; }
  next();
});
$('homeBtn').addEventListener('click', () => leaveReader());
$('autoBtn').addEventListener('click', e => {
  e.stopPropagation(); autoOn = !autoOn; $('autoBtn').setAttribute('aria-pressed', autoOn);
  if (autoOn && !typing) next(); else clearTimeout(autoTimer);
});
document.addEventListener('keydown', e => {
  const openDlg = document.querySelector('.dialog:not([hidden])');
  if (openDlg) { if (e.key === 'Escape') closeDialog(openDlg); return; }
  if (!readerOpen || e.target.closest('input, textarea')) return;
  if (e.key === 'Escape') { if (!$('logSheet').hidden || !$('menu').hidden) closeSheets(); else leaveReader(); return; }
  if (prefs.style === 'script') return;
  if (e.key === 'l' || e.key === 'L') { $('logBtn').click(); return; }
  if (e.key === 'a' || e.key === 'A') { $('autoBtn').click(); return; }
  if (!$('logSheet').hidden) return;
  const btn = e.target.closest('button');
  if (btn && $('reader').contains(btn) && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); back(); }
});

// ---------- boot ----------
async function boot() {
  try { const r = await fetch('config.json', { cache: 'no-cache' }); if (r.ok) CFG = Object.assign(CFG, await r.json()); } catch {}
  $('siteTitle').textContent = CFG.title;
  if (CFG.repoUrl) {
    $('repoLink').innerHTML = `Source and issues on <a href="${esc(CFG.repoUrl)}" target="_blank" rel="noopener">GitHub</a>.`;
    $('reportLine').innerHTML = `If you spot one, <a href="${esc(CFG.repoUrl)}/issues" target="_blank" rel="noopener">report it on GitHub</a>.`;
    $('pendingReport').innerHTML = `If something looks off, <a href="${esc(CFG.repoUrl)}/issues" target="_blank" rel="noopener">report it on GitHub</a>.`;
  }
  try {
    const r = await fetch('data/catalog.json', { cache: 'no-cache' });
    if (!r.ok) throw 0;
    CATALOG = await r.json();
  } catch { CATALOG = { events: [], error: "The story list couldn't be loaded. Check your connection and reload." }; }
  renderSwitches(); renderSyncUI();
  await route();
  if (syncOn()) syncNow();
}
window.__alsr = { buildEpub, state: () => S, syncNow, nav };   // for the test harness
boot();
})();
