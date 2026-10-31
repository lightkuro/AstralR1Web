// Menus, input and the main loop.
import { World } from './world.js';
import { AudioEngine } from './audio.js';
import { Run, rankOf } from './game.js';
import { loadSong, parseChart, urlSource, fileSource } from './chart.js';
import { openZip, folderReader, collectSet, convertSet, osuStore, OSU_DEFAULTS } from './osu.js';

const $ = id => document.getElementById(id);
const KEY = 'astral-runshot-web:';

// --- Stored settings and best scores (this browser only) -----------------------------------------

function load(name, fallback) {
  try { const v = JSON.parse(localStorage.getItem(KEY + name)); return v && typeof v === 'object' ? { ...fallback, ...v } : fallback; } catch { return fallback; }
}
function save(name, v) { try { localStorage.setItem(KEY + name, JSON.stringify(v)); } catch { /* storage blocked */ } }

const coarse = matchMedia('(pointer: coarse)').matches;
const settings = load('settings', {
  music: 0.8, sfx: 0.7, offsetMs: 0, quality: coarse ? 'low' : 'high',
  aim: coarse ? 'free' : 'look', sensitivity: 0.1, autoFire: false, muzzleFlash: false, holdBeamSnap: false,
  autoplay: false, noFail: true,
  // Targets and timing (the game's dev preset).
  targetSize: 1.4, multi: false, multiDisplay: 'stack', multiGapMs: 300,
  windowScale: 1.2, boxSpeed: 30, approachScale: 1, judgePos: 'box',
  // Crosshair.
  crossShape: 'cross', crossSize: 10, crossThick: 2, crossGap: 3, crossColor: '#27f2ff',
  // osu! map conversion.
  ...OSU_DEFAULTS,
});
const best = load('best', {});

// --- Engine ----------------------------------------------------------------------------------------

const world = new World($('view'));
const audio = new AudioEngine();
world.setQuality(settings.quality);

let songs = [];
let sel = { song: null, chart: 0 };
let run = null;
let last = null;           // { song, meta, chart, buffer } for retry
let attractS = 0;
const buffers = new Map();

// --- HUD -------------------------------------------------------------------------------------------

const hudEls = {
  score: $('hudScore'), acc: $('hudAcc'), rank: $('hudRank'), combo: $('hudCombo'), count: $('hudCount'),
  progress: $('hudProgress'), health: $('hudHealth'), damage: $('damage'), popups: $('popups'),
  cross: $('crosshair'),
};
const shown = {};
const setText = (k, v) => { if (shown[k] !== v) { shown[k] = v; hudEls[k].textContent = v; } };
const popPool = [];

const hud = {
  update(h) {
    setText('score', h.score.toLocaleString('en-US'));
    setText('acc', h.acc.toFixed(2) + '%');
    setText('rank', rankOf(h.acc));
    setText('combo', h.combo >= 2 ? String(h.combo) : '');
    setText('count', h.countdown ? String(h.countdown) : '');
    hudEls.progress.style.width = (h.progress * 100).toFixed(2) + '%';
    hudEls.health.style.width = (h.health * 100).toFixed(1) + '%';
    hudEls.health.parentElement.classList.toggle('low', h.health < 0.3);
    if (settings.aim === 'look' || !coarse || settings.autoplay) hudEls.cross.style.transform = `translate(${h.cursor.x}px, ${h.cursor.y}px)`;
  },
  popup(text, cls, x, y, sub) {
    let el = popPool.find(p => !p.busy);
    if (!el) {
      if (popPool.length >= 16) el = popPool.shift();
      else { el = document.createElement('div'); hudEls.popups.appendChild(el); }
      popPool.push(el);
    }
    el.busy = true;
    el.className = '';
    void el.offsetWidth; // restart the animation
    el.className = 'pop ' + cls;
    el.innerHTML = '';
    el.append(text);
    if (sub) { const s = document.createElement('small'); s.textContent = sub; el.append(s); }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    clearTimeout(el.timer);
    el.timer = setTimeout(() => { el.busy = false; el.className = ''; el.textContent = ''; }, 560);
  },
  damage() {
    const el = hudEls.damage;
    el.classList.remove('hit');
    void el.offsetWidth;
    el.classList.add('hit');
  },
};

// --- Screens ---------------------------------------------------------------------------------------

