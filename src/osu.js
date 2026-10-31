// osu! beatmaps -> Astral Runshot songs, in the browser: a port of AstralOsuConverter.cpp (the game's
// own converter) without the parts this version doesn't have (lane hazards, gates, track turns).
// Reads .osz archives and osu! song folders; the result is an ordinary song (info.json + charts).
import { HoldPath } from './chart.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f = s => parseFloat(s) || 0;
const i = s => parseInt(s, 10) || 0;
const r4 = v => Math.round(v * 1e4) / 1e4;
const ext = n => (/\.([^./]+)$/.exec(n) || [])[1]?.toLowerCase() || '';
const base = n => n.split('/').pop();

// --- .osz (zip) ------------------------------------------------------------------------------------

async function inflate(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** The files in a zip archive (stored or deflate entries): { names, read(name) -> Blob }. */
export async function openZip(file) {
  const buf = await file.arrayBuffer();
  const z = new Uint8Array(buf);
  const dv = new DataView(buf);
  const n = z.length;
  const le16 = p => dv.getUint16(p, true);
  const le32 = p => dv.getUint32(p, true);
  // End of central directory: the last 22+ bytes (a trailing comment may follow it).
  let eocd = -1;
  for (let p = n - 22; p >= Math.max(0, n - 22 - 65535); p--) { if (le32(p) === 0x06054b50) { eocd = p; break; } }
  if (eocd < 0) throw new Error('Not a .osz (zip) archive');
  const entries = new Map();
  const count = le16(eocd + 10);
  let dir = le32(eocd + 16);
  for (let e = 0; e < count && dir + 46 <= n; e++) {
    if (le32(dir) !== 0x02014b50) break;
    const method = le16(dir + 10), comp = le32(dir + 20), size = le32(dir + 24);
    const nameLen = le16(dir + 28), extraLen = le16(dir + 30), commentLen = le16(dir + 32);
    const local = le32(dir + 42);
    const utf8 = (le16(dir + 8) & 0x800) !== 0;
    const name = new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(z.subarray(dir + 46, dir + 46 + nameLen)).replace(/\\/g, '/');
    dir += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || local + 30 > n || le32(local) !== 0x04034b50) continue;
    const data = local + 30 + le16(local + 26) + le16(local + 28);
    if (data + comp > n || (method !== 0 && method !== 8)) continue;
    entries.set(name.toLowerCase(), { method, bytes: z.subarray(data, data + comp), size });
  }
  if (!entries.size) throw new Error('The archive is empty');
  return {
    names: [...entries.keys()],
    async read(name) {
      const en = entries.get(name.toLowerCase());
      if (!en) return null;
      return new Blob([en.method === 0 ? en.bytes : await inflate(en.bytes)]);
    },
  };
}

/** A picked folder's files as the same reader (Map of lower-case relative name -> File). */
export function folderReader(map) {
  return { names: [...map.keys()], read: async n => map.get(n.toLowerCase()) || null };
}

// --- .osu --------------------------------------------------------------------------------------------

