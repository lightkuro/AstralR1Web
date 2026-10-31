// One run of a chart: timing, aiming, judgements and score (same rules as AAstralRunManager),
// with the game's dev preset as the default tuning.
import * as THREE from 'three';
import { DistanceMap, LANE_WIDTH, PLAYFIELD } from './chart.js';
import { AIM_LIMITS, REST_PITCH, PALETTE } from './world.js';

const LATE_GRACE = 0.1;           // extra time after the Good window before a box is missed
const FIRE_RATE = 4;              // shots per second when "keep firing while held" is on
const LANE_SWITCH = 0.12;         // seconds
const AIM_TOLERANCE = 1.35;       // hit radius = target radius x this
const HOLD_AIM_TOLERANCE = 2.1;
const HOLD_END_LENIENCY = 0.12;   // time off the hold at the very end doesn't count
const HOLD_MISS = [0.15, 0.29, 0.62]; // most time off the hold for LOCKED / GREAT / GOOD
const CRITICAL_SCALE = 0.5;       // Critical Perfect = inner half of the Perfect window
const MISS_DAMAGE = 0.07, TICK_MISS_DAMAGE = 0.02, HIT_HEAL = 0.02, HEALTH_DRAIN = 0.7;
const BOX_HALF = 0.6;             // box half size, in target radii
const FRAME_START = 3.2;          // timing frame size when the box appears, in box sizes

const TAP_COLOR = PALETTE.target;
const HOLD_COLOR = PALETTE.hold;
const DOUBLE_COLOR = '#FFCC1A';   // game: double box hue 48
const TRIPLE_COLOR = '#FF4A1A';   // game: triple box hue 12
const MISS_COLOR = '#5d6075';

export const RANKS = [
  [100.5, 'SSS+'], [100, 'SSS'], [99.5, 'SS+'], [99, 'SS'], [98, 'S+'], [97, 'S'],
  [94, 'AAA'], [90, 'AA'], [80, 'A'], [75, 'BBB'], [70, 'BB'], [60, 'B'], [50, 'C'], [-1, 'D'],
];
export const rankOf = pct => RANKS.find(r => pct >= r[0] - 1e-6)[1];

export class Run {
  /** `settings` is the live settings object: aim, timing and crosshair changes apply mid-run. */
  constructor({ world, audio, hud, song, chart, buffer, settings, onEnd }) {
    Object.assign(this, { world, audio, hud, song, chart, buffer, settings, onEnd });
    this.dist = new DistanceMap(chart.runSpeed, chart.events.filter(e => e.type === 'speed' && e.value > 0),
      -song.leadIn - 3, chart.lastTime + 40);
    const size = settings.targetSize;
    this.targets = chart.targets.map(t => ({ ...t, r: t.r * size, head: null, done: false, vis: null }));
    if (settings.multi) this.groupMultiTaps();
    this.events = chart.events;
    this.endT = Math.max(chart.lastTime + 1.5, Math.min(buffer.duration - song.offset, chart.lastTime + 5));
    this.autoplay = settings.autoplay;

    this.score = {
      score: 0, combo: 0, maxCombo: 0, health: 1,
      crit: 0, perfect: 0, great: 0, good: 0, miss: 0,
      ticksHit: 0, ticksTotal: 0, holdsLocked: 0, holdsGreat: 0, holdsGood: 0, holdsBroken: 0,
      accW: 0, accT: 0, bonusW: 0, bonusT: 0,
    };
    this.spawnI = 0;
    this.eventI = 0;
    this.active = [];   // targets that can still be judged
    this.drawn = [];    // targets that own a visual (a group's first tap owns the group's box)
    this.held = new Set();
    this.nextAuto = 0;
    this.lane = Math.floor((chart.laneCount - 1) / 2);
    this.x = this.laneX(this.lane);
    this.cursor = { x: innerWidth / 2, y: innerHeight / 2 };
    this.yaw = 0;
    this.pitch = REST_PITCH;
    this.rayObj = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
    this.tmp = new THREE.Vector3();
    this.paused = false;
    this.finished = false;
    this.started = false;
    world.setLanes(chart.laneCount);
    world.clearEffects();
    world.resetNeon();
    world.showGun(true);
  }