let pauseShownAt = 0;
function show(id, on) {
  if (id === 'pause' && on && $(id).hidden) pauseShownAt = performance.now();
  $(id).hidden = !on;
}

function setPlaying(on) {
  document.body.classList.toggle('playing', on);
  show('hud', on);
  show('menu', !on);
  show('crosshair', on && (settings.aim === 'look' || !coarse || settings.autoplay));
}

function songKey(song, meta) { return song.id + '/' + meta.file; }

function renderSongList() {
  const list = $('songList');
  list.innerHTML = '';
  for (const s of songs) {
    const b = document.createElement('button');
    b.className = 'song-card' + (s === sel.song ? ' sel' : '');
    const th = document.createElement('div');
    th.className = 'thumb';
    if (s.cover) th.style.backgroundImage = `url("${s.cover}")`;
    const txt = document.createElement('div');
    const t = document.createElement('b'); t.textContent = s.title;
    const a = document.createElement('span'); a.textContent = s.artist + (s.osu ? ' · osu! map' : s.builtIn ? '' : ' · from your folder');
    txt.append(t, a);
    b.append(th, txt);
    b.onclick = () => { sel = { song: s, chart: 0 }; renderSongList(); renderDetail(); };
    list.appendChild(b);
  }
}

function renderDetail() {
  const s = sel.song;
  $('playBtn').disabled = !s;
  $('removeSong').hidden = !s?.osu;
  if (!s) return;
  $('detailCover').style.backgroundImage = s.cover ? `url("${s.cover}")` : '';
  $('detailTitle').textContent = s.title;
  $('detailArtist').textContent = [s.artist, s.mapper && 'mapped by ' + s.mapper].filter(Boolean).join(' · ');
  const charts = $('detailCharts');
  charts.innerHTML = '';
  s.charts.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = i === sel.chart ? 'sel' : '';
    b.append(c.name);
    if (c.level !== undefined) { const l = document.createElement('i'); l.textContent = c.level; b.append(l); }
    b.onclick = () => { sel.chart = i; renderDetail(); };
    charts.appendChild(b);
  });
  const rec = best[songKey(s, s.charts[sel.chart])];
  const el = $('detailBest');
  el.innerHTML = '';
  if (rec) {
    const r = document.createElement('b'); r.textContent = rec.rank;
    el.append('Best: ', r, ` ${rec.acc.toFixed(2)}% · ${rec.score.toLocaleString('en-US')}`);
  } else {
    el.textContent = 'Not played yet';
  }
}

function syncToggles() {
  $('optAutoplay').checked = settings.autoplay;
  $('optNoFail').checked = settings.noFail;
}

for (const [id, key] of [['optAutoplay', 'autoplay'], ['optNoFail', 'noFail']]) {
  $(id).onchange = e => { settings[key] = e.target.checked; save('settings', settings); };
}

// --- Loading songs ---------------------------------------------------------------------------------

async function loadSongs() {
  try {
    const idx = await (await fetch('songs/index.json')).json();
    for (const id of idx.songs || []) {
      try { songs.push(await loadSong(id, urlSource(`songs/${id}/`), true)); } catch (e) { console.warn(id, e); }
    }
  } catch (e) {
    console.warn('No song list', e);
  }
  await loadOsuSongs();
  if (!sel.song && songs.length) sel = { song: songs[0], chart: 0 };
  if (!songs.length) $('detailTitle').textContent = 'No songs found';
  renderSongList();
  renderDetail();
}

