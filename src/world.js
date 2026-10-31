// The 3D scene, styled after the game's neon city on the dev preset: a clean dark road with thin
// lane lines, glowing edge rails and side barriers, calm towers to the sides, violet fog.
// Three.js units are metres; the runner goes down -Z (track distance s = -z).
import * as THREE from 'three';
import { LANE_WIDTH } from './chart.js';

const EYE = 1.75;
export const AIM_LIMITS = { yaw: 55, up: 50, down: 25 }; // degrees, as the game
export const REST_PITCH = 6;
const MUZZLE = new THREE.Vector3(0, 0.012, -0.56); // in gun space

// The game's default theme (UAstralTheme).
export const PALETTE = {
  target: '#FF3CE6',
  hold: '#27F2FF',
  holdOutline: '#D8FFFF',
  neonA: '#B23CFF',
  neonB: '#FF3CC8',
  fog: '#3A1470',
  skyTop: '#07021A',
  horizon: '#5B22B8',
};

const ROAD_HALF = 9;
const FOG = { near: 45, far: 520 };

const FOG_GLSL = /* glsl */`
  uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
  vec3 applyFog(vec3 c, vec3 w) {
    float f = smoothstep(uFogNear, uFogFar, distance(w, cameraPosition));
    return mix(c, uFogColor, f * f * (3.0 - 2.0 * f));
  }`;

const WORLD_VERT = /* glsl */`
  varying vec3 vWorld; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// Target boxes (M_Astral_Box): solid, unlit, brighter towards the middle of each face, glowing edges.
const BOX_FRAG = /* glsl */`
  uniform vec3 uColor; uniform vec3 uEdge; uniform float uGlow;
  varying vec3 vWorld; varying vec2 vUv;
  ${FOG_GLSL}
  void main() {
    vec2 e = abs(vUv - 0.5) * 2.0;
    float m = max(e.x, e.y);
    float aa = max(fwidth(m), 1e-4);
    float edge = clamp((m - 0.84) / aa + 0.5, 0.0, 1.0);
    vec3 c = uColor * (0.28 + 0.42 * (1.0 - m)) + uEdge * edge * uGlow;
    gl_FragColor = vec4(applyFog(c, vWorld), 1.0);
    #include <colorspace_fragment>
  }`;

// Square timing frame (the game's approach frame for boxes): a border of fixed width in metres.
const FRAME_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uHalf; uniform float uWidth; uniform float uOpacity;
  varying vec3 vWorld; varying vec2 vUv;
  ${FOG_GLSL}
  void main() {
    vec2 p = abs(vUv - 0.5) * 2.0 * uHalf;
    float d = uHalf - max(p.x, p.y);
    float aa = max(fwidth(d), 1e-4);
    float a = clamp((uWidth - d) / aa + 0.5, 0.0, 1.0);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(applyFog(uColor, vWorld), a * uOpacity);
    #include <colorspace_fragment>
  }`;

// Hold rails: a 3D tube the box rides along; the part already passed is cut away.
const RAIL_VERT = /* glsl */`
  varying vec3 vLocal; varying vec3 vWorld; varying vec3 vNormal;
  void main() {
    vLocal = position;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const RAIL_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uCut; uniform float uOpacity;
  varying vec3 vLocal; varying vec3 vWorld; varying vec3 vNormal;
  ${FOG_GLSL}
  void main() {
    if (-vLocal.z < uCut) discard;
    float fres = 1.0 - abs(dot(normalize(cameraPosition - vWorld), normalize(vNormal)));
    vec3 c = uColor * (0.45 + 1.1 * fres);
    gl_FragColor = vec4(applyFog(c, vWorld), uOpacity * (0.4 + 0.6 * fres));
    #include <colorspace_fragment>
  }`;

