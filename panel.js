'use strict';
// Virtual CTC-021 panel. Talks to the simulation through the same HTTP API
// on the desktop host and (later) the ESP32.

const NS = 'http://www.w3.org/2000/svg';

// Lever column x positions, matched to the real machine.
const COLS = [250, 480, 555, 720, 800, 955, 1030, 1180, 1255, 1565, 1640];
const WL_X = { 18: 375, 20: 445, 28: 740, 32: 885, 40: 1170, 46: 1385, 50: 1530 };
const TT_X = { GRO: 517, AND: 760, BRI: 993, WEB: 1218, SUM: 1603 };
// Siding / branch offset from the main, per station: + below, - above.
const SIDING_OFF = [40, -40, -40, 40, 40, -40];
const STATION_LABELS = ['ABERDEEN', 'GROTON', 'ANDOVER', 'BRISTOL', 'WEBSTER', 'SUMMIT'];
const TYPE_COLORS = { Z: '#e0a43a', M: '#c9764a', P: '#58a8f0', L: '#9bd06a', U: '#a58ad6' };

let layout = null;
let state = null;
let lastSeq = 0;
let soundOn = false;
let audio = null;
const lampEls = {};
const leverEls = {};
const toggleEls = {};

// ---------------------------------------------------------------- helpers

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function text(parent, x, y, str, cls, extra) {
  const t = el('text', Object.assign({ x, y, class: cls }, extra || {}), parent);
  t.textContent = str;
  return t;
}

// The browser demo (ctc.js) runs the simulation in WebAssembly; otherwise
// the page talks to the desktop / ESP32 host over HTTP. Both take the same paths.
let wasm = null;

async function startWasm() {
  if (typeof createCtc !== 'function') return;
  const M = await createCtc();
  wasm = {
    tick: M.cwrap('ctc_tick', null, ['number']),
    input: M.cwrap('ctc_input', 'number', ['string', 'string']),
    command: M.cwrap('ctc_command', 'number', ['string', 'string', 'string']),
    state: M.cwrap('ctc_state', 'string', ['number']),
    layout: M.cwrap('ctc_layout', 'string', []),
  };
  M.cwrap('ctc_init', null, ['number'])((Date.now() % 0xfffffff) + 1);
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    wasm.tick(Math.min(1000, Math.round(now - last)));
    last = now;
  }, 50);
}