$('openFolder').onclick = () => $('folderInput').click();
$('addSong').onclick = () => $('folderInput').click();
$('folderInput').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  // Every folder holding an info.json is a song (pick one song folder or a folder of songs).
  const dirs = files.filter(f => /(^|\/)info\.json$/i.test(f.webkitRelativePath || f.name))
    .map(f => (f.webkitRelativePath || f.name).replace(/info\.json$/i, ''));
  let added = 0;
  // Folders with .osu files and no info.json are osu! songs: converted.
  const osuDirs = [...new Set(files.map(f => f.webkitRelativePath || f.name).filter(p => /\.osu$/i.test(p))
    .map(p => p.replace(/[^/]*$/, '')))].filter(d => !dirs.includes(d));
  if (osuDirs.length) {
    const reader = folderReader(new Map(files.map(f => [(f.webkitRelativePath || f.name).toLowerCase(), f])));
    const label = d => d.replace(/\/$/, '').split('/').pop();
    added += await importSets(osuDirs.map(d => [label(d), () => collectSet(reader, label(d), d.toLowerCase())]));
  }
  for (const dir of dirs) {
    const map = new Map();
    for (const f of files) {
      const p = f.webkitRelativePath || f.name;
      if (p.startsWith(dir) && !p.slice(dir.length).includes('/')) map.set(p.slice(dir.length).toLowerCase(), f);
    }
    try {
      const song = await loadSong('local:' + dir, fileSource(map), false);
      songs = songs.filter(s => s.id !== song.id);
      songs.push(song);
      sel = { song, chart: 0 };
      added++;
    } catch (err) {
      console.warn(dir, err);
    }
  }
  if (!added && !osuDirs.length) message('No song found there. Pick an Astral Runshot song folder (with an info.json) or an osu! song folder.');
  renderSongList();
  renderDetail();
};

// --- osu! maps (converted in the browser, kept in this browser) -------------------------------------

/** Converts a stored set with the current settings and puts it in the song list. */
async function addOsuSong(set) {
  const id = 'osu:' + set.id;
  const song = await loadSong(id, fileSource(await convertSet(set, settings)), false);
  song.osu = set;
  const at = songs.findIndex(s => s.id === id);
  if (at >= 0) songs[at] = song; else songs.push(song);
  if (sel.song?.id === id) sel.song = song;
  return song;
}

/** jobs: [label, () => Promise<set>]. Collects, stores and converts each; returns how many worked. */
async function importSets(jobs) {
  let ok = 0;
  const errors = [];
  for (let k = 0; k < jobs.length; k++) {
    const [label, collect] = jobs[k];
    message(jobs.length > 1 ? `Converting osu! maps... ${k + 1} / ${jobs.length}` : 'Converting the osu! map...', false);
    try {
      const set = await collect();
      buffers.delete('osu:' + set.id);
      const song = await addOsuSong(set);
      try { await osuStore.put(set); } catch (e) { console.warn('Not stored', e); errors.push(`${song.title}: plays now, but there's no room to keep it in this browser.`); }
      sel = { song, chart: 0 };
      ok++;
    } catch (e) {
      console.warn(label, e);
      errors.push(`${label}: ${e.message || e}`);
    }
  }
  if (errors.length) message(errors.slice(0, 4).join('\n') + (errors.length > 4 ? `\n(and ${errors.length - 4} more)` : ''));
  else show('loading', false);
  renderSongList();
  renderDetail();
  return ok;
}

/** .osz archives, or a .osu picked with its audio (and background). */
function importOsuFiles(list) {
  const files = [...list];
  const isOsz = f => /\.osz$/i.test(f.name), isOsu = f => /\.osu$/i.test(f.name);
  const jobs = files.filter(isOsz).map(f => [f.name, async () => collectSet(await openZip(f), f.name)]);
  const loose = files.filter(f => !isOsz(f));
  if (loose.some(isOsu)) {
    const reader = folderReader(new Map(loose.map(f => [f.name.toLowerCase(), f])));
    jobs.push([loose.find(isOsu).name, () => collectSet(reader, '')]);
  }
  if (!jobs.length) { message('Pick a .osz file (or a .osu with its audio file).'); return; }
  importSets(jobs);
}

$('importOsu').onclick = () => $('osuInput').click();
$('osuInput').onchange = e => { const l = [...e.target.files]; e.target.value = ''; importOsuFiles(l); };
// .osz files dropped anywhere on the menu.
const inMenu = () => !run || run.finished;
window.addEventListener('dragover', e => { if (inMenu()) e.preventDefault(); });
window.addEventListener('drop', e => {
  e.preventDefault();
  if (inMenu() && e.dataTransfer?.files?.length) importOsuFiles(e.dataTransfer.files);
});
$('removeSong').onclick = async () => {
  const s = sel.song;
  if (!s?.osu) return;
  try { await osuStore.remove(s.osu.id); } catch (e) { console.warn(e); }
  songs = songs.filter(x => x !== s);
  buffers.delete(s.id);
  sel = { song: songs[0] || null, chart: 0 };
  renderSongList();
  renderDetail();
};

