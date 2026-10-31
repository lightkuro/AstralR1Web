// Song and chart loading: the game's own format (Docs/MapFormat.md), read the same way.

// Game defaults (UAstralGameSettings), in metres and seconds.
// Dev preset: hit plane 25 m ahead, targets 2 m lower than the default.
export const PLAYFIELD = { width: 20, height: 10, bottom: 0.6, distance: 25 };
export const LANE_WIDTH = 3.6;
export const TARGET_RADIUS = 1.1;
export const DEFAULT_RUN_SPEED = 18;
export const DEFAULT_APPROACH = 1.3;
export const DEFAULT_JUDGE = { perfect: 0.045, great: 0.09, good: 0.135, obstacle: 0.08 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = v => typeof v === 'number' && Number.isFinite(v);

/** Timing points: beats <-> seconds, beat 0 at the first point. */
export class Timing {
  constructor(points) {
    const pts = (Array.isArray(points) ? points : [])
      .filter(p => p && num(p.bpm) && p.bpm > 0)
      .map(p => ({ t: num(p.t) ? p.t : 0, bpm: p.bpm, meter: p.meter || 4 }))
      .sort((a, b) => a.t - b.t);
    if (!pts.length) pts.push({ t: 0, bpm: 120, meter: 4 });
    let beat = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) beat += (pts[i].t - pts[i - 1].t) * pts[i - 1].bpm / 60;
      pts[i].beat = beat;
    }
    this.points = pts;
  }
  pointAt(key, v) {
    let p = this.points[0];
    for (const q of this.points) { if (q[key] <= v) p = q; else break; }
    return p;
  }
  beatToTime(b) { const p = this.pointAt('beat', b); return p.t + (b - p.beat) * 60 / p.bpm; }
  timeToBeat(t) { const p = this.pointAt('t', t); return p.beat + (t - p.t) * p.bpm / 60; }
  bpmAt(t) { return this.pointAt('t', t).bpm; }
}

function startOf(o, timing) {
  if (num(o.t)) return o.t;
  if (num(o.b)) return timing.beatToTime(o.b);
  return null;
}

function endOf(o, start, timing) {
  if (num(o.end)) return o.end;
  if (num(o.endB)) return timing.beatToTime(o.endB);
  if (num(o.dur)) return start + o.dur;
  if (num(o.durB)) return timing.beatToTime(timing.timeToBeat(start) + o.durB);
  return start;
}

/** Chart time -> distance along the track (m), following "speed" events. */
export class DistanceMap {
  constructor(baseSpeed, speedEvents, t0, t1) {
    this.base = baseSpeed;
    this.speeds = speedEvents;
    this.step = 1 / 200;
    this.t0 = t0;
    const n = Math.ceil((t1 - t0) / this.step) + 2;
    this.s = new Float64Array(n);
    let prev = this.mult(t0);
    for (let i = 1; i < n; i++) {
      const m = this.mult(t0 + i * this.step);
      this.s[i] = this.s[i - 1] + (prev + m) * 0.5 * this.step * baseSpeed;
      prev = m;
    }
    // Distance 0 at chart time 0.
    const zero = this.raw(0);
    for (let i = 0; i < n; i++) this.s[i] -= zero;
  }
  mult(t) {
    let m = 1;
    for (const e of this.speeds) {
      if (t < e.t) break;
      const ramp = e.end - e.t;
      m = ramp > 0 && t < e.end ? m + (e.value - m) * (t - e.t) / ramp : e.value;
    }
    return m;
  }
  speedAt(t) { return this.base * this.mult(t); }
  raw(t) {
    const f = (t - this.t0) / this.step;
    const n = this.s.length;
    if (f <= 0) return this.s[0] + (t - this.t0) * this.speedAt(this.t0);
    if (f >= n - 1) return this.s[n - 1] + (t - (this.t0 + (n - 1) * this.step)) * this.speedAt(t);
    const i = Math.floor(f);
    return this.s[i] + (this.s[i + 1] - this.s[i]) * (f - i);
  }
  at(t) { return this.raw(t); }
}

// --- Hold paths (osu! slider curves) ------------------------------------------------------------

function bezierPoints(ctrl, steps) {
  const out = [];
  const tmp = ctrl.map(p => [p[0], p[1]]);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    for (let i = 0; i < tmp.length; i++) { tmp[i][0] = ctrl[i][0]; tmp[i][1] = ctrl[i][1]; }
    for (let k = tmp.length - 1; k > 0; k--) {
      for (let i = 0; i < k; i++) {
        tmp[i][0] += (tmp[i + 1][0] - tmp[i][0]) * t;
        tmp[i][1] += (tmp[i + 1][1] - tmp[i][1]) * t;
      }
    }
    out.push([tmp[0][0], tmp[0][1]]);
  }
  return out;
}