function parse(text) {
  const sections = {};
  let cur = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) { cur = sections[line.slice(1, -1)] = []; continue; }
    if (cur) cur.push(line);
  }
  const keyValues = name => {
    const o = {};
    for (const l of sections[name] || []) { const k = l.indexOf(':'); if (k >= 0) o[l.slice(0, k).trim()] = l.slice(k + 1).trim(); }
    return o;
  };
  const map = { general: keyValues('General'), meta: keyValues('Metadata'), diff: keyValues('Difficulty'), background: '', points: [], objects: [] };
  map.mode = i(map.general.Mode);

  for (const l of sections.Events || []) {
    const p = l.split(',');
    if (p.length >= 3 && (p[0].trim() === '0' || p[0].trim() === 'Background')) { map.background = p[2].trim().replace(/^"|"$/g, ''); break; }
  }
  for (const l of sections.TimingPoints || []) {
    const p = l.split(',');
    if (p.length < 2) continue;
    map.points.push({
      time: f(p[0]), beatLen: f(p[1]),
      meter: p.length > 2 && p[2] ? i(p[2]) || 4 : 4,
      red: p.length > 6 ? p[6].trim() === '1' : true,
      kiai: p.length > 7 && p[7] ? (i(p[7]) & 1) === 1 : false,
    });
  }
  map.points.sort((a, b) => a.time - b.time || (b.red - a.red));
  for (const l of sections.HitObjects || []) {
    const p = l.split(',');
    if (p.length < 4) continue;
    const o = { x: f(p[0]), y: f(p[1]), t: f(p[2]), type: i(p[3]), hs: p.length > 4 ? i(p[4]) : 0, kind: 'circle', curve: 'L', ctrl: [], slides: 1, length: 0, end: 0 };
    o.combo = (o.type & 4) !== 0;
    if ((o.type & 2) && p.length > 7) {
      // Slider / drumroll / juice stream: curve type and control points, slides, pixel length.
      o.kind = 'slider';
      const c = p[5].split('|');
      o.curve = c[0] ? c[0][0] : 'L';
      for (let k = 1; k < c.length; k++) { const j = c[k].indexOf(':'); if (j >= 0) o.ctrl.push([f(c[k].slice(0, j)), f(c[k].slice(j + 1))]); }
      o.slides = i(p[6]);
      o.length = f(p[7]);
    } else if ((o.type & 8) && p.length > 5) {
      o.kind = 'spinner';
      o.end = f(p[5]);
    } else if ((o.type & 128) && p.length > 5) {
      o.kind = 'hold';
      o.end = f(p[5].split(':')[0]);
    }
    map.objects.push(o);
  }
  map.objects.sort((a, b) => a.t - b.t);
  return map;
}

/** Uninherited (BPM) and inherited (slider velocity) timing lookups. */
class OsuTiming {
  constructor(points) {
    this.all = points;
    this.red = points.filter(p => p.red && p.beatLen > 0);
    if (!this.red.length) this.red.push({ time: 0, beatLen: 500, meter: 4, red: true, kiai: false });
  }
  redAt(t) {
    let cur = this.red[0];
    for (const p of this.red) { if (p.time <= t + 1e-3) cur = p; else break; }
    return cur;
  }
  svAt(t) {
    let sv = 1;
    const redTime = this.redAt(t).time;
    for (const p of this.all) {
      if (p.time > t + 1e-3) break;
      if (p.red) sv = 1;
      else if (p.time >= redTime - 1e-3 && p.beatLen < 0) sv = clamp(-100 / p.beatLen, 0.1, 10);
    }
    return sv;
  }
  /** Position within the beat (0 = on it), the beat length (ms) and the beats since the BPM point. */
  beatFrac(t) {
    const r = this.redAt(t);
    const beats = (t - r.time) / r.beatLen;
    return { frac: beats - Math.floor(beats + 1e-6), beatLen: r.beatLen, beats };
  }
}

// --- One difficulty -> one chart --------------------------------------------------------------------

export const OSU_DEFAULTS = {
  osuMaxNps: 3, osuMinHold: 0.75, osuSpread: 0.8,
  osuCurves: true, osuRepeats: true, osuSpinners: true, osuBigNotes: true, osuEvents: true,
};

const ANCHORS = [[0.5, 0.45], [0.38, 0.6], [0.62, 0.62], [0.5, 0.72], [0.34, 0.42], [0.66, 0.44]];
const CURVES = { B: 'bezier', P: 'arc', C: 'catmull', L: 'linear' };