async function api(path) {
  if (wasm) {
    const url = new URL(path, location.href);
    const q = (k) => url.searchParams.get(k) || '';
    switch (url.pathname.replace(/.*\/api\//, '')) {
      case 'state': return JSON.parse(wasm.state(Number(q('since')) || 0));
      case 'layout': return JSON.parse(wasm.layout());
      case 'input': return { ok: !!wasm.input(q('id'), q('v') || '1') };
      case 'cmd': return { ok: !!wasm.command(q('c'), q('a'), q('b')) };
    }
  }
  const r = await fetch(path, { method: path.startsWith('/api/state') || path.startsWith('/api/layout') ? 'GET' : 'POST' });
  return r.json();
}

function send(id, v) {
  return api(`/api/input?id=${encodeURIComponent(id)}&v=${encodeURIComponent(v)}`);
}

function cmd(c, a, b) {
  let q = `/api/cmd?c=${encodeURIComponent(c)}`;
  if (a !== undefined) q += `&a=${encodeURIComponent(a)}`;
  if (b !== undefined) q += `&b=${encodeURIComponent(b)}`;
  return api(q);
}

// ---------------------------------------------------------------- geometry

// Build drawing geometry for every section from the x position of each
// lever column's OS. Used for both the panel model board and the overview.
function buildGeometry(endsX, osHalf, mainY, leftX, rightX, sidOff) {
  const S = layout.sections, E = layout.ends;
  const g = [];
  const trackY = (sec) => {
    const s = S[sec];
    if (s.station < 0) return mainY;
    const st = s.station;
    const isSiding = s.diverging;
    return isSiding ? mainY + sidOff[st] : mainY;
  };

  E.forEach((e, i) => {
    const x1 = endsX[i] - osHalf, x2 = endsX[i] + osHalf;
    const sy = mainY + sidOff[S[e.legN].station];
    g[e.os] = { os: true, end: i, x1, x2, y: mainY, sy, ds: e.ds, cx: endsX[i] };
  });

  S.forEach((s, i) => {
    if (s.kind === 'os') return;
    const y = trackY(i);
    if (s.block >= 0) {
      const b = layout.blocks[s.block];
      const xa = endsX[b.westEnd] + osHalf, xb = endsX[b.eastEnd] - osHalf;
      const k = b.secs.indexOf(i), n = b.secs.length;
      const w = (xb - xa) / n;
      g[i] = { x1: xa + k * w, x2: xa + (k + 1) * w, y };
    } else if (s.kind === 'boundary') {
      if (s.station === 0) g[i] = { x1: leftX, x2: endsX[0] - osHalf, y };
      else g[i] = { x1: endsX[E.length - 1] + osHalf, x2: rightX, y };
    } else {
      const ends = [];
      E.forEach((e, k) => { if (e.legN === i || e.legR === i) ends.push(k); });
      ends.sort((a, b) => endsX[a] - endsX[b]);
      g[i] = { x1: endsX[ends[0]] + osHalf, x2: endsX[ends[1]] - osHalf, y };
    }
  });
  return g;
}

// Line segments to draw for a section: OS sections have a straight and a diverging leg.
function osLegs(o) {
  const straight = [o.x1, o.y, o.x2, o.y];
  const diverging = o.ds > 0 ? [o.x1, o.y, o.x2, o.sy] : [o.x1, o.sy, o.x2, o.y];
  return { straight, diverging };
}

// Point along a section at fraction f from its west end.
function pointAt(g, sec, f, swPos) {
  const s = g[sec];
  if (s.os) {
    const legs = osLegs(s);
    const l = swPos === 'R' ? legs.diverging : legs.straight;
    return [l[0] + (l[2] - l[0]) * f, l[1] + (l[3] - l[1]) * f];
  }
  return [s.x1 + (s.x2 - s.x1) * f, s.y];
}

// ---------------------------------------------------------------- lamps

function defs(svg) {
  const d = el('defs', null, svg);
  const colors = { red: '#ff3b24', green: '#3dff7e', amber: '#ffb114', white: '#fff4d2' };
  for (const [name, c] of Object.entries(colors)) {
    const on = el('radialGradient', { id: `on-${name}`, cx: '40%', cy: '35%', r: '70%' }, d);
    el('stop', { offset: '0%', 'stop-color': '#ffffff' }, on);
    el('stop', { offset: '35%', 'stop-color': c }, on);
    el('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': '0.85' }, on);
    const off = el('radialGradient', { id: `off-${name}`, cx: '40%', cy: '35%', r: '70%' }, d);
    el('stop', { offset: '0%', 'stop-color': c, 'stop-opacity': '0.35' }, off);
    el('stop', { offset: '100%', 'stop-color': '#0b0b08', 'stop-opacity': '0.95' }, off);
    const glow = el('radialGradient', { id: `glow-${name}` }, d);
    el('stop', { offset: '30%', 'stop-color': c, 'stop-opacity': '0.55' }, glow);
    el('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': '0' }, glow);
  }
  const chrome = el('linearGradient', { id: 'chrome', x1: '0', y1: '0', x2: '1', y2: '0' }, d);
  [['0%', '#7d7f78'], ['35%', '#f4f5ef'], ['60%', '#b9bbb2'], ['100%', '#6e706a']].forEach(([o, c]) =>
    el('stop', { offset: o, 'stop-color': c }, chrome));
  const knob = el('radialGradient', { id: 'knob', cx: '35%', cy: '30%', r: '75%' }, d);
  [['0%', '#ffffff'], ['40%', '#c9cbc3'], ['100%', '#55574f']].forEach(([o, c]) =>
    el('stop', { offset: o, 'stop-color': c }, knob));
}

function makeLamp(parent, id, x, y, color, r = 10) {
  const g = el('g', { class: 'lamp', transform: `translate(${x},${y})` }, parent);
  el('circle', { r: r * 2.4, fill: `url(#glow-${color})`, class: 'lit' }, g);
  el('circle', { r: r + 3, class: 'bezel' }, g);
  el('circle', { r, fill: `url(#off-${color})` }, g);
  el('circle', { r, fill: `url(#on-${color})`, class: 'lit' }, g);
  lampEls[id] = g;
  return g;
}

function makeArrowPair(parent, id, x, y) {
  // Two white arrow jewels pointing west and east, like the real model board.
  const g = el('g', { transform: `translate(${x},${y})` }, parent);
  el('path', { d: 'M -46 0 L -30 -13 L -30 13 Z', fill: '#f4f1e6' }, g);
  el('path', { d: 'M 46 0 L 30 -13 L 30 13 Z', fill: '#f4f1e6' }, g);
  makeLamp(g, `${id}.W`, -16, 0, 'white', 10);
  makeLamp(g, `${id}.E`, 16, 0, 'white', 10);
}