function bezierPoly(pts) {
  // A repeated point splits the curve into separate segments (like osu!).
  const segs = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const same = pts[i][0] === pts[i - 1][0] && pts[i][1] === pts[i - 1][1];
    if (same) { if (cur.length > 1) segs.push(cur); cur = [pts[i]]; } else cur.push(pts[i]);
  }
  if (cur.length > 1) segs.push(cur);
  const out = [];
  for (const s of segs) {
    const p = s.length === 2 ? s : bezierPoints(s, Math.max(8, 12 * (s.length - 1)));
    for (const q of p) {
      const last = out[out.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
    }
  }
  return out.length ? out : [pts[0]];
}

function catmullPoly(p) {
  const out = [];
  const n = p.length;
  for (let i = 0; i < n - 1; i++) {
    const v1 = i > 0 ? p[i - 1] : p[i];
    const v2 = p[i];
    const v3 = p[i + 1];
    const v4 = i < n - 2 ? p[i + 2] : [2 * v3[0] - v2[0], 2 * v3[1] - v2[1]];
    for (let c = i === 0 ? 0 : 1; c <= 16; c++) {
      const t = c / 16, t2 = t * t, t3 = t2 * t;
      const f = k => 0.5 * (2 * v2[k] + (-v1[k] + v3[k]) * t + (2 * v1[k] - 5 * v2[k] + 4 * v3[k] - v4[k]) * t2
        + (-v1[k] + 3 * v2[k] - 3 * v3[k] + v4[k]) * t3);
      out.push([f(0), f(1)]);
    }
  }
  return out;
}

function arcPoly([a, b, c]) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const sq = p => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const cy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  const ta = Math.atan2(a[1] - cy, a[0] - cx);
  let tc = Math.atan2(c[1] - cy, c[0] - cx);
  const ccw = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0;
  if (ccw) { while (tc < ta) tc += Math.PI * 2; } else { while (tc > ta) tc -= Math.PI * 2; }
  const out = [];
  for (let i = 0; i <= 40; i++) {
    const t = ta + (tc - ta) * i / 40;
    out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  return out;
}