function convertMap(map, o) {
  const timing = new OsuTiming(map.points);
  const mode = map.mode;
  const sliderMult = f(map.diff.SliderMultiplier) || 1.4;
  const keys = Math.max(1, Math.round(map.diff.CircleSize ? f(map.diff.CircleSize) : 4));
  const spread = clamp(o.osuSpread, 0.2, 1), minHold = clamp(o.osuMinHold, 0, 8);
  const maxNps = clamp(o.osuMaxNps, 0.5, 12);
  const stdPos = (x, y) => [
    clamp(0.5 + (x / 512 - 0.5) * spread, 0.06, 0.94),
    clamp(0.5 + (0.5 - y / 384) * spread * 0.9, 0.1, 0.9),
  ];

  const notes = [];
  for (const ob of map.objects) {
    if (ob.kind === 'spinner' && !o.osuSpinners) continue;
    const { frac, beatLen, beats } = timing.beatFrac(ob.t);
    const big = (ob.hs & 4) !== 0;
    const kat = (ob.hs & (2 | 8)) !== 0;
    let pos;
    if (mode === 1) {
      // Taiko: don on a left, kat on a right "station"; the stations drift every 4 bars.
      const c = ANCHORS[Math.floor(Math.max(0, beats) / 16) % ANCHORS.length];
      pos = [clamp(c[0] + (kat ? 0.13 : -0.13), 0.1, 0.9), clamp(c[1], 0.15, 0.85)];
    } else if (mode === 3) {
      const col = clamp(Math.floor(ob.x * keys / 512), 0, keys - 1);
      pos = [0.15 + 0.7 * (col + 0.5) / keys, 0.45 + 0.15 * Math.sin(beats * Math.PI / 8)];
    } else if (mode === 2) {
      pos = [stdPos(ob.x, 192)[0], 0.5 + 0.2 * Math.sin(beats * Math.PI / 8)];
    } else {
      pos = stdPos(ob.x, ob.y);
    }

    const n = { t: ob.t, pos, size: big && mode === 1 && o.osuBigNotes ? 1.25 : 1, beatLen, hold: false, end: 0, path: [], curve: 'linear', repeats: 0 };
    let end = -1, path = [], curve = 'linear', repeats = 0;
    if (ob.kind === 'slider') {
      end = ob.t + ob.length / (sliderMult * 100 * timing.svAt(ob.t)) * beatLen * Math.max(1, ob.slides);
      if (mode === 0 && ob.ctrl.length) {
        curve = CURVES[ob.curve] || 'linear';
        path = ob.ctrl.map(c => stdPos(c[0], c[1]));
        repeats = o.osuRepeats ? Math.max(0, ob.slides - 1) : 0;
      } else if (mode === 1) {
        // Drumroll: a short sweep from the station towards the middle.
        path = [[clamp(pos[0] + (pos[0] < 0.5 ? 0.12 : -0.12), 0.1, 0.9), pos[1]]];
      }
    } else if (ob.kind === 'spinner' || ob.kind === 'hold') {
      end = ob.end;
      if (ob.kind === 'spinner') n.pos = [0.5, 0.55];
    }
    if (end >= 0 && end - ob.t >= minHold * beatLen) Object.assign(n, { hold: true, end, path, curve, repeats });
    // Thinning priority: on-beat notes, big / finish notes, combo starts and holds win.
    const onBeat = frac < 0.02 || frac > 0.98 ? 1 : Math.abs(frac - 0.5) < 0.02 ? 0.75
      : Math.abs(frac - 0.25) < 0.02 || Math.abs(frac - 0.75) < 0.02 ? 0.55 : 0.35;
    n.score = onBeat + (big ? 0.4 : 0) + (ob.combo ? 0.15 : 0) + (n.hold ? 0.5 : 0);
    n.last = n.hold ? n.end : n.t;
    notes.push(n);
  }

  // Thin: strongest first; a note is kept when nothing kept is within the gap (holds block their span).
  const byScore = notes.map((_, k) => k).sort((a, b) => notes[b].score - notes[a].score);
  const thin = minGap => {
    const kept = [];
    for (const k of byScore) {
      const n = notes[k];
      const gap = minGap * n.beatLen - 1;
      if (!kept.some(j => n.t < notes[j].last + gap && notes[j].t < n.last + gap)) kept.push(k);
    }
    return kept.sort((a, b) => notes[a].t - notes[b].t);
  };
  const nps = idx => idx.length > 1 ? idx.length / Math.max(1, (notes[idx[idx.length - 1]].t - notes[idx[0]].t) / 1000) : 0;
  const allNps = nps(notes.map((_, k) => k));
  // The smallest spacing that keeps the chart under the limit; denser osu! difficulties may keep a
  // bit more, so the spread between them survives.
  const budget = maxNps * clamp(allNps / 3, 0.6, 1.4);
  let kept = [];
  for (const g of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]) { kept = thin(g); if (nps(kept) <= budget) break; }

  const targets = [];
  for (const k of kept) {
    const n = notes[k];
    const pos = n.pos.map(v => Math.round(v * 1000) / 1000);
    const tg = { t: r4(n.t / 1000), pos };
    if (n.size !== 1) tg.size = n.size;
    if (n.hold) {
      const hold = { end: r4(n.end / 1000) };
      let path = n.path, curve = n.curve;
      if (!o.osuCurves && path.length > 1) {
        // Straight from the start to where the curve ends.
        const hp = new HoldPath([pos, ...path], curve, 0);
        path = [hp.atDist(hp.len)];
        curve = 'linear';
      }
      if (path.length) {
        hold.curve = curve;
        hold.path = path.map(p => p.map(r4));
        if (n.repeats > 0) hold.repeats = n.repeats;
      }
      tg.hold = hold;
    }
    targets.push(tg);
  }

  // Light and colour events where kiai starts and ends.
  const events = [];
  if (o.osuEvents) {
    let kiai = false;
    for (const p of map.points) {
      if (p.kiai === kiai) continue;
      kiai = p.kiai;
      const t = r4(p.time / 1000);
      if (kiai) events.push({ t, type: 'flash', value: 2 }, { t, type: 'color', value: 1, color: '#FF2BD6' }, { t, type: 'fov', value: 5 });
      else events.push({ t, type: 'color', value: 1, color: '#B23CFF' });
    }
  }

  // Level from the original density (thinning flattens it), nudged by what is kept.
  const level = clamp(Math.round(0.6 * allNps * 1.6 + 0.4 * nps(kept) * 2.2), 1, 10);
  return {
    level,
    chart: {
      format: 'astral-runshot-chart', version: 1, laneCount: 3,
      runSpeed: Math.round((15 + 0.6 * level) * 10) / 10,
      approachTime: Math.round(clamp(1.6 - 0.06 * level, 0.9, 1.6) * 100) / 100,
      targets, obstacles: [], events,
    },
  };
}