// ---------------------------------------------------------------- controls

function makeLever(parent, id, x, y, kind, num) {
  const positions = kind === 'switch' ? ['N', 'R'] : ['L', 'N', 'R'];
  const g = el('g', { transform: `translate(${x},${y})`, class: 'ctl' }, parent);
  // blocking device mounting blocks either side
  el('rect', { x: -66, y: 4, width: 24, height: 16, rx: 2, fill: '#c9cbc3', stroke: '#8a8c84' }, g);
  el('rect', { x: 42, y: 4, width: 24, height: 16, rx: 2, fill: '#c9cbc3', stroke: '#8a8c84' }, g);
  // plate
  el('path', { d: 'M -40 14 L -34 -26 Q 0 -44 34 -26 L 40 14 Z', fill: '#0d0d0b', stroke: '#e6e2d3', 'stroke-width': 1.5 }, g);
  text(g, 0, -22, String(num), 'plate-num');
  text(g, 0, -9, kind === 'switch' ? 'SWITCH' : 'SIGNAL', 'plate-text');
  if (kind === 'switch') {
    text(g, -26, 2, 'N', 'plate-num');
    text(g, 26, 2, 'R', 'plate-num');
  } else {
    text(g, -27, 2, 'L', 'plate-num');
    text(g, 27, 2, 'R', 'plate-num');
  }
  const h = el('g', { class: 'handle' }, g);
  el('rect', { x: -8, y: 2, width: 16, height: 52, rx: 8, fill: 'url(#chrome)', stroke: '#55574f' }, h);
  el('circle', { cx: 0, cy: 4, r: 11, fill: 'url(#knob)', stroke: '#55574f' }, g);
  // Click areas stay inside the plate: columns 21/23 etc. are only 75 apart.
  const w = 72 / positions.length;
  positions.forEach((p, k) => {
    const r = el('rect', { x: -36 + k * w, y: -40, width: w, height: 100, class: 'hit' }, g);
    r.addEventListener('click', () => { setLever(id, p); send(id, p); });
  });
  leverEls[id] = { h, kind };
}

function setLever(id, pos) {
  const l = leverEls[id];
  if (!l) return;
  const a = l.kind === 'switch' ? (pos === 'R' ? -30 : 30) : { L: 35, N: 0, R: -35 }[pos];
  l.h.setAttribute('transform', `rotate(${a} 0 4)`);
}

function makeRotary(parent, id, x, y, label, left, right, values) {
  // Diamond plate with a black pointer: electric locks and Line Power Transfer.
  const g = el('g', { transform: `translate(${x},${y})`, class: 'ctl' }, parent);
  el('rect', { x: -60, y: 8, width: 22, height: 15, rx: 2, fill: '#c9cbc3', stroke: '#8a8c84' }, g);
  el('rect', { x: 38, y: 8, width: 22, height: 15, rx: 2, fill: '#c9cbc3', stroke: '#8a8c84' }, g);
  el('path', { d: 'M 0 -36 L 30 -4 L 0 28 L -30 -4 Z', fill: '#0d0d0b', stroke: '#e6e2d3', 'stroke-width': 1.5 }, g);
  text(g, 0, -10, label, 'plate-text', { 'font-size': label.length > 5 ? 9 : 12 });
  if (left) text(g, -16, 4, left, 'plate-text');
  if (right) text(g, 16, 4, right, 'plate-text');
  const h = el('g', { class: 'handle' }, g);
  el('path', { d: 'M -9 6 Q 0 0 9 6 L 4 44 Q 0 50 -4 44 Z', fill: '#121210', stroke: '#444' }, h);
  el('circle', { cx: 0, cy: 8, r: 8, fill: '#1c1c19', stroke: '#555' }, g);
  values.forEach((v, k) => {
    const r = el('rect', { x: k === 0 ? -34 : 0, y: -36, width: 34, height: 90, class: 'hit' }, g);
    r.addEventListener('click', () => { setRotary(id, v); send(id, v); });
  });
  leverEls[id] = { h, kind: 'rotary', values };
}

function setRotary(id, v) {
  const l = leverEls[id];
  if (!l) return;
  const a = l.values.indexOf(String(v)) === 0 ? 35 : -35;
  l.h.setAttribute('transform', `rotate(${a} 0 8)`);
}