  get look() { return this.settings.aim === 'look'; }
  get approach() { return this.chart.approach * this.settings.approachScale; }
  window(k) { return this.chart.judge[k] * this.settings.windowScale; }

  /** Double / triple boxes: quick taps on one spot share a box with a hit per tap (as the game). */
  groupMultiTaps() {
    const gap = this.settings.multiGapMs / 1000;
    let lead = null;
    for (const tg of this.targets) {
      const last = lead && lead.members[lead.members.length - 1];
      const spot = 0.5 * 2 * BOX_HALF * tg.r;
      if (!tg.hold && lead && lead.members.length < 3 && tg.t - last.t <= gap + 1e-6
        && Math.hypot(tg.X - lead.X, tg.Y - lead.Y) <= spot) {
        tg.lead = lead;
        lead.members.push(tg);
        lead.groupEnd = tg.t;
      } else {
        lead = tg.hold ? null : tg;
        if (lead) { tg.members = [tg]; tg.groupEnd = tg.t; }
      }
    }
    for (const tg of this.targets) if (tg.members && tg.members.length === 1) { delete tg.members; delete tg.groupEnd; }
  }

  laneX(i) { return (i - (this.chart.laneCount - 1) / 2) * LANE_WIDTH; }

  start() {
    this.audioStart = this.audio.ctx.currentTime + this.song.leadIn + 0.2;
    this.audio.playMusic(this.buffer, this.audioStart, () => { this.audioEnded = true; });
    this.started = true;
  }

  now() {
    return this.audio.heard() - this.audioStart - this.song.offset - this.settings.offsetMs / 1000;
  }

  pause() {
    if (this.paused || this.finished) return;
    this.paused = true;
    this.held.clear();
    this.audio.pause();
  }

  resume() {
    if (!this.paused) return Promise.resolve();
    return this.audio.resume().then(() => { this.paused = false; });
  }

  quit() {
    this.finished = true;
    this.audio.stopMusic();
    this.clearTargets();
    this.world.clearEffects();
    this.world.showGun(false);
  }

  clearTargets() {
    for (const t of this.drawn) if (t.vis) this.world.releaseTarget(t.vis);
    this.drawn = [];
    this.active = [];
    this.world.setBeam(null);
  }

  // --- Input ------------------------------------------------------------------------------------

  setCursor(x, y) { this.cursor.x = x; this.cursor.y = y; }

  /** Mouse-look movement in pixels. */
  turn(dx, dy) {
    if (this.paused || this.finished) return;
    const k = this.settings.sensitivity;
    this.setAim(this.yaw + dx * k, this.pitch - dy * k);
  }

  /** Mouse look without pointer lock: the view follows the mouse (-1..1 from the middle). */
  aimFromPointer(nx, ny) {
    if (this.paused || this.finished) return;
    this.setAim(nx * AIM_LIMITS.yaw * 0.8, REST_PITCH - ny * 28);
  }

  setAim(yaw, pitch) {
    this.yaw = Math.max(-AIM_LIMITS.yaw, Math.min(AIM_LIMITS.yaw, yaw));
    this.pitch = Math.max(-AIM_LIMITS.down, Math.min(AIM_LIMITS.up, pitch));
    this.world.setAim(this.yaw, this.pitch);
    if (this.look) this.centerCursor();
  }

  centerCursor() {
    const r = this.world.canvas.getBoundingClientRect();
    this.cursor.x = r.left + r.width / 2;
    this.cursor.y = r.top + r.height / 2;
  }

  moveLane(d) {
    if (this.paused || this.finished) return;
    this.lane = Math.max(0, Math.min(this.chart.laneCount - 1, this.lane + d));
  }