async function loadOsuSongs() {
  let sets = [];
  try { sets = await osuStore.all(); } catch (e) { console.warn('No stored osu! maps', e); }
  for (const set of sets) { try { await addOsuSong(set); } catch (e) { console.warn(set.id, e); } }
}

// The osu! settings re-convert the imported maps (they're kept as the original files).
let reconvertTimer = 0;
function reconvertOsu() {
  clearTimeout(reconvertTimer);
  reconvertTimer = setTimeout(async () => {
    for (const s of songs.filter(x => x.osu)) { try { await addOsuSong(s.osu); } catch (e) { console.warn(s.id, e); } }
    renderSongList();
    renderDetail();
  }, 300);
}

async function getBuffer(song) {
  if (buffers.has(song.id)) return buffers.get(song.id);
  const names = [song.info.audio, song.info.audioFallback].filter(n => n && song.source.has(n));
  let err = new Error('The song has no audio file');
  for (const n of names) {
    try {
      const buf = await audio.decode(await song.source.buffer(n));
      buffers.set(song.id, buf);
      return buf;
    } catch (e) { err = e; }
  }
  throw err;
}

function message(text, closable = true) {
  $('loadingText').textContent = text;
  $('loadingClose').hidden = !closable;
  show('loading', true);
}
$('loadingClose').onclick = () => show('loading', false);

// --- Mouse look (pointer lock) ----------------------------------------------------------------------

const canvas = $('view');
const needsLock = () => settings.aim === 'look' && !settings.autoplay;
const locked = () => document.pointerLockElement === canvas;
let resumeOnLock = false;
let lockWorks = !!canvas.requestPointerLock; // false once the browser refuses (some embedded views)
let wasLocked = false;

/** Must run inside a click or key press. */
function lockPointer() {
  if (!needsLock() || locked() || !lockWorks) return;
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { try { canvas.requestPointerLock(); } catch { /* not allowed now */ } });
  } catch { /* not allowed now */ }
}

document.addEventListener('pointerlockchange', () => {
  if (locked()) {
    wasLocked = true;
    $('pauseHint').hidden = true;
    if (resumeOnLock && run && run.paused) { resumeOnLock = false; show('pause', false); run.resume(); }
  } else if (wasLocked && needsLock() && run && !run.finished && !run.paused) {
    wasLocked = false;
    // Esc (or switching away) gives the mouse back: pause, as the game does.
    run.pause();
    show('pause', true);
  }
});
document.addEventListener('pointerlockerror', () => {
  // Without pointer lock the view follows the mouse position instead.
  if (!wasLocked) lockWorks = false;
  if (resumeOnLock) { resumeOnLock = false; if (lockWorks) $('pauseHint').hidden = false; else { show('pause', false); run && run.resume(); } }
});

// --- Runs ------------------------------------------------------------------------------------------

async function play() {
  const song = sel.song;
  if (!song) return;
  const meta = song.charts[sel.chart];
  audio.ensure();
  lockPointer();
  audio.setVolumes(settings.music, settings.sfx);
  message('Loading...', false);
  try {
    const [json, buffer] = await Promise.all([song.source.text(meta.file).then(JSON.parse), getBuffer(song)]);
    last = { song, meta, chart: parseChart(json, song.timing), buffer };
  } catch (e) {
    console.error(e);
    message(`Couldn't load this song: ${e.message || e}`);
    return;
  }
  show('loading', false);
  startRun();
}

function startRun() {
  if (run) run.quit();
  const { song, meta, chart, buffer } = last;
  // Fresh copies: a run marks its targets as it goes.
  const fresh = { ...chart, targets: chart.targets.map(t => ({ ...t, hold: t.hold && { ...t.hold } })) };
  show('results', false);
  show('pause', false);
  setPlaying(true);
  run = new Run({
    world, audio, hud, song, chart: fresh, buffer,
    settings, // live: changes in the pause menu apply right away
    onEnd: res => showResults(song, meta, res),
  });
  run.start();
}