function makeToggle(parent, id, x, y) {
  const g = el('g', { transform: `translate(${x},${y})`, class: 'ctl' }, parent);
  el('circle', { r: 11, fill: 'url(#knob)', stroke: '#55574f' }, g);
  const bat = el('g', { class: 'toggle-bat' }, g);
  el('rect', { x: -3.5, y: -24, width: 7, height: 24, rx: 3.5, fill: 'url(#chrome)', stroke: '#55574f' }, bat);
  const hit = el('rect', { x: -16, y: -28, width: 32, height: 44, class: 'hit' }, g);
  hit.addEventListener('click', () => {
    const on = !toggleEls[id].on;
    setToggle(id, on);
    send(id, on ? '1' : '0');
  });
  toggleEls[id] = { bat, on: false };
}

function setToggle(id, on) {
  const t = toggleEls[id];
  if (!t) return;
  t.on = on;
  t.bat.setAttribute('transform', on ? 'rotate(0)' : 'rotate(180)');
}

function makeKnob(parent, x, y, r, onClick, title) {
  const g = el('g', { transform: `translate(${x},${y})`, class: 'ctl' }, parent);
  const inner = el('g', { class: 'knob' }, g);
  el('circle', { r: r + 4, fill: '#2d2f22', stroke: '#1d1e15' }, inner);
  el('circle', { r, fill: 'url(#knob)', stroke: '#55574f' }, inner);
  const hit = el('circle', { r: r + 6, class: 'hit' }, inner);
  if (title) el('title', null, hit).textContent = title;
  hit.addEventListener('click', onClick);
  return g;
}

// ---------------------------------------------------------------- panel