  fireDown(id) {
    if (this.paused || this.finished) return;
    const first = this.held.size === 0;
    this.held.add(id);
    // One shot per press; holding only matters for holds (unless "keep firing while held" is on).
    if (first && id !== 'bot') {
      const now = this.now();
      this.nextAuto = now + 1 / FIRE_RATE;
      this.fire(now);
    }
  }

  fireUp(id) { this.held.delete(id); }

  aimRay() { return this.world.ray(this.cursor.x, this.cursor.y, this.rayObj); }

  /** The point `d` metres down the aim line. */
  alongAim(d) { return this.rayObj.origin.clone().addScaledVector(this.rayObj.dir, d); }

  /** How far down the aim line a point is. */
  depthOf(p) { return Math.max(1, this.tmp.copy(p).sub(this.rayObj.origin).dot(this.rayObj.dir)); }

  aimDistance(p) {
    const r = this.rayObj;
    this.tmp.copy(p).sub(r.origin);
    const along = this.tmp.dot(r.dir);
    if (along <= 0) return Infinity;
    return this.tmp.addScaledVector(r.dir, -along).length();
  }

  /** Where a target is at time `now`: flying in until it's due, then on the hit plane. */
  posOf(tg, now, out) {
    const o = tg.lead || tg;
    let X = o.X, Y = o.Y, at = o.t, extra = 0;
    if (now < o.t) extra = (o.t - now) * this.settings.boxSpeed;
    else if (o.hold) {
      [X, Y] = o.hold.path.at((now - o.t) / (o.hold.end - o.t));
      at = Math.min(now, o.hold.end);
    } else if (o.members) {
      at = Math.min(now, o.groupEnd); // a double / triple box waits on the hit plane for its taps
    }
    return out.set(X, Y, -(this.dist.at(at) + PLAYFIELD.distance + extra));
  }

  fire(now) {
    this.world.camera.updateMatrixWorld();
    this.aimRay();
    const good = this.window('good');
    let best = null, bestD = 0;
    const p = new THREE.Vector3();
    for (const tg of this.active) {
      const dt = now - tg.t;
      if (tg.head || dt < -good || dt > good + LATE_GRACE) continue;
      const d = this.aimDistance(this.posOf(tg, now, p));
      if (d > tg.r * AIM_TOLERANCE) continue;
      if (!best || tg.t < best.t) { best = tg; bestD = d; }
    }
    // Every shot fires a tracer straight down the aim line (to the box's depth when it hits one).
    this.audio.play('shot', 0.5);
    if (!best) {
      this.world.shoot(this.alongAim(160), HOLD_COLOR, this.settings.muzzleFlash);
      return;
    }
    const dt = now - best.t;
    const a = Math.abs(dt);
    const perfect = this.window('perfect');
    const J = a <= perfect * CRITICAL_SCALE ? 'crit' : a <= perfect ? 'perfect' : a <= this.window('great') ? 'great' : 'good';
    best.head = 'hit';
    const pos = this.posOf(best, now, new THREE.Vector3());
    const owner = best.lead || best;
    this.world.shoot(this.alongAim(this.depthOf(pos)), best.hold ? HOLD_COLOR : this.colorOf(owner), this.settings.muzzleFlash);
    this.judge(J, pos, 1 - bestD / (best.r * AIM_TOLERANCE), dt, best);
    this.audio.play(J === 'crit' ? 'crit' : 'hit', 0.9);
    if (best.hold) {
      best.hold.trackFrom = now;
    } else {
      this.world.burst(pos, this.colorOf(owner), this.dist.speedAt(now));
      owner.drop = 1; // the next layer of a stack lowers into place
      this.finishTarget(best);
    }
  }

  // --- Score (AAstralRunManager::Judge) ---------------------------------------------------------