function showResults(song, meta, r) {
  attractS = run ? run.dist.at(run.lastT || 0) : 0;
  if (locked()) document.exitPointerLock();
  setTimeout(() => {
    setPlaying(false);
    show('menu', false);
    $('resSong').textContent = `${song.title} · ${meta.name}`;
    $('resRank').textContent = r.failed ? 'FAILED' : r.rank;
    $('resRank').classList.toggle('fail', r.failed);
    $('resAcc').textContent = r.acc.toFixed(4) + '%';
    const rows = [
      ['Score', r.score.toLocaleString('en-US')], ['Max combo', r.maxCombo],
      ['Critical perfect', r.crit], ['Perfect', r.perfect], ['Great', r.great], ['Good', r.good], ['Miss', r.miss],
      ['Holds locked / great / good / broken', `${r.holdsLocked} / ${r.holdsGreat} / ${r.holdsGood} / ${r.holdsBroken}`],
      ['Hold ticks', `${r.ticksHit} / ${r.ticksTotal}`],
    ];
    const g = $('resGrid');
    g.innerHTML = '';
    for (const [k, v] of rows) { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('b'); b.textContent = v; g.append(a, b); }
    let note = '';
    const key = songKey(song, meta);
    if (r.autoplay) note = 'AUTOPLAY · not saved as a best';
    else if (!r.failed && (!best[key] || r.score > best[key].score)) {
      best[key] = { score: r.score, acc: r.acc, rank: r.rank };
      save('best', best);
      note = 'NEW BEST';
    }
    $('resNote').textContent = note;
    show('results', true);
    renderDetail();
  }, r.failed ? 400 : 900);
}

function backToMenu() {
  if (locked()) document.exitPointerLock();
  if (run) { attractS = run.dist.at(run.lastT || 0); run.quit(); run = null; }
  show('results', false);
  show('pause', false);
  setPlaying(false);
}

function togglePause() {
  if (!run || run.finished) return;
  if (run.paused) resumeRun();
  else { run.pause(); show('pause', true); if (locked()) document.exitPointerLock(); }
}

function resumeRun() {
  if (!run || !run.paused) return;
  if (needsLock() && !locked() && lockWorks) { resumeOnLock = true; lockPointer(); return; }
  show('pause', false);
  run.resume();
}

function retry() {
  audio.ensure();
  lockPointer();
  audio.resume().then(startRun);
}

$('playBtn').onclick = play;
$('resRetry').onclick = retry;
$('resBack').onclick = backToMenu;
$('pauseContinue').onclick = resumeRun;
$('pauseRetry').onclick = retry;
$('pauseQuit').onclick = () => { audio.resume(); backToMenu(); };
$('hudPause').onpointerdown = e => { e.stopPropagation(); togglePause(); };

// --- Settings and credits ----------------------------------------------------------------------------