function buildPanel() {
  const svg = document.getElementById('panel');
  defs(svg);
  const S = layout.sections, E = layout.ends;
  const mainY = 190;

  // Cabinet and model board
  el('rect', { x: 0, y: 0, width: 1840, height: 1010, rx: 8, fill: '#3f4329' }, svg);
  el('rect', { x: 40, y: 18, width: 1760, height: 318, fill: '#070707', stroke: '#d9d6c8', 'stroke-width': 3 }, svg);
  const mb = el('g', null, svg);

  const g = buildGeometry(COLS, 18, mainY, 100, 1770, SIDING_OFF);

  // Track
  S.forEach((s, i) => {
    const sg = g[i];
    if (sg.os) {
      const legs = osLegs(sg);
      el('line', { x1: legs.straight[0] + 3, y1: legs.straight[1], x2: legs.straight[2] - 3, y2: legs.straight[3], class: 'mb-track' }, mb);
      el('line', { x1: legs.diverging[0] + 3, y1: legs.diverging[1], x2: legs.diverging[2] - 3, y2: legs.diverging[3], class: 'mb-track' }, mb);
    } else {
      el('line', { x1: sg.x1 + 3, y1: sg.y, x2: sg.x2 - 3, y2: sg.y, class: 'mb-track' }, mb);
    }
  });
  // Aberdeen end of territory
  el('line', { x1: 120, y1: mainY - 30, x2: 120, y2: mainY + 70, class: 'mb-track' }, mb);

  // Track lamps
  S.forEach((s, i) => {
    const sg = g[i];
    const x = sg.os ? sg.cx : (sg.x1 + sg.x2) / 2;
    makeLamp(mb, `TK.${s.id}`, x, sg.y, 'red', 9);
  });

  // Switch and signal numbers by each OS
  E.forEach((e, i) => {
    const o = g[e.os];
    text(mb, o.cx, mainY + (SIDING_OFF[S[e.legN].station] > 0 ? -16 : 26), String(e.sw), 'mb-small');
  });

  // Station names, distances
  const nameX = [140, 517, 760, 993, 1218, 1603];
  STATION_LABELS.forEach((n, i) => text(mb, nameX[i], 115, n, 'mb-text'));
  text(mb, 250, 115, 'E704', 'mb-text');
  text(mb, 1412, 115, 'JACKSON', 'mb-text', { 'font-size': 14 });
  const miles = [[365, '15.2 MILES'], [637, '8.6 MILES'], [877, '11.6 MILES'], [1105, '10.2 MILES'], [1410, '22 MILES']];
  miles.forEach(([x, t]) => text(mb, x, 42, t, 'mb-small'));
  const feet = [[517, '7,946 FT'], [760, '9,220 FT'], [993, '12,151 FT'], [1218, '6,470 FT'], [1603, '10,599 FT']];
  feet.forEach(([x, t]) => text(mb, x, 42, t, 'mb-small'));

  // Arrow pairs: control points and traffic
  makeArrowPair(mb, 'CP.E704M', 190, 70);
  makeArrowPair(mb, 'CP.E704B', 190, 292);
  makeArrowPair(mb, 'CP.GRO', 517, 70);
  makeArrowPair(mb, 'CP.AND', 760, 70);
  makeArrowPair(mb, 'CP.BRI', 993, 70);
  makeArrowPair(mb, 'CP.WEB', 1218, 70);
  makeArrowPair(mb, 'CP.SUM', 1603, 70);
  layout.blocks.forEach((b) => {
    const xa = COLS[b.westEnd], xb = COLS[b.eastEnd];
    makeArrowPair(mb, `TR.${b.id}`, (xa + xb) / 2 + (b.westEnd === 0 ? 20 : 0), 70);
  });

  // Track occupancy toggles on the model board
  layout.toggles.forEach((t) => makeToggle(mb, `TT_${t.id}`, TT_X[t.id], 300));

  // ---- control panel
  const cp = el('g', null, svg);
  E.forEach((e, i) => {
    const x = COLS[i];
    makeLamp(cp, `SW${e.sw}.N`, x - 20, 382, 'green', 10);
    makeLamp(cp, `SW${e.sw}.R`, x + 20, 382, 'amber', 10);
    makeLever(cp, `SW${e.sw}`, x, 440, 'switch', e.sw);

    makeLamp(cp, `SIG${e.sig}.S`, x, 508, 'red', 10);
    makeLamp(cp, `SIG${e.sig}.L`, x - 26, 528, 'green', 10);
    makeLamp(cp, `SIG${e.sig}.R`, x + 26, 528, 'green', 10);
    makeLever(cp, `SIG${e.sig}`, x, 590, 'signal', e.sig);

    makeToggle(cp, `CO${e.sig}`, x, 690);
    makeKnob(cp, x, 760, 13, () => send(`CODE${e.sw}`, '1'), `Code button ${e.sw}/${e.sig}`);
  });
  text(cp, 120, 694, 'CALL-ON', 'plate-text', { 'font-size': 11 });
  text(cp, 120, 764, 'CODE', 'plate-text', { 'font-size': 11 });

  layout.wl.forEach((w) => makeRotary(cp, `WL${w.num}`, WL_X[w.num], 852, `${w.num}WL`, null, null, ['N', 'R']));

  // Bottom plates
  el('rect', { x: 260, y: 915, width: 230, height: 70, fill: '#0d0d0b', stroke: '#e6e2d3' }, cp);
  [['RESET', 'BTN_RESET'], ['FIELD DISC.', 'BTN_FSD'], ['OS BELL', 'BTN_BELL'], ['RECALL', 'BTN_RECALL']].forEach(([lbl, id], k) => {
    const x = 290 + k * 57;
    text(cp, x, 932, lbl, 'plate-text', { 'font-size': 8.5 });
    makeKnob(cp, x, 960, 11, () => send(id, '1'), lbl);
  });
  el('rect', { x: 510, y: 915, width: 130, height: 70, fill: '#0d0d0b', stroke: '#e6e2d3' }, cp);
  text(cp, 545, 932, 'CONTROL', 'plate-text', { 'font-size': 8.5 });
  text(cp, 605, 932, 'INDICATION', 'plate-text', { 'font-size': 8.5 });
  makeLamp(cp, 'CODE.CTL', 545, 960, 'white', 9);
  makeLamp(cp, 'CODE.IND', 605, 960, 'white', 9);

  el('rect', { x: 840, y: 925, width: 170, height: 58, fill: '#0d0d0b', stroke: '#e6e2d3' }, cp);
  text(cp, 925, 942, 'CENTRALIZED TRAFFIC CONTROL', 'plate-text', { 'font-size': 8.5 });
  text(cp, 925, 958, 'SIMULATION SYSTEM', 'plate-text', { 'font-size': 11 });
  text(cp, 925, 974, 'WIRELESSBILLY, LLC', 'plate-text', { 'font-size': 8.5 });

  el('rect', { x: 1480, y: 900, width: 110, height: 92, fill: '#0d0d0b', stroke: '#e6e2d3' }, cp);
  text(cp, 1535, 914, 'LINE POWER TRANSFER', 'plate-text', { 'font-size': 7.5 });
  makeRotary(cp, 'LPT', 1535, 950, '', '1', '2', ['1', '2']);
  text(cp, 1497, 984, 'MANUAL', 'plate-text', { 'font-size': 7.5 });
  text(cp, 1573, 984, 'AUTO', 'plate-text', { 'font-size': 7.5 });
}