  judge(J, pos, aim = 1, dt = 0, tg = null) {
    const s = this.score;
    const comboMult = 1 + Math.min(s.combo, 100) * 0.01;
    let points = 0, combo = false, heal = 0, breaks = false;
    const bonus = { crit: 1, perfect: 0.5, great: 0.25, good: 0.1, miss: 0 };
    if (J in bonus) { s.bonusW += bonus[J]; s.bonusT += 1; }
    switch (J) {
      case 'crit': points = 320; s.crit++; s.accW += 1; s.accT += 1; combo = true; heal = HIT_HEAL; break;
      case 'perfect': points = 300; s.perfect++; s.accW += 1; s.accT += 1; combo = true; heal = HIT_HEAL; break;
      case 'great': points = 200; s.great++; s.accW += 2 / 3; s.accT += 1; combo = true; heal = HIT_HEAL * 0.7; break;
      case 'good': points = 100; s.good++; s.accW += 1 / 3; s.accT += 1; combo = true; heal = HIT_HEAL * 0.4; break;
      case 'miss': s.miss++; s.accT += 1; heal = -MISS_DAMAGE; breaks = true; break;
      case 'tick': points = 30; s.ticksHit++; s.ticksTotal++; s.accW += 0.25; s.accT += 0.25; combo = true; heal = HIT_HEAL * 0.2; break;
      case 'tickMiss': s.ticksTotal++; s.accT += 0.25; heal = -TICK_MISS_DAMAGE; breaks = true; break;
      case 'locked': points = 300; s.holdsLocked++; s.accW += 1; s.accT += 1; combo = true; heal = HIT_HEAL; break;
      case 'holdGreat': points = 200; s.holdsGreat++; s.accW += 2 / 3; s.accT += 1; combo = true; heal = HIT_HEAL * 0.7; break;
      case 'holdGood': points = 100; s.holdsGood++; s.accW += 1 / 3; s.accT += 1; combo = true; heal = HIT_HEAL * 0.4; break;
      case 'broken': s.holdsBroken++; s.accT += 1; heal = -MISS_DAMAGE * 0.5; breaks = true; break;
    }
    s.score += Math.round(points * (0.85 + 0.15 * Math.max(0, Math.min(1, aim))) * comboMult);
    if (breaks) s.combo = 0;
    else if (combo) { s.combo++; s.maxCombo = Math.max(s.maxCombo, s.combo); }
    s.health = Math.max(0, Math.min(1, s.health + (heal < 0 ? heal * HEALTH_DRAIN : heal)));

    const label = {
      crit: ['CRITICAL', 'crit', 'PERFECT'], perfect: ['PERFECT', 'perfect'], great: ['GREAT', 'great'], good: ['GOOD', 'good'],
      miss: ['MISS', 'miss'], locked: ['LOCKED', 'perfect'], holdGreat: ['GREAT', 'great'], holdGood: ['GOOD', 'good'], broken: ['BROKEN', 'miss'],
    }[J];
    if (label && pos) {
      // Above the box (not on top of it), or in one place at the top of the screen.
      const half = tg ? tg.r * BOX_HALF : 1;
      let sp;
      if (this.settings.judgePos === 'top') {
        const r = this.world.canvas.getBoundingClientRect();
        sp = { x: r.left + r.width / 2, y: r.top + Math.max(110, r.height * 0.2) };
      } else {
        sp = this.world.project(pos.clone().add(new THREE.Vector3(0, half * 1.35 + 0.25, 0)));
      }
      if (sp) {
        let sub = label[2] || '';
        if (J === 'great' || J === 'good') sub = dt < 0 ? 'EARLY' : 'LATE';
        this.hud.popup(label[0], label[1], sp.x, sp.y, sub);
      }
    }
  }

  accuracy() {
    const s = this.score;
    return ((s.accT > 0 ? s.accW / s.accT : 1) + 0.01 * (s.bonusT > 0 ? s.bonusW / s.bonusT : 1)) * 100;
  }

  // --- Per frame --------------------------------------------------------------------------------