/** A hold's path in playfield metres, walked at constant speed (bouncing on repeats). */
export class HoldPath {
  constructor(pts, curve, repeats) {
    let poly;
    if (pts.length < 2) poly = [pts[0]];
    else if (curve === 'bezier') poly = bezierPoly(pts);
    else if (curve === 'catmull') poly = catmullPoly(pts);
    else if (curve === 'arc' && pts.length === 3) poly = arcPoly(pts) || pts;
    else poly = pts;
    this.poly = poly;
    this.cum = [0];
    for (let i = 1; i < poly.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    }
    this.len = this.cum[this.cum.length - 1];
    this.repeats = Math.max(0, repeats | 0);
  }
  atDist(d) {
    const { poly, cum } = this;
    if (poly.length === 1 || d <= 0) return poly[0];
    if (d >= this.len) return poly[poly.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const f = (d - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    return [poly[lo][0] + (poly[hi][0] - poly[lo][0]) * f, poly[lo][1] + (poly[hi][1] - poly[lo][1]) * f];
  }
  at(f) {
    if (this.len <= 0) return this.poly[0];
    const spans = this.repeats + 1;
    const ph = clamp(f, 0, 1) * spans;
    const k = Math.min(Math.floor(ph), spans - 1);
    let local = ph - k;
    if (k % 2 === 1) local = 1 - local;
    return this.atDist(local * this.len);
  }
}

const toMetres = p => [
  (clamp(num(p?.[0]) ? p[0] : 0.5, -0.5, 1.5) - 0.5) * PLAYFIELD.width,
  PLAYFIELD.bottom + clamp(num(p?.[1]) ? p[1] : 0.5, -0.5, 1.5) * PLAYFIELD.height,
];

/** Turns a chart file into sorted runtime lists. */
export function parseChart(json, timing) {
  if (!json || typeof json !== 'object') throw new Error('Not a chart file');
  const laneCount = clamp(Math.round(json.laneCount) || 3, 1, 9);
  const runSpeed = num(json.runSpeed) && json.runSpeed > 0 ? json.runSpeed : DEFAULT_RUN_SPEED;
  const approach = num(json.approachTime) && json.approachTime > 0 ? json.approachTime : DEFAULT_APPROACH;
  const judge = { ...DEFAULT_JUDGE };
  for (const k of Object.keys(DEFAULT_JUDGE)) if (num(json.judge?.[k]) && json.judge[k] > 0) judge[k] = json.judge[k];

  const targets = [];
  for (const o of json.targets || []) {
    const t = startOf(o, timing);
    if (t === null) continue;
    const [X, Y] = toMetres(o.pos);
    const size = num(o.size) && o.size > 0 ? o.size : 1;
    const tg = { t, X, Y, size, r: TARGET_RADIUS * size, group: o.group | 0, hold: null };
    if (o.hold) {
      const end = endOf(o.hold, t, timing);
      if (end > t + 0.05) {
        const pts = [o.pos, ...(Array.isArray(o.hold.path) ? o.hold.path : [])].map(toMetres);
        const tickB = num(o.hold.ticks) ? o.hold.ticks : 0.5;
        const ticks = [];
        if (tickB > 0) {
          const b0 = timing.timeToBeat(t), b1 = timing.timeToBeat(end);
          for (let b = b0 + tickB; b < b1 - 1e-3 && ticks.length < 512; b += tickB) ticks.push(timing.beatToTime(b));
        }
        tg.hold = { end, path: new HoldPath(pts, o.hold.curve || 'linear', o.hold.repeats), ticks };
      }
    }
    targets.push(tg);
  }
  targets.sort((a, b) => a.t - b.t);

  const obstacles = [];
  for (const o of json.obstacles || []) {
    const t = startOf(o, timing);
    if (t === null) continue;
    const type = ['wall', 'gate', 'gap', 'block'].includes(o.type) ? o.type : 'wall';
    const lanes = [...new Set((o.lanes || []).map(l => l | 0).filter(l => l >= 0 && l < laneCount))];
    if (!lanes.length) continue;
    // A wall on every lane can't be dodged: dropped, as in the game.
    if (type !== 'gate' && lanes.length >= laneCount) continue;
    obstacles.push({ t, end: Math.max(t, endOf(o, t, timing)), type, lanes: new Set(lanes) });
  }
  obstacles.sort((a, b) => a.t - b.t);

  const events = [];
  for (const o of json.events || []) {
    const t = startOf(o, timing);
    if (t === null || !o.type) continue;
    events.push({ t, end: endOf(o, t, timing), type: o.type, value: num(o.value) ? o.value : 0, color: o.color, text: o.text });
  }
  events.sort((a, b) => a.t - b.t);

  let last = 0;
  for (const tg of targets) last = Math.max(last, tg.hold ? tg.hold.end : tg.t);
  for (const ob of obstacles) last = Math.max(last, ob.end);
  return { laneCount, runSpeed, approach, judge, targets, obstacles, events, lastTime: last };
}

// --- Song sources (built-in folders over HTTP, or a folder the player picks) ---------------------

export function urlSource(base) {
  const get = async n => {
    const r = await fetch(base + encodeURIComponent(n).replace(/%2F/g, '/'));
    if (!r.ok) throw new Error(`${n}: ${r.status}`);
    return r;
  };
  return {
    text: async n => (await get(n)).text(),
    buffer: async n => (await get(n)).arrayBuffer(),
    url: n => base + n,
    has: () => true,
  };
}

export function fileSource(files) {
  // files: Map of lower-case relative name -> File
  const find = n => files.get(String(n).toLowerCase());
  const need = n => { const f = find(n); if (!f) throw new Error(`Missing ${n}`); return f; };
  const urls = new Map();
  return {
    text: async n => need(n).text(),
    buffer: async n => need(n).arrayBuffer(),
    url: n => {
      const f = find(n);
      if (!f) return null;
      if (!urls.has(n)) urls.set(n, URL.createObjectURL(f));
      return urls.get(n);
    },
    has: n => !!find(n),
  };
}

export async function loadSong(id, source, builtIn) {
  const info = JSON.parse(await source.text('info.json'));
  if (info.format && info.format !== 'astral-runshot-song') throw new Error('Not an Astral Runshot song');
  if (!Array.isArray(info.charts) || !info.charts.length) throw new Error('The song has no charts');
  return {
    id,
    builtIn,
    info,
    source,
    timing: new Timing(info.timing),
    title: info.title || id,
    artist: info.artist || '',
    mapper: info.mapper || '',
    cover: info.cover && source.has(info.cover) ? source.url(info.cover) : null,
    offset: num(info.offset) ? info.offset : 0,
    leadIn: Math.max(1, num(info.leadIn) ? info.leadIn : 3),
    charts: info.charts.filter(c => c && c.file).map(c => ({ name: c.name || c.file, file: c.file, level: c.level })),
  };
}