// ---------------------------------------------------------------- overview

let ov = null;

function overviewEndsX() {
  // Widths: ABD, OS, B0, OS, station, OS, B1, ... compressed but in order.
  const parts = [70, 'E', 230, 'E', 120, 'E', 140, 'E', 120, 'E', 170, 'E', 130, 'E', 160, 'E', 120, 'E', 280, 'E', 130, 'E', 80];
  const osW = 30;
  const total = parts.reduce((a, p) => a + (p === 'E' ? osW : p), 0);
  const k = (1800 - 60) / total;
  const xs = [];
  let x = 30;
  for (const p of parts) {
    if (p === 'E') { xs.push(x + (osW * k) / 2); x += osW * k; } else x += p * k;
  }
  return { xs, osHalf: (osW * k) / 2 };
}

function buildOverview() {
  const svg = document.getElementById('overview');
  const { xs, osHalf } = overviewEndsX();
  const mainY = 130;
  const sid = SIDING_OFF.map((o) => o * 1.1);
  const g = buildGeometry(xs, osHalf, mainY, 30, 1770, sid);
  const tracks = el('g', null, svg);
  const signals = el('g', null, svg);
  const trains = el('g', null, svg);
  const notes = el('g', null, svg);

  const segEls = [];
  layout.sections.forEach((s, i) => {
    const sg = g[i];
    if (sg.os) {
      const legs = osLegs(sg);
      const a = el('line', { x1: legs.straight[0], y1: legs.straight[1], x2: legs.straight[2], y2: legs.straight[3], class: 'ov-track' }, tracks);
      const b = el('line', { x1: legs.diverging[0], y1: legs.diverging[1], x2: legs.diverging[2], y2: legs.diverging[3], class: 'ov-track' }, tracks);
      segEls[i] = { n: a, r: b };
    } else {
      segEls[i] = { line: el('line', { x1: sg.x1 + 2, y1: sg.y, x2: sg.x2 - 2, y2: sg.y, class: 'ov-track lined' }, tracks) };
    }
  });

  STATION_LABELS.forEach((n, st) => {
    let x;
    if (st === 0) x = (g[0].x1 + g[0].x2) / 2;
    else x = (g[layout.ends[2 * st - 1].os].cx + g[layout.ends[2 * st].os].cx) / 2;
    text(notes, x, 28, n.charAt(0) + n.slice(1).toLowerCase(), 'ov-name');
  });

  // Signal heads at each end: one per direction.
  const heads = [];
  layout.ends.forEach((e, i) => {
    const o = g[e.os];
    const mk = (dir) => {
      // A head sits on the approach side of the OS facing the direction of travel.
      const x = dir > 0 ? o.x1 - 4 : o.x2 + 4;
      const p = dir > 0 ? `M ${x - 10} -6 L ${x} 0 L ${x - 10} 6 Z` : `M ${x + 10} -6 L ${x} 0 L ${x + 10} 6 Z`;
      return el('path', { d: p, fill: '#b2321f', transform: `translate(0, ${mainY - 16})` }, signals);
    };
    heads[i] = { W: mk(-1), E: mk(1) };
  });

  const tl = layout.ends.map((e) => text(notes, g[e.os].cx, mainY + 62, '', 'ov-tl'));
  const traffic = layout.blocks.map((b) => {
    const s0 = g[b.secs[0]], s1 = g[b.secs[b.secs.length - 1]];
    return text(notes, (s0.x1 + s1.x2) / 2, mainY - 26, '', 'ov-note', { 'font-size': 14, fill: '#45e07a' });
  });
  const wl = layout.wl.map((w, k) => {
    const s = g[w.section];
    return text(notes, s.x1 + (s.x2 - s.x1) * (0.3 + 0.4 * (k % 2)), mainY + 26, '', 'ov-tl');
  });

  ov = { g, segEls, heads, trains, tl, traffic, wl, mainY };
}