  frame(dt) {
    if (!this.started || this.finished) return;
    if (this.paused) { this.world.setView(this.x, this.dist.at(this.lastT ?? 0), 0, this.yaw, this.pitch); return; }
    const now = this.now();
    this.lastT = now;
    const s = this.dist.at(now);

    this.x += (this.laneX(this.lane) - this.x) * (1 - Math.exp(-dt / (LANE_SWITCH / 3)));
    const beat = this.song.timing.timeToBeat(now);
    const bob = now > 0 ? 0.035 * Math.abs(Math.sin(Math.PI * beat)) : 0;
    this.world.setView(this.x, s, bob, this.yaw, this.pitch);
    if (this.look) this.centerCursor();

    if (this.autoplay) this.bot(now, dt);
    this.aimRay();
    if (this.settings.autoFire && this.held.size > 0 && !this.held.has('bot') && now >= this.nextAuto) {
      this.nextAuto = Math.max(this.nextAuto + 1 / FIRE_RATE, now);
      this.fire(now);
    }
    this.updateEvents(now);
    this.updateTargets(now, dt);

    const sc = this.score;
    this.hud.update({
      score: sc.score, combo: sc.combo, acc: this.accuracy(), health: sc.health,
      progress: Math.max(0, Math.min(1, now / this.endT)), countdown: now < 0 && now > -3.5 ? Math.ceil(-now) : 0,
      cursor: this.cursor,
    });

    if (!this.settings.noFail && sc.health <= 0) this.end(true);
    else if (now >= this.endT || (this.audioEnded && now > this.chart.lastTime + 0.5)) this.end(false);
  }

  updateEvents(now) {
    while (this.eventI < this.events.length && this.events[this.eventI].t <= now) {
      const e = this.events[this.eventI++];
      if (now - e.t > 1) continue; // long past (e.g. after a hitch)
      if (e.type === 'flash') this.world.flash(e.value || 1);
      else if (e.type === 'color' && e.color) this.world.setNeon(e.color);
      else if (e.type === 'fov') this.world.kickFov(e.value || 0);
    }
  }

  colorOf(owner) {
    if (owner.hold) return HOLD_COLOR;
    if (!owner.members) return TAP_COLOR;
    const left = owner.members.filter(m => !m.head).length;
    return left >= 3 ? TRIPLE_COLOR : left === 2 ? DOUBLE_COLOR : TAP_COLOR;
  }

  spawn(tg) {
    this.active.push(tg);
    if (tg.lead) return; // drawn as part of its group's box
    tg.vis = this.world.acquireTarget();
    tg.drop = 0;
    this.drawn.push(tg);
    if (tg.hold) {
      const h = tg.hold;
      h.tickI = 0;
      h.untracked = 0;
      h.trackFrom = null;
      // The rail: where the box will be over the hold, laid out ahead along the track.
      const pts = [];
      const n = Math.max(8, Math.min(64, Math.ceil((h.end - tg.t) * 40)));
      const s0 = this.dist.at(tg.t);
      for (let i = 0; i <= n; i++) {
        const tau = tg.t + (h.end - tg.t) * i / n;
        const [x, y] = h.path.at(i / n);
        pts.push([x, y, -(this.dist.at(tau) - s0)]);
      }
      this.world.makeRail(tg.vis, pts, HOLD_COLOR);
    }
  }