const GROUND_FRAG = /* glsl */`
  uniform vec3 uNeonA; uniform vec3 uNeonB; uniform float uLanes; uniform float uLaneW; uniform float uFlash;
  varying vec3 vWorld; varying vec2 vUv;
  ${FOG_GLSL}
  float lineAA(float d, float w) {
    float fw = max(fwidth(d), 1e-4);
    return clamp((w - d) / fw + 0.5, 0.0, 1.0) * min(1.0, w / fw);
  }
  void main() {
    float x = vWorld.x, z = vWorld.z;
    float span = uLanes * uLaneW * 0.5;
    float road = step(abs(x), ${ROAD_HALF.toFixed(1)});
    // One calm hairline per lane divider, glowing rails at the lane edges.
    float k = (x + span) / uLaneW;
    float lane = lineAA(abs(k - floor(k + 0.5)) * uLaneW, 0.035) * step(0.5, k) * step(k, uLanes - 0.5);
    float rail = lineAA(abs(abs(x) - span - 0.25), 0.07);
    // Faint cross seams every 10 m so the speed reads.
    float seam = lineAA(abs(fract(-z / 10.0 + 0.5) - 0.5) * 10.0, 0.03) * road;
    float gx = lineAA(abs(fract(x / 12.0 + 0.5) - 0.5) * 12.0, 0.05);
    float gz = lineAA(abs(fract(z / 12.0 + 0.5) - 0.5) * 12.0, 0.05);
    vec3 c = mix(vec3(0.002, 0.001, 0.006), vec3(0.006, 0.004, 0.014), road);
    c += vec3(0.75, 0.72, 1.0) * lane * 0.3;
    c += uNeonB * rail * 1.6 * (1.0 + uFlash);
    c += uNeonA * seam * 0.10;
    c += uNeonA * max(gx, gz) * (1.0 - road) * 0.12 * (1.0 + uFlash);
    gl_FragColor = vec4(applyFog(c, vWorld), 1.0);
    #include <colorspace_fragment>
  }`;

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w;
  }`;
const SKY_FRAG = /* glsl */`
  uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uFog; uniform float uFlash;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.5, h));
    c = mix(c, uFog, exp(-max(h, 0.0) * 18.0) * 0.6);
    c *= 1.0 + uFlash * 0.25;
    gl_FragColor = vec4(h < 0.0 ? uFog : c, 1.0);
    #include <colorspace_fragment>
  }`;

function hash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE.fog, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1500);
    this.camera.rotation.order = 'YXZ';
    this.setAim(0, REST_PITCH);
    this.scene.add(this.camera);
    this.baseFov = 60;
    this.fovKick = 0;
    this.flashV = 0;
    this.neonA = new THREE.Color(PALETTE.neonA);
    this.neonB = new THREE.Color(PALETTE.neonB);
    this.neonGoal = this.neonA.clone();
    this.fogColor = new THREE.Color(PALETTE.fog);
    this.fogU = { uFogColor: { value: this.fogColor }, uFogNear: { value: FOG.near }, uFogFar: { value: FOG.far } };
    this.scene.fog = new THREE.Fog(this.fogColor, FOG.near, FOG.far);
    this.bloom = null;
    this.quality = 'high';

    this.buildSky();
    this.buildRoad();
    this.buildCity();
    this.buildPools();
    this.buildGun();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // --- Setup ------------------------------------------------------------------------------------

  shader(frag, uniforms, extra = {}) {
    return new THREE.ShaderMaterial({ vertexShader: WORLD_VERT, fragmentShader: frag, uniforms: { ...uniforms, ...this.fogU }, ...extra });
  }

  buildSky() {
    this.skyU = {
      uTop: { value: new THREE.Color(PALETTE.skyTop) },
      uHorizon: { value: new THREE.Color(PALETTE.horizon) },
      uFog: { value: this.fogColor },
      uFlash: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.skyU, side: THREE.BackSide, depthWrite: false }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    // A few faint stars high up.
    const pts = [];
    for (let i = 0; i < 260; i++) {
      const a = hash(i, 1, 7) * Math.PI * 2, h = 0.15 + hash(i, 2, 7) * 0.85;
      const r = Math.sqrt(1 - h * h);
      pts.push(Math.cos(a) * r * 900, h * 900, Math.sin(a) * r * 900);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: '#cbb8ff', size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7 }));
    stars.frustumCulled = false;
    sky.add(stars);
    this.sky = sky;
    this.scene.add(sky);
  }

  buildRoad() {
    this.groundU = {
      uNeonA: { value: this.neonA },
      uNeonB: { value: this.neonB },
      uLanes: { value: 3 },
      uLaneW: { value: LANE_WIDTH },
      uFlash: { value: 0 },
    };
    const g = new THREE.PlaneGeometry(1000, 1400);
    g.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(g, this.shader(GROUND_FRAG, this.groundU));
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);

    // Side barriers with a neon strip and a lit top edge (uniform along the road, so they simply
    // ride along with the runner).
    this.road = new THREE.Group();
    const len = 1400;
    const dark = new THREE.MeshLambertMaterial({ color: '#130d24' });
    this.stripA = new THREE.MeshBasicMaterial({ color: this.neonA });
    this.stripB = new THREE.MeshBasicMaterial({ color: this.neonB });
    for (const side of [-1, 1]) {
      const add = (w, h, x, y, mat) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), mat);
        m.position.set(side * x, y, -len / 2 + 30);
        m.frustumCulled = false;
        this.road.add(m);
      };
      add(0.5, 1.1, ROAD_HALF + 0.3, 0.55, dark);
      add(0.06, 0.08, ROAD_HALF + 0.04, 0.6, this.stripA);
      add(0.54, 0.05, ROAD_HALF + 0.3, 1.12, this.stripB);
    }
    this.scene.add(this.road);
    this.scene.add(new THREE.HemisphereLight('#6a3cc0', '#120820', 1.4));
  }

  buildCity() {
    this.citySpacing = 16;
    this.cityPerRow = 40;
    this.cityRows = [
      { side: -1, x0: 16, x1: 30, h0: 14, h1: 60 },
      { side: 1, x0: 16, x1: 30, h0: 14, h1: 60 },
      { side: -1, x0: 55, x1: 120, h0: 40, h1: 160 },
      { side: 1, x0: 55, x1: 120, h0: 40, h1: 160 },
    ];
    const n = this.cityPerRow * this.cityRows.length;
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.bodies = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: '#160e2e' }), n);
    this.rimsA = new THREE.InstancedMesh(box, this.stripA, n);
    this.rimsB = new THREE.InstancedMesh(box, this.stripB, n);
    for (const m of [this.bodies, this.rimsA, this.rimsB]) { m.frustumCulled = false; this.scene.add(m); }
    this.citySlot = new Int32Array(n).fill(-999999);
  }

  placeCity(s) {
    const m = new THREE.Matrix4();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const q = new THREE.Quaternion();
    const per = this.cityPerRow;
    const first = Math.floor(s / this.citySpacing) - 3;
    let changed = false;
    this.cityRows.forEach((row, r) => {
      for (let i = first; i < first + per; i++) {
        const slot = r * per + (((i % per) + per) % per);
        if (this.citySlot[slot] === i) continue;
        this.citySlot[slot] = i;
        changed = true;
        const h1 = hash(i, r, 1), h2 = hash(i, r, 2), h3 = hash(i, r, 3), h4 = hash(i, r, 4);
        if (h4 < 0.15) {
          this.bodies.setMatrixAt(slot, zero); this.rimsA.setMatrixAt(slot, zero); this.rimsB.setMatrixAt(slot, zero);
          continue;
        }
        const w = 7 + h1 * 9, d = 7 + h2 * 8;
        const h = row.h0 + Math.pow(h3, 1.5) * (row.h1 - row.h0);
        const x = row.side * (row.x0 + h2 * (row.x1 - row.x0) + w / 2);
        const z = -(i * this.citySpacing + h1 * 6);
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(w, h, d));
        this.bodies.setMatrixAt(slot, m);
        // A thin lit rim round the roof, violet or pink.
        m.compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(w + 0.3, 0.35, d + 0.3));
        const a = h4 < 0.6;
        this.rimsA.setMatrixAt(slot, a ? m : zero);
        this.rimsB.setMatrixAt(slot, a ? zero : m);
      }
    });
    if (changed) {
      this.bodies.instanceMatrix.needsUpdate = true;
      this.rimsA.instanceMatrix.needsUpdate = true;
      this.rimsB.instanceMatrix.needsUpdate = true;
    }
  }

  buildPools() {
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.frameGeo = new THREE.PlaneGeometry(2, 2);
    this.ringGeo = new THREE.RingGeometry(0.94, 1.0, 48);
    this.targetPool = [];
    this.effects = [];

    const N = 420;
    this.sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color: 0xffffff }), N);
    this.sparks.frustumCulled = false;
    this.sparks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.spark = Array.from({ length: N }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Vector3() }));
    this.sparkNext = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) this.sparks.setMatrixAt(i, zero);
    this.scene.add(this.sparks);
  }

  // --- Settings ---------------------------------------------------------------------------------

  async setQuality(q) {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === 'low' ? 1 : 2));
    if (q === 'high' && !this.bloom) {
      try {
        const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
          import('three/addons/postprocessing/EffectComposer.js'),
          import('three/addons/postprocessing/RenderPass.js'),
          import('three/addons/postprocessing/UnrealBloomPass.js'),
          import('three/addons/postprocessing/OutputPass.js'),
        ]);
        const c = new EffectComposer(this.renderer);
        c.addPass(new RenderPass(this.scene, this.camera));
        c.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.3, 0.6));
        c.addPass(new OutputPass());
        this.bloom = c;
      } catch (e) {
        console.warn('Bloom unavailable', e);
      }
    }
    this.resize();
  }

  setLanes(n) { this.groundU.uLanes.value = n; }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.bloom) { this.bloom.setPixelRatio(this.renderer.getPixelRatio()); this.bloom.setSize(w, h); }
    this.camera.aspect = w / h;
    // About the game's 95 degrees across on a wide screen; on a tall phone wide enough for the playfield.
    const needV = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / this.camera.aspect));
    this.baseFov = Math.min(110, Math.max(62, needV));
    this.applyFov();
  }

  applyFov() {
    this.camera.fov = this.baseFov + this.fovKick;
    this.camera.updateProjectionMatrix();
  }

  // --- Per frame --------------------------------------------------------------------------------

  /** Yaw right / pitch up in degrees. */
  setAim(yaw, pitch) {
    this.camera.rotation.set(THREE.MathUtils.degToRad(pitch), -THREE.MathUtils.degToRad(yaw), 0);
    this.camera.updateMatrixWorld();
  }

  /** Aim angles (degrees) that look at a world point from the camera. */
  aimAt(p) {
    const d = p.clone().sub(this.camera.position);
    return {
      yaw: THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z)),
      pitch: THREE.MathUtils.radToDeg(Math.atan2(d.y, Math.hypot(d.x, d.z))),
    };
  }

  setView(x, s, bob = 0, yaw = 0, pitch = REST_PITCH) {
    this.camera.position.set(x, EYE + bob, -s);
    this.setAim(yaw, pitch);
    this.ground.position.set(x, 0, -s - 600);
    this.road.position.z = -s;
    this.sky.position.copy(this.camera.position);
    this.placeCity(s);
  }

  setNeon(hex) { try { this.neonGoal.set(hex); } catch { /* bad colour */ } }
  resetNeon() { this.neonGoal.set(PALETTE.neonA); this.neonA.set(PALETTE.neonA); }
  flash(v) { this.flashV = Math.max(this.flashV, Math.min(3, v) * 0.4); }
  kickFov(deg) { this.fovKick = deg; }

  tick(dt) {
    this.neonA.lerp(this.neonGoal, 1 - Math.exp(-dt * 2));
    this.flashV *= Math.exp(-dt * 4);
    this.groundU.uFlash.value = this.flashV;
    this.skyU.uFlash.value = this.flashV;
    this.stripA.color.copy(this.neonA).multiplyScalar(1 + this.flashV);
    this.stripB.color.copy(this.neonB).multiplyScalar(1 + this.flashV);
    if (Math.abs(this.fovKick) > 0.01) { this.fovKick *= Math.exp(-dt * 6); this.applyFov(); }
    this.tickEffects(dt);
    this.tickGun(dt);
  }

  render() {
    if (this.bloom && this.quality === 'high') this.bloom.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // --- Targets ----------------------------------------------------------------------------------

  acquireTarget() {
    let v = this.targetPool.pop();
    if (!v) {
      const box = new THREE.Mesh(this.boxGeo, this.shader(BOX_FRAG, {
        uColor: { value: new THREE.Color() }, uEdge: { value: new THREE.Color() }, uGlow: { value: 1.6 },
      }));
      const frame = new THREE.Mesh(this.frameGeo, this.shader(FRAME_FRAG, {
        uColor: { value: new THREE.Color() }, uHalf: { value: 1 }, uWidth: { value: 0.08 }, uOpacity: { value: 1 },
      }, { transparent: true, depthWrite: false }));
      v = { box, frame, rail: null, layers: [] };
    }
    this.scene.add(v.box, v.frame);
    return v;
  }

  /** Extra boxes stacked above a double / triple box. */
  layer(v, i) {
    while (v.layers.length <= i) {
      const m = new THREE.Mesh(this.boxGeo, this.shader(BOX_FRAG, {
        uColor: { value: new THREE.Color() }, uEdge: { value: new THREE.Color() }, uGlow: { value: 1.6 },
      }));
      m.visible = false;
      v.layers.push(m);
    }
    const m = v.layers[i];
    if (!m.parent) this.scene.add(m);
    return m;
  }

  releaseTarget(v) {
    this.scene.remove(v.box, v.frame);
    for (const m of v.layers) { this.scene.remove(m); m.visible = false; }
    if (v.rail) { this.scene.remove(v.rail); v.rail.geometry.dispose(); v.rail.material.dispose(); v.rail = null; }
    this.targetPool.push(v);
  }

  /** A 3D tube through `pts` (metres; z = how far ahead of the hold's start each point is). */
  makeRail(v, pts, color) {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    const g = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), 0.24, 12, false);
    const rail = new THREE.Mesh(g, this.shader(RAIL_FRAG, {
      uColor: { value: new THREE.Color(color) }, uCut: { value: 0 }, uOpacity: { value: 0.7 },
    }, { transparent: true, depthWrite: false }));
    rail.material.vertexShader = RAIL_VERT;
    rail.frustumCulled = false;
    this.scene.add(rail);
    v.rail = rail;
  }

  // --- Effects ----------------------------------------------------------------------------------

  burst(p, color, speed) {
    const c = new THREE.Color(color);
    for (let k = 0; k < 16; k++) {
      const idx = this.sparkNext;
      const s = this.spark[idx];
      this.sparkNext = (idx + 1) % this.spark.length;
      s.life = 0.5;
      s.p.copy(p);
      s.v.set(Math.random() * 2 - 1, Math.random() * 2 - 0.5, Math.random() * 2 - 1).normalize().multiplyScalar(5 + Math.random() * 7);
      s.v.z -= speed * 0.85;
      s.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.sparks.setColorAt(idx, c);
    }
    this.sparks.instanceColor.needsUpdate = true;
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    ring.position.copy(p);
    this.scene.add(ring);
    this.effects.push({ obj: ring, life: 0.25, max: 0.25, vz: -speed * 0.9 });
  }

  tickEffects(dt) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = new THREE.Vector3();
    let any = false;
    for (let i = 0; i < this.spark.length; i++) {
      const s = this.spark[i];
      if (s.life <= 0) continue;
      any = true;
      s.life -= dt;
      if (s.life <= 0) { this.sparks.setMatrixAt(i, m.makeScale(0, 0, 0)); continue; }
      s.v.y -= 14 * dt;
      s.p.addScaledVector(s.v, dt);
      q.setFromEuler(e.set(s.r.x * s.life, s.r.y * s.life, s.r.z * s.life));
      sc.setScalar(s.life / 0.5);
      this.sparks.setMatrixAt(i, m.compose(s.p, q, sc));
    }
    if (any) this.sparks.instanceMatrix.needsUpdate = true;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const f = this.effects[i];
      f.life -= dt;
      f.obj.position.z += f.vz * dt;
      const k = 1 - f.life / f.max;
      f.obj.scale.setScalar(1.4 + k * 1.8);
      f.obj.material.opacity = 1 - k;
      if (f.life <= 0) { this.scene.remove(f.obj); f.obj.material.dispose(); this.effects.splice(i, 1); }
    }
  }

  clearEffects() {
    for (const f of this.effects) { this.scene.remove(f.obj); f.obj.material.dispose(); }
    this.effects.length = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.spark.length; i++) { this.spark[i].life = 0; this.sparks.setMatrixAt(i, zero); }
    this.sparks.instanceMatrix.needsUpdate = true;
  }

  // --- Rifle, shots ----------------------------------------------------------------------------

  buildGun() {
    // A minimalist rifle in the lower right of the view, lit by a light that rides with the camera.
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(-0.6, 1, 0.6);
    light.target.position.set(0.3, -0.3, -1);
    this.camera.add(light, light.target, new THREE.AmbientLight(0x9098c0, 1.1));
    const gun = new THREE.Group();
    const body = new THREE.MeshLambertMaterial({ color: '#394062' });
    const dark = new THREE.MeshLambertMaterial({ color: '#1d2130' });
    const trim = new THREE.MeshLambertMaterial({ color: '#56618a' });
    const part = (w, h, d, x, y, z, mat, rx = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      gun.add(m);
    };
    part(0.062, 0.082, 0.42, 0, 0, -0.06, body);          // receiver
    part(0.036, 0.036, 0.3, 0, 0.012, -0.4, dark);        // barrel
    part(0.05, 0.05, 0.035, 0, 0.012, -0.54, dark);       // muzzle
    part(0.052, 0.06, 0.16, 0, -0.006, 0.22, body);       // stock
    part(0.044, 0.11, 0.05, 0, -0.085, 0.06, dark, 0.3);  // grip
    part(0.04, 0.07, 0.04, 0, -0.07, -0.16, dark, -0.1);  // magazine
    part(0.012, 0.006, 0.38, 0, 0.044, -0.08, trim);   // top strip
    part(0.004, 0.012, 0.3, 0.033, 0.01, -0.05, trim); // side strip
    for (const m of gun.children) m.material.fog = false;
    this.gunBase = new THREE.Vector3(0.25, -0.24, -0.56);
    gun.position.copy(this.gunBase);
    gun.scale.setScalar(0.85);
    gun.rotation.y = 0.07;
    gun.visible = false;
    this.camera.add(gun);
    this.gun = gun;
    this.recoilT = 1;

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), color: '#fff2dc', blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true,
    }));
    this.flashSprite.position.copy(MUZZLE).add(new THREE.Vector3(0, 0, -0.04));
    this.flashSprite.visible = false;
    gun.add(this.flashSprite);
    this.flashT = 0;

    this.tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    this.tracers = [];
    this.beam = this.makeTracer();
    this.beam.visible = false;
  }

  makeTracer() {
    // Tracers live in camera space: they leave the muzzle and travel with you.
    const m = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({
      color: PALETTE.hold, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    m.frustumCulled = false;
    m.visible = false;
    this.camera.add(m);
    return m;
  }

  showGun(on) {
    this.gun.visible = on;
    if (!on) { this.beam.visible = false; for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; } }
  }

  /** The muzzle in camera space (follows the recoil). */
  muzzleLocal(out = new THREE.Vector3()) {
    this.gun.updateMatrix();
    return out.copy(MUZZLE).applyMatrix4(this.gun.matrix);
  }

  aimLine(from, to, mesh, width) {
    const d = to.clone().sub(from);
    const len = d.length();
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.divideScalar(len || 1));
    mesh.scale.set(width, width, len);
  }

  toCamera(world) {
    this.camera.updateMatrixWorld();
    return this.camera.worldToLocal(world.clone());
  }

  /** A shot from the muzzle to `to` (world: the target hit, or far down the aim line). */
  shoot(to, color, flash = false) {
    this.recoilT = 0;
    if (flash) {
      this.flashT = 0.05;
      this.flashSprite.visible = true;
      this.flashSprite.material.rotation = Math.random() * Math.PI;
    }
    let t = this.tracers.find(x => x.life <= 0);
    if (!t) { t = { mesh: this.makeTracer(), life: 0, end: new THREE.Vector3() }; this.tracers.push(t); }
    t.life = t.max = 0.08;
    t.end.copy(this.toCamera(to));
    t.mesh.material.color.set(color);
    t.mesh.visible = true;
    this.aimLine(this.muzzleLocal(), t.end, t.mesh, 0.03);
  }

  /** The steady beam while a hold is tracked (null hides it). */
  setBeam(to, color) {
    if (!to) { this.beam.visible = false; return; }
    this.beam.visible = true;
    this.beam.material.color.set(color);
    this.beam.material.opacity = 0.75 + Math.random() * 0.25;
    this.aimLine(this.muzzleLocal(), this.toCamera(to), this.beam, 0.025 + Math.random() * 0.015);
  }

  tickGun(dt) {
    if (this.recoilT < 1) {
      this.recoilT = Math.min(1, this.recoilT + dt / 0.12);
      const kick = Math.sin(this.recoilT * Math.PI) * (1 - this.recoilT * 0.5);
      this.gun.position.set(this.gunBase.x, this.gunBase.y + kick * 0.01, this.gunBase.z + kick * 0.06);
      this.gun.rotation.x = kick * 0.12;
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flashSprite.visible = this.flashT > 0;
      this.flashSprite.scale.setScalar(0.1 + Math.random() * 0.06);
    }
    const from = this.muzzleLocal();
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / t.max);
      this.aimLine(from, t.end, t.mesh, 0.03);
      if (t.life <= 0) t.mesh.visible = false;
    }
  }

  // --- Helpers ----------------------------------------------------------------------------------

  /** World point -> CSS pixels on the canvas (null when behind the camera). */
  project(p) {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }

  /** The aim ray through a CSS pixel. */
  ray(px, py, out) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
    out.origin.copy(this.camera.position);
    out.dir.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    return out;
  }
}