const fmtMs = v => `${v > 0 ? '+' : ''}${v} ms`;
// Each group is a collapsible section; `show` hides rows that don't apply.
const SETTINGS = [
  { group: 'Aim & shooting', open: true, rows: [
    { key: 'aim', label: 'Aim', type: 'select', options: [['look', 'MOUSE LOOK (the view turns)'], ['free', 'FREE CURSOR']] },
    { key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.02, max: 0.4, step: 0.01, fmt: v => v.toFixed(2), show: () => settings.aim === 'look' },
    { key: 'autoFire', label: 'Keep firing while held', type: 'toggle', hint: 'Off: one shot per click. Holding only matters for holds.' },
    { key: 'muzzleFlash', label: 'Muzzle flash', type: 'toggle' },
    { key: 'holdBeamSnap', label: 'Beam snaps to holds', type: 'toggle', hint: 'Off: shots and the hold beam go straight down your aim. On: the hold beam locks onto the hold box.' },
  ] },
  { group: 'Targets', rows: [
    { key: 'targetSize', label: 'Target size', type: 'range', min: 0.6, max: 2.2, step: 0.05, fmt: v => v.toFixed(2) },
    { key: 'multi', label: 'Double / triple boxes', type: 'toggle', hint: 'Quick taps on one spot share a box with a hit per tap (yellow = 2 left, red = 3).' },
    { key: 'multiDisplay', label: 'Show them as', type: 'select', options: [['stack', 'STACK (next layer lowers after a hit)'], ['one', 'ONE BOX (colour only)']], show: () => settings.multi },
    { key: 'multiGapMs', label: 'Taps closer than', type: 'range', min: 100, max: 500, step: 10, fmt: v => `${v} ms`, show: () => settings.multi },
  ] },
  { group: 'Timing', open: true, rows: [
    { key: 'offsetMs', label: 'Audio offset', type: 'stepper', min: -500, max: 500, step: 5, fmt: fmtMs, hint: "Raise it if your hits are judged LATE, lower it if they're EARLY (wireless headphones often need +100 to +200 ms)." },
    { key: 'judgePos', label: 'Timing text', type: 'select', options: [['box', 'ABOVE THE BOX'], ['top', 'TOP OF THE SCREEN']] },
    { key: 'windowScale', label: 'Timing windows', type: 'select', num: true, options: [[0.8, 'STRICT'], [1, 'STANDARD'], [1.2, 'LENIENT'], [1.5, 'RELAXED']] },
    { key: 'boxSpeed', label: 'Box fly-in speed', type: 'range', min: 0, max: 80, step: 1, fmt: v => `${v} m/s`, hint: 'How fast boxes fly at you on top of your run speed (0 = they wait on the track).' },
    { key: 'approachScale', label: 'Targets show for', type: 'range', min: 0.5, max: 2, step: 0.05, fmt: v => `x${v.toFixed(2)}`, hint: "Times the map's own time. Longer = you see them coming from further away." },
  ] },
  { group: 'Crosshair', preview: true, rows: [
    { key: 'crossShape', label: 'Shape', type: 'select', options: [['cross', 'CROSS'], ['dot', 'DOT']] },
    { key: 'crossSize', label: 'Size', type: 'range', min: 2, max: 30, step: 1, fmt: v => `${v} px` },
    { key: 'crossThick', label: 'Thickness', type: 'range', min: 1, max: 6, step: 0.5, fmt: v => `${v} px`, show: () => settings.crossShape === 'cross' },
    { key: 'crossGap', label: 'Gap', type: 'range', min: 0, max: 14, step: 1, fmt: v => `${v} px`, show: () => settings.crossShape === 'cross' },
    { key: 'crossColor', label: 'Colour', type: 'color' },
  ] },
  { group: 'osu! maps', rows: [
    { key: 'osuMaxNps', label: 'Most targets per second', type: 'range', min: 0.5, max: 12, step: 0.5, fmt: v => v.toFixed(1), hint: 'Dense maps are thinned to about this (the strongest notes stay). These settings re-convert your imported maps.' },
    { key: 'osuMinHold', label: 'Shortest hold', type: 'range', min: 0, max: 4, step: 0.25, fmt: v => `${v} beats`, hint: 'Shorter sliders and holds become taps.' },
    { key: 'osuSpread', label: 'Screen area', type: 'range', min: 0.2, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%` },
    { key: 'osuCurves', label: 'Slider curves', type: 'toggle', hint: 'Off: holds go straight to where the slider ends.' },
    { key: 'osuRepeats', label: 'Slider repeats', type: 'toggle' },
    { key: 'osuSpinners', label: 'Spinners become holds', type: 'toggle' },
    { key: 'osuBigNotes', label: 'Bigger taiko big notes', type: 'toggle' },
    { key: 'osuEvents', label: 'Kiai lights', type: 'toggle', hint: 'Flashes and colour changes where kiai starts.' },
  ] },
  { group: 'Audio', rows: [
    { key: 'music', label: 'Music volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%` },
    { key: 'sfx', label: 'Effects volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)}%` },
  ] },
  { group: 'Graphics', rows: [
    { key: 'quality', label: 'Graphics', type: 'select', options: [['high', 'HIGH (glow)'], ['low', 'LOW']] },
  ] },
];

function onSetting(key) {
  save('settings', settings);
  if (key === 'music' || key === 'sfx') { audio.ensure(); audio.setVolumes(settings.music, settings.sfx); if (key === 'sfx') audio.play('hit'); }
  if (key === 'quality') world.setQuality(settings.quality);
  if (key === 'aim' && run && !run.finished) show('crosshair', true);
  if (key.startsWith('osu')) reconvertOsu();
  refreshSettings();
}

function buildSettings() {
  const body = $('settingsBody');
  body.innerHTML = '';
  for (const g of SETTINGS) {
    const d = document.createElement('details');
    d.open = !!g.open;
    const sum = document.createElement('summary');
    sum.textContent = g.group;
    d.append(sum);
    if (g.preview) { const pv = document.createElement('div'); pv.className = 'cross-preview'; pv.id = 'crossPreview'; d.append(pv); }
    for (const r of g.rows) {
      const row = document.createElement(r.type === 'stepper' ? 'div' : 'label');
      row.className = 'field' + (r.type === 'toggle' ? ' toggle' : '');
      r.el = row;
      const head = document.createElement('span');
      head.append(r.label);
      const val = document.createElement('em');
      head.append(val);
      let input;
      if (r.type === 'select') {
        input = document.createElement('select');
        for (const [v, t] of r.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.append(o); }
        input.onchange = () => { settings[r.key] = r.num ? +input.value : input.value; onSetting(r.key); };
      } else if (r.type === 'toggle') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.onchange = () => { settings[r.key] = input.checked; onSetting(r.key); };
      } else if (r.type === 'stepper') {
        // - [ number ] + and a slider, for values worth nudging (the audio offset).
        const clamp = v => Math.max(r.min, Math.min(r.max, Math.round(v / r.step) * r.step));
        const set = v => { settings[r.key] = clamp(v); onSetting(r.key); };
        input = document.createElement('div');
        input.className = 'stepper';
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.textContent = '\u2212';
        minus.onclick = e => { e.preventDefault(); set(settings[r.key] - r.step); };
        const num = document.createElement('input');
        Object.assign(num, { type: 'number', min: r.min, max: r.max, step: r.step });
        num.onchange = () => set(+num.value || 0);
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.textContent = '+';
        plus.onclick = e => { e.preventDefault(); set(settings[r.key] + r.step); };
        const range = document.createElement('input');
        Object.assign(range, { type: 'range', min: r.min, max: r.max, step: r.step });
        range.oninput = () => set(+range.value);
        input.append(minus, num, plus, range);
        r.parts = [num, range];
      } else if (r.type === 'color') {
        input = document.createElement('input');
        input.type = 'color';
        input.oninput = () => { settings[r.key] = input.value; onSetting(r.key); };
      } else {
        input = document.createElement('input');
        input.type = 'range';
        Object.assign(input, { min: r.min, max: r.max, step: r.step });
        input.oninput = () => { settings[r.key] = +input.value; onSetting(r.key); };
      }
      r.input = input;
      r.val = val;
      if (r.type === 'toggle') row.append(input, head); else row.append(head, input);
      if (r.hint) { const h = document.createElement('small'); h.textContent = r.hint; row.append(h); }
      d.append(row);
    }
    body.append(d);
  }
}