  updateTargets(now, dt) {
    const ap = this.approach;
    while (this.spawnI < this.targets.length && this.targets[this.spawnI].t - ap <= now) this.spawn(this.targets[this.spawnI++]);

    const late = this.window('good') + LATE_GRACE;
    const p = new THREE.Vector3();
    const held = this.held.size > 0;
    let beam = null;
    for (const tg of [...this.active]) {
      if (!tg.head && now > tg.t + late) {
        tg.head = 'miss';
        this.judge('miss', this.posOf(tg, now, p), 1, 0, tg);
        this.audio.play('miss', 0.5);
        if (tg.hold) tg.hold.trackFrom = tg.t;
        else { (tg.lead || tg).missAt = now; this.finishTarget(tg); continue; }
      }
      if (tg.hold && now >= tg.t) {
        const h = tg.hold;
        this.posOf(tg, now, p);
        const tracked = held && this.aimDistance(p) <= tg.r * HOLD_AIM_TOLERANCE;
        tg.tracked = tracked;
        if (tracked && now < h.end) beam = this.settings.holdBeamSnap ? p.clone() : this.alongAim(this.depthOf(p));
        if (h.trackFrom !== null && !tracked && now < h.end - HOLD_END_LENIENCY) h.untracked += dt;
        while (h.tickI < h.ticks.length && h.ticks[h.tickI] <= now) {
          h.tickI++;
          this.judge(tracked ? 'tick' : 'tickMiss');
          if (tracked) this.audio.play('tick', 0.5);
        }
        if (now >= h.end) {
          const J = h.untracked <= HOLD_MISS[0] ? 'locked' : h.untracked <= HOLD_MISS[1] ? 'holdGreat' : h.untracked <= HOLD_MISS[2] ? 'holdGood' : 'broken';
          const endPos = this.posOf(tg, h.end, new THREE.Vector3());
          this.judge(J, endPos, 1, 0, tg);
          if (J !== 'broken') {
            this.audio.play('hold', 0.7);
            this.world.burst(endPos, HOLD_COLOR, this.dist.speedAt(now));
          }
          this.finishTarget(tg);
        }
      }
    }
    this.world.setBeam(beam, HOLD_COLOR);

    for (const o of [...this.drawn]) {
      if (!this.drawTarget(o, now, dt)) {
        this.world.releaseTarget(o.vis);
        o.vis = null;
        this.drawn.splice(this.drawn.indexOf(o), 1);
      }
    }
  }

  /** Draws a box (or a group's box); returns false once it's gone. */
  drawTarget(o, now, dt) {
    const v = o.vis;
    const ap = this.approach;
    const members = o.members || [o];
    const next = members.find(m => !m.head);
    let missFade = 0;
    if (o.hold) {
      if (o.done) return false;
    } else if (!next) {
      // Every tap is done: gone if the last one was hit, else fade out grey.
      const last = members[members.length - 1];
      if (last.head === 'hit' || o.missAt === undefined) return false;
      missFade = (now - o.missAt) / 0.35;
      if (missFade >= 1) return false;
    }
    const cur = next || members[members.length - 1];
    const before = cur.t - now;
    const half = o.r * BOX_HALF;
    const edge = half * 2;
    this.posOf(o, now, v.box.position);
    const grow = Math.min(1, (ap - (o.t - now)) / 0.15); // pops in at the far end
    let k = edge * Math.max(0.05, grow);
    const color = missFade > 0 ? MISS_COLOR : this.colorOf(o);
    const u = v.box.material.uniforms;
    u.uColor.value.set(color);
    u.uEdge.value.set(o.hold ? PALETTE.holdOutline : color);
    if (missFade > 0) {
      v.box.position.y -= missFade * missFade * 3;
      k *= 1 - missFade * 0.6;
    }
    v.box.scale.setScalar(k);
    // A slow spin while flying in, square again on the beat.
    const spin = Math.max(0, o.t - now) * 1.6;
    v.box.rotation.set(spin * 0.6, spin, 0);
    u.uGlow.value = o.hold && now > o.t ? (o.tracked ? 2.4 : 0.8) : 1.6;

    // Stacked double / triple: the taps still to come sit on top and lower into place after a hit.
    o.drop = Math.max(0, (o.drop || 0) - dt / 0.12);
    const left = members.filter(m => !m.head).length;
    const stack = this.settings.multiDisplay === 'stack' && o.members ? Math.max(0, left - 1) : 0;
    const lift = o.drop * o.drop * edge * 1.08;
    v.box.position.y += lift;
    for (let i = 0; i < Math.max(stack, v.layers.length); i++) {
      if (i >= stack) { v.layers[i].visible = false; continue; }
      const m = this.world.layer(v, i);
      m.visible = true;
      m.position.copy(v.box.position);
      m.position.y += (i + 1) * edge * 1.08;
      m.rotation.copy(v.box.rotation);
      m.scale.setScalar(k);
      m.material.uniforms.uColor.value.set(color);
      m.material.uniforms.uEdge.value.set(color);
    }

    // Timing frame: closes from 3.2 box sizes to the box outline on the beat.
    if (before > 0 && missFade === 0) {
      const fh = half * 1.12 * (1 + (FRAME_START - 1) * Math.min(1, before / ap));
      v.frame.visible = true;
      v.frame.position.set(v.box.position.x, v.box.position.y - lift, v.box.position.z + half);
      v.frame.scale.setScalar(fh);
      const fu = v.frame.material.uniforms;
      fu.uColor.value.set(color);
      fu.uHalf.value = fh;
      fu.uWidth.value = 0.07 * o.r / 1.1;
      fu.uOpacity.value = Math.min(1, grow);
    } else {
      v.frame.visible = false;
    }
    if (v.rail) {
      // The rail rides in with the box, then stays put while the box slides along it.
      const ru = v.rail.material.uniforms;
      if (now < o.t) { v.rail.position.z = v.box.position.z; ru.uCut.value = 0; }
      else {
        v.rail.position.z = -(this.dist.at(o.t) + PLAYFIELD.distance);
        ru.uCut.value = this.dist.at(Math.min(now, o.hold.end)) - this.dist.at(o.t);
      }
      ru.uOpacity.value = o.head === 'miss' ? 0.3 : o.tracked ? 0.85 : 0.65;
    }
    return true;
  }