function updateOverview() {
  const f = state.field;
  const { g, segEls, heads, trains, tl, traffic, wl } = ov;

  layout.sections.forEach((s, i) => {
    const se = segEls[i];
    const trainHere = state.trains.some((t) => t.ext.some((x) => x[0] === i));
    const fouled = f.occ[i] && !trainHere;
    if (se.line) {
      se.line.setAttribute('class', 'ov-track lined' + (fouled ? ' fouled' : ''));
    } else {
      const end = f.ends[s.end];
      const lined = end.sw;
      se.n.setAttribute('class', 'ov-track' + (end.moving ? ' moving' : (lined === 'N' ? ' lined' : '')) + (fouled ? ' fouled' : ''));
      se.r.setAttribute('class', 'ov-track' + (end.moving ? ' moving' : (lined === 'R' ? ' lined' : '')) + (fouled ? ' fouled' : ''));
    }
  });

  f.ends.forEach((e, i) => {
    const colorFor = (dir) => {
      if (e.aspect === 'S' || e.dir !== dir) return '#b2321f';
      return e.aspect === 'C' ? '#45e07a' : '#ffb21c';
    };
    heads[i].W.setAttribute('fill', colorFor(-1));
    heads[i].E.setAttribute('fill', colorFor(1));
    tl[i].textContent = e.tl > 0 ? `TL ${e.tl}s` : (e.pending ? 'code…' : '');
  });

  state.field.traffic.forEach((t, b) => {
    traffic[b].textContent = t > 0 ? 'traffic →' : (t < 0 ? '← traffic' : '');
  });
  state.field.wl.forEach((s, k) => {
    wl[k].textContent = s === 'locked' ? '' : `${layout.wl[k].num}WL ${s}`;
  });

  while (trains.firstChild) trains.removeChild(trains.firstChild);
  for (const t of state.trains) {
    const color = TYPE_COLORS[t.sym[0]] || '#ddd';
    let headPt = null;
    for (const [sec, lo, hi] of t.ext) {
      const len = layout.sections[sec].len;
      const sw = layout.sections[sec].kind === 'os' ? f.ends[layout.sections[sec].end].sw : 'N';
      const a = pointAt(g, sec, lo / len, sw);
      const b = pointAt(g, sec, hi / len, sw);
      el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: color, 'stroke-width': 10, 'stroke-linecap': 'round' }, trains);
      const front = t.dir > 0 ? b : a;
      if (!headPt || (t.dir > 0 ? front[0] > headPt[0] : front[0] < headPt[0])) headPt = front;
    }
    if (headPt) {
      const arrow = t.dir > 0 ? '▶' : '◀';
      const label = t.dir > 0 ? `${t.sym} ${t.mph} ${arrow}` : `${arrow} ${t.sym} ${t.mph}`;
      const y = headPt[1] < ov.mainY ? headPt[1] - 14 : headPt[1] + 26;
      text(trains, headPt[0], y, label, 'ov-train-label', { fill: color });
    }
  }
}

// ---------------------------------------------------------------- update loop

function updatePanel() {
  for (const [id, v] of Object.entries(state.lamps)) {
    const g = lampEls[id];
    if (!g) continue;
    g.classList.toggle('on', v === 1);
    g.classList.toggle('flash', v === 2);
  }
  for (const [id, v] of Object.entries(state.inputs)) {
    if (leverEls[id]) {
      if (leverEls[id].kind === 'rotary') setRotary(id, v);
      else setLever(id, v);
    } else if (toggleEls[id]) {
      setToggle(id, v === 1);
    }
  }
}