// --- A beatmap set -> a song ------------------------------------------------------------------------

function slug(s, fallback) {
  const words = String(s).match(/[A-Za-z0-9]+/g) || [];
  const out = words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
  return out ? out.slice(0, 48) : fallback;
}

/**
 * The parts of a beatmap set worth keeping (the .osu files, the audio and the background) from a
 * reader (openZip / folderReader). `dir` limits a folder reader to one sub-folder ('' = all).
 */
export async function collectSet(reader, label, dir = '') {
  const inDir = n => n.startsWith(dir) && !n.slice(dir.length).includes('/');
  const osuNames = reader.names.filter(n => n.endsWith('.osu') && (!dir || inDir(n))).sort();
  if (!osuNames.length) throw new Error('No osu! difficulties found');
  const files = new Map();
  let first = null;
  for (const n of osuNames) {
    const text = await (await reader.read(n)).text();
    files.set(base(n), new Blob([text], { type: 'text/plain' }));
    if (!first) first = parse(text);
  }
  // Side files sit next to the .osu (in an archive: anywhere, by name).
  const side = async name => {
    if (!name) return null;
    const want = (dir + name).toLowerCase().replace(/\\/g, '/');
    const hit = reader.names.find(m => m === want) || reader.names.find(m => base(m) === base(want));
    return hit ? reader.read(hit) : null;
  };
  const audioName = first.general.AudioFilename || '';
  const audio = await side(audioName);
  if (!audio) throw new Error(`Audio file not found: ${audioName || '(none)'}`);
  files.set('audio.' + (ext(audioName) || 'mp3'), audio);
  const bg = await side(first.background);
  if (bg) files.set('cover.' + (ext(first.background) || 'jpg'), bg);
  // An archive's name without its beatmap-set number ("2529818 Artist - Title"), else the title.
  const name = String(label).replace(/\.[^.]+$/, '').replace(/^\d+\s*/, '').trim();
  const title = first.meta.Title || first.meta.TitleUnicode || 'osu! song';
  return { id: slug(name || title, 'OsuSong'), files };
}