function refreshSettings() {
  for (const g of SETTINGS) for (const r of g.rows) {
    const v = settings[r.key];
    if (r.type === 'toggle') r.input.checked = !!v;
    else if (r.parts) { for (const el of r.parts) if (document.activeElement !== el) el.value = v; }
    else if (document.activeElement !== r.input) r.input.value = v;
    r.val.textContent = r.fmt ? r.fmt(v) : '';
    r.el.hidden = r.show ? !r.show() : false;
  }
  // Target size and double / triple boxes are set up when a run starts.
  $('settingsNote').hidden = !(run && !run.finished);
  drawCrosshair();
}

/** The crosshair: a cross (four arms with a gap) or a dot, with a thin dark outline. */
function crosshairSvg() {
  const { crossShape: shape, crossSize: size, crossThick: t, crossGap: gap, crossColor: c } = settings;
  const ext = shape === 'dot' ? size / 2 + 2 : size + gap + t + 2;
  let parts;
  if (shape === 'dot') {
    parts = `<circle r="${size / 2}" fill="${c}" stroke="rgba(0,0,0,.6)" stroke-width="1"/>`;
  } else {
    const d = `M${-gap - size} 0H${-gap}M${gap} 0H${gap + size}M0 ${-gap - size}V${-gap}M0 ${gap}V${gap + size}`;
    parts = `<path d="${d}" stroke="rgba(0,0,0,.6)" stroke-width="${t + 2}" stroke-linecap="square"/>`
      + `<path d="${d}" stroke="${c}" stroke-width="${t}" stroke-linecap="square"/>`;
  }
  return `<svg width="${ext * 2}" height="${ext * 2}" viewBox="${-ext} ${-ext} ${ext * 2} ${ext * 2}" style="display:block;margin:${-ext}px 0 0 ${-ext}px">${parts}</svg>`;
}