function updateHeader() {
  document.getElementById('clock').textContent = state.clock;
  const m = document.getElementById('mode');
  m.textContent = state.mode === 'auto' ? 'AUTOMATIC' : 'MANUAL';
  m.classList.toggle('auto', state.mode === 'auto');
  const L = state.line;
  let line = 'Code line idle';
  if (state.fsd) line = 'Field stations DISCONNECTED';
  else if (L.state === 'control') line = `Sending control → ${L.end}`;
  else if (L.state === 'indication') line = `Indication ← ${L.end}`;
  if (L.queued) line += `  (${L.queued} queued)`;
  if (state.bellCut) line += '  · bell cut out';
  document.getElementById('line').textContent = line;
  document.querySelectorAll('#speed button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.s) === state.scale));
  document.getElementById('pause').textContent = state.paused ? 'Resume' : 'Pause';
  document.getElementById('autoSpawn').checked = state.autoSpawn;
  document.getElementById('maxTrains').value = String(state.maxTrains);
  document.getElementById('stats').textContent =
    `${state.completed} through · ${state.spads} SPAD · ${state.collisions} collisions`;
}

function updateTrains() {
  const rows = state.trains.map((t) => {
    const color = TYPE_COLORS[t.sym[0]] || '#ddd';
    return `<tr><td class="sym" style="color:${color}">${t.sym}</td><td>${t.type}</td>` +
      `<td>${t.dir > 0 ? 'EB' : 'WB'}</td><td>${t.mph}</td><td>${t.len.toLocaleString()} ft</td>` +
      `<td>${t.loc}</td><td>${t.status}${t.dest ? ` → ${t.dest}` : ''}</td></tr>`;
  });
  document.getElementById('trainRows').innerHTML = rows.join('') ||
    '<tr><td colspan="7" style="color:#9c9a86">No trains in the territory</td></tr>';
}

function addEvents() {
  const list = document.getElementById('events');
  for (const ev of state.events) {
    if (ev.s <= lastSeq) continue;
    lastSeq = ev.s;
    if (ev.k === 2) ding();
    const li = document.createElement('li');
    li.className = `k${ev.k}`;
    li.innerHTML = `<span class="t">${ev.t}</span>${ev.k === 2 ? '🔔 ' : ''}${ev.m.replace(/</g, '&lt;')}`;
    list.insertBefore(li, list.firstChild);
  }
  while (list.children.length > 300) list.removeChild(list.lastChild);
}

function ding() {
  if (!soundOn || !audio) return;
  const t0 = audio.currentTime;
  [[1180, 0.35], [2950, 0.12], [1770, 0.15]].forEach(([f, v]) => {
    const o = audio.createOscillator();
    const gn = audio.createGain();
    o.frequency.value = f;
    gn.gain.setValueAtTime(v, t0);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
    o.connect(gn).connect(audio.destination);
    o.start(t0);
    o.stop(t0 + 1.5);
  });
}

async function poll() {
  try {
    state = await api(`/api/state?since=${lastSeq}`);
    updateHeader();
    updatePanel();
    updateOverview();
    updateTrains();
    addEvents();
  } catch (e) {
    document.getElementById('line').textContent = 'Lost connection to simulator…';
  }
  setTimeout(poll, 200);
}

// ---------------------------------------------------------------- wiring

function wireControls() {
  document.querySelectorAll('#speed button').forEach((b) =>
    b.addEventListener('click', () => cmd('scale', b.dataset.s)));
  document.getElementById('pause').addEventListener('click', () => cmd('pause', state && state.paused ? '0' : '1'));
  document.getElementById('sound').addEventListener('click', (e) => {
    soundOn = !soundOn;
    if (soundOn && !audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    e.target.textContent = soundOn ? 'Sound on' : 'Sound off';
    if (soundOn) ding();
  });
  const typeSel = document.getElementById('spawnType');
  layout.trainTypes.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.prefix;
    o.textContent = `${t.name} (${t.prefix})`;
    typeSel.appendChild(o);
  });
  document.getElementById('spawnE').addEventListener('click', () => cmd('spawn', 'E', typeSel.value));
  document.getElementById('spawnW').addEventListener('click', () => cmd('spawn', 'W', typeSel.value));
  document.getElementById('autoSpawn').addEventListener('change', (e) => cmd('autospawn', e.target.checked ? '1' : '0'));
  document.getElementById('maxTrains').addEventListener('change', (e) => cmd('maxtrains', e.target.value));
  document.getElementById('lampTest').addEventListener('click', () => cmd('lamptest'));
  document.getElementById('clearTrains').addEventListener('click', () => cmd('clear'));
  // Two-click confirm built into the button (browser confirm() dialogs are blocked in some viewers).
  const resetBtn = document.getElementById('resetSim');
  let armTimer = null;
  resetBtn.addEventListener('click', () => {
    if (resetBtn.classList.contains('armed')) {
      clearTimeout(armTimer);
      resetBtn.classList.remove('armed');
      resetBtn.textContent = 'Reset simulation';
      cmd('reset');
      return;
    }
    resetBtn.classList.add('armed');
    resetBtn.textContent = 'Click again to reset';
    armTimer = setTimeout(() => {
      resetBtn.classList.remove('armed');
      resetBtn.textContent = 'Reset simulation';
    }, 4000);
  });
  document.getElementById('showField').addEventListener('change', (e) =>
    document.querySelector('.log').classList.toggle('hide-field', !e.target.checked));
}

async function init() {
  await startWasm();
  layout = await api('/api/layout');
  buildPanel();
  buildOverview();
  wireControls();
  poll();
}

init();
