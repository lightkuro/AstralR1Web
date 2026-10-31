// Web Audio: the music clock and short synthesized sound effects.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.src = null;
    this.sfxBuffers = {};
    this.smooth = null;
    this.lastPerf = 0;
  }

  /** Call from a user gesture (browsers only allow audio after one). */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.musicGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.musicGain.connect(this.ctx.destination);
      this.sfxGain.connect(this.ctx.destination);
      this.makeSfx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolumes(music, sfx) {
    if (!this.ctx) return;
    this.musicGain.gain.value = music;
    this.sfxGain.gain.value = sfx;
  }

  decode(data) {
    // The callback form also works on older Safari.
    return new Promise((res, rej) => this.ctx.decodeAudioData(data, res, e => rej(e || new Error('Could not decode audio'))));
  }

  /** Starts the music so that its first sample is heard at context time `when`. */
  playMusic(buffer, when, onEnded) {
    this.stopMusic();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    src.connect(g).connect(this.musicGain);
    src.onended = () => { if (this.src === src && onEnded) onEnded(); };
    src.start(Math.max(this.ctx.currentTime, when), Math.max(0, this.ctx.currentTime - when));
    this.src = src;
    this.srcGain = g;
    this.resetClock();
  }

  fadeMusic(seconds) {
    if (!this.srcGain) return;
    const t = this.ctx.currentTime;
    this.srcGain.gain.setValueAtTime(this.srcGain.gain.value, t);
    this.srcGain.gain.linearRampToValueAtTime(0, t + seconds);
  }

  stopMusic() {
    if (this.src) {
      this.src.onended = null;
      try { this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
    }
    this.src = null;
    this.srcGain = null;
  }

  pause() { return this.ctx ? this.ctx.suspend() : Promise.resolve(); }
  resume() { return this.ctx ? this.ctx.resume().then(() => this.resetClock()) : Promise.resolve(); }
  resetClock() { this.smooth = null; }

  /** Context time of the sound reaching the speakers now. */
  rawHeard() {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** rawHeard, smoothed: the audio clock moves in blocks, frames need steady time. */
  heard() {
    if (!this.ctx) return 0;
    const est = this.rawHeard();
    const p = performance.now() / 1000;
    if (this.smooth === null || this.ctx.state !== 'running') {
      this.smooth = est;
    } else {
      this.smooth += p - this.lastPerf;
      const err = est - this.smooth;
      this.smooth = Math.abs(err) > 0.03 ? est : this.smooth + err * 0.05;
    }
    this.lastPerf = p;
    return this.smooth;
  }

  play(name, gain = 1) {
    const b = this.sfxBuffers[name];
    if (!b || !this.ctx || this.ctx.state !== 'running') return;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      s.connect(g).connect(this.sfxGain);
    } else {
      s.connect(this.sfxGain);
    }
    s.start();
  }

  makeSfx() {
    const sr = this.ctx.sampleRate;
    let seed = 12345;
    const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
    const make = (dur, fn) => {
      const n = Math.ceil(dur * sr);
      const b = this.ctx.createBuffer(1, n, sr);
      const d = b.getChannelData(0);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const v = fn(t, () => { lp += (noise() - lp) * 0.12; return lp; });
        d[i] = Math.max(-1, Math.min(1, v));
      }
      return b;
    };
    const sin = (f, t) => Math.sin(2 * Math.PI * f * t);
    this.sfxBuffers = {
      hit: make(0.12, t => noise() * Math.exp(-t * 900) * 0.5 + sin(1650, t) * Math.exp(-t * 55) * 0.45),
      crit: make(0.14, t => noise() * Math.exp(-t * 900) * 0.5 + (sin(1650, t) + sin(2475, t) * 0.6) * Math.exp(-t * 45) * 0.38),
      // The rifle: a short snap with a falling zap.
      shot: make(0.11, t => noise() * Math.exp(-t * 70) * 0.35 + Math.sin(2 * Math.PI * (950 * t - 3200 * t * t)) * Math.exp(-t * 38) * 0.32),
      tick: make(0.05, t => sin(2600, t) * Math.exp(-t * 90) * 0.3),
      hold: make(0.5, t => (sin(880, t) + sin(1320, t) * 0.6 + sin(1760, t) * 0.25) * Math.exp(-t * 8) * 0.3),
      miss: make(0.16, t => sin(150 - 200 * t, t) * Math.exp(-t * 22) * 0.45),
      crash: make(0.4, (t, lp) => lp() * Math.exp(-t * 9) * 2.2),
      gate: make(0.16, t => sin(600 + 2400 * t, t) * Math.min(1, t * 200) * Math.exp(-t * 18) * 0.3),
    };
  }
}