function drawCrosshair() {
  const svg = crosshairSvg();
  $('crosshair').innerHTML = svg;
  const pv = $('crossPreview');
  if (pv) pv.innerHTML = svg;
}

function openSettings() { refreshSettings(); show('settings', true); }
buildSettings();
drawCrosshair();
$('openSettings').onclick = openSettings;
$('pauseSettings').onclick = openSettings;
$('closeSettings').onclick = () => show('settings', false);
$('openCredits').onclick = () => show('credits', true);
$('closeCredits').onclick = () => show('credits', false);

// First visit: point people at the full game.
if (!load('intro', {}).seen) { show('intro', true); save('intro', { seen: true }); $('introContinue').focus(); }
$('introClose').onclick = $('introContinue').onclick = () => show('intro', false);
for (const id of ['settings', 'credits', 'intro']) $(id).addEventListener('pointerdown', e => { if (e.target.id === id) show(id, false); });

// --- Input -----------------------------------------------------------------------------------------

const FIRE_KEYS = new Set(['KeyZ', 'KeyX', 'KeyJ', 'KeyK']);
const playing = () => run && !run.finished && !run.paused;

canvas.addEventListener('pointerdown', e => {
  if (!playing()) return;
  e.preventDefault();
  if (needsLock() && !locked() && lockWorks) { lockPointer(); return; }
  if (!settings.autoplay && settings.aim !== 'look') run.setCursor(e.clientX, e.clientY);
  try { $('view').setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  run.fireDown('p' + e.pointerId);
});
window.addEventListener('pointermove', e => {
  if (!run || settings.autoplay) return;
  if (settings.aim === 'look') {
    if (locked()) run.turn(e.movementX, e.movementY);
    else if (e.pointerType === 'mouse') {
      const r = canvas.getBoundingClientRect();
      run.aimFromPointer(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    }
    return;
  }
  if (e.pointerType === 'mouse' || run.held.has('p' + e.pointerId)) run.setCursor(e.clientX, e.clientY);
});
const release = e => { if (run) run.fireUp('p' + e.pointerId); };
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);


window.addEventListener('keydown', e => {
  if (!run || run.finished) {
    if (!$('intro').hidden) { if (e.code === 'Escape') show('intro', false); return; }
    if (e.code === 'Enter' && !$('menu').hidden && !$('playBtn').disabled && $('settings').hidden) play();
    if (e.code === 'KeyR' && !$('results').hidden) retry();
    if (e.code === 'Escape') { if ($('settings').hidden && $('credits').hidden && !$('results').hidden) backToMenu(); show('settings', false); show('credits', false); }
    return;
  }
  if (!$('settings').hidden) { if (e.code === 'Escape') show('settings', false); return; }
  if (run.paused) {
    // Pause menu: Space continues, Esc quits (as in the game).
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); resumeRun(); }
    // (The Esc that released the mouse can arrive just after the pause: ignore it.)
    else if (e.code === 'Escape' && performance.now() - pauseShownAt > 400) backToMenu();
    else if (e.code === 'KeyR') retry();
    return;
  }
  if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); togglePause(); return; }
  if (e.code === 'KeyR' && !e.repeat) { retry(); return; }
  if (e.repeat) return;
  if (FIRE_KEYS.has(e.code)) run.fireDown('k' + e.code);
  else if (e.code === 'KeyA' || e.code === 'ArrowLeft') run.moveLane(-1);
  else if (e.code === 'KeyD' || e.code === 'ArrowRight') run.moveLane(1);
});
window.addEventListener('keyup', e => { if (run && FIRE_KEYS.has(e.code)) run.fireUp('k' + e.code); });

const autoPause = () => { if (playing()) { run.pause(); show('pause', true); if (locked()) document.exitPointerLock(); } };
window.addEventListener('blur', autoPause);
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });

// --- Main loop ---------------------------------------------------------------------------------------

let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (run && !run.finished) {
    run.frame(dt);
  } else {
    attractS += 16 * dt;
    world.setView(0, attractS, 0);
  }
  world.tick(dt);
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

syncToggles();
loadSongs();

// For quick checks from the console.
window.astral = { get run() { return run; }, get last() { return last; }, startRun, settings, world };