/** A collected set as a song folder: Map of lower-case name -> Blob (info.json, charts, audio, cover). */
export async function convertSet(set, options) {
  const o = { ...OSU_DEFAULTS, ...options };
  const maps = [];
  for (const [n, blob] of set.files) {
    if (!n.endsWith('.osu')) continue;
    const m = parse(await blob.text());
    m.name = m.meta.Version || n.replace(/\.osu$/, '');
    maps.push(m);
  }
  if (!maps.length) throw new Error('No osu! difficulties found');
  const first = maps[0];
  const out = new Map();
  const audioFile = [...set.files.keys()].find(n => n.startsWith('audio.'));
  const coverFile = [...set.files.keys()].find(n => n.startsWith('cover.'));
  out.set(audioFile, set.files.get(audioFile));
  if (coverFile) out.set(coverFile, set.files.get(coverFile));

  const charts = [];
  const used = new Set();
  for (const m of maps) {
    const { chart, level } = convertMap(m, o);
    let file = slug(m.name, 'Chart').toLowerCase();
    while (used.has(file)) file += 'x';
    used.add(file);
    file += '.json';
    out.set(file, new Blob([JSON.stringify(chart)], { type: 'application/json' }));
    charts.push({ name: m.name, file, level });
  }
  charts.sort((a, b) => a.level - b.level);

  const red = new OsuTiming(first.points).red;
  const preview = first.general.PreviewTime !== undefined ? f(first.general.PreviewTime) : -1;
  const timing = red.map(p => ({ t: r4(p.time / 1000), bpm: r4(60000 / p.beatLen), meter: p.meter }));
  const info = {
    format: 'astral-runshot-song', version: 1,
    title: first.meta.Title || first.meta.TitleUnicode || 'osu! song',
    artist: first.meta.Artist || first.meta.ArtistUnicode || 'Unknown',
    mapper: `${first.meta.Creator || ''} (osu! conversion)`,
    audio: audioFile,
    ...(coverFile ? { cover: coverFile } : {}),
    offset: 0,
    previewStart: preview >= 0 ? preview / 1000 : (timing[0]?.t || 0),
    leadIn: 3,
    timing,
    environment: 'neon_city',
    source: { type: 'osu' },
    charts,
  };
  out.set('info.json', new Blob([JSON.stringify(info)], { type: 'application/json' }));
  return out;
}

// --- Imported sets, kept in this browser (IndexedDB) -----------------------------------------------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('astral-runshot-web', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('osu', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('osu', mode);
    const req = fn(t.objectStore('osu'));
    t.oncomplete = () => { d.close(); resolve(req && req.result); };
    t.onerror = t.onabort = () => { d.close(); reject(t.error); };
  });
}

export const osuStore = {
  all: () => tx('readonly', s => s.getAll()).then(rows => (rows || []).map(r => ({ id: r.id, files: new Map(r.files) }))),
  put: set => tx('readwrite', s => s.put({ id: set.id, files: [...set.files] })),
  remove: id => tx('readwrite', s => s.delete(id)),
};