  finishTarget(tg) {
    tg.done = true;
    const i = this.active.indexOf(tg);
    if (i >= 0) this.active.splice(i, 1);
  }

  // --- Autoplay ---------------------------------------------------------------------------------

  bot(now, dt) {
    // Follow the hold in progress, else turn towards the next box; fire on time.
    const p = new THREE.Vector3();
    let focus = null, holding = false;
    for (const tg of this.active) {
      if (tg.hold && now >= tg.t && now < tg.hold.end) { focus = tg; holding = true; break; }
    }
    if (!focus) {
      for (const tg of this.active) if (!tg.head && (!focus || tg.t < focus.t)) focus = tg;
    }
    if (holding) this.held.add('bot'); else this.held.delete('bot');
    const k = holding ? 1 : 1 - Math.exp(-dt * 12);
    if (focus) {
      // Aim where the box will be when it's due.
      this.posOf(focus, Math.max(now, focus.t), p);
      if (this.look) {
        const a = this.world.aimAt(p);
        this.setAim(this.yaw + (a.yaw - this.yaw) * k, this.pitch + (a.pitch - this.pitch) * k);
      } else {
        const sp = this.world.project(p);
        if (sp) {
          this.cursor.x += (sp.x - this.cursor.x) * k;
          this.cursor.y += (sp.y - this.cursor.y) * k;
        }
      }
    }
    for (const tg of [...this.active]) {
      if (tg.head || tg.t > now) continue;
      this.posOf(tg, now, p);
      if (this.look) {
        const a = this.world.aimAt(p);
        this.setAim(a.yaw, a.pitch);
      } else {
        const sp = this.world.project(p);
        if (!sp) continue;
        this.cursor.x = sp.x; this.cursor.y = sp.y;
      }
      this.fire(now);
    }
  }

  // --- End --------------------------------------------------------------------------------------

  end(failed) {
    if (this.finished) return;
    this.finished = true;
    this.world.showGun(false);
    this.audio.fadeMusic(failed ? 0.8 : 1.5);
    const src = this.audio.src;
    setTimeout(() => { if (this.audio.src === src) this.audio.stopMusic(); }, 1600);
    this.clearTargets();
    const s = this.score;
    const acc = failed ? Math.min(this.accuracy(), 100) : this.accuracy();
    this.onEnd({ ...s, acc, rank: failed ? 'F' : rankOf(acc), failed, autoplay: this.autoplay });
  }
}
