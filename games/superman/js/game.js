/* Superman Over Metropolis — a physics sandbox for the whole power set.
 * Runs from file:// with the vendored three.js r128 build (no server, no network).
 */
(function () {
'use strict';

const errEl = document.getElementById('err');
function fail() { errEl.hidden = false; const t = document.getElementById('title'); if (t) t.hidden = true; }
if (!window.THREE || !THREE.EffectComposer) { fail(); return; }

// ============================================================ constants
const V3 = THREE.Vector3, Q4 = THREE.Quaternion;
const G = 9.81, CELL = 5, STORY = 4, LOTS = 7, PITCH = 60, HALF = LOTS * PITCH / 2;
const WATER_Z = 240, WATER_Y = -0.6, SEAFLOOR = -24, FAR_SHORE = 1800;
const inBay = z => z > WATER_Z && z < FAR_SHORE;
const MAXP = 200;
const T_COL = 0, T_GLASS = 1, T_SLAB = 2;               // block types
const BREAK_E = [9e6, 5e5, 1.6e6];                        // joules to break each type
const MASS_T = [62000, 11000, 30000];                     // kg per block type
const SLAB_H = 0.5;
const UP = new V3(0, 1, 0);
const HOSP = new V3(-180, 0, 190);
const rnd = Math.random, R = (a, b) => a + rnd() * (b - a);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x), lerp = (a, b, t) => a + (b - a) * t;
const pick = a => a[Math.floor(rnd() * a.length)];
function srand(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const airRho = h => 1.225 * Math.exp(-Math.max(0, h) / 8500);
const soundSpeed = h => Math.max(295, 340.3 - 0.0041 * Math.max(0, h));
const lin = h => new THREE.Color(h).convertSRGBToLinear();
const T1 = new V3(), T2 = new V3(), T3 = new V3(), T4 = new V3(), T5 = new V3(), T6 = new V3();
const TQ = new Q4(), TQ2 = new Q4(), TM = new THREE.Matrix4(), TS = new V3();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const money = n => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n);

const AVES = ['Siegel Ave', 'Shuster Ave', 'Kane Ave', 'Clinton Ave', 'Bessolo Blvd', 'Lincoln Ave', 'Hob’s Bay Rd', 'River Rd'];
const STREETS = ['1st St', '2nd St', '3rd St', 'Centennial St', '5th St', '6th St', '7th St', 'Harbor St'];

// ============================================================ renderer + post
const canvas = document.getElementById('c');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
} catch (e) { fail(); return; }
// quality presets: ?q=low|medium|high|ultra (remembered), or ?q=shot for headless screenshots
let storedQ = null; try { storedQ = localStorage.getItem('sm-quality'); } catch (_) { /* storage blocked */ }
const GPU_NAME = (() => { try { const gl = renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : ''; } catch (_) { return ''; } })();
// high-end desktop GPUs default to Ultra; everything else to High (the player can always change it)
const STRONG_GPU = /RTX\s?(20[6-9]0|30[6-9]0|40[6-9]0|50[6-9]0)|RX\s?(6[7-9]|7[7-9]|9[0-9])\d\d|Arc\s?A7|Apple M\d (Pro|Max|Ultra)/i.test(GPU_NAME);
const QUALITY = (location.search.match(/[?&]q=(low|medium|high|ultra|shot)/) || [])[1] || storedQ || (STRONG_GPU ? 'ultra' : 'high');
const LOWQ = QUALITY === 'low', SHOTQ = QUALITY === 'shot', MEDQ = QUALITY === 'medium', ULTRA = QUALITY === 'ultra';
const DPR = window.devicePixelRatio || 1;
// destruction budgets scale with the preset: live physics chunks and total debris/rubble pieces
const LIVE_CAP = { low: 250, medium: 350, high: 600, ultra: 900, shot: 450 }[QUALITY];
const DEBRIS_SLOTS = { low: 2400, medium: 3000, high: 4800, ultra: 7200, shot: 3600 }[QUALITY];
const PR = LOWQ ? 0.5 : SHOTQ || MEDQ ? 1 : ULTRA ? Math.min(DPR, 2) : Math.min(DPR, 1.5);
renderer.setPixelRatio(PR);
renderer.shadowMap.enabled = !LOWQ;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputEncoding = THREE.LinearEncoding;
renderer.toneMapping = THREE.NoToneMapping;
renderer.info.autoReset = false; // the frame loop resets it, so counts cover every pass

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 450000);
camera.rotation.order = 'YXZ';

const isGL2 = renderer.capabilities.isWebGL2;
const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
const mainRT = isGL2 && !LOWQ && !SHOTQ && !MEDQ && THREE.WebGLMultisampleRenderTarget
  ? Object.assign(new THREE.WebGLMultisampleRenderTarget(4, 4, rtOpts), { samples: ULTRA ? 8 : 4 }) : new THREE.WebGLRenderTarget(4, 4, rtOpts);
const composer = new THREE.EffectComposer(renderer, mainRT);
composer.addPass(new THREE.RenderPass(scene, camera));
const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 1.0);
composer.addPass(bloom);
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uExposure: { value: 1.0 }, uSat: { value: 1.08 }, uVig: { value: 0.55 },
    uAberr: { value: 0 }, uTime: { value: 0 }, uTint: { value: new THREE.Color(1, 1, 1) }, uTintAmt: { value: 0 },
    uLift: { value: new THREE.Color(0.012, 0.01, 0.02) }
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform float uExposure,uSat,uVig,uAberr,uTime,uTintAmt; uniform vec3 uTint,uLift; varying vec2 vUv;',
    'vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }',
    'void main(){',
    ' vec2 cc=vUv-0.5; float r2=dot(cc,cc); vec3 col;',
    ' if(uAberr>0.0){ vec2 o=cc*uAberr*(0.3+r2);',
    '   col=vec3(texture2D(tDiffuse,vUv+o).r,texture2D(tDiffuse,vUv).g,texture2D(tDiffuse,vUv-o).b);',
    ' } else col=texture2D(tDiffuse,vUv).rgb;',
    ' col=aces(col*uExposure); col=pow(col,vec3(1.0/2.2));',
    ' col=col+uLift*(1.0-col);',
    ' float l=dot(col,vec3(0.299,0.587,0.114)); col=mix(vec3(l),col,uSat);',
    ' col=mix(col,col*uTint,uTintAmt);',
    ' col*=1.0-uVig*r2*1.4;',
    ' float n=fract(sin(dot(vUv*vec2(1234.5,987.1)+uTime,vec2(12.9898,78.233)))*43758.5453);',
    ' col+=(n-0.5)*0.018;',
    ' gl_FragColor=vec4(col,1.0);',
    '}'
  ].join('\n')
};
const grade = new THREE.ShaderPass(GradeShader);
composer.addPass(grade);

// ============================================================ lights, sky, env
const SUN_DIR = new V3(-0.61, 0.31, 0.73).normalize(); // low over the bay: glare upper right, far shore backlit
const hemi = new THREE.HemisphereLight(lin(0xa9c6ff), lin(0x5e5446), 0.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(lin(0xffd2a1), 3.3);
sun.castShadow = true;
sun.shadow.mapSize.set(ULTRA ? 4096 : MEDQ ? 1024 : 2048, ULTRA ? 4096 : MEDQ ? 1024 : 2048);
{
  const sc = sun.shadow.camera;
  const SR = ULTRA ? 200 : 150; sc.left = -SR; sc.right = SR; sc.top = SR; sc.bottom = -SR; sc.near = 10; sc.far = 1500;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
}
scene.add(sun, sun.target);
scene.fog = new THREE.FogExp2(0xffffff, 0.0011);

const HOR0 = [1.0, 0.8, 0.62], HOR1 = [0.3, 0.5, 0.92];
const SKY_VS = [
  'varying vec3 vDir;', '#include <common>', '#include <logdepthbuf_pars_vertex>',
  'void main(){ vDir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
  '#include <logdepthbuf_vertex>', '}'
].join('\n');
const SKY_FS = [
  'uniform vec3 uSun; uniform float uSpace; varying vec3 vDir;', '#include <common>', '#include <logdepthbuf_pars_fragment>',
  'void main(){', '#include <logdepthbuf_fragment>',
  ' vec3 d=normalize(vDir); float y=d.y;',
  ' vec3 zen=mix(vec3(0.17,0.34,0.70),vec3(0.0,0.0,0.012),uSpace);',
  ' vec3 hor=mix(vec3(1.0,0.80,0.62),vec3(0.30,0.50,0.92),uSpace);',
  ' vec3 col=mix(hor,zen,pow(clamp(y,0.0,1.0),0.42));',
  ' if(y<0.0) col=mix(hor,mix(vec3(0.46,0.44,0.41),vec3(0.10,0.20,0.36),uSpace),clamp(-y*5.0,0.0,1.0));',
  ' col=pow(col,vec3(2.2))*1.15;',
  ' float s=max(dot(d,uSun),0.0);',
  ' col+=vec3(2.6,1.3,0.5)*pow(s,7.0)*0.45*(1.0-0.6*uSpace);',
  ' col+=vec3(40.0,32.0,22.0)*smoothstep(0.9993,0.9997,s);',
  ' gl_FragColor=vec4(col,1.0);', '#include <encodings_fragment>', '}'
].join('\n');
const skyMat = new THREE.ShaderMaterial({
  uniforms: { uSun: { value: SUN_DIR }, uSpace: { value: 0 } },
  vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(380000, 48, 24), skyMat);
sky.renderOrder = -10; sky.frustumCulled = false;
scene.add(sky);
{ // image-based lighting from the sky so glass, paint and water reflect the sunset
  const envScene = new THREE.Scene();
  const envMat = skyMat.clone();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), envMat));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(49, 32), new THREE.MeshBasicMaterial({ color: lin(0x6d6458) }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -2; envScene.add(ground);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.02, 0.1, 100).texture;
  pm.dispose();
}
// stars
const stars = (() => {
  const n = 2600, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    T1.set(R(-1, 1), R(-0.3, 1), R(-1, 1)).normalize().multiplyScalar(300000);
    p[i * 3] = T1.x; p[i * 3 + 1] = T1.y; p[i * 3 + 2] = T1.z;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const s = new THREE.Points(g, m); s.frustumCulled = false; scene.add(s); return s;
})();

// ============================================================ particles
const PVS = [
  'attribute float size; attribute vec4 color4; uniform float uScale; varying vec4 vC;',
  '#include <common>', '#include <logdepthbuf_pars_vertex>',
  'void main(){ vC=color4; vec4 mv=modelViewMatrix*vec4(position,1.0);',
  ' gl_PointSize = size>0.0 ? clamp(size*uScale/max(-mv.z,0.1),1.0,600.0) : 0.0;',
  ' gl_Position=projectionMatrix*mv;', '#include <logdepthbuf_vertex>', '}'
].join('\n');
const PFS = [
  'varying vec4 vC;', '#include <common>', '#include <logdepthbuf_pars_fragment>',
  'void main(){', '#include <logdepthbuf_fragment>',
  ' vec2 q=gl_PointCoord-0.5; float d=length(q); if(d>0.5) discard;',
  ' float a=smoothstep(0.5,0.04,d); gl_FragColor=vec4(vC.rgb,vC.a*a);', '}'
].join('\n');
const pMats = [];
class PSys {
  constructor(max, additive) {
    this.max = max; this.i = 0; this.live = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.ml = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 4); this.c1 = new Float32Array(max * 3);
    this.gr = new Float32Array(max); this.dr = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('color4', this.aCol); g.setAttribute('size', this.aSize);
    const m = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } }, vertexShader: PVS, fragmentShader: PFS,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    pMats.push(m);
    this.pts = new THREE.Points(g, m); this.pts.frustumCulled = false; this.pts.renderOrder = additive ? 3 : 2;
    scene.add(this.pts);
  }
  emit(x, y, z, vx, vy, vz, life, sA, sB, r, g, b, a, r2, g2, b2, grav, drag) {
    const i = this.i; this.i = (i + 1) % this.max;
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.ml[i] = life; this.s0[i] = sA; this.s1[i] = sB; this.size[i] = sA;
    this.c0[i4] = r; this.c0[i4 + 1] = g; this.c0[i4 + 2] = b; this.c0[i4 + 3] = a;
    this.c1[i3] = r2; this.c1[i3 + 1] = g2; this.c1[i3 + 2] = b2; this.emitted = true;
    this.col[i4] = r; this.col[i4 + 1] = g; this.col[i4 + 2] = b; this.col[i4 + 3] = 0;
    this.gr[i] = grav; this.dr[i] = drag;
  }
  update(dt) {
    if (this.live === 0 && !this.emitted) return;
    this.emitted = false;
    const { pos, vel, life, ml, s0, s1, c0, c1, col, size, gr, dr } = this;
    let live = 0;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const i3 = i * 3, i4 = i * 4;
      if (life[i] <= 0) { size[i] = 0; col[i4 + 3] = 0; continue; }
      live++;
      const t = 1 - life[i] / ml[i];
      vel[i3 + 1] -= G * gr[i] * dt;
      const k = 1 / (1 + dr[i] * dt);
      vel[i3] *= k; vel[i3 + 1] *= k; vel[i3 + 2] *= k;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      if (gr[i] > 0 && pos[i3 + 1] < 0.05 && !inBay(pos[i3 + 2])) {
        pos[i3 + 1] = 0.05; vel[i3 + 1] *= -0.3; vel[i3] *= 0.6; vel[i3 + 2] *= 0.6;
      }
      size[i] = s0[i] + (s1[i] - s0[i]) * t;
      col[i4] = c0[i4] + (c1[i3] - c0[i4]) * t;
      col[i4 + 1] = c0[i4 + 1] + (c1[i3 + 1] - c0[i4 + 1]) * t;
      col[i4 + 2] = c0[i4 + 2] + (c1[i3 + 2] - c0[i4 + 2]) * t;
      col[i4 + 3] = c0[i4 + 3] * (1 - t) * Math.min(1, t * 10 + 0.2);
    }
    this.live = live;
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true;
  }
}
const ADD = new PSys(9000, true);
const SMK = new PSys(8000, false);
const FX = {
  fire(x, y, z, s) { s = s || 1; ADD.emit(x + R(-0.6, 0.6) * s, y, z + R(-0.6, 0.6) * s, R(-1, 1), R(2.5, 6) * s, R(-1, 1), R(0.5, 1.1), 1.7 * s, 0.4 * s, 5, 2.2, 0.55, 0.9, 2.2, 0.35, 0.05, -0.25, 0.6); },
  smoke(x, y, z, s, d) { s = s || 1; d = d === undefined ? 0.07 : d; SMK.emit(x, y, z, R(-1, 1), R(2, 4.5), R(-1, 1), R(2.5, 5.5), 2 * s, 9 * s, d, d, d * 0.95, 0.55, d * 1.6, d * 1.6, d * 1.6, -0.03, 0.25); },
  dust(x, y, z, vx, vy, vz, s) { s = s || 1; SMK.emit(x, y, z, vx, vy, vz, R(2, 4.5), 2.2 * s, 9 * s, 0.42, 0.37, 0.31, 0.6, 0.5, 0.46, 0.4, 0.02, 1.4); },
  spark(x, y, z, vx, vy, vz) { ADD.emit(x, y, z, vx, vy, vz, R(0.3, 0.8), 0.3, 0.08, 6, 4, 1.6, 1, 3, 0.8, 0.15, 1, 0.4); },
  glass(x, y, z, vx, vy, vz) { SMK.emit(x, y, z, vx, vy, vz, R(1.2, 2.6), 0.32, 0.22, 0.75, 0.9, 1.1, 0.9, 0.5, 0.65, 0.85, 1, 0.2); },
  ice(x, y, z, vx, vy, vz) { SMK.emit(x, y, z, vx, vy, vz, R(0.5, 0.95), 0.3, 1.9, 0.75, 0.95, 1.2, 0.65, 0.9, 1.0, 1.15, 0.0, 1.8); },
  steam(x, y, z) { SMK.emit(x, y, z, R(-1, 1), R(2, 4), R(-1, 1), R(1.5, 3), 1, 5, 0.9, 0.9, 0.92, 0.45, 1, 1, 1, -0.02, 0.5); },
  molten(x, y, z, vx, vy, vz) { ADD.emit(x, y, z, vx, vy, vz, R(0.8, 1.6), 0.45, 0.15, 6, 2, 0.3, 1, 2, 0.3, 0, 1, 0.2); },
  water(x, y, z, vx, vy, vz) { SMK.emit(x, y, z, vx, vy, vz, R(0.8, 1.6), 0.6, 1.8, 0.7, 0.85, 0.95, 0.75, 0.85, 0.92, 1, 1, 0.3); },
  vapor(x, y, z, vx, vy, vz) { SMK.emit(x, y, z, vx, vy, vz, 0.25, 1.4, 2.8, 1.1, 1.1, 1.15, 0.5, 1, 1, 1, 0, 2); },
  plasma(x, y, z, vx, vy, vz) { ADD.emit(x, y, z, vx, vy, vz, R(0.15, 0.35), 1.8, 0.4, 6, 2.4, 0.8, 0.9, 4, 0.5, 0.1, 0, 1); },
  beam(x, y, z) { ADD.emit(x, y, z, R(-4, 4), R(1, 6), R(-4, 4), R(0.2, 0.5), 0.9, 0.2, 8, 2.5, 0.6, 1, 4, 0.6, 0.1, 0.3, 0.5); },
  flash(x, y, z) { ADD.emit(x, y, z, 0, 0, 0, 0.12, 0.9, 0.5, 12, 12, 12, 1, 6, 6, 6, 0, 0); },
  sparkle(x, y, z) { ADD.emit(x, y, z, R(-1, 1), R(1, 3), R(-1, 1), R(0.6, 1.2), 0.4, 0.1, 4, 3.2, 1.2, 1, 2, 1.5, 0.4, -0.05, 0.5); },
  kryp(x, y, z) { ADD.emit(x + R(-2, 2), y + R(-2, 2), z + R(-2, 2), R(-2, 2), R(-2, 2), R(-2, 2), R(0.4, 0.9), 1.8, 0.4, 0.6, 5, 1, 0.9, 0.2, 2, 0.4, 0, 0.6); }
};

// ============================================================ audio
const AU = { ctx: null, master: null, muted: false, last: {} };
function initAudio() {
  if (AU.ctx) { if (AU.ctx.state === 'suspended') AU.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  const c = new AC(); AU.ctx = c;
  const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
  AU.master = c.createGain(); AU.master.gain.value = 0.75;
  AU.master.connect(comp); comp.connect(c.destination);
  const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  AU.noise = buf;
  const loop = (filterType, freq, q) => {
    const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
    const f = c.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(AU.master); s.start();
    return { f, g };
  };
  AU.wind = loop('bandpass', 400, 0.7);
  AU.freeze = loop('highpass', 2600, 0.5);
  AU.fireL = loop('lowpass', 500, 0.6);
  const hg = c.createGain(); hg.gain.value = 0;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
  const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 92;
  const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 184.6;
  const o2g = c.createGain(); o2g.gain.value = 0.35;
  o1.connect(lp); o2.connect(o2g); o2g.connect(lp); lp.connect(hg); hg.connect(AU.master); o1.start(); o2.start();
  AU.heat = { g: hg, o1, o2 };
}
function sfxOK(name, gap) {
  if (!AU.ctx || AU.muted) return false;
  const t = AU.ctx.currentTime; if (AU.last[name] && t - AU.last[name] < gap) return false; AU.last[name] = t; return true;
}
function distVol(p) { return p ? 1 / (1 + camera.position.distanceTo(p) / 70) : 1; }
function sfxNoise(vol, dur, type, freq, freqEnd, q) {
  const c = AU.ctx, t = c.currentTime;
  const s = c.createBufferSource(); s.buffer = AU.noise;
  const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q || 0.7;
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(AU.master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function sfxTone(vol, dur, type, f0, f1) {
  const c = AU.ctx, t = c.currentTime;
  const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(AU.master); o.start(t); o.stop(t + dur + 0.05);
}
const SFX = {
  punch(p, k) { if (!sfxOK('punch', 0.05)) return; const v = distVol(p) * (k || 1); sfxTone(0.9 * v, 0.35, 'sine', 120, 38); sfxNoise(0.6 * v, 0.25, 'lowpass', 2200, 200); },
  boom(p, k) { if (!sfxOK('boom', 0.08)) return; const v = distVol(p) * (k || 1); sfxNoise(1.3 * v, 2.6, 'lowpass', 900, 40); sfxTone(1.0 * v, 1.2, 'sine', 70, 25); },
  sonic() { if (!sfxOK('sonic', 0.5)) return; sfxNoise(1.6, 0.05, 'highpass', 300); setTimeout(() => { if (AU.ctx) sfxNoise(1.4, 1.8, 'lowpass', 700, 30); }, 70); sfxTone(1.1, 1.4, 'sine', 55, 22); },
  crumble(p, k) { if (!sfxOK('crumble', 0.12)) return; const v = distVol(p) * (k || 1); sfxNoise(0.8 * v, 1.6, 'lowpass', 520, 90); },
  glass(p) { if (!sfxOK('glass', 0.08)) return; const v = distVol(p); sfxNoise(0.5 * v, 0.6, 'highpass', 3500, 6000, 2); sfxTone(0.12 * v, 0.4, 'triangle', 3100, 2400); },
  ping(p) { if (!sfxOK('ping', 0.03)) return; const v = distVol(p); sfxTone(0.25 * v, 0.18, 'triangle', R(2200, 3200), 900); },
  shot(p) { if (!sfxOK('shot', 0.04)) return; const v = distVol(p); sfxNoise(0.7 * v, 0.12, 'bandpass', 1400, 400, 0.8); },
  clap() { if (!sfxOK('clap', 0.2)) return; sfxNoise(1.5, 0.08, 'highpass', 600); sfxNoise(1.1, 1.3, 'lowpass', 1200, 60); },
  whoosh() { if (!sfxOK('whoosh', 0.1)) return; sfxNoise(0.6, 0.45, 'bandpass', 400, 2400, 1.2); },
  splash(p) { if (!sfxOK('splash', 0.1)) return; const v = distVol(p); sfxNoise(0.8 * v, 0.9, 'lowpass', 2400, 300); },
  alert() { if (!sfxOK('alert', 0.5)) return; sfxTone(0.22, 0.16, 'square', 880); setTimeout(() => AU.ctx && sfxTone(0.22, 0.22, 'square', 660), 190); },
  good() { if (!sfxOK('good', 0.3)) return; sfxTone(0.2, 0.25, 'triangle', 660); setTimeout(() => AU.ctx && sfxTone(0.2, 0.4, 'triangle', 990), 140); },
  cheer(p) { if (!sfxOK('cheer', 1)) return; const v = distVol(p); for (let i = 0; i < 6; i++) setTimeout(() => AU.ctx && sfxNoise(0.25 * v, 0.6, 'bandpass', R(900, 1800), null, 3), i * 60); },
  freezeHit() { if (!sfxOK('frz', 0.15)) return; sfxTone(0.15, 0.3, 'triangle', 2600, 1200); },
  heartbeat() { if (!sfxOK('hb', 0.9)) return; sfxTone(0.35, 0.12, 'sine', 60, 40); setTimeout(() => AU.ctx && sfxTone(0.28, 0.12, 'sine', 55, 38), 180); }
};

// ============================================================ shared textures
function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, srgb) {
  const t = new THREE.CanvasTexture(c); t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (srgb) t.encoding = THREE.sRGBEncoding; return t;
}
function concreteTexture(base) {
  const [c, x] = cnv(128, 128);
  x.fillStyle = base; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${R(0.02, 0.07)})`; x.fillRect(rnd() * 128, rnd() * 128, R(1, 4), R(1, 4)); }
  x.strokeStyle = 'rgba(0,0,0,.18)'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, 125, 125);
  return tex(c, true);
}

// ============================================================ city layout
const rs = srand(1938);
const lotInfo = [], buildings = [];
let NBLK = 0;
// facade styles: 0 brick walk-up, 1 limestone, 2 glass curtain wall, 3 modern ribbon windows
const STYLE_COLORS = [
  ['#8a4636', '#9a5440', '#7c3c30', '#a0624a', '#6e3a2e'],
  ['#d3c4a8', '#c9b796', '#ddd1b9', '#bfae90', '#cbbfa9'],
  ['#5d6b78', '#6c7884', '#4f5c68', '#7a858f'],
  ['#b9b8b2', '#d6d2c8', '#a3a6a8', '#c7c2b6']
];
for (let j = 0; j < LOTS; j++) for (let i = 0; i < LOTS; i++) {
  const lx = -HALF + i * PITCH + 10, lz = -HALF + j * PITCH + 10;
  let type = 'bld';
  if (i === 0 && j === LOTS - 1) type = 'hospital';
  else if (!(i === 3 && j === 3) && rs() < 0.15) type = 'park';
  const info = { i, j, lx, lz, type, b: null, name: STREETS[i] + ' & ' + AVES[j] };
  lotInfo.push(info);
  if (type !== 'bld') continue;
  const center = i === 3 && j === 3;
  const nx = center ? 7 : 4 + Math.floor(rs() * 3), nz = center ? 7 : 4 + Math.floor(rs() * 3);
  const d = Math.hypot(i - 3, j - 3);
  let ny = Math.floor(5 + rs() * 7 + Math.max(0, 3.4 - d) * rs() * 9);
  if (center) ny = 46;
  ny = Math.min(ny, 46);
  const style = ny < 10 ? (rs() < 0.7 ? 0 : 1) : ny < 22 ? Math.floor(rs() * 4) : 1 + Math.floor(rs() * 3);
  const b = {
    id: buildings.length, lot: info, name: info.name, nx, ny, nz, start: NBLK, style,
    x0: lx + (40 - nx * CELL) / 2, z0: lz + (40 - nz * CELL) / 2,
    color: new THREE.Color(pick(STYLE_COLORS[style])).convertSRGBToLinear()
  };
  // wedding-cake setbacks on tall towers
  b.tiers = [{ y: 0, ins: 0 }];
  const w = Math.min(nx, nz);
  if (ny >= 16 && w >= 5) b.tiers.push({ y: Math.floor(ny * (0.5 + rs() * 0.15)), ins: 1 });
  if (ny >= 30 && w >= 7) b.tiers.push({ y: Math.floor(ny * (0.78 + rs() * 0.08)), ins: 2 });
  b.x1 = b.x0 + nx * CELL; b.z1 = b.z0 + nz * CELL; b.h = ny * STORY;
  NBLK += nx * ny * nz;
  buildings.push(b); info.b = b;
}
const MAXH = Math.max(...buildings.map(b => b.h));
const insetAt = (b, y) => { let ins = 0; for (const t of b.tiers) if (y >= t.y) ins = t.ins; return ins; };

// block storage (structure of arrays)
const blkB = new Uint16Array(NBLK), blkX = new Uint8Array(NBLK), blkY = new Uint8Array(NBLK), blkZ = new Uint8Array(NBLK);
const blkT = new Uint8Array(NBLK), alive = new Uint8Array(NBLK), pendingFall = new Uint8Array(NBLK);
const heat = new Float32Array(NBLK), frost = new Float32Array(NBLK), fireI = new Float32Array(NBLK), burn = new Float32Array(NBLK);
const bearing = new Uint8Array(NBLK);          // load-bearing columns
const blkStyle = new Uint8Array(NBLK);         // facade style + flags (4 solid, 8 storefront, 16 cornice)
const dropY = new Float32Array(NBLK), dropV = new Float32Array(NBLK); // kinematic drop while waiting for a physics slot
const blkColor = new Float32Array(NBLK * 3);

function makeBlockMat(map) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0.02 });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeat; attribute float aFrost;\nvarying float vHeat; varying float vFrost;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat=aHeat; vFrost=aFrost;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHeat; varying float vFrost;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + HEAT_GLSL);
  };
  return m;
}
const HEAT_GLSL = [
  'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62,0.86,1.0), clamp(vFrost,0.0,1.0)*0.8);',
  'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03,0.025,0.02), clamp(vHeat*0.55,0.0,0.55));',
  'totalEmissiveRadiance += vec3(4.5,1.3,0.22) * pow(clamp(vHeat,0.0,1.4),1.7) * 2.0;',
  'totalEmissiveRadiance += vec3(0.15,0.35,0.5) * clamp(vFrost,0.0,1.0) * 0.4;'
].join('\n');
// procedural facades: window grids sized to real 5 m x 4 m floors, so every style reads at street level
const FACADE_GLSL = `
float st = vStyle;
float fTop = step(15.5, st); st -= 16.0 * fTop;
float fStore = step(7.5, st); st -= 8.0 * fStore;
float fSolid = step(3.5, st); st -= 4.0 * fSolid;
vec2 fu = vUv;
float isRoof = 0.0;
#ifdef WORLD_UV
  vec3 an = abs(vWN);
  float hz = an.x > an.z ? vWP.z : vWP.x;
  fu = vec2(fract(hz / 5.0), fract(vWP.y / 4.0));
  isRoof = step(0.7, an.y);
  fStore = vWP.y < 4.0 ? 1.0 : 0.0;
  float seedW = fract(sin(dot(floor(vec2(hz / 5.0, vWP.y / 4.0)), vec2(12.98, 78.23))) * 43758.5);
#else
  float seedW = vSeed;
#endif
vec3 base = diffuseColor.rgb;
float gl = 0.0, fr = 0.0, nwin = 2.0, signGlow = 0.0;
vec3 sc = vec3(0.0);
if (st < 0.5) {
  nwin = 2.0; vec2 c = vec2(fract(fu.x * 2.0), fu.y);
  gl = step(0.25, c.x) * step(c.x, 0.75) * step(0.24, c.y) * step(c.y, 0.84);
  float lintel = step(0.84, c.y) * step(c.y, 0.91) * step(0.21, c.x) * step(c.x, 0.79);
  float sill = step(0.18, c.y) * step(c.y, 0.24) * step(0.21, c.x) * step(c.x, 0.79);
  float row = floor(fu.y * 16.0);
  float bx = fu.x * 9.0 + mod(row, 2.0) * 0.5;
  float mortar = max(step(0.86, fract(fu.y * 16.0)), step(0.93, fract(bx)));
  base *= (0.9 + 0.2 * fract(sin(dot(vec2(floor(bx), row) + seedW * 17.0, vec2(12.9, 78.2))) * 43758.5)) * (1.0 - 0.25 * mortar);
  base = mix(base, vec3(0.55, 0.51, 0.45), max(lintel, sill));
  fr = gl * step(abs(c.y - 0.6), 0.018);
  // fire-escape grille drawn across the windows of walk-ups
  fr += gl * step(0.5, fract(seedW * 5.0)) * step(fract(fu.x * 2.0), 0.5) * step(0.86, fract(c.x * 12.0)) * 0.9;
} else if (st < 1.5) {
  nwin = 3.0; vec2 c = vec2(fract(fu.x * 3.0), fu.y);
  gl = step(0.22, c.x) * step(c.x, 0.78) * step(0.2, c.y) * step(c.y, 0.8);
  base *= 1.0 - 0.14 * step(0.93, fu.y) + 0.05 * step(fu.y, 0.06);
  base *= 0.95 + 0.05 * step(0.5, fract(fu.y * 4.0));
  fr = gl * (step(abs(c.x - 0.5), 0.03) + step(abs(c.y - 0.62), 0.02));
} else if (st < 2.5) {
  nwin = 4.0; gl = step(0.07, fu.y) * step(fu.y, 0.95);
  fr = step(0.955, fract(fu.x * 4.0)) + step(fract(fu.x * 4.0), 0.045);
} else {
  nwin = 5.0; gl = step(0.34, fu.y) * step(fu.y, 0.82);
  fr = gl * step(0.965, fract(fu.x * 5.0));
  base *= 0.96 + 0.04 * step(0.5, fract(fu.y * 8.0));
}
if (fSolid > 0.5) { gl = 0.0; fr = 0.0; base *= 0.93; }
if (fStore > 0.5 && fSolid < 0.5) {
  // street-level shopfront: display glass, a sign band and a warm lit interior
  gl = step(0.05, fu.x) * step(fu.x, 0.95) * step(0.04, fu.y) * step(fu.y, 0.66);
  fr = gl * step(abs(fract(fu.x * 2.0) - 0.5), 0.012);
  float sgn = step(0.71, fu.y) * step(fu.y, 0.9) * step(0.05, fu.x) * step(fu.x, 0.95);
  sc = 0.5 + 0.5 * cos(6.2831 * (seedW + vec3(0.0, 0.33, 0.67)));
  base = mix(base, sc * 0.55, sgn);
  signGlow = sgn * step(0.45, fract(seedW * 7.0));
}
if (fTop > 0.5) { float cor = step(0.84, fu.y); base = mix(base, base * 1.12 + 0.03, cor); gl *= 1.0 - cor; }
if (isRoof > 0.5) { gl = 0.0; fr = 0.0; base = vec3(0.32, 0.31, 0.3) * (0.85 + 0.3 * seedW); }
gl = clamp(gl, 0.0, 1.0) * (1.0 - clamp(fr, 0.0, 1.0));
float wi = floor(fu.x * nwin);
float litW = step(0.55, fract(sin(seedW * 91.7 + wi * 13.1) * 43758.5)) * vLit;
vec3 glassCol = mix(vec3(0.05, 0.065, 0.09), vec3(0.14, 0.18, 0.24), fu.y);
diffuseColor.rgb = mix(base, glassCol, gl);
float fGlass = gl;
float fLit = gl * litW + fStore * gl * 0.55;
`;
const WHITE_TEX = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
WHITE_TEX.needsUpdate = true;
function makeFacadeMat(worldUV) {
  const m = new THREE.MeshStandardMaterial({ map: WHITE_TEX, roughness: 0.82, metalness: 0.0, emissive: new THREE.Color(0, 0, 0) });
  if (worldUV) m.defines = { WORLD_UV: '' };
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeat; attribute float aFrost; attribute float aLit; attribute float aStyle; attribute float aSeed;\nvarying float vHeat; varying float vFrost; varying float vLit; varying float vStyle; varying float vSeed; varying vec3 vWP; varying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat=aHeat; vFrost=aFrost; vLit=aLit; vStyle=aStyle; vSeed=aSeed;')
      .replace('#include <worldpos_vertex>', [
        '#include <worldpos_vertex>',
        '{ vec4 wq = vec4(transformed, 1.0); vec3 nq = objectNormal;',
        '#ifdef USE_INSTANCING',
        '  wq = instanceMatrix * wq; nq = mat3(instanceMatrix) * nq;',
        '#endif',
        '  wq = modelMatrix * wq; vWP = wq.xyz; vWN = normalize(mat3(modelMatrix) * nq); }'
      ].join('\n'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHeat; varying float vFrost; varying float vLit; varying float vStyle; varying float vSeed; varying vec3 vWP; varying vec3 vWN;\n' + ((window.SM_FACADE_EXT && window.SM_FACADE_EXT.pars) || ''))
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FACADE_GLSL + '\n' + ((window.SM_FACADE_EXT && window.SM_FACADE_EXT.fragment) || ''))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.04, fGlass);\n' + ((window.SM_FACADE_EXT && window.SM_FACADE_EXT.roughness) || ''))
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(metalness, 0.8, fGlass);')
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        'totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * fLit * 0.6 + sc * signGlow * 1.6;',
        (window.SM_FACADE_EXT && window.SM_FACADE_EXT.emissive) || '',
        HEAT_GLSL
      ].join('\n'));
  };
  return m;
}
const facadeMat = makeFacadeMat(false);
const colMat = facadeMat;
const wallMat = facadeMat;
const slabMat = makeBlockMat(concreteTexture('#c8c2b7'));
const roofMat = makeBlockMat(concreteTexture('#8f8b84'));

// one InstancedMesh per block type so each can use its own look
function blockMesh(geo, mats, count) {
  const g = geo.clone();
  const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  const aH = mk(), aF = mk(), aL = mk(), aS = mk(), aD = mk();
  g.setAttribute('aHeat', aH); g.setAttribute('aFrost', aF); g.setAttribute('aLit', aL); g.setAttribute('aStyle', aS); g.setAttribute('aSeed', aD);
  for (let i = 0; i < count; i++) aD.setX(i, rnd());
  const m = new THREE.InstancedMesh(g, mats, count);
  m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
  m.userData = { aH, aF, aL, aS, aD };
  return m;
}
const boxGeo = new THREE.BoxGeometry(CELL, STORY, CELL);
const slabGeo = new THREE.BoxGeometry(CELL, SLAB_H, CELL);
slabGeo.translate(0, -STORY / 2 + SLAB_H / 2, 0);
// counts per type
let nCol = 0, nGlass = 0, nSlab = 0;
const blkSub = new Int32Array(NBLK).fill(-1); // index within its type mesh
function coreMask(b, m, ins) {
  // corners plus interior columns inside one tier's footprint; add columns until every cell is within SPAN of one
  const x0 = ins, x1 = b.nx - 1 - ins, z0 = ins, z1 = b.nz - 1 - ins;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const ex = x === x0 || x === x1, ez = z === z0 || z === z1;
    if ((ex && ez) || (!ex && !ez && (x - x0) % 3 === 1 && (z - z0) % 3 === 1)) m[z * b.nx + x] = 1;
  }
  for (let guard = 0; guard < 50; guard++) {
    const d = new Int16Array(b.nx * b.nz).fill(99), q = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const i = z * b.nx + x; if (m[i]) { d[i] = 0; q.push(i); } }
    for (let k = 0; k < q.length; k++) {
      const i = q[k], x = i % b.nx, z = (i / b.nx) | 0;
      for (const [cx, cz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (cx < x0 || cz < z0 || cx > x1 || cz > z1) continue; const j = cz * b.nx + cx;
        if (d[j] > d[i] + 1) { d[j] = d[i] + 1; q.push(j); }
      }
    }
    let worst = -1, wi = -1;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const i = z * b.nx + x; if (d[i] > worst) { worst = d[i]; wi = i; } }
    if (worst <= 2) return;
    const x = wi % b.nx, z = (wi / b.nx) | 0;
    m[clamp(z, z0 + 1, Math.max(z0 + 1, z1 - 1)) * b.nx + clamp(x, x0 + 1, Math.max(x0 + 1, x1 - 1))] = 1;
  }
}
const inFoot = (b, x, y, z) => { const i = insetAt(b, y); return x >= i && z >= i && x <= b.nx - 1 - i && z <= b.nz - 1 - i; };
for (const b of buildings) {
  b.core = new Uint8Array(b.nx * b.nz);
  for (const t of b.tiers) coreMask(b, b.core, t.ins);
  for (let y = 0; y < b.ny; y++) for (let z = 0; z < b.nz; z++) for (let x = 0; x < b.nx; x++) {
    const g = b.start + (y * b.nz + z) * b.nx + x;
    blkB[g] = b.id; blkX[g] = x; blkY[g] = y; blkZ[g] = z;
    if (!inFoot(b, x, y, z)) { alive[g] = 0; continue; }
    alive[g] = 1;
    const ins = insetAt(b, y);
    const edgeX = x === ins || x === b.nx - 1 - ins, edgeZ = z === ins || z === b.nz - 1 - ins;
    const corner = edgeX && edgeZ, core = b.core[z * b.nx + x] === 1;
    const roofHere = y === b.ny - 1 || !inFoot(b, x, y + 1, z);
    let t;
    if (corner || core) t = T_COL;                    // corner and core columns carry the load
    else if (edgeX || edgeZ) t = T_GLASS;             // facade
    else if (roofHere) t = T_COL;                     // roof deck (looks solid, carries nothing)
    else t = T_SLAB;                                  // floor plates
    blkT[g] = t; bearing[g] = corner || core ? 1 : 0;
    let sty = b.style;
    if (t === T_COL) sty += 4;
    if (y === 0) sty += 8;
    if (roofHere && (edgeX || edgeZ)) sty += 16;
    blkStyle[g] = sty;
    if (t === T_COL) blkSub[g] = nCol++; else if (t === T_GLASS) blkSub[g] = nGlass++; else blkSub[g] = nSlab++;
  }
}
const meshCol = blockMesh(boxGeo, [colMat, colMat, roofMat, roofMat, colMat, colMat], nCol);
const meshGlass = blockMesh(boxGeo, [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat], nGlass);
const meshSlab = blockMesh(slabGeo, slabMat, nSlab);
const typeMesh = [meshCol, meshGlass, meshSlab];
const typeDirty = [false, false, false], attrDirty = [false, false, false];
scene.add(meshCol, meshGlass, meshSlab);
for (let g = 0; g < NBLK; g++) {
  if (blkSub[g] < 0) continue;
  const b = buildings[blkB[g]], t = blkT[g], m = typeMesh[t], s = blkSub[g];
  TM.makeTranslation(b.x0 + (blkX[g] + 0.5) * CELL, (blkY[g] + 0.5) * STORY, b.z0 + (blkZ[g] + 0.5) * CELL);
  m.setMatrixAt(s, TM);
  const v = R(0.93, 1.04);
  const col = T1.set(b.color.r * v, b.color.g * v, b.color.b * v);
  if (t === T_SLAB) col.set(0.5, 0.48, 0.45);
  blkColor[g * 3] = col.x; blkColor[g * 3 + 1] = col.y; blkColor[g * 3 + 2] = col.z;
  m.setColorAt(s, new THREE.Color(col.x, col.y, col.z));
  m.userData.aS.setX(s, blkStyle[g]);
  m.userData.aD.setX(s, rs());
  if (t === T_GLASS) m.userData.aL.setX(s, rs() < 0.3 ? R(0.4, 1) : 0);
}
for (const m of typeMesh) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

function buildingAt(x, z) {
  const i = Math.floor((x + HALF) / PITCH), j = Math.floor((z + HALF) / PITCH);
  if (i < 0 || j < 0 || i >= LOTS || j >= LOTS) return null;
  return lotInfo[j * LOTS + i].b;
}
const cellIndex = (b, x, y, z) => b.start + (y * b.nz + z) * b.nx + x;
function blockCenter(g, o) { const b = buildings[blkB[g]]; return o.set(b.x0 + (blkX[g] + 0.5) * CELL, (blkY[g] + 0.5) * STORY, b.z0 + (blkZ[g] + 0.5) * CELL); }
// solid vertical extent of a block (slabs are thin plates at the bottom of the cell)
function blockY0(g) { return blkY[g] * STORY; }
function blockY1(g) { return blkY[g] * STORY + (blkT[g] === T_SLAB ? SLAB_H : STORY); }
function blockAt(x, y, z) {
  const b = buildingAt(x, z); if (!b || y < 0 || y >= b.h) return -1;
  const cx = Math.floor((x - b.x0) / CELL), cz = Math.floor((z - b.z0) / CELL);
  if (cx < 0 || cz < 0 || cx >= b.nx || cz >= b.nz) return -1;
  const g = cellIndex(b, cx, Math.floor(y / STORY), cz);
  if (!alive[g]) return -1;
  if (blkT[g] === T_SLAB && y > blockY1(g)) return -1;
  return g;
}
// ============================================================ attachments (awnings, fire escapes, cornices, rooftop tanks)
// Each piece is pinned to one block; when that block breaks or starts to fall, the piece goes with it.
const attByBlock = new Map();
const ATT = (() => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const kinds = {
    awning: { geo: box, mat: new THREE.MeshStandardMaterial({ roughness: 0.85 }) },
    iron: { geo: box, mat: new THREE.MeshStandardMaterial({ color: lin(0x1b1d20), roughness: 0.55, metalness: 0.6 }) },
    cornice: { geo: box, mat: new THREE.MeshStandardMaterial({ roughness: 0.8 }) },
    tank: { geo: new THREE.CylinderGeometry(1.4, 1.4, 2.6, 16), mat: new THREE.MeshStandardMaterial({ color: lin(0x5f4330), roughness: 0.92 }) },
    tankRoof: { geo: new THREE.ConeGeometry(1.55, 0.9, 16), mat: new THREE.MeshStandardMaterial({ color: lin(0x3e3a36), roughness: 0.7, metalness: 0.3 }) },
    roofBox: { geo: box, mat: new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.2 }) }
  };
  for (const k in kinds) kinds[k].list = [];
  return kinds;
})();
const AWNING_COLORS = [0x7a1f1f, 0x1f4a2e, 0x1d2b4f, 0x5a2333, 0x2f2f33, 0x8a5a1c];
function facadeNormals(g) {
  const b = buildings[blkB[g]], ins = insetAt(b, blkY[g]), x = blkX[g], z = blkZ[g], out = [];
  if (x === ins) out.push([-1, 0]); if (x === b.nx - 1 - ins) out.push([1, 0]);
  if (z === ins) out.push([0, -1]); if (z === b.nz - 1 - ins) out.push([0, 1]);
  return out;
}
const _aq = new Q4(), _aq2 = new Q4(), _ap = new V3(), _as = new V3(), _ax = new V3(1, 0, 0);
function attach(kind, g, cx, cy, cz, sx, sy, sz, yaw, tilt, color) {
  _aq.setFromAxisAngle(UP, yaw); if (tilt) _aq.multiply(_aq2.setFromAxisAngle(_ax, tilt));
  const m = new THREE.Matrix4().compose(_ap.set(cx, cy, cz), _aq, _as.set(sx, sy, sz));
  const e = { g, m, color };
  ATT[kind].list.push(e);
}
// a face-local placement: along = offset along the facade, out = distance in front of the wall
function onFace(g, n, along, up, out, o) {
  blockCenter(g, o);
  o.x += n[0] * (2.5 + out) + (n[1] !== 0 ? along : 0);
  o.z += n[1] * (2.5 + out) + (n[0] !== 0 ? along : 0);
  o.y = blockY0(g) + up;
  return o;
}
{
  const rq = srand(4242), P0 = new V3();
  for (const b of buildings) {
    const base = b.color;
    const corniceCol = new THREE.Color(base.r * 1.12 + 0.02, base.g * 1.1 + 0.02, base.b * 1.08 + 0.02);
    // fire escapes climb one bay of each street-facing side of a brick walk-up
    const fe = b.style === 0 ? [[Math.floor(b.nx / 2), 0], [Math.floor(b.nx / 2), b.nz - 1]] : [];
    for (let y = 0; y < b.ny; y++) for (let z = 0; z < b.nz; z++) for (let x = 0; x < b.nx; x++) {
      const g = cellIndex(b, x, y, z); if (!alive[g]) continue;
      const ns = facadeNormals(g); if (!ns.length) continue;
      const st = blkStyle[g], top = st >= 16, solid = blkT[g] === T_COL;
      for (const n of ns) {
        const yaw = Math.atan2(n[0], n[1]);
        // storefront awnings
        if (y === 0 && !solid && rq() < 0.55) {
          onFace(g, n, 0, 3.0, 0.75, P0);
          attach('awning', g, P0.x, P0.y, P0.z, 4.3, 0.1, 1.5, yaw, 0.32, lin(pick(AWNING_COLORS)));
        }
        // belt course over the shops on masonry buildings
        if (y === 0 && b.style <= 1) { onFace(g, n, 0, 3.85, 0.15, P0); attach('cornice', g, P0.x, P0.y, P0.z, 5.02, 0.3, 0.3, yaw, 0, corniceCol); }
        // cornice (masonry) or metal coping (glass and modern) at the top of every tier
        if (top) {
          if (b.style <= 1) { onFace(g, n, 0, STORY - 0.3, 0.35, P0); attach('cornice', g, P0.x, P0.y, P0.z, 5.4, 0.6, 0.7, yaw, 0, corniceCol); }
          else { onFace(g, n, 0, STORY - 0.12, 0.1, P0); attach('iron', g, P0.x, P0.y, P0.z, 5.05, 0.24, 0.2, yaw, 0, null); }
        }
        // fire escape landings, railings and ladders
        if (b.style === 0 && y >= 1 && y < b.ny - 1 && fe.some(([fx, fz]) => fx === x && fz === z) && n[0] === 0) {
          onFace(g, n, 0, 0.05, 0.6, P0); attach('iron', g, P0.x, P0.y, P0.z, 3.8, 0.07, 1.2, yaw, 0, null);
          onFace(g, n, 0, 0.98, 1.18, P0); attach('iron', g, P0.x, P0.y, P0.z, 3.8, 0.05, 0.05, yaw, 0, null);
          onFace(g, n, 0, 0.5, 1.18, P0); attach('iron', g, P0.x, P0.y, P0.z, 3.8, 0.04, 0.04, yaw, 0, null);
          for (const s of [-1.88, 1.88]) { onFace(g, n, s, 0.5, 1.18, P0); attach('iron', g, P0.x, P0.y, P0.z, 0.05, 0.95, 0.05, yaw, 0, null); }
          onFace(g, n, 0.6, 2.05, 0.55, P0); attach('iron', g, P0.x, P0.y, P0.z, 0.45, 0.05, 4.4, yaw + Math.PI / 2, -0.95, null);
        }
      }
    }
    // rooftops: wooden water tanks on masonry walk-ups, mechanical bulkheads on towers
    const cx = Math.floor(b.nx / 2), cz = Math.floor(b.nz / 2), gTop = cellIndex(b, cx, b.ny - 1, cz);
    if (!alive[gTop]) continue;
    const roofY = b.h, c = blockCenter(gTop, new V3());
    if (b.style <= 1 && b.ny <= 18 && rq() < 0.75) {
      const ox = c.x + (rq() - 0.5) * 3, oz = c.z + (rq() - 0.5) * 3;
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) attach('iron', gTop, ox + lx * 1.0, roofY + 0.9, oz + lz * 1.0, 0.16, 1.8, 0.16, 0, 0, null);
      attach('iron', gTop, ox, roofY + 1.82, oz, 2.6, 0.1, 2.6, 0, 0, null);
      attach('tank', gTop, ox, roofY + 1.87 + 1.3, oz, 1, 1, 1, 0, 0, null);
      attach('tankRoof', gTop, ox, roofY + 1.87 + 2.6 + 0.45, oz, 1, 1, 1, 0, 0, null);
    } else {
      attach('roofBox', gTop, c.x, roofY + 1.4, c.z, 4.2, 2.8, 4.2, 0, 0, lin(0x8c8a86));
      for (let k = 0; k < 3; k++) attach('roofBox', gTop, c.x + (rq() - 0.5) * 3.5, roofY + 0.5, c.z + (rq() - 0.5) * 3.5, 1.4, 1, 1.1, rq() * 3, 0, lin(0xb4b6b8));
    }
  }
  for (const k in ATT) {
    const A = ATT[k], n = A.list.length; if (!n) continue;
    const m = new THREE.InstancedMesh(A.geo, A.mat, n);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    A.list.forEach((e, i) => {
      m.setMatrixAt(i, e.m);
      if (e.color) m.setColorAt(i, e.color);
      let arr = attByBlock.get(e.g); if (!arr) attByBlock.set(e.g, arr = []); arr.push([m, i, k]);
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    scene.add(m); A.mesh = m;
  }
}
{
  // the Daily Planet globe crowns the central tower
  const b = buildings.find(bb => bb.lot.i === 3 && bb.lot.j === 3);
  if (b) {
    const g = cellIndex(b, Math.floor(b.nx / 2), b.ny - 1, Math.floor(b.nz / 2));
    if (alive[g]) {
      const c = blockCenter(g, new V3()), y = b.h + 9;
      const globe = new THREE.Mesh(new THREE.SphereGeometry(7, 40, 24), new THREE.MeshStandardMaterial({ color: lin(0x3d6fb8), roughness: 0.35, metalness: 0.6 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(8.6, 0.45, 10, 64), new THREE.MeshStandardMaterial({ color: lin(0xd8a531), roughness: 0.3, metalness: 0.9 }));
      const lat = new THREE.Mesh(new THREE.TorusGeometry(7.05, 0.18, 6, 48), ring.material);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, 4, 12), ring.material);
      globe.position.set(c.x, y, c.z); ring.position.copy(globe.position); ring.rotation.set(Math.PI / 2 - 0.4, 0, 0.3);
      lat.position.copy(globe.position); lat.rotation.x = Math.PI / 2; post.position.set(c.x, b.h + 2, c.z);
      for (const m of [globe, ring, lat, post]) { m.castShadow = true; scene.add(m); }
      const arr = attByBlock.get(g) || []; attByBlock.set(g, arr);
      arr.push([{ setMatrixAt() { for (const m of [globe, ring, lat, post]) m.visible = false; }, instanceMatrix: {} }, 0, 'globe']);
    }
  }
}
function dropAttachments(g) {
  const arr = attByBlock.get(g); if (!arr) return;
  attByBlock.delete(g);
  blockCenter(g, T5);
  let water = false;
  for (const [m, i, k] of arr) { m.setMatrixAt(i, ZERO_M); m.instanceMatrix.needsUpdate = true; if (k === 'tank') water = true; }
  for (let k = 0; k < 6; k++) FX.dust(T5.x + R(-2, 2), T5.y + R(-1, 2), T5.z + R(-2, 2), R(-2, 2), R(-1, 1), R(-2, 2), 0.8);
  if (water) { const y = buildings[blkB[g]].h + 3; for (let k = 0; k < 60; k++) FX.water(T5.x, y, T5.z, R(-6, 6), R(0, 6), R(-6, 6)); SFX.splash(T5); }
}

function setBlockHeat(g, v) { heat[g] = v; const t = blkT[g]; typeMesh[t].userData.aH.setX(blkSub[g], v); attrDirty[t] = true; if (v > 0) hotSet.add(g); }
const hotSet = new Set(), frostSet = new Set();
function setBlockFrost(g, v) { frost[g] = v; const t = blkT[g]; typeMesh[t].userData.aF.setX(blkSub[g], v); attrDirty[t] = true; }
function hideBlock(g) { const t = blkT[g]; typeMesh[t].setMatrixAt(blkSub[g], ZERO_M); typeDirty[t] = true; }

// ============================================================ ground, water, parks
{
  const S = 2048, m = S / 480, [c, x] = cnv(S, S);
  const P = (w) => (w + 240) * m;
  x.fillStyle = '#2d2e31'; x.fillRect(0, 0, S, S);
  for (let i = 0; i < 26000; i++) { x.fillStyle = `rgba(255,255,255,${R(0.01, 0.05)})`; x.fillRect(rnd() * S, rnd() * S, 2, 2); }
  for (const L of lotInfo) {
    x.fillStyle = '#8f8a80'; x.fillRect(P(L.lx), P(L.lz), 40 * m, 40 * m);
    x.fillStyle = 'rgba(0,0,0,.25)';
    for (let k = 0; k <= 40; k += 2.5) { x.fillRect(P(L.lx + k), P(L.lz), 1, 40 * m); x.fillRect(P(L.lx), P(L.lz + k), 40 * m, 1); }
    if (L.type === 'park') {
      x.fillStyle = '#3f6a33'; x.fillRect(P(L.lx + 3), P(L.lz + 3), 34 * m, 34 * m);
      x.fillStyle = '#b6a98f'; x.fillRect(P(L.lx + 18.5), P(L.lz + 3), 3 * m, 34 * m); x.fillRect(P(L.lx + 3), P(L.lz + 18.5), 34 * m, 3 * m);
    } else if (L.type === 'hospital') {
      x.fillStyle = '#b9b4aa'; x.fillRect(P(L.lx + 3), P(L.lz + 3), 34 * m, 34 * m);
      x.fillStyle = '#e8e8e8'; x.beginPath(); x.arc(P(HOSP.x), P(HOSP.z), 12 * m, 0, 7); x.fill();
      x.fillStyle = '#d42a2a'; x.fillRect(P(HOSP.x - 2), P(HOSP.z - 8), 4 * m, 16 * m); x.fillRect(P(HOSP.x - 8), P(HOSP.z - 2), 16 * m, 4 * m);
    } else {
      x.fillStyle = '#6b665d'; x.fillRect(P(L.lx + 3), P(L.lz + 3), 34 * m, 34 * m);
    }
  }
  for (let k = 0; k <= LOTS; k++) {
    const rc = -HALF + k * PITCH;
    x.fillStyle = '#d9b23a';
    for (let t = -240; t < 240; t += 6) { x.fillRect(P(t), P(rc) - 1.5, 3 * m, 3); x.fillRect(P(rc) - 1.5, P(t), 3, 3 * m); }
    x.fillStyle = 'rgba(235,235,235,.75)';
    for (let k2 = 0; k2 <= LOTS; k2++) {
      const rc2 = -HALF + k2 * PITCH;
      for (let s = -8; s <= 8; s += 1.6) { x.fillRect(P(rc2 + 11), P(rc + s), 2.5 * m, 0.7 * m); x.fillRect(P(rc + s), P(rc2 + 11), 0.7 * m, 2.5 * m); }
    }
  }
  const cityMat = new THREE.MeshStandardMaterial({ map: tex(c, true), roughness: 0.92, metalness: 0 });
  // asphalt detail in world space: aggregate grain, cracks, sealed seams, polished wheel tracks, oil, wet patches
  cityMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vAWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vAWP;
float aHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float aNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(aHash(i), aHash(i + vec2(1, 0)), u.x), mix(aHash(i + vec2(0, 1)), aHash(i + vec2(1, 1)), u.x), u.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float aMask = 1.0 - smoothstep(0.035, 0.07, dot(diffuseColor.rgb, vec3(0.333)));
vec2 ap = vAWP.xz;
float aRough = 0.92;
if (aMask > 0.0) {
  float grain = aHash(floor(ap * 14.0)) * 0.5 + aNoise(ap * 2.3) * 0.35 + aNoise(ap * 0.31) * 0.45;
  vec3 aCol = diffuseColor.rgb * (0.82 + 0.3 * grain);
  float crack = 1.0 - smoothstep(0.0, 0.012, abs(aNoise(ap * 0.42 + 7.0) - 0.5));
  crack *= step(0.55, aNoise(ap * 0.07));
  aCol *= 1.0 - 0.45 * crack;
  float seam = step(0.86, aNoise(vec2(ap.x * 0.05, 3.0))) * step(abs(fract(ap.y * 0.1) - 0.5), 0.02);
  aCol = mix(aCol, aCol * 0.55, seam);
  vec2 off = mod(ap + 210.0, 60.0) - 30.0; off = 30.0 - abs(off);   // distance to the nearest road centreline, per axis
  float lane = min(off.x, off.y);
  float tracks = max(smoothstep(0.5, 0.0, abs(lane - 2.6)), smoothstep(0.5, 0.0, abs(lane - 4.4)));
  aCol *= 1.0 + 0.1 * tracks; aRough -= 0.22 * tracks;
  float oil = smoothstep(0.62, 0.8, aNoise(ap * 0.9)) * smoothstep(0.7, 0.0, abs(lane - 3.5));
  aCol *= 1.0 - 0.35 * oil; aRough -= 0.3 * oil;
  float wet = smoothstep(0.74, 0.8, aNoise(ap * 0.045 + 13.0)) * smoothstep(0.35, 0.6, aNoise(ap * 0.4));
  aCol *= 1.0 - 0.35 * wet; aRough = mix(aRough, 0.04, wet);
  diffuseColor.rgb = mix(diffuseColor.rgb, aCol, aMask);
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, clamp(aRough, 0.03, 1.0), aMask);');
  };
  const city = new THREE.Mesh(new THREE.PlaneGeometry(480, 480), cityMat);
  city.rotation.x = -Math.PI / 2; city.position.y = 0.02; city.receiveShadow = true; scene.add(city);
  const land = new THREE.Mesh(new THREE.PlaneGeometry(800000, 400000), new THREE.MeshStandardMaterial({ color: lin(0x5f604c), roughness: 1 }));
  land.rotation.x = -Math.PI / 2; land.position.z = WATER_Z - 200000; land.receiveShadow = true; scene.add(land);
  const waterN = (() => {
    const S = 256, [c, x] = cnv(S, S), img = x.createImageData(S, S), H = new Float32Array(S * S);
    const waves = [[3, 1, 0.5, 0.2], [1, 4, 0.35, 1.3], [5, -2, 0.25, 2.1], [-2, 7, 0.18, 0.7], [9, 3, 0.1, 3.3], [-6, -11, 0.07, 4.1]];
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      let h = 0; for (const [a, b2, amp, ph] of waves) h += amp * Math.sin(2 * Math.PI * (a * i + b2 * j) / S + ph);
      H[j * S + i] = h;
    }
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const dx = H[j * S + (i + 1) % S] - H[j * S + (i - 1 + S) % S], dy = H[((j + 1) % S) * S + i] - H[((j - 1 + S) % S) * S + i];
      const nx = -dx * 2.2, ny = -dy * 2.2, nz = 1, l = Math.hypot(nx, ny, nz), o = (j * S + i) * 4;
      img.data[o] = (nx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const t = tex(c, false); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(800000 / 30, (FAR_SHORE - WATER_Z) / 30); return t;
  })();
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(800000, FAR_SHORE - WATER_Z + 40), new THREE.MeshStandardMaterial({ color: lin(0x173f57), roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.92, normalMap: waterN, normalScale: new THREE.Vector2(0.55, 0.55) }));
  window.__waterN = waterN;
  ocean.rotation.x = -Math.PI / 2; ocean.position.set(0, WATER_Y, (WATER_Z + FAR_SHORE) / 2); ocean.renderOrder = 1; scene.add(ocean);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(800000, 400000), new THREE.MeshStandardMaterial({ color: lin(0x22303a), roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, SEAFLOOR, WATER_Z + 200000); scene.add(floor);
  const shore = new THREE.Mesh(new THREE.PlaneGeometry(800000, 400000), land.material);
  shore.rotation.x = -Math.PI / 2; shore.position.set(0, 0, FAR_SHORE + 200000); shore.receiveShadow = true; scene.add(shore);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(8000, -SEAFLOOR + 0.4, 3), new THREE.MeshStandardMaterial({ color: lin(0x77746c), roughness: 0.9 }));
  wall.position.set(0, (SEAFLOOR + 0.4) / 2, WATER_Z + 1.5); wall.receiveShadow = true; scene.add(wall);
  const wall2 = wall.clone(); wall2.position.z = FAR_SHORE - 1.5; scene.add(wall2);
  // parks: trees
  const trunkG = new THREE.CylinderGeometry(0.18, 0.28, 3, 6); trunkG.translate(0, 1.5, 0);
  const crownG = new THREE.IcosahedronGeometry(2.4, 1); crownG.translate(0, 4.6, 0);
  const parks = lotInfo.filter(L => L.type === 'park');
  const nT = parks.length * 14;
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: lin(0x4a3527), roughness: 1 }), nT);
  const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: lin(0x3e6b2f), roughness: 0.95 }), nT);
  let ti = 0;
  for (const L of parks) for (let k = 0; k < 14; k++) {
    let px, pz; do { px = L.lx + R(5, 35); pz = L.lz + R(5, 35); } while (Math.abs(px - L.lx - 20) < 3 || Math.abs(pz - L.lz - 20) < 3);
    const s = R(0.8, 1.3); TM.compose(T1.set(px, 0, pz), TQ.setFromAxisAngle(UP, R(0, 6.28)), TS.set(s, s * R(0.9, 1.2), s));
    trunks.setMatrixAt(ti, TM); crowns.setMatrixAt(ti, TM);
    crowns.setColorAt(ti, lin(pick([0x3e6b2f, 0x4f7a34, 0x5e7f2e, 0x355d2a]))); ti++;
  }
  trunks.castShadow = crowns.castShadow = true; trunks.receiveShadow = crowns.receiveShadow = true;
  trunks.frustumCulled = crowns.frustumCulled = false;
  scene.add(trunks, crowns);
}

// clouds: soft volumes you can fly through
const clouds = [];
const cloudSys = (() => {
  const n = 520, pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
  const cr = srand(77); let i = 0;
  for (let c = 0; c < 65; c++) {
    const cx = (cr() - 0.5) * 14000, cz = (cr() - 0.5) * 14000, cy = 900 + cr() * 500, r = 90 + cr() * 140;
    clouds.push({ x: cx, y: cy, z: cz, r: r * 1.4 });
    for (let k = 0; k < 8; k++, i++) {
      pos[i * 3] = cx + (cr() - 0.5) * r * 2; pos[i * 3 + 1] = cy + (cr() - 0.5) * r * 0.5; pos[i * 3 + 2] = cz + (cr() - 0.5) * r * 2;
      const b = 1.5 + cr() * 0.4; col[i * 4] = b; col[i * 4 + 1] = b * 0.93; col[i * 4 + 2] = b * 0.86; col[i * 4 + 3] = 0.5;
      size[i] = r * (1.2 + cr());
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color4', new THREE.BufferAttribute(col, 4)); g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 500 } }, vertexShader: PVS, fragmentShader: PFS, transparent: true, depthWrite: false });
  pMats.push(m);
  const p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = 1; scene.add(p); return p;
})();

// ============================================================ plugins (skyline, street dressing)
// Modules in js/*.js push a function onto window.SM_PLUGINS before this file loads.
// Each gets a context and may return { colliders: [{x0,y0,z0,x1,y1,z1}], update(dt, camera) }.
const farFacadeMat = makeFacadeMat(true);
function instancedFacade(geo, count, worldUV) {
  return blockMesh(geo, worldUV === false ? facadeMat : farFacadeMat, count);
}
const pluginColliders = [], pluginUpdates = [];
const colGrid = new Map(), COLG = 60;
const colKey = (i, j) => (i & 2047) | ((j & 2047) << 11);
{
  const ctx = {
    THREE, scene, renderer, camera, lin, rnd, srand, R, clamp, pick,
    CONST: { CELL, STORY, LOTS, PITCH, HALF, WATER_Z, WATER_Y, FAR_SHORE, SEAFLOOR },
    lotInfo, buildings, HOSP, inBay, instancedFacade, makeFacadeMat, STYLE_COLORS,
    isLowQuality: LOWQ, quality: QUALITY, composer, bloom, grade, sun, hemi, SUN_DIR, skyMat, sky, getPlayer: () => P
  };
  for (const plug of (window.SM_PLUGINS || [])) {
    try {
      const out = plug(ctx) || {};
      if (out.colliders) for (const c of out.colliders) {
        pluginColliders.push(c);
        for (let i = Math.floor(c.x0 / COLG); i <= Math.floor(c.x1 / COLG); i++)
          for (let j = Math.floor(c.z0 / COLG); j <= Math.floor(c.z1 / COLG); j++) {
            const k = colKey(i, j); let a = colGrid.get(k); if (!a) colGrid.set(k, a = []); a.push(c);
          }
      }
      if (out.update) pluginUpdates.push(out.update);
    } catch (e) { console.error('plugin failed', e); }
  }
}
function collidersNear(x, z) { return colGrid.get(colKey(Math.floor(x / COLG), Math.floor(z / COLG))) || null; }
// push a sphere out of static plugin colliders; returns the push normal or null
function pushOutColliders(p, r, vel, bounce) {
  const list = collidersNear(p.x, p.z); if (!list) return null;
  let hitN = null;
  for (const c of list) {
    if (p.x + r < c.x0 || p.x - r > c.x1 || p.z + r < c.z0 || p.z - r > c.z1 || p.y + r < c.y0 || p.y - r > c.y1) continue;
    const dx0 = p.x + r - c.x0, dx1 = c.x1 - (p.x - r), dz0 = p.z + r - c.z0, dz1 = c.z1 - (p.z - r), dy1 = c.y1 - (p.y - r);
    const m = Math.min(dx0, dx1, dz0, dz1, dy1);
    const n = T6.set(0, 0, 0);
    if (m === dy1) { p.y += dy1; n.y = 1; } else if (m === dx0) { p.x -= dx0; n.x = -1; } else if (m === dx1) { p.x += dx1; n.x = 1; } else if (m === dz0) { p.z -= dz0; n.z = -1; } else { p.z += dz1; n.z = 1; }
    const vn = vel.dot(n); if (vn < 0) vel.addScaledVector(n, -vn * (1 + (bounce || 0)));
    hitN = n;
  }
  return hitN;
}

// ============================================================ decals, rings, flashes
const decalTex = {};
{
  let [c, x] = cnv(256, 256);
  let gr = x.createRadialGradient(128, 128, 10, 128, 128, 128);
  gr.addColorStop(0, 'rgba(20,16,12,.95)'); gr.addColorStop(0.55, 'rgba(40,34,28,.75)'); gr.addColorStop(1, 'rgba(40,34,28,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = 'rgba(10,8,6,.9)'; x.lineWidth = 3;
  for (let i = 0; i < 16; i++) {
    x.beginPath(); x.moveTo(128, 128); let a = i / 16 * 6.28 + R(-0.2, 0.2), r = 0;
    while (r < 125) { r += R(8, 18); a += R(-0.3, 0.3); x.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); }
    x.stroke();
  }
  decalTex.crater = tex(c, true);
  [c, x] = cnv(128, 128); gr = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(10,8,6,.9)'); gr.addColorStop(1, 'rgba(10,8,6,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  decalTex.scorch = tex(c, true);
  [c, x] = cnv(128, 128); gr = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(230,248,255,.95)'); gr.addColorStop(0.7, 'rgba(200,236,255,.8)'); gr.addColorStop(1, 'rgba(200,236,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  decalTex.ice = tex(c, true);
}
const decalGeo = new THREE.PlaneGeometry(1, 1); decalGeo.rotateX(-Math.PI / 2);
const decals = []; let decalI = 0;
const decalMats = {};
for (const k in decalTex) decalMats[k] = new THREE.MeshStandardMaterial({ map: decalTex[k], transparent: true, depthWrite: false, roughness: k === 'ice' ? 0.1 : 1, metalness: 0 });
function addDecal(type, x, y, z, r) {
  let d = decals[decalI];
  if (!d) { d = new THREE.Mesh(decalGeo, decalMats[type]); d.receiveShadow = true; d.renderOrder = 1; scene.add(d); decals[decalI] = d; }
  d.material = decalMats[type]; d.position.set(x, y + 0.06 + decalI * 0.0004, z); d.scale.set(r * 2, 1, r * 2); d.rotation.y = R(0, 6.28); d.visible = true;
  decalI = (decalI + 1) % 70;
}
const iceSheets = []; // freeze breath over water makes walkable ice
function onIce(x, z) { for (const s of iceSheets) if ((x - s.x) ** 2 + (z - s.z) ** 2 < s.r * s.r) return true; return false; }
function groundY(x, z) { if (inBay(z)) return onIce(x, z) ? WATER_Y + 0.1 : SEAFLOOR; return 0; }

const rings = [];
const ringGeo = new THREE.RingGeometry(0.86, 1, 64);
function ring(pos, normal, r0, r1, dur, color, op) {
  let e = rings.find(r => !r.on);
  if (!e) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }));
    m.renderOrder = 4; scene.add(m); e = { m }; rings.push(e);
  }
  e.on = true; e.t = 0; e.dur = dur; e.r0 = r0; e.r1 = r1; e.op = op || 0.8;
  e.m.material.color.copy(color || new THREE.Color(2, 2, 2.2)); e.m.position.copy(pos);
  e.m.quaternion.setFromUnitVectors(T1.set(0, 0, 1), normal); e.m.visible = true;
}
function updateRings(dt) {
  for (const e of rings) {
    if (!e.on) continue; e.t += dt; const k = e.t / e.dur;
    if (k >= 1) { e.on = false; e.m.visible = false; continue; }
    const s = lerp(e.r0, e.r1, 1 - (1 - k) * (1 - k)); e.m.scale.set(s, s, s); e.m.material.opacity = e.op * (1 - k);
  }
}
const flashes = [];
for (let i = 0; i < 3; i++) { const l = new THREE.PointLight(lin(0xffa050), 0, 120, 2); scene.add(l); flashes.push({ l, t: 0, p: 0 }); }
function flashLight(pos, power, dist) {
  const f = flashes.reduce((a, b) => (a.l.intensity < b.l.intensity ? a : b));
  f.l.position.copy(pos); f.p = power; f.l.distance = dist; f.l.intensity = power;
}

// ============================================================ bodies
let uid = 0;
const bodies = [];         // live dynamic bodies (debris, cars, heli, meteor)
const rubble = [];         // settled debris merged into static piles
const people = [];
let bodiesDirty = false;

function initBody(o, kind, pos, hx, hy, hz, mass) {
  o.id = ++uid; o.kind = kind; o.pos = pos.clone(); o.vel = new V3(); o.quat = new Q4(); o.angVel = new V3();
  o.half = new V3(hx, hy, hz); o.mass = mass; o.invM = 1 / mass; o.rad = (hx + hy + hz) / 3;
  o.invI = 9 / (2 * mass * (hx * hx + hy * hy + hz * hz)); o.area = 4 * Math.max(hx * hy, hy * hz, hx * hz) * 0.7;
  o.sleeping = false; o.sleepT = 0; o.held = false; o.heat = 0; o.frost = 0; o.hp = 100; o.onGround = false; o.impact = 0;
  o.dead = false; o.rest = 0.15; o.mu = 0.65; o.cd = 1.05; o.dispVol = 8 * hx * hy * hz; o.wet = false; o.age = 0; o.noGrav = false;
  return o;
}
function makeBody(kind, pos, hx, hy, hz, mass) { const b = initBody({}, kind, pos, hx, hy, hz, mass); bodies.push(b); return b; }
function wake(b) { if (b.sleeping) { b.sleeping = false; b.sleepT = 0; } }
function liveDebris() { let n = 0; for (const b of bodies) if (b.kind === 'debris' && !b.dead) n++; return n; }
let liveDebrisCount = 0;

// debris InstancedMesh: shared by live chunks and static rubble
const dGeo = new THREE.BoxGeometry(1, 1, 1);
const debrisMeshes = [T_COL, T_GLASS, T_SLAB].map(t => {
  const m = blockMesh(dGeo, t === T_GLASS ? [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat] : (t === T_COL ? colMat : slabMat), DEBRIS_SLOTS / 3 | 0);
  for (let i = 0; i < m.count; i++) { m.setMatrixAt(i, ZERO_M); m.setColorAt(i, new THREE.Color(1, 1, 1)); }
  scene.add(m); m.userData.free = []; for (let i = m.count - 1; i >= 0; i--) m.userData.free.push(i);
  return m;
});
const dDirty = [false, false, false];
function allocDebrisSlot(t) {
  const m = debrisMeshes[t];
  if (!m.userData.free.length) {
    // recycle the oldest static rubble of this look
    const i = rubble.findIndex(r => r.btype === t);
    if (i < 0) return -1;
    const r = rubble[i]; rubble.splice(i, 1); removeFromStatic(r); freeDebrisSlot(r);
  }
  return m.userData.free.pop();
}
function freeDebrisSlot(b) {
  if (b.slot < 0) return; const m = debrisMeshes[b.btype];
  m.setMatrixAt(b.slot, ZERO_M); dDirty[b.btype] = true; m.userData.free.push(b.slot); b.slot = -1;
}
function writeDebris(b) {
  const m = debrisMeshes[b.btype];
  TM.compose(b.pos, b.quat, TS.set(b.half.x * 2, b.half.y * 2, b.half.z * 2));
  m.setMatrixAt(b.slot, TM); dDirty[b.btype] = true;
}
function setDebrisHeat(b, v) { b.heat = v; const m = debrisMeshes[b.btype]; m.userData.aH.setX(b.slot, v); m.userData.aH.needsUpdate = true; }
function setDebrisFrost(b, v) { b.frost = v; const m = debrisMeshes[b.btype]; m.userData.aF.setX(b.slot, v); m.userData.aF.needsUpdate = true; }

function m0Style(t, slot, st) { const m = debrisMeshes[t]; m.userData.aS.setX(slot, st); m.userData.aS.needsUpdate = true; }
function spawnDebris(pos, hx, hy, hz, vel, btype, color, hv, fv, spin, force, style) {
  if (liveDebrisCount >= LIVE_CAP && !force) return null;
  const slot = allocDebrisSlot(btype); if (slot < 0) return null;
  const mass = MASS_T[btype] * (8 * hx * hy * hz) / (btype === T_SLAB ? CELL * CELL * SLAB_H : CELL * CELL * STORY);
  const b = makeBody('debris', pos, hx, hy, hz, Math.max(150, mass));
  b.slot = slot; b.btype = btype; b.color = color; b.dispVol = b.mass / 2400; b.full = hx > 2; b.style = style || 0;
  m0Style(btype, slot, b.style);
  b.vel.copy(vel); b.angVel.set(R(-1, 1), R(-1, 1), R(-1, 1)).multiplyScalar(spin || 0.5);
  const m = debrisMeshes[btype];
  m.setColorAt(slot, color); m.instanceColor.needsUpdate = true;
  setDebrisHeat(b, hv || 0); setDebrisFrost(b, fv || 0);
  writeDebris(b); liveDebrisCount++;
  return b;
}
function removeBody(b) {
  if (b.dead) return; b.dead = true; bodiesDirty = true;
  if (b.kind === 'debris') { freeDebrisSlot(b); liveDebrisCount--; }
  if (b.mesh) { if (b.mesh.isCar) b.mesh.visible = false; else scene.remove(b.mesh); }
  if (P.hold === b) P.hold = null;
}

// static rubble: settled chunks leave the simulation but still collide
const SH = 6, staticHash = new Map();
const skey = (x, y, z) => (x & 1023) | ((z & 1023) << 10) | ((y & 255) << 20); // fits in a V8 small integer; wrap-around only adds a distance test
function addToStatic(r) {
  const k = skey(Math.floor(r.pos.x / SH), Math.floor(r.pos.y / SH), Math.floor(r.pos.z / SH)); r.skey = k;
  let a = staticHash.get(k); if (!a) staticHash.set(k, a = []); a.push(r);
}
function removeFromStatic(r) { const a = staticHash.get(r.skey); if (a) { const i = a.indexOf(r); if (i >= 0) a.splice(i, 1); } }
function settleToRubble(b) {
  b.dead = true; bodiesDirty = true; liveDebrisCount--;
  const r = { kind: 'rubble', pos: b.pos.clone(), quat: b.quat.clone(), half: b.half.clone(), rad: b.rad, slot: b.slot, btype: b.btype, style: b.style, color: b.color, mass: b.mass, heat: b.heat, frost: b.frost, full: b.full };
  rubble.push(r); addToStatic(r);
}
function reviveRubble(r, vel) {
  if (liveDebrisCount >= LIVE_CAP) return null;
  const i = rubble.indexOf(r); if (i < 0) return null; rubble.splice(i, 1); removeFromStatic(r);
  const b = makeBody('debris', r.pos, r.half.x, r.half.y, r.half.z, r.mass);
  b.quat.copy(r.quat); b.slot = r.slot; b.btype = r.btype; b.style = r.style; b.color = r.color; b.full = r.full; b.dispVol = r.mass / 2400;
  b.heat = r.heat; b.frost = r.frost; if (vel) b.vel.copy(vel); liveDebrisCount++;
  return b;
}
function rubbleNear(p, rad, cb) {
  const x0 = Math.floor((p.x - rad) / SH), x1 = Math.floor((p.x + rad) / SH);
  const y0 = Math.floor((p.y - rad) / SH), y1 = Math.floor((p.y + rad) / SH);
  const z0 = Math.floor((p.z - rad) / SH), z1 = Math.floor((p.z + rad) / SH);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    const a = staticHash.get(skey(x, y, z)); if (!a) continue;
    for (let i = a.length - 1; i >= 0; i--) cb(a[i]);
  }
}

// ============================================================ cars
const CAR_COLORS = [0xa3141c, 0x1a3f80, 0xe6e2d8, 0x1d1e21, 0x8f989e, 0xf2b90f, 0xf2b90f, 0x245e3c, 0x5a2569, 0xc95f1a, 0x3a3f46, 0xd8d6d0];
// sedan built from side-profile extrusions: lower body to the beltline, a glass greenhouse, a roof panel
function extrudeProfile(pts, width, bevel) {
  const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -(width - 2 * bevel) / 2); g.computeVertexNormals(); return g;
}
const carGeo = {
  body: extrudeProfile([[-2.18, -0.52], [2.18, -0.52], [2.24, -0.12], [2.08, 0.14], [0.95, 0.27], [-1.62, 0.3], [-2.16, 0.22], [-2.24, -0.1]], 1.8, 0.06),
  cabin: extrudeProfile([[0.25, 0.76], [-0.92, 0.76], [-0.96, 0.81], [0.21, 0.81]], 1.56, 0.02),
  glass: extrudeProfile([[0.98, 0.25], [0.24, 0.78], [-0.93, 0.78], [-1.66, 0.27]], 1.6, 0.02),
  wheel: new THREE.CylinderGeometry(0.36, 0.36, 0.24, 16), light: new THREE.BoxGeometry(0.06, 0.14, 0.42)
};
carGeo.wheel.rotateX(Math.PI / 2);
const glassMat = new THREE.MeshStandardMaterial({ color: lin(0x1c2633), roughness: 0.05, metalness: 0.9 });
const tireMat = new THREE.MeshStandardMaterial({ color: lin(0x18181a), roughness: 0.9 });
const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(3, 2.8, 2.4), emissiveIntensity: 1 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: new THREE.Color(2.5, 0.05, 0.05), emissiveIntensity: 1 });
// all cars share seven instanced meshes; each car keeps a small proxy with the old mesh API
const MAXC = 220;
const paintMat = new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.55 });
paintMat.onBeforeCompile = sh => {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aHeat; varying float vHeat;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = aHeat;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vHeat;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(3.0, 0.6, 0.05) * vHeat;');
};
const CARI = (() => {
  const parts = [];
  const mk = (geo, mat, perCar, locals, shadow) => {
    const g = geo.clone();
    if (mat === paintMat) g.setAttribute('aHeat', new THREE.InstancedBufferAttribute(new Float32Array(MAXC * perCar), 1));
    const m = new THREE.InstancedMesh(g, mat, MAXC * perCar);
    m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = true;
    for (let i = 0; i < m.count; i++) m.setMatrixAt(i, ZERO_M);
    if (mat === paintMat) for (let i = 0; i < m.count; i++) m.setColorAt(i, new THREE.Color(1, 1, 1));
    scene.add(m); parts.push({ m, perCar, locals: locals.map(([x, y, z]) => new THREE.Matrix4().makeTranslation(x, y, z)), paint: mat === paintMat });
  };
  mk(carGeo.body, paintMat, 1, [[0, 0, 0]], true);
  mk(carGeo.cabin, paintMat, 1, [[0, 0, 0]], true);
  mk(carGeo.glass, glassMat, 1, [[0, 0, 0]], false);
  mk(carGeo.wheel, tireMat, 4, [[-1.38, -0.49, -0.84], [-1.38, -0.49, 0.84], [1.38, -0.49, -0.84], [1.38, -0.49, 0.84]], true);
  mk(carGeo.light, headMat, 2, [[2.2, -0.02, 0.58], [2.2, -0.02, -0.58]], false);
  mk(carGeo.light, tailMat, 2, [[-2.22, 0.02, 0.6], [-2.22, 0.02, -0.6]], false);
  return { parts, free: Array.from({ length: MAXC }, (_, i) => MAXC - 1 - i) };
})();
function makeCarMesh(color) {
  const slot = CARI.free.pop();
  return {
    isCar: true, slot, position: new V3(), quaternion: new Q4(), scale: new V3(1, 1, 1), visible: true,
    userData: { paint: { color: lin(color), emissive: new THREE.Color(0, 0, 0) }, base: lin(color) }
  };
}
const _cm = new THREE.Matrix4(), _cp = new THREE.Matrix4();
function writeCarInstances() {
  for (const part of CARI.parts) {
    for (const c of cars) {
      const mesh = c.mesh; if (mesh.slot === undefined) continue;
      if (c.dead || !mesh.visible) { for (let k = 0; k < part.perCar; k++) part.m.setMatrixAt(mesh.slot * part.perCar + k, ZERO_M); continue; }
      _cm.compose(mesh.position, mesh.quaternion, mesh.scale);
      for (let k = 0; k < part.perCar; k++) part.m.setMatrixAt(mesh.slot * part.perCar + k, _cp.multiplyMatrices(_cm, part.locals[k]));
      if (part.paint) { part.m.setColorAt(mesh.slot, mesh.userData.paint.color); part.m.geometry.attributes.aHeat.setX(mesh.slot, mesh.userData.paint.emissive.r / 3); }
    }
    part.m.instanceMatrix.needsUpdate = true;
    if (part.paint) { part.m.instanceColor.needsUpdate = true; part.m.geometry.attributes.aHeat.needsUpdate = true; }
  }
}
const cars = [];
function spawnCar(axis, dir, laneCoord, along, color) {
  const pos = axis === 'x' ? new V3(along, 0.85, laneCoord) : new V3(laneCoord, 0.85, along);
  const c = makeBody('car', pos, 2.2, 0.85, 0.93, 1500);
  c.mesh = makeCarMesh(color || pick(CAR_COLORS)); c.cd = 0.4; c.rest = 0.2;
  c.drive = { axis, dir, lane: laneCoord, v: R(10, 15), target: R(11, 16) };
  c.flood = 0; c.wreck = false; c.burnT = 0; c.alarm = 0;
  const yaw = axis === 'x' ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
  c.quat.setFromAxisAngle(UP, yaw);
  cars.push(c); return c;
}
for (let k = 0; k <= LOTS; k++) {
  const rc = -HALF + k * PITCH;
  for (let n = 0; n < 3; n++) {
    if (rs() < 0.75) spawnCar('x', 1, rc + 3.5, R(-240, 240));
    if (rs() < 0.75) spawnCar('x', -1, rc - 3.5, R(-240, 240));
    if (rs() < 0.75) spawnCar('z', 1, rc - 3.5, R(-240, 230));
    if (rs() < 0.75) spawnCar('z', -1, rc + 3.5, R(-240, 230));
  }
}
// parked cars line the curbs, clear of intersections
{
  const nearCross = a => { const r = ((a + HALF) % PITCH + PITCH) % PITCH; return r < 16 || r > PITCH - 16; };
  for (let k = 1; k < LOTS; k++) {
    const rc = -HALF + k * PITCH;
    for (const side of [-1, 1]) for (const axis of ['x', 'z']) {
      for (let a = -HALF + 8; a < HALF - 4; a += R(6, 14)) {
        if (nearCross(a) || rs() < 0.8) continue;
        if (axis === 'z' && a > 225) continue;
        if (!CARI.free.length) break;
        const c = spawnCar(axis, side, rc + side * 8, a);
        c.drive = null; c.sleeping = true; c.parked = true;
        c.quat.setFromAxisAngle(UP, axis === 'x' ? (side > 0 ? 0 : Math.PI) : (side > 0 ? -Math.PI / 2 : Math.PI / 2));
        a += 4.6;
      }
    }
  }
}
function disturbCar(c) { if (c.drive) { c.drive = null; c.alarm = 6; } c.parked = false; wake(c); }
function damageCar(c, dv) {
  if (c.kind !== 'car' || dv < 9) return;
  c.hp -= (dv - 9) * 6;
  if (!c.wreck && c.hp <= 0) {
    c.wreck = true; ledger.damage += 38000; hopeHit(0.4);
    c.mesh.userData.paint.color.copy(c.mesh.userData.base).multiplyScalar(0.25);
    c.mesh.scale.set(1, 0.82, 1);
  }
}
function explodeCar(c) {
  if (c.exploded) return; c.exploded = true; c.wreck = true; c.burnT = 25; c.drive = null;
  c.mesh.userData.paint.color.setRGB(0.02, 0.02, 0.02); c.mesh.scale.set(1, 0.78, 1);
  ledger.damage += 45000;
  explode(c.pos, 2.5e7, { src: c });
}

// ============================================================ people
// pedestrians are built from instanced parts so legs and arms can swing (local forward is +X)
const PPL = (() => {
  const parts = {};
  const mk = (name, geo, rough) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: rough }), MAXP);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    for (let i = 0; i < MAXP; i++) { m.setMatrixAt(i, ZERO_M); m.setColorAt(i, new THREE.Color(1, 1, 1)); }
    scene.add(m); parts[name] = m; return m;
  };
  const torso = new THREE.CylinderGeometry(0.2, 0.16, 0.62, 12); torso.scale(0.68, 1, 1); torso.translate(0, 0.24, 0);
  const hips = new THREE.CylinderGeometry(0.165, 0.17, 0.2, 12); hips.scale(0.7, 1, 1); hips.translate(0, -0.03, 0);
  const leg = new THREE.CylinderGeometry(0.078, 0.058, 0.86, 8); leg.translate(0, -0.43, 0);
  const arm = new THREE.CylinderGeometry(0.056, 0.044, 0.6, 8); arm.translate(0, -0.3, 0);
  const head = new THREE.SphereGeometry(0.11, 14, 10); head.scale(0.95, 1.1, 0.9); head.translate(0, 0.73, 0);
  const hair = new THREE.SphereGeometry(0.116, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55); hair.translate(-0.012, 0.75, 0);
  mk('torso', torso, 0.85); mk('hips', hips, 0.85); mk('legL', leg, 0.85); mk('legR', leg, 0.85);
  mk('armL', arm, 0.85); mk('armR', arm, 0.85); mk('head', head, 0.6); mk('hair', hair, 0.7);
  return parts;
})();
const PPL_LIST = Object.values(PPL);
const _pm = new THREE.Matrix4(), _pl = new THREE.Matrix4(), _pr = new THREE.Matrix4();
function placePart(mesh, slot, base, px, py, pz, ang) {
  _pl.makeTranslation(px, py, pz); if (ang) _pl.multiply(_pr.makeRotationZ(ang));
  _pm.multiplyMatrices(base, _pl); mesh.setMatrixAt(slot, _pm);
}
const SHIRTS = [0x7a2b2b, 0x2b4a7a, 0x3c3c3c, 0x6b5a3a, 0x2f6b55, 0x8a6d9c, 0xb0a07a, 0x404d60, 0x9c4f2e, 0xd8d4c8, 0x1f2a44, 0xa8322d];
const PANTS = [0x23262d, 0x2c3a55, 0x4a4036, 0x5b5f66, 0x1b1c1f, 0x6f6455];
const HAIR = [0x16110d, 0x2b1d14, 0x4a3020, 0x8a6a3c, 0x6b6b6b, 0x0d0d0d];
function setPersonColors(slot, thug) {
  const shirt = lin(thug ? 0x141414 : pick(SHIRTS)), pants = lin(thug ? 0x1e2024 : pick(PANTS));
  PPL.torso.setColorAt(slot, shirt); PPL.armL.setColorAt(slot, shirt); PPL.armR.setColorAt(slot, shirt);
  PPL.hips.setColorAt(slot, pants); PPL.legL.setColorAt(slot, pants); PPL.legR.setColorAt(slot, pants);
  PPL.head.setColorAt(slot, lin(thug ? 0x222222 : pick(SKIN))); PPL.hair.setColorAt(slot, lin(thug ? 0x111111 : pick(HAIR)));
  for (const m of PPL_LIST) m.instanceColor.needsUpdate = true;
}
const SKIN = [0xf1c6a5, 0xd9a07a, 0xa86b45, 0x6e4329, 0xe6b58e];
function spawnPerson(mode, pos, opts) {
  const slot = people.length; if (slot >= MAXP) return null;
  const p = initBody({}, 'person', pos, 0.22, 0.9, 0.22, R(55, 95));
  p.slot = slot; p.mode = mode; p.face = R(0, 6.28); p.dir = new V3(Math.cos(p.face), 0, Math.sin(p.face));
  p.hs = pick([0.92, 1, 1, 1.06]); p.ws = pick([0.9, 1, 1.1]);
  p.spd = R(1.1, 1.6); p.fleeT = 0; p.injured = false; p.danger = false; p.anim = R(0, 6); p.cheerT = 0; p.photoT = 0; p.goneT = 0;
  p.thug = false; p.cuffed = false; p.rest = 0.05; p.mu = 0.9; p.dispVol = p.mass / 980;
  Object.assign(p, opts || {});
  setPersonColors(slot, p.thug);
  people.push(p); return p;
}
function reusePerson() { return people.find(p => p.mode === 'gone'); }
function placePerson(mode, pos, opts) {
  const p = reusePerson();
  if (!p) return spawnPerson(mode, pos, opts);
  const slot = p.slot; initBody(p, 'person', pos, 0.22, 0.9, 0.22, R(55, 95));
  p.slot = slot; p.mode = mode; p.injured = false; p.danger = false; p.thug = false; p.cuffed = false; p.fleeT = 0; p.cheerT = 0; p.photoT = 0;
  p.face = R(0, 6.28); p.dir = new V3(Math.cos(p.face), 0, Math.sin(p.face)); p.spd = R(1.1, 1.6); p.rest = 0.05; p.mu = 0.9; p.dispVol = p.mass / 980;
  Object.assign(p, opts || {});
  setPersonColors(slot, p.thug);
  return p;
}
for (let n = 0; n < 130; n++) {
  const L = pick(lotInfo.filter(l => l.type !== 'park'));
  const p = spawnPerson('free', new V3(L.lx + 1.6 + rs() * 36.8, 0.9, L.lz + (rs() < 0.5 ? 1.6 : 38.4)));
  if (rs() < 0.5) { p.pos.set(L.lx + (rs() < 0.5 ? 1.6 : 38.4), 0.9, L.lz + 1.6 + rs() * 36.8); }
  p.lot = L; const a = Math.floor(rs() * 4) * Math.PI / 2; p.dir.set(Math.cos(a), 0, Math.sin(a));
}
function knock(p, vel, injure) {
  if (p.mode === 'gone' || p.mode === 'safe' || p.mode === 'held') return;
  if (p.mode === 'trapped') p.danger = true;
  p.mode = 'phys'; p.vel.copy(vel); p.sleeping = false; p.sleepT = 0; p.onGround = false;
  p.angVel.set(R(-3, 3), R(-1, 1), R(-3, 3)); p.quat.setFromAxisAngle(UP, p.face);
  if (injure) injurePerson(p);
}
function injurePerson(p) {
  if (p.injured || p.thug) return; p.injured = true; p.danger = false; ledger.injuries++; hopeHit(4); currentInc && (currentInc.injuries++);
  if (sfxOK('hurt', 2)) toast('A bystander was hurt. Carry them to the hospital pad.', 'alert');
}
function scare(pos, radius, t) {
  for (const p of people) {
    if ((p.mode !== 'free' && p.mode !== 'cheer') || p.thug) continue;
    const d2 = (p.pos.x - pos.x) ** 2 + (p.pos.z - pos.z) ** 2; if (d2 > radius * radius) continue;
    p.mode = 'free'; p.fleeT = t || 6; p.dir.set(p.pos.x - pos.x, 0, p.pos.z - pos.z).normalize();
  }
}
function celebrate(pos, radius) {
  let n = 0;
  for (const p of people) {
    if (p.mode !== 'free' || p.thug || p.fleeT > 0) continue;
    const d2 = (p.pos.x - pos.x) ** 2 + (p.pos.z - pos.z) ** 2; if (d2 > radius * radius) continue;
    p.mode = 'cheer'; p.cheerT = R(4, 7); p.photoT = R(0, 1); n++;
  }
  if (n) SFX.cheer(pos);
}

// ============================================================ Superman
const P = {
  pos: new V3(-90, 45, 150), vel: new V3(), flying: true, grounded: false, quat: new Q4(),
  hold: null, holdRel: new Q4(), charge: 0, charging: false, punchT: 0, heat: false, freeze: false,
  xray: false, hear: false, slow: false, solar: 1, boomed: false, clapCD: 0, walkPhase: 0, hitT: 0,
  landT: 0, bank: 0, lastYaw: 0, combatT: 0, kryp: 0
};
let yaw = -0.54, pitch = -0.08;
const hero = (() => {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: lin(0x1c3fb8), roughness: 0.42, metalness: 0.08, emissive: new THREE.Color(0, 0, 0) });
  const red = new THREE.MeshStandardMaterial({ color: lin(0xb3121a), roughness: 0.48, metalness: 0.05 });
  const skin = new THREE.MeshStandardMaterial({ color: lin(0xe2a987), roughness: 0.62 });
  const hair = new THREE.MeshStandardMaterial({ color: lin(0x0e0f12), roughness: 0.45 });
  const gold = new THREE.MeshStandardMaterial({ color: lin(0xf2b705), roughness: 0.35, metalness: 0.4 });
  const add = (geo, mat, x, y, z, parent, sx, sy, sz) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (sx) m.scale.set(sx, sy, sz);
    m.castShadow = true; (parent || g).add(m); return m;
  };
  const sph = (r) => new THREE.SphereGeometry(r, 24, 16);
  // turned silhouettes: profile points are [radius, y]
  const lathe = (pts, seg) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg || 28);
  // torso: a lathe-turned V-taper (narrow waist, broad lats and chest), flattened front to back
  add(lathe([[0.0, -0.13], [0.152, -0.13], [0.158, -0.02], [0.175, 0.1], [0.212, 0.22], [0.232, 0.33], [0.226, 0.42], [0.17, 0.5], [0.09, 0.55], [0.0, 0.56]]), suit, 0, 0, 0, null, 1.24, 1, 0.66);
  add(sph(0.13), suit, -0.088, 0.33, -0.07, null, 0.95, 0.66, 0.5);           // pecs
  add(sph(0.13), suit, 0.088, 0.33, -0.07, null, 0.95, 0.66, 0.5);
  add(sph(0.12), suit, -0.14, 0.47, 0.01, null, 1.1, 0.55, 0.85);              // traps
  add(sph(0.12), suit, 0.14, 0.47, 0.01, null, 1.1, 0.55, 0.85);
  add(sph(0.105), suit, -0.29, 0.425, 0, null, 1, 1.05, 1);                   // deltoids
  add(sph(0.105), suit, 0.29, 0.425, 0, null, 1, 1.05, 1);
  for (const sy of [0.06, 0.15]) for (const sx of [-0.045, 0.045]) add(sph(0.05), suit, sx, sy, -0.095, null, 1, 0.8, 0.45); // abs
  // trunks, belt and buckle
  add(lathe([[0.0, -0.32], [0.12, -0.32], [0.175, -0.25], [0.168, -0.13], [0.0, -0.13]]), red, 0, 0, 0, null, 1.18, 1, 0.74);
  add(new THREE.TorusGeometry(0.163, 0.022, 8, 32), gold, 0, -0.115, 0, null, 1.17, 0.74, 1).rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(0.075, 0.05, 0.02), gold, 0, -0.115, -0.128);
  // neck, head and the curl
  add(lathe([[0.0, 0.5], [0.07, 0.5], [0.064, 0.6], [0.06, 0.66], [0.0, 0.66]], 16), skin, 0, 0, 0.005, null, 1.05, 1, 1);
  add(sph(0.108), skin, 0, 0.735, -0.005, null, 0.88, 1.12, 1.0);              // cranium
  add(new THREE.BoxGeometry(0.11, 0.07, 0.07), skin, 0, 0.655, -0.06);         // square jaw
  add(sph(0.03), skin, 0, 0.62, -0.085, null, 1.3, 0.9, 1);                    // chin
  add(sph(0.022), skin, -0.098, 0.73, 0.0, null, 0.5, 1, 0.8); add(sph(0.022), skin, 0.098, 0.73, 0.0, null, 0.5, 1, 0.8); // ears
  add(new THREE.SphereGeometry(0.114, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, 0, 0.758, 0.014, null, 0.94, 1.0, 1.04);
  add(sph(0.05), hair, 0.03, 0.82, -0.075, null, 1.4, 0.55, 0.8);             // swept front
  add(new THREE.TorusGeometry(0.02, 0.007, 6, 14, 4.6), hair, -0.012, 0.795, -0.11).rotation.y = 0.3; // the curl
  // chest shield
  const [ec, ex] = cnv(256, 224);
  ex.scale(2, 2);
  ex.fillStyle = '#f2b705'; ex.strokeStyle = '#b3121a'; ex.lineWidth = 9; ex.beginPath();
  ex.moveTo(16, 8); ex.lineTo(112, 8); ex.lineTo(124, 36); ex.lineTo(64, 104); ex.lineTo(4, 36); ex.closePath(); ex.fill(); ex.stroke();
  ex.fillStyle = '#b3121a'; ex.font = '900 66px Georgia, serif'; ex.textAlign = 'center'; ex.textBaseline = 'middle'; ex.fillText('S', 64, 52);
  const emblem = new THREE.Mesh(new THREE.PlaneGeometry(0.23, 0.2), new THREE.MeshStandardMaterial({ map: tex(ec, true), transparent: true, roughness: 0.4, metalness: 0.2 }));
  emblem.position.set(0, 0.315, -0.158); emblem.rotation.set(-0.16, Math.PI, 0); g.add(emblem);
  // two-segment limbs: shoulder/hip pivots with elbow/knee pivots so poses read properly
  const limb = (side, isArm) => {
    const piv = new THREE.Group(), joint = new THREE.Group();
    if (isArm) {
      piv.position.set(side * 0.3, 0.42, 0); g.add(piv);
      add(new THREE.CylinderGeometry(0.074, 0.062, 0.3, 16), suit, 0, -0.15, 0, piv);
      add(sph(0.062), suit, 0, -0.13, -0.025, piv, 1, 1.5, 1);                 // bicep
      add(sph(0.05), suit, 0, -0.15, 0.03, piv, 1, 1.4, 0.9);                 // tricep
      joint.position.set(0, -0.29, 0); piv.add(joint);
      add(sph(0.058), suit, 0, 0, 0, joint);                                  // elbow
      add(new THREE.CylinderGeometry(0.06, 0.046, 0.26, 16), suit, 0, -0.13, 0, joint);
      add(sph(0.052), skin, 0, -0.29, -0.004, joint, 0.95, 1.15, 1.1);         // fist
    } else {
      piv.position.set(side * 0.098, -0.22, 0); g.add(piv);
      add(new THREE.CylinderGeometry(0.098, 0.07, 0.38, 16), suit, 0, -0.19, 0, piv);
      add(sph(0.08), suit, 0, -0.13, -0.025, piv, 1, 1.6, 1);                 // quad
      joint.position.set(0, -0.38, 0); piv.add(joint);
      add(sph(0.066), suit, 0, 0, 0, joint);                                  // knee
      add(new THREE.CylinderGeometry(0.068, 0.054, 0.3, 16), red, 0, -0.17, 0, joint);  // boot
      add(sph(0.056), red, 0, -0.1, 0.03, joint, 1, 1.7, 1);                  // calf
      add(new THREE.TorusGeometry(0.069, 0.012, 6, 20), red, 0, -0.03, 0, joint).rotation.x = Math.PI / 2; // boot cuff
      add(new THREE.BoxGeometry(0.09, 0.06, 0.2), red, 0, -0.335, -0.045, joint); // foot
    }
    piv.userData.joint = joint;
    return piv;
  };
  const armL = limb(-1, true), armR = limb(1, true), legL = limb(-1, false), legR = limb(1, false);
  // cape: verlet cloth simulated in the body frame
  const CW = 8, CH = 12, pts = [], prev = [], rest = [], cons = [];
  for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) {
    const t = r / (CH - 1), w = 0.4 + 0.3 * t;
    const v = new V3((c / (CW - 1) - 0.5) * w, 0.48 - r * 0.112, 0.17 + t * 0.03);
    pts.push(v.clone()); prev.push(v.clone()); rest.push(v.clone());
  }
  const idx = (r, c) => r * CW + c;
  const link = (a, b) => cons.push([a, b, rest[a].distanceTo(rest[b])]);
  for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) {
    if (c < CW - 1) link(idx(r, c), idx(r, c + 1));
    if (r < CH - 1) link(idx(r, c), idx(r + 1, c));
    if (r < CH - 1 && c < CW - 1) { link(idx(r, c), idx(r + 1, c + 1)); link(idx(r, c + 1), idx(r + 1, c)); }
    if (r < CH - 2) link(idx(r, c), idx(r + 2, c));
  }
  const cg = new THREE.BufferGeometry();
  const cpos = new Float32Array(CW * CH * 3), cuv = new Float32Array(CW * CH * 2), cind = [];
  for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) { cuv[idx(r, c) * 2] = c / (CW - 1); cuv[idx(r, c) * 2 + 1] = 1 - r / (CH - 1); }
  for (let r = 0; r < CH - 1; r++) for (let c = 0; c < CW - 1; c++) { const a = idx(r, c), b = idx(r, c + 1), d = idx(r + 1, c), e = idx(r + 1, c + 1); cind.push(a, d, b, b, d, e); }
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3)); cg.setAttribute('uv', new THREE.BufferAttribute(cuv, 2)); cg.setIndex(cind);
  const capeMat = new THREE.MeshStandardMaterial({ color: lin(0xa80f16), roughness: 0.62, side: THREE.DoubleSide });
  const cape = new THREE.Mesh(cg, capeMat); cape.castShadow = true; cape.frustumCulled = false; g.add(cape);
  scene.add(g);
  return { g, suit, armL, armR, legL, legR, elbowL: armL.userData.joint, elbowR: armR.userData.joint, kneeL: legL.userData.joint, kneeR: legR.userData.joint, cape: { CW, CH, pts, prev, rest, cons, geo: cg, pos: cpos } };
})();

function updateCape(dt, t) {
  const C = hero.cape, n = C.pts.length;
  TQ.copy(P.quat).invert();
  const grav = T1.set(0, -G, 0).applyQuaternion(TQ);
  const wind = T2.copy(P.vel).multiplyScalar(-1).applyQuaternion(TQ);
  const wl = wind.length(); if (wl > 45) wind.multiplyScalar(45 / wl);
  const speed = P.vel.length();
  const steps = 3, h = Math.min(dt, 1 / 30) / steps;
  for (let s = 0; s < steps; s++) {
    for (let i = C.CW; i < n; i++) {
      const p = C.pts[i], q = C.prev[i], r = Math.floor(i / C.CW);
      const vx = p.x - q.x, vy = p.y - q.y, vz = p.z - q.z;
      q.copy(p);
      const flutter = Math.min(1, speed / 25) * (Math.sin(t * 17 + r * 0.9 + (i % C.CW)) * 5 + Math.sin(t * 9.3 + r * 1.7) * 4);
      const ax = grav.x + (wind.x - vx / h) * 3.2 + flutter * 0.4;
      const ay = grav.y + (wind.y - vy / h) * 3.2;
      const az = grav.z + (wind.z - vz / h) * 3.2 + flutter;
      p.x += vx * 0.99 + ax * h * h; p.y += vy * 0.99 + ay * h * h; p.z += vz * 0.99 + az * h * h;
    }
    for (let it = 0; it < 4; it++) {
      for (const [a, b, L] of C.cons) {
        const pa = C.pts[a], pb = C.pts[b];
        const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const k = (d - L) / d * 0.5, wa = a < C.CW ? 0 : 1, wb = b < C.CW ? 0 : 1, ws = wa + wb; if (!ws) continue;
        const fa = k * 2 * wa / ws, fb = k * 2 * wb / ws;
        pa.x += dx * fa; pa.y += dy * fa; pa.z += dz * fa; pb.x -= dx * fb; pb.y -= dy * fb; pb.z -= dz * fb;
      }
      for (let i = 0; i < C.CW; i++) C.pts[i].copy(C.rest[i]);
    }
    for (let i = C.CW; i < n; i++) { // keep the cape outside the body capsule
      const p = C.pts[i];
      if (p.y > -1.0 && p.y < 0.55) {
        const rr = Math.sqrt(p.x * p.x * 0.6 + p.z * p.z), minR = 0.24;
        if (rr < minR) { const k = minR / (rr || 1e-4); p.x *= k; p.z = p.z < 0 && Math.abs(p.x) < 0.25 ? -p.z : p.z * k; }
      }
    }
  }
  for (let i = 0; i < n; i++) { const p = C.pts[i]; C.pos[i * 3] = p.x; C.pos[i * 3 + 1] = p.y; C.pos[i * 3 + 2] = p.z; }
  C.geo.attributes.position.needsUpdate = true; C.geo.computeVertexNormals();
}

// ============================================================ helicopter + meteor meshes
function makeHeliMesh() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: lin(0xe8e2d6), roughness: 0.3, metalness: 0.4 });
  const stripe = new THREE.MeshStandardMaterial({ color: lin(0x1d4f9c), roughness: 0.3, metalness: 0.4 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  add(new THREE.SphereGeometry(1.4, 18, 12), paint, 0.6, 0, 0).scale.set(1.6, 1, 1);
  add(new THREE.SphereGeometry(1.0, 14, 10), glassMat, 1.9, 0.2, 0).scale.set(0.8, 0.8, 0.9);
  add(new THREE.CylinderGeometry(0.22, 0.4, 5, 10), stripe, -3.2, 0.3, 0).rotation.z = Math.PI / 2;
  add(new THREE.BoxGeometry(0.15, 1.3, 0.7), stripe, -5.6, 0.8, 0);
  add(new THREE.BoxGeometry(3.4, 0.1, 0.12), tireMat, 0.4, -1.45, 0.9); add(new THREE.BoxGeometry(3.4, 0.1, 0.12), tireMat, 0.4, -1.45, -0.9);
  const rotor = new THREE.Group(); rotor.position.set(0.5, 1.55, 0); g.add(rotor);
  for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.04, 0.3), tireMat); b.rotation.y = i * Math.PI / 4 * 2; b.position.y = 0; rotor.add(b); }
  g.userData.rotor = rotor; scene.add(g); return g;
}
function makeMeteorMesh(kryp) {
  const geo = new THREE.IcosahedronGeometry(3, 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { T1.fromBufferAttribute(p, i); T1.multiplyScalar(R(0.8, 1.15)); p.setXYZ(i, T1.x, T1.y, T1.z); }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: lin(kryp ? 0x1d3a1f : 0x3a2e28), roughness: 0.9, flatShading: true,
    emissive: kryp ? new THREE.Color(0.2, 2.5, 0.4) : new THREE.Color(2.5, 0.7, 0.15), emissiveIntensity: 0.6
  }));
  m.castShadow = true; scene.add(m);
  if (kryp) { const l = new THREE.PointLight(lin(0x4dff6a), 3, 90, 2); m.add(l); }
  return m;
}

// ============================================================ pigeons
// Small flocks circle rooftops near the player and scatter when he flies close.
const BIRDS = (() => {
  const g = new THREE.BufferGeometry();
  // a body plus two wing triangles; flapping scales the instance on Y
  const v = new Float32Array([0, 0, -0.12, 0, 0, 0.16, 0.05, 0.02, 0, 0, 0, -0.06, -0.32, 0.06, 0.02, 0, 0, 0.08, 0, 0, -0.06, 0.32, 0.06, 0.02, 0, 0, 0.08]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3)); g.computeVertexNormals();
  const N = 54, m = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: lin(0x5b5f66), roughness: 0.9, side: THREE.DoubleSide }), N);
  m.frustumCulled = false; m.castShadow = true; scene.add(m);
  const flocks = [];
  for (let f = 0; f < 3; f++) {
    const fl = { c: new V3(), r: R(14, 26), y: 0, t: R(0, 9), scatter: 0, vel: new V3(), birds: [] };
    for (let k = 0; k < N / 3; k++) fl.birds.push({ ph: R(0, 6.28), off: new V3(R(-4, 4), R(-2, 2), R(-4, 4)), flap: R(0, 6) });
    flocks.push(fl);
  }
  return { m, flocks, N };
})();
function perchFlock(fl) {
  const near = buildings.filter(b => Math.hypot((b.x0 + b.x1) / 2 - P.pos.x, (b.z0 + b.z1) / 2 - P.pos.z) < 220);
  const b = near.length ? pick(near) : pick(buildings);
  fl.c.set((b.x0 + b.x1) / 2, b.h + R(8, 18), (b.z0 + b.z1) / 2); fl.scatter = 0; fl.r = R(14, 26);
}
let birdsInit = false;
function updateBirds(dt) {
  if (!birdsInit) { birdsInit = true; for (const fl of BIRDS.flocks) perchFlock(fl); }
  let i = 0;
  for (const fl of BIRDS.flocks) {
    fl.t += dt;
    const dP = fl.c.distanceTo(P.pos);
    if (fl.scatter <= 0 && dP < 30 + P.vel.length() * 0.3) { fl.scatter = 5; fl.vel.copy(fl.c).sub(P.pos).setY(0).normalize().multiplyScalar(14).setY(6); }
    if (fl.scatter > 0) { fl.scatter -= dt; fl.c.addScaledVector(fl.vel, dt); if (fl.scatter <= 0) perchFlock(fl); }
    else if (dP > 600) perchFlock(fl);
    for (const bd of fl.birds) {
      const a = fl.t * (fl.scatter > 0 ? 0.2 : 0.45) + bd.ph;
      T1.set(Math.cos(a) * fl.r, Math.sin(a * 2.3) * 1.5, Math.sin(a) * fl.r).add(bd.off).add(fl.c);
      const heading = Math.atan2(-Math.sin(a) * 1, Math.cos(a)) + (fl.scatter > 0 ? 0 : 0);
      bd.flap += dt * (fl.scatter > 0 ? 22 : 12);
      TQ.setFromAxisAngle(UP, -a);
      TM.compose(T1, TQ, TS.set(1.4, 1.4 * (0.35 + 0.65 * Math.abs(Math.sin(bd.flap))), 1.4));
      BIRDS.m.setMatrixAt(i++, TM);
    }
  }
  BIRDS.m.instanceMatrix.needsUpdate = true;
}

// ============================================================ the ledger (one source of truth)
const ledger = { saves: 0, lost: 0, injuries: 0, damage: 0, hope: 50, streak: 0, best: 0, medals: { gold: 0, silver: 0, bronze: 0 }, resolved: 0, thugs: 0, deflected: 0, time: 0, combo: 0, maxCombo: 0, cleanNights: 0, lastDamageHope: 0 };
function hopeAdd(v) { ledger.hope = clamp(ledger.hope + v, 0, 100); }
// one accident shouldn't sink a session: at most 10 Hope lost in any 5 s window
let hopeWinT = -99, hopeWinLoss = 0;
function hopeHit(v) {
  if (ledger.time - hopeWinT > 5) { hopeWinT = ledger.time; hopeWinLoss = 0; }
  const take = Math.max(0, Math.min(v, 10 - hopeWinLoss)); hopeWinLoss += take; hopeAdd(-take);
}
function addSave(n, pos, why) {
  ledger.saves += n; hopeAdd(2 * n); SFX.good();
  if (pos) celebrate(pos, 45);
  toast((why || 'Saved') + (n > 1 ? ` ×${n}` : ''), 'good');
  checkUnlocks();
}
const UNLOCKS = [
  { id: 'boom', name: 'Glass-safe sonic boom', test: () => ledger.saves >= 10, desc: 'Save 10 people' },
  { id: 'land', name: 'Shockwave landing', test: () => ledger.hope >= 70, desc: 'Reach 70 Hope' },
  { id: 'speed', name: 'Top speed raised to Mach 3 at sea level', test: () => ledger.resolved >= 4, desc: 'Resolve 4 emergencies' },
  { id: 'beam', name: 'Overcharged heat vision', test: () => ledger.medals.gold >= 3, desc: 'Earn 3 gold medals' }
];
const unlocked = new Set();
function checkUnlocks() {
  for (const u of UNLOCKS) if (!unlocked.has(u.id) && u.test()) { unlocked.add(u.id); toast('Unlocked: ' + u.name, 'good'); }
}

// ============================================================ HUD
const $ = id => document.getElementById(id);
const hud = $('hud'), toastsEl = $('toasts'), markersEl = $('markers');
const lastToast = {};
function toast(msg, kind) {
  const now = performance.now(); if (lastToast[msg] && now - lastToast[msg] < 3000) return; lastToast[msg] = now;
  const d = document.createElement('div'); d.className = 'toast ' + (kind || ''); d.textContent = msg; toastsEl.prepend(d);
  setTimeout(() => d.classList.add('out'), 3800); setTimeout(() => d.remove(), 4400);
  while (toastsEl.children.length > 4) toastsEl.lastChild.remove();
}
const chips = {}; document.querySelectorAll('.chip').forEach(c => { chips[c.dataset.p] = c; });
const markerPool = [];
function markers(list) {
  while (markerPool.length < list.length) { const d = document.createElement('div'); d.className = 'mk'; d.innerHTML = '<span></span><b></b>'; markersEl.appendChild(d); markerPool.push(d); }
  const w = innerWidth, h = innerHeight;
  for (let i = 0; i < markerPool.length; i++) {
    const d = markerPool[i], m = list[i];
    if (!m) { if (d.style.display !== 'none') d.style.display = 'none'; continue; }
    T1.copy(m.pos).project(camera);
    let x = (T1.x * 0.5 + 0.5) * w, y = (-T1.y * 0.5 + 0.5) * h, behind = T1.z > 1, edge = false;
    if (behind) { x = w - x; y = h - 20; edge = true; }
    if (x < 30 || x > w - 30 || y < 60 || y > h - 30) edge = true;
    x = clamp(x, 30, w - 30); y = clamp(y, 60, h - 30);
    if (d.style.display) d.style.display = '';
    const cls = 'mk ' + m.cls + (edge ? ' edge' : ''); if (d._c !== cls) d.className = d._c = cls;
    d.style.transform = `translate(${x | 0}px,${y | 0}px) translate(-50%,-100%)`;
    if (d._l !== m.label) d.firstChild.textContent = d._l = m.label;
    const sub = m.sub || ''; if (d._s !== sub) d.lastChild.textContent = d._s = sub;
  }
}

// ============================================================ fires
const fires = new Set();
function igniteBlock(g, I) {
  if (!alive[g] || fireI[g] > 0 || frost[g] > 0.4 || fires.size > 260) return;
  fireI[g] = I || 0.25; fires.add(g);
}
function exposedFace(g, o) {
  const b = buildings[blkB[g]], x = blkX[g], y = blkY[g], z = blkZ[g];
  const opts = [];
  const free = (cx, cy, cz) => cx < 0 || cz < 0 || cy < 0 || cx >= b.nx || cz >= b.nz || cy >= b.ny || !alive[cellIndex(b, cx, cy, cz)];
  if (free(x + 1, y, z)) opts.push(0); if (free(x - 1, y, z)) opts.push(1); if (free(x, y, z + 1)) opts.push(2); if (free(x, y, z - 1)) opts.push(3); if (free(x, y + 1, z)) opts.push(4);
  if (!opts.length) return false;
  blockCenter(g, o); const f = pick(opts);
  if (f === 0) o.x += 2.7; else if (f === 1) o.x -= 2.7; else if (f === 2) o.z += 2.7; else if (f === 3) o.z -= 2.7; else o.y += 2.1;
  if (f < 4) { o.x += f >= 2 ? R(-2, 2) : 0; o.z += f < 2 ? R(-2, 2) : 0; o.y += R(-1.5, 1); }
  return true;
}
const FIRE_NB = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
function updateFires(dt) {
  let loud = 0;
  for (const g of fires) {
    if (!alive[g]) { fires.delete(g); fireI[g] = 0; continue; }
    let I = fireI[g];
    if (I <= 0) { fires.delete(g); fireI[g] = 0; blockCenter(g, T1); for (let k = 0; k < 4; k++) FX.steam(T1.x + R(-2, 2), T1.y + R(-1, 2), T1.z + R(-2, 2)); continue; }
    I = Math.min(1, I + 0.03 * dt); fireI[g] = I; burn[g] += I * dt;
    if (heat[g] < 0.3 * I) setBlockHeat(g, 0.3 * I);
    const cd = camera.position.distanceTo(blockCenter(g, T2));
    if (cd < 900 && rnd() < I * 0.7 && exposedFace(g, T1)) {
      FX.fire(T1.x, T1.y, T1.z, 1.1 * I + 0.3);
      if (rnd() < 0.35) FX.smoke(T1.x, T1.y + 2, T1.z, 1.3 * I + 0.4);
    }
    if (cd < 120) loud += I / (1 + cd / 30);
    const b = buildings[blkB[g]], x = blkX[g], y = blkY[g], z = blkZ[g];
    for (let k = 0; k < 6; k++) {
      const pr = I * 0.03 * dt * (k === 4 ? 2.2 : k === 5 ? 0.4 : 1);
      if (rnd() < pr) {
        const cx = x + FIRE_NB[k][0], cy = y + FIRE_NB[k][1], cz = z + FIRE_NB[k][2];
        if (cx >= 0 && cz >= 0 && cy >= 0 && cx < b.nx && cz < b.nz && cy < b.ny) igniteBlock(cellIndex(b, cx, cy, cz), 0.15);
      }
    }
    if (burn[g] > (blkT[g] === T_COL ? 80 : 45)) { breakBlock(g, T3.set(R(-1, 1), -1, R(-1, 1)), 1, 'fire'); }
  }
  if (AU.ctx) AU.fireL.g.gain.setTargetAtTime(AU.muted ? 0 : Math.min(0.5, loud * 0.4), AU.ctx.currentTime, 0.2);
}

// ============================================================ destruction
const dirtyBuildings = new Set();
const _bbVel = new V3();
function breakBlock(g, vel, pieces, cause) {
  if (!alive[g]) return;
  vel = _bbVel.copy(vel); // callers pass shared scratch vectors that the piece placement below reuses
  alive[g] = 0; pendingFall[g] = 0; hideBlock(g); dropAttachments(g);
  const b = buildings[blkB[g]], t = blkT[g];
  dirtyBuildings.add(b);
  const c = blockCenter(g, new V3());
  const dy = dropY[g]; c.y -= dy; dropY[g] = 0; dropV[g] = 0;
  if (t === T_SLAB) c.y = blockY0(g) + SLAB_H / 2 - dy;
  const cost = t === T_GLASS ? 90000 : t === T_COL ? 320000 : 160000;
  ledger.damage += cost; if (currentInc && cause !== 'fire') currentInc.damage += cost;
  if (fireI[g] > 0) { fires.delete(g); fireI[g] = 0; }
  const col = new THREE.Color(blkColor[g * 3], blkColor[g * 3 + 1], blkColor[g * 3 + 2]);
  const h = heat[g], f = frost[g];
  setBlockHeat(g, 0); setBlockFrost(g, 0);
  if (t === T_GLASS) {
    for (let k = 0; k < 26; k++) FX.glass(c.x + R(-2.5, 2.5), c.y + R(-2, 2), c.z + R(-2.5, 2.5), vel.x * 0.4 + R(-6, 6), vel.y * 0.4 + R(-2, 6), vel.z * 0.4 + R(-6, 6));
    SFX.glass(c);
  }
  if (cause === 'melt') {
    for (let k = 0; k < 18; k++) FX.molten(c.x + R(-2, 2), c.y + R(-1.5, 1.5), c.z + R(-2, 2), R(-1, 1), R(-1, 2), R(-1, 1));
    for (let k = 0; k < 6; k++) FX.smoke(c.x, c.y, c.z, 1, 0.05);
  } else if (cause !== 'boom') {
    const hy = t === T_SLAB ? SLAB_H / 2 : STORY / 2;
    if (pieces <= 1) {
      spawnDebris(c, 2.45, hy * 0.98, 2.45, vel, t, col, h, f, 0.3, false, blkStyle[g] & 7);
    } else {
      const ex = t === T_GLASS ? 0.55 : 1, layers = pieces >= 8 && t !== T_SLAB ? [-1, 1] : [0];
      for (const sy of layers) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const hy2 = layers.length > 1 ? hy * 0.47 : hy * 0.95;
        spawnDebris(T1.set(c.x + sx * 1.25, c.y + sy * hy * 0.5, c.z + sz * 1.25), 1.2 * ex * R(0.75, 1), hy2 * (t === T_GLASS ? 0.5 : 1), 1.2 * ex * R(0.75, 1),
          T2.copy(vel).add(T3.set(sx * R(1, 5), R(0, 5) + sy * 2, sz * R(1, 5))), t, col, h, f, 3, false, blkStyle[g] & 7);
      }
    }
    for (let k = 0; k < 8; k++) FX.dust(c.x + R(-2, 2), c.y + R(-1, 1), c.z + R(-2, 2), vel.x * 0.15 + R(-2, 2), R(-1, 2), vel.z * 0.15 + R(-2, 2), 1);
  }
  // wake anything resting nearby, free trapped people
  for (const o of bodies) if (o.sleeping && o.pos.distanceToSquared(c) < 64) wake(o);
  rubbleNear(c, 6, r => { if (r.pos.y > c.y - 1) reviveRubble(r, null); });
  for (const p of people) if (p.mode === 'trapped' && p.trapCell === g) { knock(p, T1.copy(vel).multiplyScalar(0.3), false); p.danger = true; }
  for (const p of people) if ((p.mode === 'free' || p.mode === 'cheer') && p.pos.distanceToSquared(c) < 100 && c.y > 3) knock(p, T1.set(R(-2, 2), 0, R(-2, 2)), false);
}
// structure: anything no longer connected to the ground through solid blocks falls
const fallQueue = [];
const SPAN = 2; // a plate can hang this many cells from a supported column
function structuralCheck(b) {
  const N = b.nx * b.ny * b.nz, best = new Int8Array(N).fill(99), q = [];
  const push = (j, sp) => { if (sp < best[j]) { best[j] = sp; q.push(j); } };
  // the ground carries everything on the street-level floor
  for (let z = 0; z < b.nz; z++) for (let x = 0; x < b.nx; x++) { const i = z * b.nx + x; if (alive[b.start + i]) push(i, 0); }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], sp = best[i], g = b.start + i;
    const x = i % b.nx, t = (i / b.nx) | 0, z = t % b.nz, y = (t / b.nz) | 0;
    const isCol = bearing[g] && sp === 0;
    // columns stack on columns
    if (isCol && y + 1 < b.ny) { const j = i + b.nx * b.nz; if (alive[b.start + j] && bearing[b.start + j]) push(j, 0); }
    // floors and facade hang sideways from a supported column, up to SPAN cells
    if (sp + 1 > SPAN) continue;
    const side = (cx, cz) => {
      if (cx < 0 || cz < 0 || cx >= b.nx || cz >= b.nz) return;
      const j = (y * b.nz + cz) * b.nx + cx; const gj = b.start + j;
      if (!alive[gj]) return;
      if (bearing[gj]) return;              // a column must be carried from below
      push(j, sp + 1);
    };
    side(x + 1, z); side(x - 1, z); side(x, z + 1); side(x, z - 1);
    // the plate directly on top of a supported column (roof deck) is carried by it
    if (isCol && y + 1 < b.ny) { const j = i + b.nx * b.nz; if (alive[b.start + j] && !bearing[b.start + j]) push(j, 1); }
  }
  let fell = 0;
  for (let i = 0; i < N; i++) {
    const g = b.start + i;
    if (alive[g] && best[i] === 99 && !pendingFall[g]) { pendingFall[g] = 1; dropAttachments(g); dropY[g] = 0; dropV[g] = 0; fallQueue.push(g); fqSorted = false; fell++; }
  }
  if (fell > 12) {
    blockCenter(b.start + ((b.ny >> 1) * b.nz + (b.nz >> 1)) * b.nx + (b.nx >> 1), T1);
    toast(fell > 120 ? `${b.name}: the tower is coming down!` : `${b.name}: floors collapsing`, 'alert');
    SFX.crumble(T1, 2); addShake(Math.min(2, fell / 80) / (1 + camera.position.distanceTo(T1) / 150));
    scare(T1, 90, 10); hopeHit(Math.min(8, fell / 40));
    if (fell > 30) { // a billowing dust cloud rolls out through the streets
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, n = Math.min(260, 60 + fell / 3);
      for (let k = 0; k < n; k++) {
        const a = R(0, 6.28), s = R(6, 22), r0 = R(8, 18);
        SMK.emit(cx + Math.cos(a) * r0, R(0.5, 6), cz + Math.sin(a) * r0, Math.cos(a) * s, R(0.5, 4), Math.sin(a) * s, R(6, 11), R(5, 9), R(22, 34), 0.5, 0.46, 0.4, 0.75, 0.62, 0.58, 0.52, 0.0, 0.35);
      }
    }
  }
}
let fqSorted = true;
function processFallQueue(dt) {
  // unsupported plates become real bodies as live slots free up, lowest first
  if (!fallQueue.length) return;
  if (!fqSorted) { fallQueue.sort((a, b) => blkY[a] - blkY[b]); fqSorted = true; }
  let n = 0, head = 0;
  while (head < fallQueue.length && liveDebrisCount < LIVE_CAP && n < 30) {
    const g = fallQueue[head++]; if (!alive[g]) continue;
    breakBlock(g, T1.set(R(-0.6, 0.6), -dropV[g], R(-0.6, 0.6)), 1, 'collapse'); n++;
  }
  if (head) fallQueue.splice(0, head);
  // the rest drop kinematically so the tower never hangs in the air
  for (let k = fallQueue.length - 1; k >= 0; k--) {
    const g = fallQueue[k]; if (!alive[g]) { fallQueue.splice(k, 1); continue; }
    const floor = blkY[g] * STORY + STORY / 2 - dropY[g];
    if (floor <= STORY / 2 + 0.01) { dropV[g] = 0; continue; }
    dropV[g] = Math.min(dropV[g] + G * dt, 40); dropY[g] = Math.min(dropY[g] + dropV[g] * dt, blkY[g] * STORY);
    const t = blkT[g], m = typeMesh[t];
    blockCenter(g, T2); T2.y -= dropY[g]; TM.makeTranslation(T2.x, T2.y, T2.z); m.setMatrixAt(blkSub[g], TM); typeDirty[t] = true;
  }
}
function explode(pos, energy, opts) {
  opts = opts || {};
  const Rr = clamp(Math.cbrt(energy) / 18, 4, 48);
  const c = pos.clone();
  for (let k = 0; k < 90; k++) {
    const v = T1.set(R(-1, 1), R(-0.2, 1), R(-1, 1)).normalize().multiplyScalar(R(4, 18) * Rr / 14);
    ADD.emit(c.x, c.y, c.z, v.x, v.y, v.z, R(0.5, 1.3), R(2, 5) * Rr / 12, R(0.5, 1.5), 8, 3.2, 0.6, 1, 2, 0.2, 0.02, -0.15, 1.6);
  }
  for (let k = 0; k < 50; k++) FX.smoke(c.x + R(-Rr, Rr) * 0.4, c.y + R(0, Rr * 0.4), c.z + R(-Rr, Rr) * 0.4, Rr / 7, 0.04);
  for (let k = 0; k < 60; k++) FX.spark(c.x, c.y, c.z, R(-30, 30), R(0, 35), R(-30, 30));
  flashLight(c, 60 * Rr, Rr * 8);
  ring(T1.set(c.x, Math.max(c.y, 0.3), c.z), UP, 1, Rr * 2.2, 0.7, new THREE.Color(2.5, 1.6, 0.9), 0.7);
  if (c.y < 3 && !inBay(c.z)) addDecal('crater', c.x, 0, c.z, Rr * 0.5);
  SFX.boom(c, Math.min(2, Rr / 12));
  addShake(Math.min(2.5, Rr / 8) / (1 + camera.position.distanceTo(c) / 120));
  const R2 = Rr * 2;
  for (const b of bodies) {
    if (b === opts.src || b.dead || b.held) continue;
    const d = b.pos.distanceTo(c); if (d > R2) continue;
    const dv = clamp(Math.sqrt(2 * energy * 0.04 / b.mass) * (1 - d / R2) ** 2, 0, 110);
    const dir = T1.copy(b.pos).sub(c); dir.y += d * 0.4; dir.normalize();
    b.vel.addScaledVector(dir, dv); b.angVel.add(T2.set(R(-1, 1), R(-1, 1), R(-1, 1)).multiplyScalar(dv * 0.15)); wake(b);
    if (b.kind === 'car') { disturbCar(b); damageCar(b, dv * 2); if (d < Rr * 0.6 && !b.exploded && rnd() < 0.5) setTimeout(() => explodeCar(b), R(200, 900)); }
    if (b.kind === 'heli' || b.kind === 'meteor') b.hp -= dv;
  }
  rubbleNear(c, R2, r => {
    const d = r.pos.distanceTo(c); if (d > R2) return;
    const dv = clamp(Math.sqrt(2 * energy * 0.04 / r.mass) * (1 - d / R2) ** 2, 0, 80); if (dv < 2) return;
    const dir = T1.copy(r.pos).sub(c); dir.y += d * 0.4; dir.normalize();
    reviveRubble(r, dir.multiplyScalar(dv));
  });
  for (const p of people) {
    if (p.mode === 'gone' || p.mode === 'safe' || p.mode === 'held') continue;
    const d = p.pos.distanceTo(c); if (d > R2) continue;
    if (p.mode === 'trapped') continue;
    const dir = T1.copy(p.pos).sub(c); dir.y += d * 0.6; dir.normalize();
    knock(p, dir.multiplyScalar(clamp(30 * (1 - d / R2), 2, 25)), d < Rr * 0.8);
  }
  scare(c, R2 * 3, 10);
  // structure: break blocks within the blast core, ignite and shatter windows further out
  const Rb = clamp(Math.cbrt(energy / BREAK_E[T_SLAB]) * 2.2, 0, 16);
  forBlocksInSphere(c, Rr, (g, d) => {
    if (d < Rb && energy > BREAK_E[blkT[g]] * 0.5) breakBlock(g, T1.copy(blockCenter(g, T2)).sub(c).normalize().multiplyScalar(25 * (1 - d / Rb) + 4), 4, 'blast');
    else if (blkT[g] === T_GLASS && d < Rr) breakBlock(g, T1.copy(blockCenter(g, T2)).sub(c).normalize().multiplyScalar(14), 1, 'boom');
    else if (rnd() < 0.15) igniteBlock(g, 0.3);
  });
  const pd = P.pos.distanceTo(c);
  if (pd < R2) { P.vel.addScaledVector(T1.copy(P.pos).sub(c).normalize(), 22 * (1 - pd / R2)); P.hitT = 0.4; }
}
const _fbsC = new V3();
function forBlocksInSphere(c0, r, cb) {
  const c = _fbsC.copy(c0); // callbacks reuse T1..T6, so work from a private copy
  for (const b of buildings) {
    if (c.x + r < b.x0 || c.x - r > b.x1 || c.z + r < b.z0 || c.z - r > b.z1 || c.y - r > b.h) continue;
    const x0 = clamp(Math.floor((c.x - r - b.x0) / CELL), 0, b.nx - 1), x1 = clamp(Math.floor((c.x + r - b.x0) / CELL), 0, b.nx - 1);
    const z0 = clamp(Math.floor((c.z - r - b.z0) / CELL), 0, b.nz - 1), z1 = clamp(Math.floor((c.z + r - b.z0) / CELL), 0, b.nz - 1);
    const y0 = clamp(Math.floor((c.y - r) / STORY), 0, b.ny - 1), y1 = clamp(Math.floor((c.y + r) / STORY), 0, b.ny - 1);
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const g = cellIndex(b, x, y, z); if (!alive[g]) continue;
      const d = blockCenter(g, T5).distanceTo(c); if (d <= r) cb(g, d);
    }
  }
}

// ============================================================ raycast
const SL = { t0: 0, t1: 0, ax: 0 };
function slab(o, d, x0, y0, z0, x1, y1, z1) {
  let t0 = -Infinity, t1 = Infinity, ax = -1;
  const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z], lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(da[a]) < 1e-9) { if (oa[a] < lo[a] || oa[a] > hi[a]) return false; continue; }
    let ta = (lo[a] - oa[a]) / da[a], tb = (hi[a] - oa[a]) / da[a];
    if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
    if (ta > t0) { t0 = ta; ax = a; } if (tb < t1) t1 = tb; if (t0 > t1) return false;
  }
  SL.t0 = t0; SL.t1 = t1; SL.ax = ax; return true;
}
function rayBuilding(b, o, d, tA, tB, out) {
  const t = tA + 1e-4;
  const px = o.x + d.x * t - b.x0, py = o.y + d.y * t, pz = o.z + d.z * t - b.z0;
  let cx = clamp(Math.floor(px / CELL), 0, b.nx - 1), cy = clamp(Math.floor(py / STORY), 0, b.ny - 1), cz = clamp(Math.floor(pz / CELL), 0, b.nz - 1);
  const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
  const dX = d.x !== 0 ? Math.abs(CELL / d.x) : Infinity, dY = d.y !== 0 ? Math.abs(STORY / d.y) : Infinity, dZ = d.z !== 0 ? Math.abs(CELL / d.z) : Infinity;
  let mX = d.x !== 0 ? ((sx > 0 ? (cx + 1) * CELL : cx * CELL) - px) / d.x : Infinity;
  let mY = d.y !== 0 ? ((sy > 0 ? (cy + 1) * STORY : cy * STORY) - py) / d.y : Infinity;
  let mZ = d.z !== 0 ? ((sz > 0 ? (cz + 1) * CELL : cz * CELL) - pz) / d.z : Infinity;
  let tc = t, axis = SL.ax;
  for (let n = 0; n < 300; n++) {
    const g = cellIndex(b, cx, cy, cz);
    if (alive[g]) {
      if (blkT[g] !== T_SLAB) { out.t = tc; out.g = g; out.axis = axis; return true; }
      const wx = b.x0 + cx * CELL, wz = b.z0 + cz * CELL;
      const sv = { t0: SL.t0, t1: SL.t1, ax: SL.ax };
      if (slab(o, d, wx, cy * STORY, wz, wx + CELL, cy * STORY + SLAB_H, wz + CELL) && SL.t0 <= tB) {
        out.t = Math.max(SL.t0, tc); out.g = g; out.axis = SL.ax; SL.t0 = sv.t0; SL.t1 = sv.t1; SL.ax = sv.ax; return true;
      }
      SL.t0 = sv.t0; SL.t1 = sv.t1; SL.ax = sv.ax;
    }
    if (mX < mY && mX < mZ) { cx += sx; tc = t + mX; mX += dX; axis = 0; if (cx < 0 || cx >= b.nx) return false; }
    else if (mY < mZ) { cy += sy; tc = t + mY; mY += dY; axis = 1; if (cy < 0 || cy >= b.ny) return false; }
    else { cz += sz; tc = t + mZ; mZ += dZ; axis = 2; if (cz < 0 || cz >= b.nz) return false; }
    if (tc > tB) return false;
  }
  return false;
}
function raycast(o, d, maxT, opts) {
  opts = opts || {};
  const hit = { t: maxT, type: '', g: -1, body: null, point: new V3(), normal: new V3() };
  const out = {};
  for (const b of buildings) {
    if (!slab(o, d, b.x0, 0, b.z0, b.x1, b.h, b.z1)) continue;
    if (SL.t1 < 0 || SL.t0 > hit.t) continue;
    if (rayBuilding(b, o, d, Math.max(0, SL.t0), Math.min(SL.t1, hit.t), out) && out.t < hit.t) {
      hit.t = out.t; hit.type = 'block'; hit.g = out.g;
      const dc = [d.x, d.y, d.z][out.axis]; hit.normal.set(0, 0, 0).setComponent(out.axis, dc > 0 ? -1 : 1);
    }
  }
  if (opts.bodies !== false) {
    const test = (b) => {
      const ox = b.pos.x - o.x, oy = b.pos.y - o.y, oz = b.pos.z - o.z;
      const tc = ox * d.x + oy * d.y + oz * d.z; if (tc < 0 || tc - b.rad > hit.t) return;
      const d2 = ox * ox + oy * oy + oz * oz - tc * tc, r = b.rad * 1.1; if (d2 > r * r) return;
      const th = tc - Math.sqrt(r * r - d2); if (th < hit.t && th > 0) { hit.t = th; hit.type = 'body'; hit.body = b; }
    };
    for (const b of bodies) if (!b.dead && !b.held) test(b);
    if (opts.people !== false) for (const p of people) if (p.mode !== 'gone' && p.mode !== 'held' && p.mode !== 'trapped') test(p);
    if (opts.rubble) rubbleNear(T1.copy(o).addScaledVector(d, Math.min(maxT, 60) / 2), Math.min(maxT, 60) / 2 + 3, r => {
      const before = hit.body; test(r); if (hit.body === r) hit.type = 'rubble'; else hit.body = before;
    });
  }
  if (d.y < 0) {
    const tg = (0 - o.y) / d.y;
    if (tg > 0 && tg < hit.t) {
      const x = o.x + d.x * tg, z = o.z + d.z * tg;
      if (!inBay(z)) { hit.t = tg; hit.type = 'ground'; hit.normal.set(0, 1, 0); }
      else { const tw = (WATER_Y - o.y) / d.y; if (tw < hit.t) { hit.t = tw; hit.type = onIce(o.x + d.x * tw, o.z + d.z * tw) ? 'ice' : 'water'; hit.normal.set(0, 1, 0); } }
    }
  }
  hit.point.copy(o).addScaledVector(d, hit.t);
  if (hit.type === 'body' || hit.type === 'rubble') hit.normal.copy(hit.point).sub(hit.body.pos).normalize();
  return hit;
}

// ============================================================ physics
const hash = new Map();
const hk = skey;
function hashInsert(b) {
  const k = hk(Math.floor(b.pos.x / SH), Math.floor(b.pos.y / SH), Math.floor(b.pos.z / SH));
  let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(b);
}
function stepBody(b, h) {
  if (b.held || b.sleeping || b.dead) return;
  const p = b.pos, v = b.vel;
  b.age += h;
  if (!b.noGrav) v.y -= G * h * (b.gScale || 1);
  const sp2 = v.lengthSq();
  if (sp2 > 1 && !b.noDrag) {
    const sp = Math.sqrt(sp2), k = 0.5 * airRho(p.y) * b.cd * b.area * sp / b.mass;
    v.multiplyScalar(1 / (1 + k * h));
  }
  // water: buoyancy from displaced volume; cars flood and sink
  if (inBay(p.z) && p.y - b.half.y < WATER_Y && !onIce(p.x, p.z)) {
    const sub = clamp((WATER_Y - (p.y - b.half.y)) / (2 * b.half.y), 0, 1);
    if (b.kind === 'car') { b.flood = Math.min(1, (b.flood || 0) + 0.035 * h); if (rnd() < 0.3) FX.water(p.x + R(-1, 1), WATER_Y, p.z + R(-1, 1), R(-0.5, 0.5), R(0.5, 1.5), R(-0.5, 0.5)); }
    const vol = b.kind === 'car' ? b.dispVol * 0.55 * (1 - b.flood) + 1.6 : b.dispVol;
    v.y += 1000 * vol * sub * G / b.mass * h;
    v.multiplyScalar(1 / (1 + 2.2 * sub * h)); b.angVel.multiplyScalar(1 / (1 + 2.5 * sub * h));
    if (!b.wet) {
      b.wet = true; const s = Math.min(3, v.length() / 8);
      for (let k = 0; k < 30 * s + 6; k++) FX.water(p.x, WATER_Y, p.z, R(-6, 6) * s, R(4, 14) * s, R(-6, 6) * s);
      SFX.splash(p); if (b.heat > 0.3 || b.kind === 'meteor') for (let k = 0; k < 20; k++) FX.steam(p.x + R(-2, 2), WATER_Y, p.z + R(-2, 2));
    }
  }
  p.addScaledVector(v, h);
  const w = b.angVel, wl = w.length();
  if (wl > 1e-4) { TQ.setFromAxisAngle(T6.copy(w).divideScalar(wl), wl * h); b.quat.premultiply(TQ); b.quat.normalize(); }
  b.onGround = false;
  groundCollide(b);
  buildingCollide(b);
  { const n = pushOutColliders(p, b.rad, v, b.rest); if (n && n.y > 0.5) b.onGround = true; }
  if (b.kind === 'debris' || b.kind === 'car') staticCollide(b);
  if (p.y < SEAFLOOR - 20 || Math.abs(p.x) > 60000 || Math.abs(p.z) > 60000 || p.y > 200000) { removeBody(b); return; }
  // sleep
  if (v.lengthSq() < 0.12 && w.lengthSq() < 0.12 && (b.onGround || b.wet)) { b.sleepT += h; if (b.sleepT > 0.7) { b.sleeping = true; v.set(0, 0, 0); w.set(0, 0, 0); } }
  else b.sleepT = 0;
  if (b.onGround) w.multiplyScalar(1 / (1 + 2.5 * h));
}
const CORN = [];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) CORN.push([sx, sy, sz]);
function groundCollide(b) {
  const p = b.pos, gy = groundY(p.x, p.z);
  const bound = b.half.length();
  if (p.y - bound > gy) return;
  let maxPen = 0, impact = 0;
  const v = b.vel, w = b.angVel;
  for (const c of CORN) {
    const r = T3.set(c[0] * b.half.x, c[1] * b.half.y, c[2] * b.half.z).applyQuaternion(b.quat);
    const pen = gy - (p.y + r.y); if (pen <= 0) continue;
    if (pen > maxPen) maxPen = pen;
    const vpx = v.x + (w.y * r.z - w.z * r.y), vpy = v.y + (w.z * r.x - w.x * r.z), vpz = v.z + (w.x * r.y - w.y * r.x);
    if (vpy >= 0) continue;
    impact = Math.max(impact, -vpy);
    const e = vpy < -3 ? b.rest : 0;
    const den = b.invM + (r.x * r.x + r.z * r.z) * b.invI;
    const j = -(1 + e) * vpy / den;
    v.y += j * b.invM;
    w.x += -r.z * j * b.invI; w.z += r.x * j * b.invI;
    const vtl = Math.hypot(vpx, vpz);
    if (vtl > 1e-4) {
      const tx = vpx / vtl, tz = vpz / vtl;
      const cx = r.y * tz, cy = r.z * tx - r.x * tz, cz = -r.y * tx;
      const denT = b.invM + (cx * cx + cy * cy + cz * cz) * b.invI;
      const jt = Math.min(b.mu * j, vtl / denT);
      v.x -= tx * jt * b.invM; v.z -= tz * jt * b.invM;
      w.x -= cx * jt * b.invI; w.y -= cy * jt * b.invI; w.z -= cz * jt * b.invI;
    }
  }
  if (maxPen > 0) { p.y += maxPen * 0.85; b.onGround = true; if (impact > 2.5) onImpact(b, impact, 'ground'); }
}
function buildingCollide(b) {
  const p = b.pos, r = b.rad;
  if (p.y - r > MAXH) return;
  const bd = buildingAt(p.x, p.z); if (!bd || p.y - r > bd.h) return;
  const x0 = Math.max(0, Math.floor((p.x - r - bd.x0) / CELL)), x1 = Math.min(bd.nx - 1, Math.floor((p.x + r - bd.x0) / CELL));
  const z0 = Math.max(0, Math.floor((p.z - r - bd.z0) / CELL)), z1 = Math.min(bd.nz - 1, Math.floor((p.z + r - bd.z0) / CELL));
  const y0 = Math.max(0, Math.floor((p.y - r) / STORY)), y1 = Math.min(bd.ny - 1, Math.floor((p.y + r) / STORY));
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const g = cellIndex(bd, x, y, z); if (!alive[g] || pendingFall[g]) continue;
    const ax0 = bd.x0 + x * CELL, az0 = bd.z0 + z * CELL, ay0 = blockY0(g), ay1 = blockY1(g);
    const cx = clamp(p.x, ax0, ax0 + CELL), cy = clamp(p.y, ay0, ay1), cz = clamp(p.z, az0, az0 + CELL);
    let nx = p.x - cx, ny = p.y - cy, nz = p.z - cz, d2 = nx * nx + ny * ny + nz * nz;
    if (d2 >= r * r) continue;
    let d = Math.sqrt(d2), pen;
    if (d < 1e-5) {
      const dxm = p.x - ax0, dxp = ax0 + CELL - p.x, dym = p.y - ay0, dyp = ay1 - p.y, dzm = p.z - az0, dzp = az0 + CELL - p.z;
      const m = Math.min(dxm, dxp, dym, dyp, dzm, dzp);
      nx = ny = nz = 0;
      if (m === dyp) ny = 1; else if (m === dym) ny = -1; else if (m === dxm) nx = -1; else if (m === dxp) nx = 1; else if (m === dzm) nz = -1; else nz = 1;
      pen = m + r;
    } else { nx /= d; ny /= d; nz /= d; pen = r - d; }
    const vn = b.vel.x * nx + b.vel.y * ny + b.vel.z * nz;
    if (vn < 0) {
      const sp = -vn, E = 0.5 * b.mass * sp * sp, need = BREAK_E[blkT[g]];
      if (sp > 11 && E > need) {
        breakBlock(g, T4.copy(b.vel).multiplyScalar(0.5), blkT[g] === T_GLASS ? 1 : 4, 'impact');
        b.vel.multiplyScalar(Math.sqrt(Math.max(0.05, (E - need) / E)));
        onImpact(b, sp, 'block');
        continue;
      }
      if (sp > 2.5) onImpact(b, sp, 'block');
      b.vel.x -= nx * vn * (1 + b.rest); b.vel.y -= ny * vn * (1 + b.rest); b.vel.z -= nz * vn * (1 + b.rest);
      b.vel.multiplyScalar(0.92);
    }
    if (b.held) continue;
    p.x += nx * pen; p.y += ny * pen; p.z += nz * pen;
    if (ny > 0.6) b.onGround = true;
  }
}
function staticCollide(b) {
  // only the cells the body overlaps; no closure allocation (this runs per awake body per substep)
  const p = b.pos, rr = b.rad + 2.6;
  const x0 = Math.floor((p.x - rr) / SH), x1 = Math.floor((p.x + rr) / SH);
  const y0 = Math.floor((p.y - rr) / SH), y1 = Math.floor((p.y + rr) / SH);
  const z0 = Math.floor((p.z - rr) / SH), z1 = Math.floor((p.z + rr) / SH);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
    const a = staticHash.get(skey(cx, cy, cz)); if (!a) continue;
    for (let i = a.length - 1; i >= 0; i--) {
      const r = a[i];
      const dx = p.x - r.pos.x, dy = p.y - r.pos.y, dz = p.z - r.pos.z, rs2 = b.rad + r.rad;
      const d2 = dx * dx + dy * dy + dz * dz; if (d2 >= rs2 * rs2) continue;
      const d = Math.sqrt(d2) || 1e-4, nx = dx / d, ny = dy / d, nz = dz / d, pen = rs2 - d;
      const vn = b.vel.x * nx + b.vel.y * ny + b.vel.z * nz;
      if (vn < -14 && 0.5 * b.mass * vn * vn > 3e6 && reviveRubble(r, T4.copy(b.vel).multiplyScalar(0.5))) continue;
      p.x += nx * pen * 0.8; p.y += ny * pen * 0.8; p.z += nz * pen * 0.8;
      if (vn < 0) { b.vel.x -= nx * vn * 1.1; b.vel.y -= ny * vn * 1.1; b.vel.z -= nz * vn * 1.1; b.vel.multiplyScalar(0.9); b.angVel.multiplyScalar(0.9); }
      if (ny > 0.5) b.onGround = true;
    }
  }
}
let lastCrackT = 0;
function onImpact(b, sp, kind) {
  b.impact = Math.max(b.impact, sp);
  const p = b.pos;
  if (sp > 6 && camera.position.distanceToSquared(p) < 400 * 400) {
    const n = Math.min(14, sp * 0.5) | 0;
    for (let k = 0; k < n; k++) FX.dust(p.x + R(-1, 1) * b.half.x, p.y - b.half.y * 0.6, p.z + R(-1, 1) * b.half.z, R(-3, 3), R(0, 2), R(-3, 3), Math.min(1.5, b.rad / 1.5));
    if (b.kind === 'debris') SFX.crumble(p, Math.min(1.5, b.mass / 30000 * sp / 15)); else if (b.kind === 'car') SFX.punch(p, 0.5);
    if (b.mass > 20000 && sp > 12) addShake(Math.min(1, b.mass / 60000 * sp / 30) / (1 + camera.position.distanceTo(p) / 60));
  }
  if (b.kind === 'debris' && kind === 'ground' && b.mass > 15000 && sp > 13 && simT - lastCrackT > 0.15 && !inBay(p.z)) {
    lastCrackT = simT; addDecal('crater', p.x, 0, p.z, Math.min(4.5, Math.cbrt(b.mass) / 14 * sp / 20));
  }
  if (b.kind === 'debris') {
    if (b.full && sp > 15 && kind === 'ground' && liveDebrisCount < LIVE_CAP - 4) shatter(b, false);
    if (b.frost > 0.75 && sp > 10) shatter(b, true);
  } else if (b.kind === 'car') {
    damageCar(b, sp); if (b.heat > 0.7 && sp > 12) explodeCar(b); if (sp > 40 && !b.exploded) explodeCar(b);
    if (b.frost > 0.75 && sp > 12) shatterCar(b);
  } else if (b.kind === 'person') {
    if (sp > 10.5) injurePerson(b);
  } else if (b.kind === 'heli') heliImpact(b, sp);
  else if (b.kind === 'meteor') meteorImpact(b);
}
function shatter(b, ice) {
  if (b.dead) return;
  const pos = b.pos.clone(), vel = b.vel.clone(), h = b.half;
  removeBody(b);
  if (ice) { for (let k = 0; k < 40; k++) FX.ice(pos.x, pos.y, pos.z, R(-8, 8), R(0, 10), R(-8, 8)); SFX.glass(pos); }
  const q = b.quat;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const off = T1.set(sx * h.x * 0.5, 0, sz * h.z * 0.5).applyQuaternion(q);
    const d = spawnDebris(T2.copy(pos).add(off), h.x * 0.48, h.y * 0.95, h.z * 0.48, T3.copy(vel).multiplyScalar(0.4).add(off.multiplyScalar(1.8)).setY(Math.abs(vel.y) * 0.15 + R(1, 4)), b.btype, b.color, b.heat, b.frost * 0.5, 3, true, b.style);
    if (d) d.quat.copy(q);
  }
  for (let k = 0; k < 10; k++) FX.dust(pos.x, pos.y, pos.z, R(-4, 4), R(0, 3), R(-4, 4), 1.2);
}
function shatterCar(c) {
  if (c.dead) return; const p = c.pos.clone();
  for (let k = 0; k < 70; k++) FX.ice(p.x + R(-2, 2), p.y + R(-0.5, 1), p.z + R(-1, 1), R(-10, 10), R(0, 10), R(-10, 10));
  for (let k = 0; k < 40; k++) FX.glass(p.x, p.y, p.z, R(-9, 9), R(0, 9), R(-9, 9));
  SFX.glass(p); removeBody(c); ledger.damage += 40000; toast('Frozen steel is brittle. The car shattered.', 'ice');
}
function physStep(h) {
  for (let i = 0; i < bodies.length; i++) stepBody(bodies[i], h);
  for (const p of people) if (p.mode === 'phys') stepBody(p, h);
  hash.clear();
  for (const b of bodies) if (!b.dead) hashInsert(b);
  for (const p of people) if (p.mode === 'phys' || p.mode === 'held') hashInsert(p);
  for (const b of bodies) if (!b.dead && (!b.sleeping || b.held)) collideNeighbors(b);
  for (const p of people) if (p.mode === 'phys' && !p.sleeping) collideNeighbors(p);
}
function collideNeighbors(a) {
  const cx = Math.floor(a.pos.x / SH), cy = Math.floor(a.pos.y / SH), cz = Math.floor(a.pos.z / SH);
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
    const arr = hash.get(hk(x, y, z)); if (!arr) continue;
    for (const o of arr) {
      if (o === a) continue;
      const oAwake = !o.sleeping || o.held;
      if (oAwake && o.id < a.id) continue;
      resolvePair(a, o);
    }
  }
}
function resolvePair(a, b) {
  const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z, rs2 = a.rad + b.rad;
  const d2 = dx * dx + dy * dy + dz * dz; if (d2 >= rs2 * rs2) return;
  const d = Math.sqrt(d2) || 1e-4, nx = dx / d, ny = dy / d, nz = dz / d, pen = rs2 - d;
  const vr = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny + (b.vel.z - a.vel.z) * nz;
  const imp = -vr;
  if (imp > 1.2) { if (!a.held) wake(a); if (!b.held) wake(b); }
  const wa = a.held || a.sleeping ? 0 : a.invM, wb = b.held || b.sleeping ? 0 : b.invM, ws = wa + wb;
  if (!ws) return;
  a.pos.x -= nx * pen * wa / ws * 0.7; a.pos.y -= ny * pen * wa / ws * 0.7; a.pos.z -= nz * pen * wa / ws * 0.7;
  b.pos.x += nx * pen * wb / ws * 0.7; b.pos.y += ny * pen * wb / ws * 0.7; b.pos.z += nz * pen * wb / ws * 0.7;
  if (vr < 0) {
    const j = -1.2 * vr / ws;
    a.vel.x -= nx * j * wa; a.vel.y -= ny * j * wa; a.vel.z -= nz * j * wa;
    b.vel.x += nx * j * wb; b.vel.y += ny * j * wb; b.vel.z += nz * j * wb;
    if (ny > 0.6) b.onGround = true; if (ny < -0.6) a.onGround = true;
    if (imp > 6) { bodyHit(a, b, imp); bodyHit(b, a, imp); }
  }
}
function bodyHit(a, other, imp) {
  if (a.kind === 'person' && other.mass > 40 && imp > 8) injurePerson(a);
  if (a.kind === 'car') { disturbCar(a); damageCar(a, imp); }
  if (a.kind === 'heli' && imp > 18) heliImpact(a, imp);
  if (a.kind === 'meteor' && !a.held && other.kind !== 'person') meteorImpact(a);
}

// ============================================================ effects of fast bodies on walking people
function bodiesVsPeople() {
  for (const b of bodies) {
    if (b.dead || b.sleeping || b.held || b.kind === 'heli') continue;
    const sp2 = b.vel.lengthSq(); if (sp2 < 25 || b.pos.y - b.half.y > 3) continue;
    if (b.drive) continue;
    for (const p of people) {
      if (p.mode !== 'free' && p.mode !== 'cheer' && p.mode !== 'thug') continue;
      const dx = p.pos.x - b.pos.x, dz = p.pos.z - b.pos.z, rr = b.rad + 0.5;
      if (dx * dx + dz * dz > rr * rr) continue;
      const sp = Math.sqrt(sp2);
      if (p.thug) { p.cuffed = true; }
      knock(p, T1.copy(b.vel).multiplyScalar(0.7).setY(R(2, 5)), sp > 8);
    }
  }
}

// ============================================================ bullets
const bullets = [];
const bulletGeo = new THREE.BufferGeometry();
const bulletPos = new Float32Array(240 * 6);
bulletGeo.setAttribute('position', new THREE.BufferAttribute(bulletPos, 3).setUsage(THREE.DynamicDrawUsage));
const bulletLines = new THREE.LineSegments(bulletGeo, new THREE.LineBasicMaterial({ color: new THREE.Color(9, 6, 2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
bulletLines.frustumCulled = false; scene.add(bulletLines);
function fireBullet(from, to, spread) {
  if (bullets.length >= 240) return;
  const d = T1.copy(to).sub(from).normalize();
  d.x += R(-spread, spread); d.y += R(-spread, spread); d.z += R(-spread, spread); d.normalize();
  bullets.push({ p: from.clone(), v: d.multiplyScalar(380), life: 1.6 });
  FX.flash(from.x, from.y, from.z); SFX.shot(from);
}
function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i]; const p0 = T1.copy(b.p);
    b.p.addScaledVector(b.v, dt); b.life -= dt;
    let dead = b.life <= 0;
    // hit Superman? (closest point on segment)
    const seg = T2.copy(b.p).sub(p0), L2 = seg.lengthSq();
    const tt = L2 > 0 ? clamp(T3.copy(P.pos).sub(p0).dot(seg) / L2, 0, 1) : 0;
    const cp = T3.copy(p0).addScaledVector(seg, tt);
    if (!dead && cp.distanceToSquared(P.pos) < 0.9) {
      const n = T4.copy(cp).sub(P.pos).normalize();
      b.v.reflect(n).multiplyScalar(0.55); b.reflected = true; b.p.copy(cp).addScaledVector(n, 0.2); b.life = Math.min(b.life, 0.6);
      for (let k = 0; k < 8; k++) FX.spark(cp.x, cp.y, cp.z, n.x * 8 + R(-5, 5), n.y * 8 + R(-5, 5), n.z * 8 + R(-5, 5));
      SFX.ping(cp); P.hitT = 0.12; ledger.deflected++;
    }
    if (!dead) for (const p of people) {
      if (p.thug || (p.mode !== 'free' && p.mode !== 'cheer' && p.mode !== 'phys' && p.mode !== 'down')) continue;
      const t2 = L2 > 0 ? clamp(T4.copy(p.pos).sub(p0).dot(seg) / L2, 0, 1) : 0;
      if (T4.copy(p0).addScaledVector(seg, t2).distanceToSquared(p.pos) < 0.3) { injurePerson(p); if (currentInc && b.reflected) currentInc.miss = true; dead = true; break; }
    }
    if (!dead && (blockAt(b.p.x, b.p.y, b.p.z) >= 0 || b.p.y < 0)) {
      for (let k = 0; k < 5; k++) FX.spark(b.p.x, b.p.y, b.p.z, R(-5, 5), R(0, 6), R(-5, 5)); dead = true;
    }
    if (dead) { bullets.splice(i, 1); continue; }
  }
  for (let i = 0; i < 240; i++) {
    const b = bullets[i], o = i * 6;
    if (!b) { bulletPos.fill(0, o, o + 6); continue; }
    const sp = b.v.length() || 1, L = Math.min(5, sp * 0.012);
    bulletPos[o] = b.p.x; bulletPos[o + 1] = b.p.y; bulletPos[o + 2] = b.p.z;
    bulletPos[o + 3] = b.p.x - b.v.x / sp * L; bulletPos[o + 4] = b.p.y - b.v.y / sp * L; bulletPos[o + 5] = b.p.z - b.v.z / sp * L;
  }
  bulletGeo.attributes.position.needsUpdate = true;
}

// ============================================================ emergencies (one at a time)
let currentInc = null, nextIncT = 25, incCount = 0;
const INC_TYPES = ['heli', 'meteor', 'fire', 'robbery'];
function startIncident(forced) {
  if (currentInc) endIncident(false, 'Emergency abandoned.');
  const type = forced ? String(forced).replace('kryptonite', 'meteor') : INC_TYPES[incCount % INC_TYPES.length]; incCount++;
  let inc = null;
  if (type === 'fire') inc = startFire();
  else if (type === 'heli') inc = startHeli();
  else if (type === 'robbery') inc = startRobbery();
  else inc = startMeteor(forced === 'kryptonite' || (!forced && incCount > 4 && rnd() < 0.6));
  if (!inc) return;
  inc.injuries = 0; inc.damage = 0; inc.age = 0; inc.miss = false; inc.saved0 = ledger.saves;
  currentInc = inc; SFX.alert(); toast(inc.title, 'alert');
  if (!onboard.done.has('mapTip')) { onboard.done.add('mapTip'); setTimeout(() => toast('Follow the gold beam, or press M for the map', ''), 2500); }
}
function endIncident(success, msg) {
  const inc = currentInc; if (!inc) return; currentInc = null; nextIncT = R(35, 50);
  if (inc.cleanup) inc.cleanup();
  if (!success) { ledger.streak = 0; hopeHit(5 + 3 * (inc.lost || 0)); toast(msg || 'Too late.', 'alert'); return; }
  ledger.resolved++;
  // gold means clean first; speed is a loose gate
  const lost = inc.lost || 0, fast = inc.age < inc.limit * 0.6;
  const medal = lost === 0 && inc.injuries === 0 && !inc.miss && inc.damage <= 7.5e5 && fast ? 'gold'
    : lost === 0 && inc.injuries <= 1 && inc.damage <= 3e6 ? 'silver' : 'bronze';
  ledger.medals[medal]++;
  ledger.streak++; ledger.best = Math.max(ledger.best, ledger.streak);
  hopeAdd(medal === 'gold' ? 10 : medal === 'silver' ? 5 : 1);
  toast(`${msg || 'Emergency handled'} — ${medal.toUpperCase()}${ledger.streak > 1 ? ` · streak ×${ledger.streak}` : ''}`, 'good');
  checkUnlocks();
}
// first-session onboarding: each tip fires once, as soon as it's relevant
const onboard = { t0: -1, done: new Set(), hospT: -99 };
function updateOnboarding() {
  if (onboard.t0 < 0) return;
  const t = ledger.time;
  const once = (id, cond, msg) => { if (!onboard.done.has(id) && cond) { onboard.done.add(id); toast(msg, 'good'); return true; } return false; };
  once('shift', t > 8 || ((keys.has('ShiftLeft') || pad.boost) && P.pos.y < 150), 'Shift to go fast. Climb first: low sonic booms break windows.');
  once('grab', t > 18, 'Press E to grab a car or person. Press E again to set it down.');
  once('heat', (currentInc && currentInc.type === 'meteor') || mouseR, 'Hold right mouse (or R) for heat vision. Sunlight recharges it.');
  if (once('hosp', ledger.injuries > 0 || (P.hold && P.hold.kind === 'person') || t > 60, 'Carry the injured to the hospital pad. It wins back Hope.')) onboard.hospT = t;
}
function updateIncident(dt) {
  updateOnboarding();
  if (!currentInc) { if (started) { nextIncT -= dt; if (nextIncT <= 0) startIncident(); } return; }
  const inc = currentInc; inc.age += dt;
  inc.update(dt);
  if (currentInc === inc && inc.age > inc.limit) inc.timeout();
}
// --- fire with trapped people
function startFire() {
  const cands = buildings.filter(b => b.ny >= 8);
  const b = pick(cands); const y = Math.floor(b.ny * R(0.3, 0.65));
  const side = Math.floor(R(0, 4));
  const lit = [];
  for (let k = 0; k < 4; k++) {
    let x, z;
    if (side < 2) { x = clamp(Math.floor(b.nx / 2) + k - 1, 1, b.nx - 2); z = side === 0 ? 0 : b.nz - 1; }
    else { z = clamp(Math.floor(b.nz / 2) + k - 1, 1, b.nz - 2); x = side === 2 ? 0 : b.nx - 1; }
    const g = cellIndex(b, x, clamp(y + (k === 3 ? 1 : 0), 0, b.ny - 2), z);
    if (alive[g]) { igniteBlock(g, 0.55); lit.push(g); }
  }
  if (!lit.length) return null;
  const trapped = [];
  for (let k = 0; k < 3; k++) {
    const cx = 1 + Math.floor(R(0, b.nx - 2)), cz = 1 + Math.floor(R(0, b.nz - 2)), cy = clamp(y + (k === 2 ? 1 : 0), 0, b.ny - 2);
    const g = cellIndex(b, cx, cy, cz);
    const pos = new V3(b.x0 + (cx + 0.5) * CELL + R(-1, 1), cy * STORY + SLAB_H + 0.9, b.z0 + (cz + 0.5) * CELL + R(-1, 1));
    const p = placePerson('trapped', pos, { trapCell: g, danger: true }); if (p) trapped.push(p);
  }
  const inc = {
    type: 'fire', b, trapped, limit: 150, title: `Fire at ${b.name}, people trapped on floor ${y + 1}. Hold Q: freeze breath.`,
    marker() {
      let n = 0; T1.set(0, 0, 0);
      for (const g of fires) if (blkB[g] === b.id) { T1.add(blockCenter(g, T2)); n++; }
      return n ? T1.divideScalar(n).clone() : new V3((b.x0 + b.x1) / 2, b.h, (b.z0 + b.z1) / 2);
    },
    update(dt) {
      let n = 0; for (const g of fires) if (blkB[g] === b.id) n++;
      for (const p of trapped) if (p.mode === 'trapped' && fireI[p.trapCell] > 0.85 && this.age > 60 && rnd() < 0.03 * dt) { p.mode = 'gone'; ledger.lost++; this.lost = (this.lost || 0) + 1; hopeHit(3); toast('Someone was lost in the fire.', 'alert'); }
      if (n === 0) {
        let r = 0; for (const p of trapped) if (p.mode === 'trapped') { p.mode = 'free'; p.pos.set(b.x0 - 2, 0.9, (b.z0 + b.z1) / 2); p.danger = false; r++; }
        if (r) addSave(r, this.marker(), 'Firefighters reached the trapped');
        endIncident(true, 'Fire out');
      } else if (trapped.every(p => p.mode !== 'trapped') && n < 3 && this.age > 20) {
        // all carried out and nearly extinguished
      }
    },
    timeout() {
      let l = 0; for (const p of trapped) if (p.mode === 'trapped') { p.mode = 'gone'; l++; }
      ledger.lost += l; this.lost = (this.lost || 0) + l; endIncident(false, `The fire at ${b.name} burned too long. ${l} lost.`);
    }
  };
  return inc;
}
// --- falling helicopter
const helis = [];
function startHeli() {
  const L = pick(lotInfo.filter(l => l.type === 'bld' && l.b));
  const pos = new V3(L.lx + 20, Math.max(170, L.b.h + 80), L.lz + 20);
  const h = makeBody('heli', pos, 2.6, 1.5, 1.4, 3200);
  h.mesh = makeHeliMesh(); h.noGrav = true; h.phase = 'trouble'; h.t = 0; h.cd = 1.2; h.landed = false; h.crashed = false; h.rotorW = 30;
  helis.push(h);
  return {
    type: 'heli', h, limit: 70, title: 'News chopper losing power over ' + L.name + '!',
    marker() { return h.pos.clone().add(T1.set(0, 3, 0)); },
    update(dt) {
      h.t += dt;
      if (h.phase === 'trouble') {
        h.angVel.set(Math.sin(h.t * 3) * 0.3, 1.2, Math.cos(h.t * 2) * 0.3);
        h.vel.set(Math.sin(h.t) * 3, Math.sin(h.t * 1.7) * 1.5, Math.cos(h.t * 0.8) * 3); wake(h);
        if (rnd() < 0.5) FX.smoke(h.pos.x - 1, h.pos.y + 1, h.pos.z, 1, 0.05);
        if (h.t > 10) { h.phase = 'falling'; h.noGrav = false; h.gScale = 0.6; toast('Rotor failure — it’s falling!', 'alert'); SFX.alert(); }
      } else if (h.phase === 'falling') {
        h.rotorW = Math.max(4, h.rotorW - dt * 8);
        if (!h.held) { h.angVel.y = lerp(h.angVel.y, 2.5, dt); }
        if (rnd() < 0.8) FX.smoke(h.pos.x, h.pos.y + 1, h.pos.z, 1.2, 0.04);
        if (rnd() < 0.3) FX.fire(h.pos.x - 1, h.pos.y + 1, h.pos.z, 0.6);
      }
      if (h.landed) { addSave(3, h.pos, 'Pilot, reporter and camera operator safe'); endIncident(true, 'Helicopter down safely'); }
      else if (h.crashed) { ledger.lost += 3; this.lost = 3; endIncident(false, 'The helicopter crashed.'); }
    },
    timeout() { if (!h.landed && !h.crashed) { if (h.phase === 'trouble') { h.phase = 'falling'; h.noGrav = false; } } },
    cleanup() { setTimeout(() => removeBody(h), 25000); }
  };
}
function heliImpact(h, sp) {
  if (h.landed || h.crashed || h.phase === 'trouble') return;
  if (sp > 14) { h.crashed = true; explode(h.pos, 3e7, { src: h }); h.mesh.traverse(m => { if (m.material && m.material.color) m.material = m.material.clone(), m.material.color.setRGB(0.03, 0.03, 0.03); }); }
  else if (h.onGround || sp < 14) { if (h.onGround && !h.held && h.vel.length() < 8) { h.landed = true; if (sp > 7) toast('Hard landing, but they’re alive.', ''); } }
}
// --- meteor (sometimes Kryptonite)
const meteors = [];
function startMeteor(kryp) {
  const L = pick(lotInfo.filter(l => l.type === 'bld'));
  const target = new V3(L.lx + 20, 0, L.lz + 20);
  const dir = T1.set(R(-1, 1), 0, R(-1, 1)).normalize();
  const start = target.clone().addScaledVector(dir, 2800).setY(2600);
  const m = makeBody('meteor', start, 3, 3, 3, 26000);
  m.mesh = makeMeteorMesh(kryp); m.kryp = kryp; m.noGrav = true; m.noDrag = true; m.target = target; m.hp = 100; m.heat = 0; m.done = false;
  m.vel.copy(target).sub(start).normalize().multiplyScalar(150); m.angVel.set(R(-1, 1), R(-1, 1), R(-1, 1));
  meteors.push(m);
  return {
    type: 'meteor', m, limit: 40,
    title: kryp ? 'A green meteor is falling on ' + L.name + '. Kryptonite! Deal with it from range.' : 'Meteor inbound on ' + L.name + '. Impact in about 25 seconds.',
    marker() { return m.pos.clone(); },
    update(dt) {
      // resolve outcomes first: every ending removes the body, so check before the dead early-out
      if (m.done === 'space') { endIncident(true, 'Meteor hurled back into space'); return; }
      if (m.done === 'shattered') { endIncident(true, 'Meteor shattered'); return; }
      if (m.done === 'hit') { endIncident(false, 'The meteor hit the city.'); return; }
      if (m.done === 'vapor') { endIncident(true, 'Meteor vaporized'); return; }
      if (m.dead) return;
      if (!m.held && m.noGrav) {
        const p = m.pos;
        for (let k = 0; k < 6; k++) { ADD.emit(p.x + R(-2, 2), p.y + R(-2, 2), p.z + R(-2, 2), -m.vel.x * 0.05 + R(-2, 2), -m.vel.y * 0.05 + R(-2, 2), -m.vel.z * 0.05 + R(-2, 2), R(0.5, 1.2), 3.5, 1, kryp ? 0.8 : 7, kryp ? 6 : 2.5, kryp ? 1 : 0.5, 1, kryp ? 0.2 : 2, kryp ? 2 : 0.3, 0.05, 0, 0.3); }
        FX.smoke(p.x, p.y, p.z, 1.5, 0.05);
      }
      if (kryp) for (let k = 0; k < 2; k++) FX.kryp(m.pos.x, m.pos.y, m.pos.z);
      if (m.heat >= 1) { vaporize(m); return; }
      if (m.thrown && m.pos.y > 1500 && m.vel.y > 0) { m.done = 'space'; removeBody(m); }
    },
    timeout() { },
    cleanup() { if (!m.dead && m.done !== 'hit') removeBody(m); }
  };
}
function meteorImpact(m) {
  if (m.done || m.dead) return;
  m.done = 'hit'; explode(m.pos, 2.5e8, { src: m });
  addDecal('crater', m.pos.x, 0, m.pos.z, 16);
  removeBody(m);
}
function vaporize(m) {
  if (m.dead) return; const p = m.pos;
  for (let k = 0; k < 120; k++) FX.molten(p.x, p.y, p.z, R(-20, 20), R(-10, 20), R(-20, 20));
  for (let k = 0; k < 30; k++) FX.steam(p.x + R(-3, 3), p.y + R(-3, 3), p.z + R(-3, 3));
  flashLight(p, 400, 200); SFX.boom(p, 0.8); m.done = 'vapor'; removeBody(m);
}
function shatterMeteor(m, dir) {
  if (m.dead) return; const p = m.pos.clone(), v = m.vel.clone();
  m.done = 'shattered'; removeBody(m);
  for (let k = 0; k < 10; k++) {
    const d = spawnDebris(T1.copy(p).add(T2.set(R(-2, 2), R(-2, 2), R(-2, 2))), R(0.5, 1), R(0.5, 1), R(0.5, 1),
      T3.copy(v).multiplyScalar(0.2).addScaledVector(dir, 40).add(T2.set(R(-25, 25), R(-5, 25), R(-25, 25))), T_COL, new THREE.Color(0.06, 0.05, 0.04), 1.1, 0, 4, true, 5);
    if (d) d.mass *= 0.5;
  }
  explode(p, 2e7, {}); toast('Shattered! Watch where the burning pieces land.', '');
}
// --- armed robbery: the Arkham half
const thugs = [];
function startRobbery() {
  const L = pick(lotInfo.filter(l => l.type === 'bld'));
  const corner = new V3(L.lx + 1.6, 0.9, L.lz + R(8, 32));
  const crew = [];
  for (let k = 0; k < 4; k++) {
    const p = placePerson('thug', corner.clone().add(T1.set(R(-1, 1), 0, k * 2.2)), { thug: true, aimT: R(3, 5), tele: 0, burst: 0, cuffed: false });
    if (p) crew.push(p);
  }
  scare(corner, 50, 12);
  return {
    type: 'robbery', crew, limit: 120, title: `Armed robbery at ${L.name}. Shots fired.`,
    marker() { return corner.clone().setY(3); },
    update(dt) {
      for (const p of crew) updateThug(p, dt);
      if (crew.every(p => p.cuffed || p.injured || p.mode === 'gone')) {
        ledger.thugs += crew.length; endIncident(true, `All ${crew.length} robbers stopped${ledger.combo > 3 ? ` · ${ledger.combo}-hit combo` : ''}`);
        celebrate(corner, 60);
      }
    },
    timeout() { for (const p of crew) if (!p.cuffed) p.mode = 'gone'; endIncident(false, 'The robbers got away.'); }
  };
}
let lastTeleT = -9;
function updateThug(p, dt) {
  if (p.cuffed || p.mode !== 'thug') return;
  const d = p.pos.distanceTo(P.pos);
  p.face = Math.atan2(P.pos.z - p.pos.z, P.pos.x - p.pos.x);
  if (p.burst > 0) {
    p.burstT -= dt;
    if (p.burstT <= 0) { p.burst--; p.burstT = 0.09; fireBullet(T1.copy(p.pos).setY(p.pos.y + 0.4), T2.copy(P.pos), d < 60 ? 0.02 : 0.05); }
    return;
  }
  if (p.tele > 0) {
    p.tele -= dt;
    if (p.tele <= 0) { p.burst = 5; p.burstT = 0; }
    return;
  }
  p.aimT -= dt;
  if (p.aimT <= 0 && d < 120 && simT - lastTeleT > 0.8) { p.tele = 1.0; lastTeleT = simT; p.aimT = R(2.5, 4.5); flashHit(0.5); }
  if (p.aimT <= 0 && d >= 120) { p.aimT = R(2, 4); fireBullet(T1.copy(p.pos).setY(1.4), T2.copy(p.pos).add(T3.set(R(-20, 20), 40, R(-20, 20))), 0.1); }
}
function apprehend(p, how) {
  if (p.cuffed) return;
  p.cuffed = true; p.burst = 0;
  const counter = p.tele > 0;
  ledger.combo++; ledger.maxCombo = Math.max(ledger.maxCombo, ledger.combo); P.combatT = 4;
  hopeAdd(counter ? 2.5 : 1.5);
  toast(`${counter ? 'Counter! ' : ''}${how} · combo ${ledger.combo}`, counter ? 'good' : '');
  p.tele = 0;
}

// ============================================================ input
const keys = new Set();
let mouseL = false, mouseR = false, started = false, paused = false;
const pad = { lx: 0, ly: 0, rx: 0, ry: 0, prev: [] };
addEventListener('keydown', e => {
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return; keys.add(e.code); onKey(e.code);
});
addEventListener('keyup', e => { keys.delete(e.code); });
addEventListener('blur', () => { keys.clear(); mouseL = mouseR = false; P.charging = false; });
canvas.addEventListener('mousedown', e => {
  if (!started) return;
  if (paused) { setPaused(false); return; }
  if (document.pointerLockElement !== canvas) { try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { } }
  initAudio();
  if (e.button === 0) { mouseL = true; P.charging = true; P.charge = 0; }
  if (e.button === 2) mouseR = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0 && mouseL) { mouseL = false; releaseCharge(); }
  if (e.button === 2) mouseR = false;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (!started || paused) return;
  if (document.pointerLockElement !== canvas && !(e.buttons & 1)) return;
  yaw -= e.movementX * 0.0021; pitch = clamp(pitch - e.movementY * 0.0021, -1.45, 1.45);
});
document.addEventListener('pointerlockchange', () => { if (started && document.pointerLockElement !== canvas && !paused && !MAP.open && !document.getElementById('bench-results')) setPaused(true); });
function onKey(code) {
  if (!started) { if ((code === 'Enter' || code === 'Space' || code === 'NumpadEnter') && titleReady) begin(); return; }
  if (code === 'KeyP') { setPaused(!paused); return; }
  if (paused) { if (code === 'KeyN') return; return; }
  if (code === 'Backquote' || code === 'F3') { fpsEl.hidden = !fpsEl.hidden; return; }
  if (code === 'KeyM' || code === 'Tab') { setMapOpen(!MAP.open); return; }
  if (MAP.open) { if (code === 'Escape') setMapOpen(false); return; }
  if (code === 'KeyK') { AU.muted = !AU.muted; if (AU.master) AU.master.gain.value = AU.muted ? 0 : 0.75; toast(AU.muted ? 'Sound off' : 'Sound on'); }
  if (code === 'KeyE') grabOrRelease();
  if (code === 'KeyF') { P.flying = !P.flying; if (P.flying) P.vel.y = Math.max(P.vel.y, 6); toast(P.flying ? 'Flying' : 'Walking'); }
  if (code === 'Space' && !P.flying) { if (P.grounded) { P.vel.y = 38; P.grounded = false; FX.dust(P.pos.x, P.pos.y - 0.9, P.pos.z, 0, 1, 0, 2); SFX.whoosh(); } else P.flying = true; }
  if (code === 'KeyX') { P.xray = !P.xray; setXray(P.xray); }
  if (code === 'KeyH') { P.hear = !P.hear; toast(P.hear ? 'Listening… heartbeats and cries are marked' : 'Hearing off'); }
  if (code === 'KeyV') { P.slow = !P.slow; toast(P.slow ? 'The world slows to a crawl' : 'Normal time'); }
  if (code === 'KeyG') clap();
  if (code === 'KeyN') { setPaused(true); }
}
function releaseCharge() {
  if (!P.charging) return; P.charging = false;
  const power = 1 + Math.min(1, P.charge / 1.2) * 3; P.charge = 0;
  if (P.hold) throwHeld(power); else punch(power);
}
function setPaused(v) {
  paused = v; $('paused').hidden = !v;
  if (v) { renderFrontPage(); if (document.pointerLockElement) document.exitPointerLock(); }
  else { try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { } }
}
$('paused').addEventListener('click', () => setPaused(false));
function pollPad() {
  const gp = navigator.getGamepads ? Array.from(navigator.getGamepads()).find(g => g && g.connected) : null;
  if (!gp) { pad.lx = pad.ly = pad.rx = pad.ry = 0; pad.on = false; return; }
  pad.on = true;
  const dz = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
  pad.lx = dz(gp.axes[0] || 0); pad.ly = dz(gp.axes[1] || 0); pad.rx = dz(gp.axes[2] || 0); pad.ry = dz(gp.axes[3] || 0);
  const b = i => gp.buttons[i] && gp.buttons[i].pressed;
  const edge = i => b(i) && !pad.prev[i];
  if (!started) { if ((edge(0) || edge(9)) && titleReady) begin(); }
  else {
    if (edge(9)) setPaused(!paused);
    if (edge(8)) setMapOpen(!MAP.open);
    if (!paused) {
      if (edge(4)) grabOrRelease();
      if (edge(2)) clap();
      if (edge(3)) { P.xray = !P.xray; setXray(P.xray); }
      if (edge(11)) { P.hear = !P.hear; }
      if (edge(12)) { P.slow = !P.slow; }
      if (edge(13)) { P.flying = !P.flying; }
      if (edge(5)) { P.charging = true; P.charge = 0; }
      if (!b(5) && pad.prev[5]) releaseCharge();
    }
  }
  pad.heat = (gp.buttons[7] && gp.buttons[7].value > 0.3);
  pad.freeze = (gp.buttons[6] && gp.buttons[6].value > 0.3);
  pad.up = b(0); pad.down = b(1); pad.boost = b(10);
  for (let i = 0; i < gp.buttons.length; i++) pad.prev[i] = b(i);
}

// ============================================================ powers
function aimDir(o) { return o.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)); }
function heroPoint(local, o) { return o.copy(local).applyQuaternion(P.quat).add(P.pos); }
const EYE_L = new V3(-0.045, 0.74, -0.11), EYE_R = new V3(0.045, 0.74, -0.11), MOUTH = new V3(0, 0.66, -0.12);
function kryptoniteNear() {
  let k = 0;
  for (const m of meteors) if (!m.dead && m.kryp) { const d = m.pos.distanceTo(P.pos); k = Math.max(k, clamp(1 - (d - 15) / 70, 0, 1)); }
  for (const r of bodies) if (r.kind === 'debris' && r.kryp && !r.dead) { const d = r.pos.distanceTo(P.pos); k = Math.max(k, clamp(1 - d / 30, 0, 1)); }
  return k;
}
function findTarget(range, cone) {
  const o = T5.copy(P.pos).add(T6.set(0, 0.3, 0)), d = aimDir(new V3());
  let best = null, bestS = Infinity;
  const consider = (b) => {
    const rel = T1.copy(b.pos).sub(o), along = rel.dot(d);
    if (along < -1.5 || along > range + b.rad) return;
    const perp = rel.addScaledVector(d, -along).length();
    if (perp > b.rad + cone + along * 0.15) return;
    const s = along + perp * 1.5; if (s < bestS) { bestS = s; best = b; }
  };
  for (const b of bodies) if (!b.dead && !b.held) consider(b);
  for (const p of people) if (p.mode !== 'gone' && p.mode !== 'held' && p.mode !== 'safe' && p.mode !== 'trapped') consider(p);
  rubbleNear(o, range + 3, r => consider(r));
  return best;
}
function punch(power) {
  P.punchT = 0.3;
  const d = aimDir(new V3()), o = T5.copy(P.pos).add(T6.set(0, 0.35, 0)).clone();
  const E = 2.5e7 * power * (1 - kryptoniteNear() * 0.8);
  let t = findTarget(5.5 + power, 1.4);
  if (t && t.kind === 'rubble') t = reviveRubble(t, null) || null;
  if (t) {
    const at = T1.copy(t.pos).lerp(o, 0.4);
    ring(at, d, 0.3, 3 + power * 2, 0.35, null, 0.9);
    for (let k = 0; k < 12; k++) FX.spark(at.x, at.y, at.z, d.x * 10 + R(-6, 6), d.y * 10 + R(-6, 6), d.z * 10 + R(-6, 6));
    addShake(0.25 * power); hitStop(0.05 * power);
    if (t.kind === 'person') {
      if (t.thug) { knock(t, T2.copy(d).multiplyScalar(7).setY(3), false); t.mode = 'phys'; apprehend(t, 'Pulled punch'); SFX.punch(at, 0.6); }
      else toast('Superman doesn’t hit civilians. Press E to carry them.', '');
      return;
    }
    if (t.kind === 'meteor') { if (t.kryp && kryptoniteNear() > 0.6) { toast('Kryptonite — you’re too weak up close. Use heat vision or throw debris.', 'alert'); return; } shatterMeteor(t, d); SFX.punch(at, 1.5); return; }
    if (t.frost > 0.75 && (t.kind === 'car' || t.kind === 'debris')) { if (t.kind === 'car') shatterCar(t); else shatter(t, true); return; }
    const v = Math.min(140, Math.sqrt(2 * E / t.mass));
    t.vel.addScaledVector(d, v); t.vel.y += v * 0.1; wake(t);
    t.angVel.add(T2.set(R(-1, 1), R(-1, 1), R(-1, 1)).multiplyScalar(Math.min(12, v / 8)));
    if (t.kind === 'car') { disturbCar(t); damageCar(t, v * 0.8); scare(t.pos, 40, 6); }
    if (t.kind === 'heli' && t.phase === 'falling') t.vel.y = Math.max(t.vel.y, 0);
    SFX.punch(at, 0.8 + power * 0.3);
    return;
  }
  const hit = raycast(o, d, 6 + power, { bodies: false });
  if (hit.type === 'block') {
    const c = hit.point;
    ring(c, hit.normal, 0.3, 3 + power * 2, 0.35, null, 0.9);
    const rad = 2.5 + power * 1.6;
    let budget = E;
    forBlocksInSphere(T2.copy(c).addScaledVector(d, 1.5), rad, (g, dist) => {
      const need = BREAK_E[blkT[g]]; if (budget < need) return; budget -= need;
      breakBlock(g, T3.copy(d).multiplyScalar(30 * Math.sqrt(power) * (1 - dist / (rad + 1)) + 6).add(T4.set(R(-3, 3), R(0, 4), R(-3, 3))), 4, 'punch');
    });
    for (let k = 0; k < 14; k++) FX.dust(c.x, c.y, c.z, d.x * 8 + R(-4, 4), R(-1, 4), d.z * 8 + R(-4, 4), 1.4);
    SFX.punch(c, 1.2); SFX.crumble(c); addShake(0.4 * power); hitStop(0.06 * power);
    if (budget === E) { for (let k = 0; k < 10; k++) FX.spark(c.x, c.y, c.z, R(-8, 8), R(-8, 8), R(-8, 8)); toast('Too solid for that. Charge the punch.', ''); }
    return;
  }
  // air punch: a small shock cone
  SFX.whoosh(); ring(T1.copy(o).addScaledVector(d, 2), d, 0.3, 4, 0.3, null, 0.6);
  if (power > 2.5) coneImpulse(o, d, 25, 0.5, 18 * power / 4);
}
function coneImpulse(o, d, range, cosA, dv) {
  const cos = Math.cos(cosA);
  for (const b of bodies) {
    if (b.dead || b.held) continue;
    const rel = T1.copy(b.pos).sub(o), dist = rel.length(); if (dist > range || dist < 0.1) continue;
    if (rel.dot(d) / dist < cos) continue;
    const k = (1 - dist / range) * Math.min(1, Math.sqrt(8000 / b.mass));
    b.vel.addScaledVector(d, dv * k).y += dv * k * 0.2; wake(b);
    if (b.kind === 'car') disturbCar(b);
  }
  rubbleNear(o, range, r => {
    const rel = T1.copy(r.pos).sub(o), dist = rel.length(); if (dist > range || dist < 0.1 || rel.dot(d) / dist < cos) return;
    const k = (1 - dist / range) * Math.min(1, Math.sqrt(8000 / r.mass)); if (dv * k > 3) reviveRubble(r, T2.copy(d).multiplyScalar(dv * k));
  });
}
function clap() {
  if (P.clapCD > 0) return; P.clapCD = 1.0; P.punchT = 0.25; P.clapT = 0.25;
  const o = T5.copy(P.pos).add(T6.set(0, 0.3, 0)).clone(), d = aimDir(new V3());
  SFX.clap(); addShake(0.5); hitStop(0.04);
  ring(T1.copy(o).addScaledVector(d, 2), d, 0.5, 30, 0.6, new THREE.Color(2.2, 2.3, 2.6), 0.7);
  for (let k = 0; k < 60; k++) { const v = T1.copy(d).multiplyScalar(R(30, 60)).add(T2.set(R(-12, 12), R(-12, 12), R(-12, 12))); FX.vapor(o.x, o.y, o.z, v.x, v.y, v.z); }
  coneImpulse(o, d, 70, 0.6, 45);
  const cos = Math.cos(0.6);
  for (const p of people) {
    if (p.mode === 'gone' || p.mode === 'held' || p.mode === 'safe' || p.mode === 'trapped') continue;
    const rel = T1.copy(p.pos).sub(o), dist = rel.length(); if (dist > 60 || rel.dot(d) / dist < cos) continue;
    if (p.thug && !p.cuffed) { knock(p, T2.copy(d).multiplyScalar(10 * (1 - dist / 60) + 3).setY(3), false); p.mode = 'phys'; apprehend(p, 'Thunder clap'); }
    else if (!p.thug && dist < 25) knock(p, T2.copy(d).multiplyScalar(6 * (1 - dist / 25)).setY(1.5), false);
  }
  // shots in the air get swatted
  for (const b of bullets) { const rel = T1.copy(b.p).sub(o); if (rel.length() < 60 && rel.normalize().dot(d) > cos) { b.v.copy(d).multiplyScalar(-60).add(T2.set(R(-30, 30), R(-30, 30), R(-30, 30))); b.life = 0.3; } }
  for (const g of fires) { const c = blockCenter(g, T1), rel = c.sub(o), dist = rel.length(); if (dist < 55 && rel.normalize().dot(d) > cos) fireI[g] -= 0.6 * (1 - dist / 55); }
  forBlocksInSphere(o, 45, (g, dist) => {
    if (blkT[g] !== T_GLASS || rnd() > 0.35) return;
    const c = blockCenter(g, T1).sub(o); if (c.normalize().dot(d) < cos) return;
    breakBlock(g, T2.copy(d).multiplyScalar(10), 1, 'boom');
  });
}
function grabOrRelease() {
  if (P.hold) { releaseHeld(); return; }
  let t = findTarget(7, 1.8);
  if (t && t.kind === 'rubble') t = reviveRubble(t, null);
  if (t && t.kind === 'meteor' && t.kryp && kryptoniteNear() > 0.5) { toast('Kryptonite! You can’t hold it.', 'alert'); return; }
  if (!t) {
    const o = T5.copy(P.pos).add(T6.set(0, 0.3, 0)).clone(), d = aimDir(new V3());
    const hit = raycast(o, d, 7, { bodies: false });
    if (hit.type === 'block') {
      // rip a plate out of the wall
      const g = hit.g;
      if (liveDebrisCount >= LIVE_CAP) { toast('Too much falling already. Wait a moment.', ''); return; }
      const before = liveDebrisCount; breakBlock(g, T1.set(0, 0, 0), 1, 'rip');
      if (liveDebrisCount > before) t = bodies[bodies.length - 1];
      SFX.crumble(hit.point); addShake(0.3);
    }
  }
  if (!t) {
    if (people.some(p => p.mode === 'trapped' && p.pos.distanceToSquared(P.pos) < 144)) toast('Put out the fire to free them, or break the wall open.', '');
    return;
  }
  if (t.kind === 'person') {
    if (t.mode === 'trapped') return;
    if (t.thug && !t.cuffed) apprehend(t, 'Disarmed');
    t.mode = 'held'; t.prevDanger = t.danger || t.pos.y > 4 || t.injured;
  } else if (t.kind === 'car') disturbCar(t);
  else if (t.kind === 'heli' && t.phase === 'trouble') { t.phase = 'falling'; t.noGrav = false; }
  else if (t.kind === 'meteor') { t.noGrav = false; t.noDrag = false; }
  t.held = true; t.sleeping = false; t.vel.set(0, 0, 0); t.angVel.set(0, 0, 0);
  TQ.copy(P.quat).invert(); P.holdRel.copy(TQ).multiply(t.quat);
  if (t.kind === 'person') P.holdRel.setFromAxisAngle(T1.set(1, 0, 0), -Math.PI / 2);
  P.hold = t; SFX.whoosh();
  if (t.mass > 20000) toast(`${Math.round(t.mass / 1000)} tonnes. Easy.`, '');
}
function heldPos(h, o) {
  const big = Math.max(h.half.x, h.half.y, h.half.z) > 1.0;
  const up = T1.set(0, 1, 0).applyQuaternion(P.quat), fr = T2.set(0, 0, -1).applyQuaternion(P.quat);
  if (h.kind === 'person') return o.copy(P.pos).addScaledVector(fr, 0.45).addScaledVector(up, 0.05);
  if (big) return o.copy(P.pos).addScaledVector(up, 0.95 + Math.max(h.half.y, 1)).addScaledVector(fr, 0.2);
  return o.copy(P.pos).addScaledVector(fr, 0.9).addScaledVector(up, 0.4);
}
function releaseHeld(throwVel) {
  const h = P.hold; if (!h) return; P.hold = null; h.held = false; h.sleeping = false;
  h.vel.copy(throwVel || P.vel);
  if (h.kind === 'person') {
    h.mode = 'phys'; h.sleepT = 0;
    if (h.thug) { h.cuffed = true; return; }
    const nearHosp = Math.hypot(h.pos.x - HOSP.x, h.pos.z - HOSP.z) < 16 && h.pos.y < 6;
    if (nearHosp && h.injured) { h.mode = 'safe'; h.goneT = 2; ledger.injuries--; if (currentInc && currentInc.injuries > 0) currentInc.injuries--; addSave(1, h.pos, 'Patient delivered to the hospital'); return; }
    h.setDown = true;
  } else if (h.kind === 'heli') {
    h.angVel.set(0, 0, 0);
  } else if (h.kind === 'car' && !throwVel && P.pos.y < 6 && P.vel.length() < 4) {
    h.quat.setFromAxisAngle(UP, yaw + Math.PI / 2);
  }
}
function throwHeld(power) {
  const h = P.hold; if (!h) return;
  if (h.kind === 'person' && !h.thug) { releaseHeld(); toast('You set them down gently.', ''); return; }
  const d = aimDir(new V3());
  const v = Math.min(170, Math.sqrt(2 * 3e7 * power * (1 - kryptoniteNear() * 0.8) / h.mass));
  releaseHeld(T1.copy(P.vel).addScaledVector(d, v));
  h.angVel.set(R(-1, 1), R(-1, 1), R(-1, 1)).multiplyScalar(2); h.thrown = true;
  P.punchT = 0.3; SFX.whoosh(); addShake(0.2 * power);
  if (h.kind === 'meteor' && d.y > 0.3) toast('Up and away…', '');
}

// heat vision
const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 2.2, 0.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const beamGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.1), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true); beamGeo.translate(0, 0.5, 0); beamGeo.rotateX(Math.PI / 2);
const beams = [0, 1].map(() => { const g = new THREE.Group(); const a = new THREE.Mesh(beamGeo, beamMat), b = new THREE.Mesh(beamGeo, beamGlowMat); a.scale.set(0.035, 0.035, 1); b.scale.set(0.14, 0.14, 1); g.add(a, b); g.visible = false; scene.add(g); return g; });
const beamLight = new THREE.PointLight(lin(0xff4a1a), 0, 40, 2); scene.add(beamLight);
let lastScorch = new V3(1e9, 0, 0);
function heatVision(dt, on) {
  const can = on && P.solar > 0.01;
  for (const b of beams) b.visible = can;
  beamLight.intensity = can ? 40 : 0;
  if (AU.ctx) AU.heat.g.gain.setTargetAtTime(can && !AU.muted ? 0.12 : 0, AU.ctx.currentTime, 0.03);
  if (!can) { if (on && P.solar <= 0.01) toast('Solar charge empty. Fly high into the sun to recharge.', 'alert'); return; }
  const weak = kryptoniteNear();
  const power = (unlocked.has('beam') ? 1.6 : 1) * (1 - weak * 0.85);
  P.solar = Math.max(0, P.solar - dt * 0.05);
  const o = camera.position, d = aimDir(new V3());
  const camD = o.distanceTo(P.pos);
  const hit = raycast(T1.copy(o).addScaledVector(d, camD + 0.8).clone(), d, 2500, { rubble: true });
  const end = hit.point;
  for (let i = 0; i < 2; i++) {
    const e = heroPoint(i ? EYE_R : EYE_L, T2), len = e.distanceTo(end);
    beams[i].position.copy(e); beams[i].lookAt(end); beams[i].scale.set(1, 1, len);
    beams[i].children[0].scale.set(0.035 * (1 + Math.sin(simT * 60 + i) * 0.2) * power, 0.035 * power, 1);
  }
  beamLight.position.copy(end).addScaledVector(hit.normal, 1);
  if (!hit.type) return;
  if (rnd() < 0.8) FX.beam(end.x, end.y, end.z);
  if (hit.type === 'block') {
    // a cutting beam: melts a block in a fraction of a second and keeps burning through the next one
    const g = hit.g, v = heat[g] + dt * 6 * power;
    setBlockHeat(g, v);
    forBlocksInSphere(end, 4, (n, d) => { if (n !== g) { setBlockHeat(n, Math.min(1.3, heat[n] + dt * 1.6 * power * (1 - d / 4))); if (heat[n] > 0.9 && rnd() < dt * 0.6) igniteBlock(n, 0.25); } });
    if (rnd() < 0.7) FX.molten(end.x, end.y, end.z, hit.normal.x * 3 + R(-2, 2), R(-1, 3), hit.normal.z * 3 + R(-2, 2));
    if (rnd() < 0.25) FX.smoke(end.x, end.y, end.z, 0.8, 0.05);
    if (v >= (blkT[g] === T_COL ? 1.5 : 1.0)) {
      const c = blockCenter(g, new V3());
      breakBlock(g, T3.set(0, -1, 0), 0, 'melt');
      // molten slag drops out of the cut and glows as it falls
      if (rnd() < 0.6) spawnDebris(c, R(0.4, 0.8), R(0.3, 0.6), R(0.4, 0.8), T3.set(R(-2, 2), R(-1, 2), R(-2, 2)), T_COL, new THREE.Color(0.08, 0.06, 0.05), 1.3, 0, 2, false, 5);
      if (rnd() < 0.5) igniteBlock(g, 0.4);
      SFX.crumble(c, 0.6);
    }
  } else if (hit.type === 'body' || hit.type === 'rubble') {
    let b = hit.body;
    if (b.kind === 'rubble') { b.heat += dt * power; if (b.heat > 1) { const rb = reviveRubble(b, null); if (rb) b = rb; else return; } else { const m = debrisMeshes[b.btype]; m.userData.aH.setX(b.slot, b.heat); m.userData.aH.needsUpdate = true; return; } }
    if (b.kind === 'person') {
      if (b.thug && !b.cuffed) { apprehend(b, 'Gun melted'); for (let k = 0; k < 10; k++) FX.molten(b.pos.x, b.pos.y + 0.3, b.pos.z, R(-1, 1), R(0, 2), R(-1, 1)); }
      else toast('Never at people. The beam stops short.', '');
      return;
    }
    const rate = b.kind === 'car' ? 0.5 : b.kind === 'meteor' ? 0.22 : b.kind === 'heli' ? 0.35 : 0.8 * Math.pow(20000 / b.mass, 0.3);
    b.heat = Math.min(1.4, b.heat + dt * rate * power);
    if (b.kind === 'debris') { setDebrisHeat(b, b.heat); if (b.heat >= 1.2) { const p = b.pos; for (let k = 0; k < 20; k++) FX.molten(p.x, p.y, p.z, R(-3, 3), R(0, 4), R(-3, 3)); removeBody(b); } }
    if (b.kind === 'car') { b.mesh.userData.paint.emissive.setRGB(b.heat * 3, b.heat * 0.6, 0); disturbCar(b); if (b.heat >= 1) explodeCar(b); }
    if (b.kind === 'heli' && b.heat >= 1 && !b.crashed) { b.crashed = true; explode(b.pos, 3e7, { src: b }); }
  } else if (hit.type === 'ground') {
    if (end.distanceToSquared(lastScorch) > 1.2) { addDecal('scorch', end.x, 0, end.z, 0.9); lastScorch.copy(end); }
    if (rnd() < 0.5) FX.spark(end.x, end.y, end.z, R(-4, 4), R(2, 7), R(-4, 4));
  } else if (hit.type === 'water' || hit.type === 'ice') {
    for (let k = 0; k < 3; k++) FX.steam(end.x + R(-1, 1), WATER_Y, end.z + R(-1, 1));
    if (hit.type === 'ice') for (const s of iceSheets) if (Math.hypot(end.x - s.x, end.z - s.z) < s.r) s.r = Math.max(0, s.r - dt * 3);
  }
}
// freeze breath
let lastIce = new V3(1e9, 0, 0);
function freezeBreath(dt, on) {
  if (AU.ctx) AU.freeze.g.gain.setTargetAtTime(on && !AU.muted ? 0.22 : 0, AU.ctx.currentTime, 0.05);
  if (!on) return;
  const weak = 1 - kryptoniteNear() * 0.85;
  const o = heroPoint(MOUTH, new V3()), d = aimDir(new V3());
  for (let k = 0; k < 14; k++) {
    const v = T1.copy(d).multiplyScalar(R(30, 48) * weak).add(T2.set(R(-5, 5), R(-5, 5), R(-5, 5)));
    FX.ice(o.x, o.y, o.z, v.x + P.vel.x, v.y + P.vel.y, v.z + P.vel.z);
  }
  const range = 45 * weak * (unlocked.has('beam') ? 1.2 : 1), cos = Math.cos(0.26);
  const inCone = (p) => { const rel = T3.copy(p).sub(o), dist = rel.length(); if (dist > range || dist < 0.01) return -1; return rel.dot(d) / dist >= cos ? dist : -1; };
  for (const b of bodies) {
    if (b.dead) continue; const dist = inCone(b.pos); if (dist < 0) continue;
    const k = dt * (1.2 - dist / range);
    b.heat = Math.max(0, b.heat - k * 2); b.frost = Math.min(1.2, b.frost + k * 0.9);
    if (b.kind === 'debris') { setDebrisFrost(b, b.frost); setDebrisHeat(b, b.heat); }
    if (b.kind === 'car') {
      b.burnT = Math.max(0, b.burnT - k * 8); b.mesh.userData.paint.emissive.setRGB(b.heat * 3, b.heat * 0.6, 0);
      if (b.frost > 0.6) { if (b.drive) { b.drive = null; toast('Car frozen solid.', 'ice'); } b.mesh.userData.paint.color.copy(b.mesh.userData.base).lerp(new THREE.Color(0.6, 0.85, 1), Math.min(1, b.frost)); }
    }
    if (b.kind === 'meteor') { b.heat = Math.max(0, b.heat - k); }
    if (!b.held && b.mass < 5000) { b.vel.addScaledVector(d, k * 20 * (2000 / b.mass)); wake(b); }
  }
  for (const p of people) {
    if (!p.thug || p.cuffed || p.mode !== 'thug') continue;
    const dist = inCone(p.pos); if (dist < 0) continue;
    p.frz = (p.frz || 0) + dt * 2.5; if (p.frz > 1) { apprehend(p, 'Frozen stiff'); SFX.freezeHit(); }
  }
  for (const g of fires) { const dist = inCone(blockCenter(g, T4)); if (dist >= 0) { fireI[g] -= dt * 1.2 * (1.2 - dist / range); if (rnd() < 0.3) FX.steam(T4.x, T4.y, T4.z); } }
  const hit = raycast(o, d, range, { bodies: false });
  if (hit.type === 'block') { setBlockFrost(hit.g, Math.min(1.2, frost[hit.g] + dt * 0.8)); setBlockHeat(hit.g, Math.max(0, heat[hit.g] - dt * 2)); frostSet.add(hit.g); if (fireI[hit.g] > 0) fireI[hit.g] -= dt * 2; }
  else if ((hit.type === 'water' || hit.type === 'ice') && hit.point.distanceToSquared(lastIce) > 4) {
    lastIce.copy(hit.point);
    const s = iceSheets.find(s => Math.hypot(hit.point.x - s.x, hit.point.z - s.z) < s.r + 1.5);
    if (s) s.r = Math.min(s.r + 0.6, 14); else { iceSheets.push({ x: hit.point.x, z: hit.point.z, r: 2.5 }); if (iceSheets.length > 70) iceSheets.shift(); }
    addDecal('ice', hit.point.x, WATER_Y + 0.05, hit.point.z, 3); SFX.freezeHit();
  } else if (hit.type === 'ground' && hit.point.distanceToSquared(lastIce) > 3) { lastIce.copy(hit.point); addDecal('ice', hit.point.x, 0, hit.point.z, 1.8); }
}
function setXray(on) {
  for (const m of [wallMat, colMat, slabMat]) { m.transparent = on; m.opacity = on ? 0.1 : 1; m.depthWrite = !on; m.needsUpdate = true; }
  for (const m of PPL_LIST) { m.material.depthTest = !on; m.material.emissive.setRGB(on ? 0.2 : 0, on ? 0.9 : 0, on ? 1.4 : 0); m.renderOrder = on ? 6 : 0; }
  grade.uniforms.uTint.value.setRGB(0.7, 0.95, 1.15);
  toast(on ? 'X-ray: walls fade, people glow' : 'X-ray off', 'ice');
}

// ============================================================ player
const camState = { off: new V3(0, 2, 8), fov: 70, shake: 0, roll: 0 };
let hitStopT = 0;
function addShake(a) { camState.shake = Math.min(2.5, camState.shake + a); }
function hitStop(t) { hitStopT = Math.max(hitStopT, t); }
function flashHit(a) { const el = $('fx-hit'); el.style.opacity = a; setTimeout(() => { el.style.opacity = 0; }, 120); }
let smashedThisStep = false, lastSmashFx = 0;
function playerCollide(prevSpeed) {
  const p = P.pos;
  smashedThisStep = false;
  const bd = buildingAt(p.x, p.z);
  if (bd && p.y - 1 < bd.h) {
    const hx = 0.35, hy = 0.97;
    const x0 = Math.max(0, Math.floor((p.x - hx - bd.x0) / CELL)), x1 = Math.min(bd.nx - 1, Math.floor((p.x + hx - bd.x0) / CELL));
    const z0 = Math.max(0, Math.floor((p.z - hx - bd.z0) / CELL)), z1 = Math.min(bd.nz - 1, Math.floor((p.z + hx - bd.z0) / CELL));
    const y0 = Math.max(0, Math.floor((p.y - hy) / STORY)), y1 = Math.min(bd.ny - 1, Math.floor((p.y + hy) / STORY));
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const g = cellIndex(bd, x, y, z); if (!alive[g] || pendingFall[g]) continue;
      const ax0 = bd.x0 + x * CELL, az0 = bd.z0 + z * CELL, ay0 = blockY0(g), ay1 = blockY1(g);
      const ox = Math.min(p.x + hx - ax0, ax0 + CELL - (p.x - hx)), oy = Math.min(p.y + hy - ay0, ay1 - (p.y - hy)), oz = Math.min(p.z + hx - az0, az0 + CELL - (p.z - hx));
      if (ox <= 0 || oy <= 0 || oz <= 0) continue;
      const sp = P.vel.length(), t = blkT[g];
      // superpowered flight: plough through glass, floors and columns alike; he barely slows
      if ((P.flying && sp > 12) || sp > 30 || (P.charging && P.charge > 0.8)) {
        breakBlock(g, T1.copy(P.vel).multiplyScalar(0.6).add(T2.set(R(-4, 4), R(-2, 5), R(-4, 4))), sp > 70 ? 8 : 4, 'smash');
        P.vel.multiplyScalar(t === T_COL ? 0.97 : 0.99); smashedThisStep = true;
        continue;
      }
      const cx = ax0 + CELL / 2, cy = (ay0 + ay1) / 2, cz = az0 + CELL / 2;
      let n;
      if (ox < oy && ox < oz) { const s = p.x > cx ? 1 : -1; p.x += s * ox; n = T3.set(s, 0, 0); }
      else if (oy < oz) { const s = p.y > cy ? 1 : -1; p.y += s * oy; n = T3.set(0, s, 0); if (s > 0) P.grounded = true; }
      else { const s = p.z > cz ? 1 : -1; p.z += s * oz; n = T3.set(0, 0, s); }
      const vn = P.vel.dot(n);
      if (vn < 0) {
        if (sp > 26 && t === T_COL) {
          P.vel.addScaledVector(n, -vn * 1.6); P.vel.multiplyScalar(0.7); addShake(0.6); SFX.punch(p, 1);
          for (let k = 0; k < 16; k++) FX.spark(p.x, p.y, p.z, n.x * 10 + R(-8, 8), R(-4, 8), n.z * 10 + R(-8, 8));
          setBlockHeat(g, Math.min(1, heat[g] + 0.2)); hotSet.add(g);
        } else P.vel.addScaledVector(n, -vn);
      }
    }
  }
  if (smashedThisStep) {
    // tear a ragged, body-sized hole around his path and blow it out ahead of him
    const sp = P.vel.length();
    forBlocksInSphere(p, 3.2, (g, d) => {
      if (rnd() < (blkT[g] === T_COL ? 0.45 : 0.75) * (1 - d / 4.5)) breakBlock(g, T1.copy(P.vel).multiplyScalar(0.5).add(T2.set(R(-6, 6), R(-3, 6), R(-6, 6))), sp > 70 ? 8 : 4, 'smash');
    });
    if (simT - lastSmashFx > 0.08) {
      lastSmashFx = simT;
      addShake(0.35); hitStop(0.012); SFX.punch(p, 1); SFX.crumble(p, 1.2);
      for (let k = 0; k < 24; k++) FX.dust(p.x, p.y, p.z, P.vel.x * 0.35 + R(-8, 8), P.vel.y * 0.35 + R(-4, 8), P.vel.z * 0.35 + R(-8, 8), 1.6);
      for (let k = 0; k < 30; k++) FX.glass(p.x, p.y, p.z, P.vel.x * 0.5 + R(-10, 10), R(-4, 10), P.vel.z * 0.5 + R(-10, 10));
    }
  }
  // rubble pushes Superman out (or gets kicked loose if he is fast)
  rubbleNear(p, 4, r => {
    const d = p.distanceTo(r.pos), rs2 = r.rad + 0.6; if (d >= rs2) return;
    if (P.vel.length() > 20 && reviveRubble(r, T1.copy(P.vel).multiplyScalar(0.6))) return;
    const n = T1.copy(p).sub(r.pos).normalize(); p.addScaledVector(n, rs2 - d);
    const vn = P.vel.dot(n); if (vn < 0) P.vel.addScaledVector(n, -vn); if (n.y > 0.5) P.grounded = true;
  });
  if (P.flying && P.vel.length() > 40) {
    const list = collidersNear(p.x, p.z);
    if (list) for (const c of list) if (p.x > c.x0 && p.x < c.x1 && p.z > c.z0 && p.z < c.z1 && p.y > c.y0 && p.y < c.y1 && rnd() < 0.5) {
      FX.dust(p.x, p.y, p.z, P.vel.x * 0.3 + R(-6, 6), R(-3, 6), P.vel.z * 0.3 + R(-6, 6), 1.4); FX.glass(p.x, p.y, p.z, R(-8, 8), R(-2, 8), R(-8, 8)); break;
    }
  } else { const n = pushOutColliders(p, 0.5, P.vel, 0); if (n && n.y > 0.5) P.grounded = true; }
  const gy = groundY(p.x, p.z);
  if (p.y - 0.97 < gy) {
    const vy = P.vel.y;
    p.y = gy + 0.97;
    if (vy < -30 && (!P.flying || vy < -45)) superLanding(-vy);
    if (vy < 0) P.vel.y = 0;
    P.grounded = true;
  }
}
function superLanding(v) {
  const p = P.pos, gy = groundY(p.x, p.z);
  if (gy < 0) { for (let k = 0; k < 80; k++) FX.water(p.x, WATER_Y, p.z, R(-12, 12), R(6, 26), R(-12, 12)); SFX.splash(p); return; }
  const r = clamp(v * 0.18, 3, 14) * (unlocked.has('land') ? 1.5 : 1);
  addDecal('crater', p.x, 0, p.z, r * 0.5);
  ring(T1.set(p.x, 0.4, p.z), UP, 1, r * 3, 0.6, new THREE.Color(1.6, 1.5, 1.4), 0.6);
  for (let k = 0; k < 50; k++) { const a = R(0, 6.28), s = R(8, 22); FX.dust(p.x + Math.cos(a) * 1.5, 0.3, p.z + Math.sin(a) * 1.5, Math.cos(a) * s, R(0, 3), Math.sin(a) * s, 1.5); }
  SFX.boom(p, Math.min(1.5, v / 50)); addShake(Math.min(2, v / 40)); hitStop(0.08); P.landT = 0.6;
  ledger.damage += 25000;
  for (const b of bodies) {
    if (b.dead || b.held) continue; const d = b.pos.distanceTo(p); if (d > r * 3) continue;
    const k = 1 - d / (r * 3); b.vel.add(T1.copy(b.pos).sub(p).setY(0).normalize().multiplyScalar(k * 20).setY(k * 12)); wake(b); if (b.kind === 'car') disturbCar(b);
  }
  for (const pp of people) { if (pp.mode !== 'free' && pp.mode !== 'cheer') continue; const d = pp.pos.distanceTo(p); if (d < r * 2.5) knock(pp, T1.copy(pp.pos).sub(p).setY(0).normalize().multiplyScalar(4).setY(2), d < r * 0.6); }
  scare(p, 60, 6);
}
function updatePlayer(dt) {
  const fwd = aimDir(new V3());
  const right = new V3(Math.cos(yaw), 0, -Math.sin(yaw));
  let mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + pad.lx;
  let mz = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) - pad.ly;
  const my = (keys.has('Space') || pad.up ? 1 : 0) - (keys.has('KeyC') || pad.down ? 1 : 0);
  if (keys.has('ArrowLeft')) yaw += dt * 2; if (keys.has('ArrowRight')) yaw -= dt * 2;
  if (keys.has('ArrowUp')) pitch = clamp(pitch + dt * 1.5, -1.45, 1.45); if (keys.has('ArrowDown')) pitch = clamp(pitch - dt * 1.5, -1.45, 1.45);
  if (pad.on) { yaw -= pad.rx * dt * 2.6; pitch = clamp(pitch - pad.ry * dt * 2, -1.45, 1.45); }
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || pad.boost;
  const alt = P.pos.y, rho = airRho(alt);
  P.kryp = kryptoniteNear();
  const weak = 1 - P.kryp * 0.75;
  if (P.flying) {
    const wish = T1.copy(fwd).multiplyScalar(mz).addScaledVector(right, mx).addScaledVector(UP, my);
    if (wish.lengthSq() > 1) wish.normalize();
    const sp = P.vel.length();
    let allowed = 75;
    if (wish.lengthSq() > 0.01) {
      const vmaxBase = unlocked.has('speed') ? 1020 : 480;
      const vmax = (boost ? (alt < 150 ? 300 : Math.min(9000, vmaxBase * Math.sqrt(1.225 / rho))) : 75) * weak;
      const acc = (boost ? 140 + sp * 1.3 : 55) * weak;
      P.vel.addScaledVector(wish, acc * dt);
      const along = P.vel.dot(wish);
      if (along > 0) { // carve turns: bleed sideways velocity so flight follows the aim
        const side = T2.copy(P.vel).addScaledVector(wish, -along);
        P.vel.addScaledVector(side, -Math.min(1, dt * (boost ? 2.6 : 3.5)));
        P.vel.addScaledVector(wish, side.length() * Math.min(1, dt * (boost ? 2.6 : 3.5)) * 0.85);
      }
      allowed = Math.max(vmax, sp - 400 * dt);
      const s2 = P.vel.length(); if (s2 > allowed) P.vel.multiplyScalar(allowed / s2);
    } else P.vel.multiplyScalar(Math.exp(-2.4 * dt));
    if (P.kryp > 0.2) P.vel.y -= G * P.kryp * dt * 2;
  } else {
    P.vel.y -= G * dt;
    const fH = T1.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const wish = T2.copy(fH).multiplyScalar(mz).addScaledVector(right, mx); if (wish.lengthSq() > 1) wish.normalize();
    const target = (boost ? 70 : 8) * weak, acc = P.grounded ? (boost ? 160 : 60) : 12;
    const vh = T3.set(P.vel.x, 0, P.vel.z), want = T4.copy(wish).multiplyScalar(target), dv = want.sub(vh);
    const dl = dv.length(), step = acc * dt; if (dl > step) dv.multiplyScalar(step / dl);
    P.vel.x += dv.x; P.vel.z += dv.z;
    P.walkPhase += vh.length() * dt * 1.7;
    if (boost && P.grounded && vh.length() > 20 && rnd() < 0.8) FX.dust(P.pos.x, 0.2, P.pos.z, -P.vel.x * 0.1, 1, -P.vel.z * 0.1, 1);
  }
  // integrate with sub-steps so fast flight sweeps through blocks instead of tunnelling
  const prevSpeed = P.vel.length();
  P.grounded = false;
  const disp = P.vel.length() * dt, steps = Math.min(80, Math.max(1, Math.ceil(disp / 1.2)));
  for (let s = 0; s < steps; s++) {
    P.pos.addScaledVector(P.vel, dt / steps);
    if (P.pos.y < MAXH + 3 || P.pos.y < 3) playerCollide(prevSpeed);
  }
  P.pos.y = Math.min(P.pos.y, 160000);
  // body collisions: he is effectively immovable; things bounce off him
  const ps = P.vel.length();
  for (const b of bodies) {
    if (b.dead || b.held) continue;
    const d = b.pos.distanceTo(P.pos), rr = b.rad + 0.55; if (d >= rr) continue;
    const n = T1.copy(b.pos).sub(P.pos).divideScalar(d || 1);
    const vr = T2.copy(P.vel).sub(b.vel).dot(n);
    if (vr > 0) { b.vel.addScaledVector(n, vr * 1.3); wake(b); if (b.kind === 'car') { disturbCar(b); damageCar(b, vr); } if (vr > 15) { SFX.punch(b.pos, 0.6); addShake(0.2); } }
    if (b.mass > 50000 && ps < 20) P.pos.addScaledVector(n, -(rr - d)); else b.pos.addScaledVector(n, rr - d);
  }
  // sonic boom, vapour cone, re-entry plasma
  const c = soundSpeed(alt), mach = ps / c;
  if (mach > 0.93 && mach < 1.04 && rho > 0.2) {
    const vd = T1.copy(P.vel).normalize(), a1 = T2.set(1, 0, 0).cross(vd).normalize(), a2 = T3.copy(vd).cross(a1);
    for (let k = 0; k < 16; k++) { const a = R(0, 6.28), r = 2.2; const pt = T4.copy(P.pos).addScaledVector(a1, Math.cos(a) * r).addScaledVector(a2, Math.sin(a) * r).addScaledVector(vd, -1.5); FX.vapor(pt.x, pt.y, pt.z, P.vel.x * 0.9, P.vel.y * 0.9, P.vel.z * 0.9); }
  }
  if (mach >= 1 && !P.boomed) { P.boomed = true; sonicBoom(); }
  if (mach < 0.9) P.boomed = false;
  if (ps > 1100 && rho > 0.002) for (let k = 0; k < 8; k++) { const v = T1.copy(P.vel).multiplyScalar(0.92); FX.plasma(P.pos.x + R(-1, 1), P.pos.y + R(-1, 1), P.pos.z + R(-1, 1), v.x, v.y, v.z); }
  // wakes: dust over land, spray over water
  if (P.flying && ps > 35) {
    const gy = groundY(P.pos.x, P.pos.z), h = P.pos.y - Math.max(gy, gy < 0 ? WATER_Y : 0);
    if (h < 12) {
      const n = Math.min(12, (ps / 20) * (1 - h / 12)) | 0;
      for (let k = 0; k < n; k++) {
        const s = R(0.3, 1);
        if (inBay(P.pos.z) && !onIce(P.pos.x, P.pos.z)) FX.water(P.pos.x + R(-2, 2), WATER_Y + 0.2, P.pos.z + R(-2, 2), -P.vel.x * 0.1 + R(-6, 6) * s, R(4, 12) * (1 - h / 12), -P.vel.z * 0.1 + R(-6, 6) * s);
        else FX.dust(P.pos.x + R(-2, 2), 0.4, P.pos.z + R(-2, 2), P.vel.x * 0.15 + R(-6, 6), R(1, 5), P.vel.z * 0.15 + R(-6, 6), 1.2);
      }
    }
    // clouds are a volume you can hit
    for (const cl of clouds) {
      const dx = P.pos.x - cl.x, dy = (P.pos.y - cl.y) * 2.5, dz = P.pos.z - cl.z;
      if (dx * dx + dy * dy + dz * dz < cl.r * cl.r && rnd() < 0.9) {
        for (let k = 0; k < 3; k++) SMK.emit(P.pos.x + R(-6, 6), P.pos.y + R(-4, 4), P.pos.z + R(-6, 6), P.vel.x * 0.4 + R(-6, 6), P.vel.y * 0.4 + R(-4, 4), P.vel.z * 0.4 + R(-6, 6), R(0.6, 1.2), 4, 10, 1.4, 1.4, 1.45, 0.45, 1.5, 1.5, 1.5, 0, 1.2);
        P.inCloud = 0.3;
      }
    }
  }
  if (P.inCloud > 0) P.inCloud -= dt;
  // solar charge: the sun is the battery; thinner air means more of it
  P.solar = Math.min(1, P.solar + dt * (0.02 + (alt > 500 ? 0.05 : 0) + (alt > 20000 ? 0.08 : 0)));
  if (P.clapCD > 0) P.clapCD -= dt;
  if (P.charging) { P.charge += dt; if (P.charge > 0.4 && rnd() < 0.3) { const h = heroPoint(T1.set(0.3, -0.2, -0.3), T2); FX.sparkle(h.x, h.y, h.z); } }
  if (P.hitT > 0) P.hitT -= dt;
  if (P.punchT > 0) P.punchT -= dt;
  if (P.landT > 0) P.landT -= dt;
  if (P.combatT > 0) P.combatT -= dt; else ledger.combo = 0;
  if (alt > 100000 && !P.karman) { P.karman = true; toast('Above the Kármán line. Welcome to space.', 'good'); }
  // the held object rides with him
  if (P.hold) {
    const h = P.hold;
    if (h.dead || (h.kind === 'person' && h.mode !== 'held')) P.hold = null;
    else {
      heldPos(h, h.pos); h.vel.copy(P.vel); h.quat.copy(P.quat).multiply(P.holdRel);
      if (ps > 14 && h.kind !== 'person') buildingCollide(h);
      if (h.kind === 'meteor' && h.kryp) { releaseHeld(); toast('Kryptonite burns. You had to drop it.', 'alert'); }
    }
  }
  heatVision(dt, !!(mouseR || keys.has('KeyR') || pad.heat) && !paused);
  P.freeze = !!(keys.has('KeyQ') || pad.freeze); freezeBreath(dt, P.freeze);
  updateHeroPose(dt, fwd);
}
function sonicBoom() {
  const p = P.pos.clone();
  SFX.sonic(); addShake(1.2); hitStop(0.05);
  const vd = T1.copy(P.vel).normalize();
  ring(p, vd, 1, 80, 0.9, new THREE.Color(2, 2.1, 2.3), 0.5);
  ring(p, vd, 1, 40, 0.5, new THREE.Color(2, 2.1, 2.3), 0.7);
  const rad = 50 * clamp(airRho(p.y) / 1.225, 0, 1);
  if (rad < 5) return;
  if (unlocked.has('boom')) { toast('Mach 1 \u2014 controlled boom, no glass broken', ''); return; }
  let shattered = 0;
  forBlocksInSphere(p, rad, (g, d) => {
    if (blkT[g] !== T_GLASS || rnd() > 0.55 * (1 - d / rad)) return;
    breakBlock(g, T2.copy(blockCenter(g, T3)).sub(p).normalize().multiplyScalar(12), 1, 'boom'); shattered++;
  });
  for (const pp of people) {
    if (pp.mode !== 'free' && pp.mode !== 'cheer') continue; const d = pp.pos.distanceTo(p);
    if (d < rad * 1.5) knock(pp, T2.copy(pp.pos).sub(p).setY(0).normalize().multiplyScalar(3).setY(1), false);
  }
  for (const c of cars) if (!c.dead && c.pos.distanceTo(p) < rad * 1.5) c.alarm = 8;
  if (shattered > 8) { toast(`Sonic boom shattered ${shattered} windows. Fly higher before going supersonic.`, 'alert'); hopeHit(Math.min(4, shattered / 8)); }
  else toast('Mach 1', '');
}
function updateHeroPose(dt, fwd) {
  const sp = P.vel.length();
  const f = P.flying ? clamp((sp - 12) / 25, 0, 1) : 0;
  const camFH = T1.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  const vdir = T2.copy(P.vel).divideScalar(sp || 1);
  const up = T3.copy(UP).lerp(vdir, f).normalize();
  if (up.lengthSq() < 0.1) up.copy(UP);
  const front = T4.copy(camFH).lerp(T5.set(0, -1, 0), f * 0.92);
  front.addScaledVector(up, -front.dot(up));
  if (front.lengthSq() < 1e-4) front.copy(camFH).addScaledVector(up, -camFH.dot(up));
  front.normalize();
  const back = front.multiplyScalar(-1), x = T6.copy(up).cross(back).normalize();
  back.copy(x).cross(up).normalize();
  TM.makeBasis(x, up, back); TQ.setFromRotationMatrix(TM);
  // bank into turns
  const yawRate = (yaw - P.lastYaw) / Math.max(dt, 1e-3); P.lastYaw = yaw;
  P.bank = lerp(P.bank, clamp(yawRate * 0.25 * f, -0.8, 0.8), 1 - Math.exp(-6 * dt));
  TQ2.setFromAxisAngle(T1.set(0, 1, 0), P.bank); TQ.multiply(TQ2);
  P.quat.slerp(TQ, 1 - Math.exp(-10 * dt));
  hero.g.position.copy(P.pos); hero.g.quaternion.copy(P.quat);
  // limbs
  const t = simT;
  // arm z: negative swings the left arm outward, positive the right (mirror image)
  let aL = 0.12, aR = 0.12, aLz = -0.1, aRz = 0.1, lL = 0, lR = 0;
  const sp2 = P.vel.length();
  P.idleT = sp2 < 2 && !P.hold && !P.charging && P.punchT <= 0 ? (P.idleT || 0) + dt : 0;
  if (P.flying && sp2 > 80) { aR = Math.PI * 0.96; aRz = 0.05; aL = 0.15; lL = 0.05; lR = -0.02; }
  else if (P.flying && f > 0.5) { aR = 0.35; aL = 0.35; aLz = -0.2; aRz = 0.2; lL = 0.05; lR = -0.02; }
  else if (P.idleT > 1.5) { aL = -0.3; aR = -0.3; aLz = -0.55; aRz = 0.55; lL = 0.06; lR = -0.06; }
  else if (P.flying) { aL = 0.25 + Math.sin(t * 2) * 0.05; aR = 0.25 + Math.cos(t * 2) * 0.05; aLz = -0.22; aRz = 0.22; lL = 0.12 + Math.sin(t * 1.6) * 0.06; lR = -0.05; }
  else if (P.grounded) { const s = Math.sin(P.walkPhase); lL = s * 0.7; lR = -s * 0.7; aL = -s * 0.5; aR = s * 0.5; }
  if (P.landT > 0) { lL = -0.8; lR = 0.4; aL = 0.6; aR = 0.2; aRz = -0.6; }
  if (P.hold) {
    const big = Math.max(P.hold.half.x, P.hold.half.y, P.hold.half.z) > 1;
    if (big) { aL = aR = Math.PI * 0.97; aLz = -0.15; aRz = 0.15; } else { aL = aR = 1.3; aLz = -0.2; aRz = 0.2; }
  }
  if (P.punchT > 0) { aR = Math.PI / 2 + (f > 0.5 ? 0.6 : 0); aRz = 0; if (P.clapT > 0) { aL = aR = Math.PI / 2; aLz = -0.25; aRz = 0.25; } }
  if (P.clapT > 0) P.clapT -= dt;
  if (P.charging) { aR = -0.6; aRz = -0.3; }
  if (P.kryp > 0.3) { aL = 1.3; aLz = 0.6; aR = 0.1; lL = 0.25; }
  // elbows (x bends forward, z bends toward the body) and knees (negative x bends back)
  let eLx = 0.15, eRx = 0.15, eLz = 0, eRz = 0, kL = -0.05, kR = -0.05;
  if (P.flying && sp2 > 80) { eRx = 0; eLx = 0.1; kL = -0.05; kR = -0.35; }
  else if (P.flying && f > 0.5) { eLx = eRx = 0.35; kL = -0.15; kR = -0.4; }
  else if (P.idleT > 1.5) { eLx = eRx = -0.1; eLz = 1.45; eRz = -1.45; }
  else if (P.flying) { eLx = eRx = 0.3; kL = -0.25 - Math.sin(t * 1.6) * 0.08; kR = -0.12; }
  else if (P.grounded) { const s = P.walkPhase; kL = -Math.max(0, Math.sin(s + 1.6)) * 0.9; kR = -Math.max(0, Math.sin(s + 1.6 + Math.PI)) * 0.9; eLx = eRx = 0.35; }
  if (P.landT > 0) { kL = -1.4; kR = -0.35; eRx = 0.3; }
  if (P.hold) { const big = Math.max(P.hold.half.x, P.hold.half.y, P.hold.half.z) > 1; eLx = eRx = big ? 0.25 : 0.9; }
  if (P.punchT > 0) { eRx = 0; if (P.clapT > 0) eLx = eRx = 0.15; }
  if (P.charging) { eRx = 1.9; }
  if (P.kryp > 0.3) { eLx = 1.5; eLz = 0.6; }
  const k = 1 - Math.exp(-14 * dt);
  hero.elbowL.rotation.x = lerp(hero.elbowL.rotation.x, eLx, k); hero.elbowR.rotation.x = lerp(hero.elbowR.rotation.x, eRx, k);
  hero.elbowL.rotation.z = lerp(hero.elbowL.rotation.z, eLz, k); hero.elbowR.rotation.z = lerp(hero.elbowR.rotation.z, eRz, k);
  hero.kneeL.rotation.x = lerp(hero.kneeL.rotation.x, kL, k); hero.kneeR.rotation.x = lerp(hero.kneeR.rotation.x, kR, k);
  hero.armL.rotation.x = lerp(hero.armL.rotation.x, aL, k); hero.armR.rotation.x = lerp(hero.armR.rotation.x, aR, k);
  hero.armL.rotation.z = lerp(hero.armL.rotation.z, aLz, k); hero.armR.rotation.z = lerp(hero.armR.rotation.z, aRz, k);
  hero.legL.rotation.x = lerp(hero.legL.rotation.x, lL, k); hero.legR.rotation.x = lerp(hero.legR.rotation.x, lR, k);
  hero.suit.emissive.setRGB(P.hitT > 0 ? 1.2 : 0, P.hitT > 0 ? 1.0 : P.kryp * 0.6, P.hitT > 0 ? 0.6 : 0);
}

// ============================================================ world updates
function updateCars(dt) {
  for (const c of cars) {
    if (c.dead) continue;
    if (c.drive && !c.held) {
      const d = c.drive, dirV = d.axis === 'x' ? T1.set(d.dir, 0, 0) : T1.set(0, 0, d.dir);
      let target = d.target;
      const ahead = T2.copy(c.pos).addScaledVector(dirV, 9);
      if (ahead.distanceToSquared(P.pos) < 36 && P.pos.y < 4) target = 0;
      for (const o of cars) if (o !== c && !o.dead && !o.parked && o.pos.distanceToSquared(ahead) < 30) { target = 0; break; }
      if (target > 0) { const k = skey(Math.floor(ahead.x / SH), Math.floor(1 / SH), Math.floor(ahead.z / SH)); const ra = staticHash.get(k), ha = hash.get(k); if ((ra && ra.length) || (ha && ha.some(o => o.kind === 'debris'))) target = 0; }
      if (target === 0 && rnd() < dt * 0.3 && sfxOK('horn', 1.5)) sfxTone(0.05 * distVol(c.pos), 0.35, 'square', 392);
      d.v = lerp(d.v, target, 1 - Math.exp(-1.6 * dt));
      if (d.axis === 'x') { c.pos.x += d.dir * d.v * dt; c.pos.z = d.lane; if (c.pos.x > 245) c.pos.x = -245; if (c.pos.x < -245) c.pos.x = 245; }
      else { c.pos.z += d.dir * d.v * dt; c.pos.x = d.lane; if (c.pos.z > 232) c.pos.z = -245; if (c.pos.z < -245) c.pos.z = 232; }
      c.pos.y = 0.85; c.vel.copy(dirV).multiplyScalar(d.v); c.sleeping = true;
    }
    if (c.burnT > 0) { c.burnT -= dt; if (rnd() < 0.6) FX.fire(c.pos.x + R(-1.5, 1.5), c.pos.y + 0.6, c.pos.z + R(-0.7, 0.7), 1); if (rnd() < 0.3) FX.smoke(c.pos.x, c.pos.y + 2, c.pos.z, 1.2, 0.03); }
    if (c.heat > 0) { c.heat = Math.max(0, c.heat - dt * 0.06); c.mesh.userData.paint.emissive.setRGB(c.heat * 3, c.heat * 0.6, 0); }
    if (c.alarm > 0) { c.alarm -= dt; if (sfxOK('alarm' + c.id, 0.5) && distVol(c.pos) > 0.15) sfxTone(0.04 * distVol(c.pos), 0.25, 'square', (Math.floor(simT * 2) % 2) ? 880 : 660); }
    c.mesh.position.copy(c.pos); c.mesh.quaternion.copy(c.quat);
  }
  writeCarInstances();
  for (const h of helis) if (!h.dead) { h.mesh.position.copy(h.pos); h.mesh.quaternion.copy(h.quat); h.mesh.userData.rotor.rotation.y += (h.crashed ? 0 : h.rotorW) * dt; }
  for (const m of meteors) if (!m.dead) {
    m.mesh.position.copy(m.pos); m.mesh.quaternion.copy(m.quat);
    if (m.noGrav && !m.held) { // incoming: straight line; check for impact
      if (blockAt(m.pos.x, m.pos.y, m.pos.z) >= 0 || m.pos.y < 3) meteorImpact(m);
    }
  }
  for (const m of meteors) if (m.dead && m.mesh.parent) scene.remove(m.mesh);
  for (const h of helis) if (h.dead && h.mesh.parent) scene.remove(h.mesh);
}
const MAT_UP = new THREE.Matrix4();
function updatePeople(dt) {
  let hurtN = 0;
  for (const p of people) {
    p.anim += dt;
    switch (p.mode) {
      case 'free': {
        const sp = p.fleeT > 0 ? 5.2 : p.spd;
        if (p.fleeT > 0) p.fleeT -= dt;
        const nx = p.pos.x + p.dir.x * sp * dt, nz = p.pos.z + p.dir.z * sp * dt;
        if (blockAt(nx, 1, nz) >= 0 || nz > WATER_Z - 4 || Math.abs(nx) > 255 || nz < -255) {
          const a = Math.floor(rnd() * 4) * Math.PI / 2; p.dir.set(Math.cos(a), 0, Math.sin(a)); if (p.fleeT > 0) p.dir.multiplyScalar(-1);
        } else { p.pos.x = nx; p.pos.z = nz; }
        if (p.fleeT <= 0 && rnd() < dt * 0.05) { const a = Math.floor(rnd() * 4) * Math.PI / 2; p.dir.set(Math.cos(a), 0, Math.sin(a)); }
        p.pos.y = groundY(p.pos.x, p.pos.z) + 0.9; p.face = Math.atan2(p.dir.z, p.dir.x);
        break;
      }
      case 'cheer':
        p.cheerT -= dt; p.face = Math.atan2(P.pos.z - p.pos.z, P.pos.x - p.pos.x);
        p.photoT -= dt; if (p.photoT <= 0) { p.photoT = R(0.8, 2.5); FX.flash(p.pos.x, p.pos.y + 0.5, p.pos.z); }
        if (p.cheerT <= 0) p.mode = 'free';
        break;
      case 'phys':
        if (p.sleeping || (p.onGround && p.vel.lengthSq() < 0.3 && p.age > 0.4)) {
          if (p.thug) { p.cuffed = true; p.mode = 'thug'; p.pos.y = 0.9; break; }
          if (p.injured) { p.mode = 'down'; p.pos.y = groundY(p.pos.x, p.pos.z) + 0.25; break; }
          if (p.setDown && p.prevDanger) addSave(1, p.pos, 'Set down safely');
          p.setDown = false; p.prevDanger = false; p.danger = false;
          p.mode = 'free'; p.pos.y = groundY(p.pos.x, p.pos.z) + 0.9; p.fleeT = 3; p.quat.identity();
        }
        if (inBay(p.pos.z) && p.pos.y < 0) { p.vel.multiplyScalar(0.9); }
        break;
      case 'down': hurtN++; break;
      case 'held': if (p.injured) hurtN++; break;
      case 'safe': p.goneT -= dt; if (rnd() < 0.3) FX.sparkle(p.pos.x, p.pos.y, p.pos.z); if (p.goneT <= 0) p.mode = 'gone'; break;
      default: break;
    }
    // pose the instanced body parts
    const s = p.slot;
    if (p.mode === 'gone') { for (const m of PPL_LIST) m.setMatrixAt(s, ZERO_M); continue; }
    if (p.mode === 'phys' || p.mode === 'held') TQ.copy(p.quat);
    else if (p.mode === 'down') TQ.setFromAxisAngle(UP, -p.face).multiply(TQ2.setFromAxisAngle(T1.set(0, 0, 1), Math.PI / 2));
    else TQ.setFromAxisAngle(UP, -p.face);
    T2.copy(p.pos);
    let legA = 0, armL = 0.08, armR = 0.08, kneel = false;
    const walking = p.mode === 'free' || (p.mode === 'thug' && false);
    if (walking) {
      const fast = p.fleeT > 0, ph = p.anim * (fast ? 10 : 6.2);
      legA = Math.sin(ph) * (fast ? 0.8 : 0.45); armL = -legA * 0.8; armR = legA * 0.8;
      T2.y += Math.abs(Math.cos(ph)) * (fast ? 0.06 : 0.03);
      if (fast) { armL += 0.5; armR += 0.5; }
    } else if (p.mode === 'cheer') {
      armL = Math.PI * 0.85 + Math.sin(p.anim * 9) * 0.25; armR = p.photoT < 0.6 ? 1.5 : Math.PI * 0.85 + Math.cos(p.anim * 9) * 0.25;
      T2.y += Math.abs(Math.sin(p.anim * 7)) * 0.12;
    } else if (p.mode === 'phys' || p.mode === 'held') {
      legA = Math.sin(p.anim * 13) * 0.6; armL = 1.2 + Math.sin(p.anim * 11) * 0.8; armR = 1.2 + Math.cos(p.anim * 12) * 0.8;
    } else if (p.mode === 'trapped') {
      armL = Math.PI * 0.9 + Math.sin(p.anim * 6) * 0.3; armR = Math.PI * 0.9 - Math.sin(p.anim * 6) * 0.3;
    } else if (p.mode === 'thug') {
      if (p.cuffed) { kneel = true; armL = armR = -0.5; }
      else { armL = 0.4; armR = p.tele > 0 || p.burst > 0 ? Math.PI / 2 : 1.1; }
    }
    if (kneel) T2.y -= 0.42;
    if (walking && p.fleeT > 0) TQ.multiply(TQ2.setFromAxisAngle(T1.set(0, 0, 1), -0.26));
    if (p.mode === 'thug' && !p.cuffed) { T2.y -= 0.08; TQ.multiply(TQ2.setFromAxisAngle(T1.set(0, 0, 1), -0.18)); }
    TM.compose(T2, TQ, TS.set(p.ws || 1, p.hs || 1, p.ws || 1));
    placePart(PPL.torso, s, TM, 0, 0, 0, 0); placePart(PPL.hips, s, TM, 0, 0, 0, 0);
    placePart(PPL.head, s, TM, 0, 0, 0, 0); placePart(PPL.hair, s, TM, 0, 0, 0, 0);
    placePart(PPL.legL, s, TM, 0, -0.06, -0.095, kneel ? 1.45 : legA); placePart(PPL.legR, s, TM, 0, -0.06, 0.095, kneel ? 0.2 : -legA);
    placePart(PPL.armL, s, TM, 0, 0.5, -0.235, armL); placePart(PPL.armR, s, TM, 0, 0.5, 0.235, armR);
  }
  for (const m of PPL_LIST) m.instanceMatrix.needsUpdate = true;
  ledger.injuries = hurtN;
}
let coolAcc = 0;
function cool(dt) {
  coolAcc += dt; if (coolAcc < 0.1) return; dt = coolAcc; coolAcc = 0;
  // heated blocks bleed heat; burning ones keep their own glow
  for (const g of hotSet) {
    if (!alive[g]) { hotSet.delete(g); continue; }
    if (fireI[g] > 0) continue;
    const v = heat[g] - dt * 0.05;
    if (v <= 0.002) { heat[g] = 0; typeMesh[blkT[g]].userData.aH.setX(blkSub[g], 0); attrDirty[blkT[g]] = true; hotSet.delete(g); } else setBlockHeat(g, v);
  }
  for (const g of frostSet) { if (!alive[g]) { frostSet.delete(g); continue; } const v = frost[g] - dt * 0.02; if (v <= 0) { setBlockFrost(g, 0); frostSet.delete(g); } else setBlockFrost(g, v); }
  for (const b of bodies) {
    if (b.kind !== 'debris' || b.dead) continue;
    if (b.heat > 0) { setDebrisHeat(b, Math.max(0, b.heat - dt * 0.05)); if (rnd() < b.heat * 0.2) FX.smoke(b.pos.x, b.pos.y, b.pos.z, 0.6, 0.06); }
    if (b.frost > 0) setDebrisFrost(b, Math.max(0, b.frost - dt * 0.02));
  }
}

// ============================================================ camera
const titleAngle = () => 0.55 + Math.sin(simT * 0.07) * 0.35;
function updateCamera(dt) {
  if (!started) {
    // cinematic title framing: hero in the right third, slow drift around him
    const ta = titleAngle();
    camera.position.set(P.pos.x + Math.sin(ta) * 6.2, P.pos.y + 0.35, P.pos.z + Math.cos(ta) * 6.2);
    const rx = Math.cos(ta), rz = -Math.sin(ta);
    camera.lookAt(T5.set(P.pos.x - rx * 2.1, P.pos.y + 0.25, P.pos.z - rz * 2.1));
    if (camera.fov !== 48) { camera.fov = 48; camState.fov = 48; camera.updateProjectionMatrix(); }
    return;
  }
  const fwd = aimDir(T1), right = T2.set(Math.cos(yaw), 0, -Math.sin(yaw));
  const sp = P.vel.length();
  const combat = currentInc && currentInc.type === 'robbery' && currentInc.marker().distanceTo(P.pos) < 70;
  const walking = !P.flying && started;
  let dist = combat ? 5.2 : walking ? 8.4 + Math.min(4, sp * 0.05) : 6.8 + Math.min(9, sp * 0.025);
  if (P.hold) dist += Math.min(8, Math.max(P.hold.half.x, P.hold.half.y, P.hold.half.z) * 1.4);
  if (!started) dist = 9;
  // walking frames him low and off-centre, like a third-person street camera; flight keeps him central
  const want = T3.copy(fwd).multiplyScalar(-dist).addScaledVector(UP, combat ? 1.1 : walking ? 2.4 : 1.5).addScaledVector(right, combat ? 1.2 : walking ? 0.85 : 0.95);
  camState.off.lerp(want, 1 - Math.exp(-(combat ? 6 : 9) * dt));
  const cp = T4.copy(P.pos).add(camState.off);
  // keep the camera out of walls
  const toCam = T5.copy(cp).sub(P.pos), L = toCam.length(); toCam.divideScalar(L || 1);
  const hit = raycast(T6.copy(P.pos).addScaledVector(UP, 0.5), toCam, L, { bodies: false });
  if (hit.type === 'block' && !P.xray) cp.copy(P.pos).addScaledVector(UP, 0.5).addScaledVector(toCam, Math.max(1.2, hit.t - 0.6));
  if (cp.y < groundY(cp.x, cp.z) + 0.4 && !inBay(cp.z)) cp.y = 0.4;
  camera.position.copy(cp);
  if (camState.shake > 0) {
    const s = camState.shake * camState.shake * 0.35;
    camera.position.add(T5.set(R(-1, 1) * s, R(-1, 1) * s, R(-1, 1) * s));
    camState.shake = Math.max(0, camState.shake - dt * 2.2);
  }
  camera.lookAt(T5.copy(camera.position).add(fwd));
  // banking and speed FOV give flight its weight
  camState.roll = lerp(camState.roll, -P.bank * 0.35, 1 - Math.exp(-5 * dt));
  camera.rotateZ(camState.roll);
  const mach = sp / soundSpeed(P.pos.y);
  const fovT = (combat ? 62 : 68) + Math.min(24, mach * 14 + sp * 0.03) + (P.charging ? -Math.min(6, P.charge * 5) : 0);
  camState.fov = lerp(camState.fov, fovT, 1 - Math.exp(-4 * dt));
  camera.fov = camState.fov; camera.updateProjectionMatrix();
}

// ============================================================ HUD + atmosphere
let hudT = 0;
const spdEl = $('spd'), machEl = $('mach'), altEl = $('alt'), rhoEl = $('rho'), modeEl = $('mode');
const solarBar = $('solar-bar'), solarPct = $('solar-pct'), chargeC = document.querySelector('#charge circle');
function updateHUD(dt) {
  const sp = P.vel.length(), alt = P.pos.y;
  solarBar.style.transform = `scaleX(${P.solar.toFixed(3)})`;
  solarBar.parentElement.classList.toggle('low', P.solar < 0.2);
  chargeC.style.strokeDashoffset = (100.5 * (1 - Math.min(1, P.charge / 1.2))).toFixed(1);
  hudT -= dt;
  if (hudT <= 0) {
    hudT = 0.1;
    spdEl.textContent = Math.round(sp * 3.6).toLocaleString();
    machEl.textContent = (sp / soundSpeed(alt)).toFixed(2);
    altEl.textContent = alt > 10000 ? (alt / 1000).toFixed(1) + ' km' : Math.round(alt) + ' m';
    rhoEl.textContent = airRho(alt) < 0.001 ? airRho(alt).toExponential(1) : airRho(alt).toFixed(3);
    const inc = currentInc;
    modeEl.textContent = (P.kryp > 0.2 ? 'Kryptonite! · ' : '') + (P.flying ? (alt > 100000 ? 'Orbit' : 'Flight') : 'Walking') + (P.slow ? ' · slow time' : '') + (inc ? ` · ${Math.max(0, Math.ceil(inc.limit - inc.age))}s` : '');
    $('st-saved').textContent = ledger.saves; $('st-lost').textContent = ledger.lost; $('st-inj').textContent = ledger.injuries;
    $('st-thugs').textContent = ledger.thugs + (ledger.combo > 1 ? ` (×${ledger.combo})` : '');
    $('st-res').textContent = `${ledger.resolved} · \u{1F947}${ledger.medals.gold} \u{1F948}${ledger.medals.silver} \u{1F949}${ledger.medals.bronze}`;
    $('st-dmg').textContent = money(ledger.damage);
    $('st-hope').textContent = Math.round(ledger.hope);
    $('st-streak').textContent = ledger.streak;
    solarPct.textContent = Math.round(P.solar * 100) + '%';
    chips.boost.classList.toggle('on', !!(keys.has('ShiftLeft') || keys.has('ShiftRight') || pad.boost));
    chips.punch.classList.toggle('on', P.punchT > 0 || P.charging);
    chips.grab.classList.toggle('on', !!P.hold);
    chips.heat.classList.toggle('on', beams[0].visible);
    chips.freeze.classList.toggle('on', !!P.freeze);
    chips.xray.classList.toggle('on', P.xray); chips.hear.classList.toggle('on', P.hear); chips.slow.classList.toggle('on', P.slow);
    chips.clap.classList.toggle('on', P.clapCD > 0.6); chips.fly.classList.toggle('on', P.flying);
  }
  const list = [];
  if (currentInc) list.push({ pos: currentInc.marker(), cls: currentInc.m && currentInc.m.kryp ? 'kryp' : 'inc', label: currentInc.type === 'robbery' ? 'Robbery' : currentInc.type === 'fire' ? 'Fire' : currentInc.type === 'heli' ? 'Falling helicopter' : (currentInc.m && currentInc.m.kryp ? 'Kryptonite meteor' : 'Meteor'), sub: Math.round(currentInc.marker().distanceTo(P.pos) / 5) * 5 + ' m' });
  if (currentInc && currentInc.type === 'robbery') for (const p of currentInc.crew) if (p.tele > 0 && !p.cuffed) list.push({ pos: T1.copy(p.pos).setY(p.pos.y + 1.6).clone(), cls: 'hurt', label: '!', sub: 'shot coming' });
  let hearN = 0;
  for (const p of people) {
    if (p.mode === 'down' && (P.hear || p.pos.distanceTo(P.pos) < 70)) list.push({ pos: T1.copy(p.pos).setY(p.pos.y + 1).clone(), cls: 'hurt', label: 'Injured', sub: Math.round(p.pos.distanceTo(P.pos)) + ' m' });
    if (p.mode === 'trapped' && (P.hear || P.xray)) { list.push({ pos: T1.copy(p.pos).setY(p.pos.y + 1).clone(), cls: 'trap', label: 'Trapped', sub: 'floor ' + (Math.floor(p.pos.y / STORY) + 1) }); hearN++; }
  }
  const anyHurt = people.some(p => p.mode === 'down' || (p.mode === 'held' && p.injured));
  if (anyHurt || (P.hold && P.hold.kind === 'person') || ledger.time - onboard.hospT < 8) list.push({ pos: T1.copy(HOSP).setY(3).clone(), cls: 'hosp', label: 'Hospital', sub: Math.round(HOSP.distanceTo(P.pos)) + ' m' });
  if (P.hear && hearN) SFX.heartbeat();
  markers(list.slice(0, 40));
}
function updateAtmosphere(dt) {
  const alt = camera.position.y;
  const space = clamp(Math.log10(Math.max(1, alt / 2000)) / 1.7, 0, 1);
  skyMat.uniforms.uSpace.value = space;
  sky.position.copy(camera.position); stars.position.copy(camera.position);
  stars.material.opacity = clamp((space - 0.4) * 2, 0, 1);
  const hr = lerp(HOR0[0], HOR1[0], space), hg = lerp(HOR0[1], HOR1[1], space), hb = lerp(HOR0[2], HOR1[2], space);
  scene.fog.color.setRGB(Math.pow(hr, 2.2) * 1.15, Math.pow(hg, 2.2) * 1.15, Math.pow(hb, 2.2) * 1.15);
  scene.fog.density = 0.00055 * clamp(airRho(alt) / 1.225, 0.0, 1) + (P.inCloud > 0 ? 0.02 : 0);
  sun.position.copy(P.pos).addScaledVector(SUN_DIR, 600); sun.target.position.copy(P.pos);
  const sunUp = 1 + space * 0.6; sun.intensity = 3.3 * sunUp;
  // post: speed distortion, slow-time desaturation, x-ray / underwater / kryptonite tints
  const mach = P.vel.length() / soundSpeed(P.pos.y);
  const gu = grade.uniforms;
  gu.uTime.value = simT % 100;
  gu.uAberr.value = lerp(gu.uAberr.value, clamp((mach - 0.6) * 0.012, 0, 0.02) + (P.hitT > 0 ? 0.01 : 0), 1 - Math.exp(-5 * dt));
  gu.uSat.value = lerp(gu.uSat.value, P.slow ? 0.35 : 1.08, 1 - Math.exp(-5 * dt));
  const under = camera.position.y < WATER_Y && inBay(camera.position.z);
  let tint = 0;
  if (P.xray) { gu.uTint.value.setRGB(0.75, 1.0, 1.2); tint = 0.6; }
  else if (under) { gu.uTint.value.setRGB(0.3, 0.6, 0.8); tint = 0.85; }
  else if (P.kryp > 0.1) { gu.uTint.value.setRGB(0.6, 1.3, 0.6); tint = P.kryp * 0.7; }
  else if (P.slow) { gu.uTint.value.setRGB(0.8, 0.9, 1.15); tint = 0.4; }
  gu.uTintAmt.value = lerp(gu.uTintAmt.value, tint, 1 - Math.exp(-6 * dt));
  gu.uVig.value = 0.5 + (P.slow ? 0.4 : 0) + P.kryp * 0.5;
  bloom.strength = 0.55 + (P.slow ? 0.15 : 0);
  if (AU.ctx) {
    const sp = P.vel.length();
    AU.wind.g.gain.setTargetAtTime(AU.muted ? 0 : Math.min(0.6, sp / 250) * clamp(airRho(P.pos.y) / 1.225 + 0.05, 0, 1), AU.ctx.currentTime, 0.1);
    AU.wind.f.frequency.setTargetAtTime(250 + Math.min(2500, sp * 6), AU.ctx.currentTime, 0.1);
  }
  for (const f of flashes) if (f.l.intensity > 0) f.l.intensity = Math.max(0, f.l.intensity - f.p * dt * 3);
}

// ============================================================ front page
function headline() {
  const L = ledger;
  const dmg = money(L.damage);
  if (L.saves === 0 && L.damage < 1e6) return ['A QUIET SKY', 'Metropolis looks up and waits'];
  if (L.hope >= 80) return [`SUPERMAN SAVES ${L.saves}`, L.damage > 5e6 ? `Even with ${dmg} in damage, the city cheers` : 'City hails a near-flawless day'];
  if (L.hope >= 55) return [`${L.saves} RESCUED`, `— but repair bill hits ${dmg}`];
  if (L.hope >= 30) return [`HERO OR HAZARD?`, `${dmg} in damage, ${L.saves} saved, ${L.injuries + L.lost} hurt or lost`];
  return ['CITY ASKS: WHO WILL STOP HIM?', `Damage tops ${dmg} as alien’s rampage continues`];
}
function renderFrontPage() {
  const [h1, h2] = headline(), L = ledger;
  const rows = UNLOCKS.map(u => `<li class="${unlocked.has(u.id) ? 'got' : ''}">${u.name} <small>${unlocked.has(u.id) ? 'unlocked' : u.desc}</small></li>`).join('');
  $('paper').innerHTML = `
    <div class="mast">Daily Planet</div>
    <div class="dateline">Metropolis &middot; Final edition &middot; ${new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</div>
    <h2>${h1}</h2><p class="deck">${h2}</p>
    <div class="cols">
      <div><b>${L.saves}</b><span>lives saved</span></div>
      <div><b>${L.lost}</b><span>lost</span></div>
      <div><b>${money(L.damage)}</b><span>property damage</span></div>
      <div><b>${Math.round(L.hope)}</b><span>Hope</span></div>
      <div><b>${L.medals.gold}/${L.medals.silver}/${L.medals.bronze}</b><span>gold / silver / bronze</span></div>
      <div><b>${L.best}</b><span>best streak</span></div>
    </div>
    <ul class="unlocks">${rows}</ul>
    <p class="hint">Click or press P to get back out there.</p>`;
}

// ============================================================ maps, waypoints and beacon beams
// Minimap (rotates with the camera, zooms with speed), full city map (M / Tab, click to set a waypoint),
// and tall light beacons so every alert can be followed from across the city.
const MAP = (() => {
  const W0 = -1400, SPAN = 2800, PPM = 0.5; // base layer: world x/z in [-1400, 1400] at 0.5 px per metre
  const base = document.createElement('canvas'); base.width = base.height = SPAN * PPM;
  const bx = base.getContext('2d');
  const P2 = v => (v - W0) * PPM;
  bx.fillStyle = '#2a2d33'; bx.fillRect(0, 0, base.width, base.height);
  bx.fillStyle = '#1d3d57'; bx.fillRect(0, P2(WATER_Z), base.width, (FAR_SHORE - WATER_Z) * PPM); // the bay
  bx.fillStyle = '#3a3e46';                                                                          // streets everywhere else
  // skyline footprints from the plugin colliders
  bx.fillStyle = '#4c525c';
  for (const c of pluginColliders) if (c.y0 < 1) bx.fillRect(P2(c.x0), P2(c.z0), Math.max(1, (c.x1 - c.x0) * PPM), Math.max(1, (c.z1 - c.z0) * PPM));
  // the destructible core: sidewalks, parks, hospital (towers are drawn live so damage shows)
  for (const L of lotInfo) {
    bx.fillStyle = L.type === 'park' ? '#3d6b3a' : L.type === 'hospital' ? '#6c7a72' : '#565b63';
    bx.fillRect(P2(L.lx), P2(L.lz), 40 * PPM, 40 * PPM);
  }
  const big = document.getElementById('bigmap-c'), bigx = big.getContext('2d');
  const mini = document.getElementById('minimap'), mx = mini.getContext('2d');
  return { base, P2, W0, PPM, big, bigx, mini, mx, open: false, waypoint: null, t: 0, bigView: { cx: 0, cz: 300, mpp: 2.2 } };
})();

// live building state for the maps: fraction of blocks still standing
function refreshBuildingDamage() {
  for (const b of buildings) {
    let n = 0, a = 0;
    for (let g = b.start, e = b.start + b.nx * b.ny * b.nz; g < e; g += 3) { n++; if (alive[g]) a++; }
    b.standing = n ? a / n : 0;
  }
}
refreshBuildingDamage();

// everything that deserves a pin: [x, z, kind, label]
function mapPins() {
  const pins = [];
  if (currentInc) { const m = currentInc.marker(); pins.push([m.x, m.z, currentInc.m && currentInc.m.kryp ? 'kryp' : 'inc', currentInc.type]); }
  for (const p of people) {
    if (p.mode === 'down') pins.push([p.pos.x, p.pos.z, 'hurt', 'Injured']);
    else if (p.mode === 'trapped') pins.push([p.pos.x, p.pos.z, 'trap', 'Trapped']);
  }
  const carrying = P.hold && P.hold.kind === 'person';
  if (carrying || people.some(p => p.mode === 'down')) pins.push([HOSP.x, HOSP.z, 'hosp', 'Hospital']);
  if (MAP.waypoint) pins.push([MAP.waypoint.x, MAP.waypoint.z, 'way', 'Waypoint']);
  return pins;
}
const PIN_COL = { inc: '#ffc531', kryp: '#a6ff3d', hurt: '#ff6b6b', trap: '#9be6ff', hosp: '#57e39a', way: '#5aa9ff' };
function drawPin(ctx, x, y, kind, r, pulse) {
  ctx.save(); ctx.translate(x, y);
  const col = PIN_COL[kind] || '#fff';
  if (pulse) { ctx.globalAlpha = 0.35 * (1 - pulse); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, r * (1 + Math.abs(pulse) * 1.6), 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
  ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineWidth = 2;
  ctx.beginPath();
  if (kind === 'hurt') { ctx.rect(-r * 0.3, -r, r * 0.6, r * 2); ctx.rect(-r, -r * 0.3, r * 2, r * 0.6); }
  else if (kind === 'hosp') { ctx.rect(-r, -r, r * 2, r * 2); }
  else if (kind === 'trap') { ctx.rect(-r, -r * 0.7, r * 2, r * 1.4); }
  else if (kind === 'kryp') { for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); }
  else if (kind === 'way') { ctx.moveTo(0, r * 1.2); ctx.lineTo(-r * 0.8, -r * 0.2); ctx.arc(0, -r * 0.3, r * 0.8, Math.PI, 0); ctx.closePath(); }
  else { ctx.moveTo(0, -r * 1.2); ctx.lineTo(r, 0); ctx.lineTo(0, r * 1.2); ctx.lineTo(-r, 0); ctx.closePath(); }
  ctx.fill(); ctx.stroke();
  if (kind === 'hosp') { ctx.fillStyle = '#0b2a1a'; ctx.font = `800 ${r * 1.5}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', 0, 1); }
  ctx.restore();
}
function drawTowers(ctx, toX, toY, s) {
  for (const b of buildings) {
    const st = b.standing; if (st < 0.02) continue;
    const h = b.h * st, v = Math.min(1, 0.35 + h / 220);
    ctx.fillStyle = `rgb(${Math.round(110 + 90 * v)},${Math.round(112 + 88 * v)},${Math.round(120 + 85 * v)})`;
    ctx.globalAlpha = 0.45 + 0.55 * st;
    ctx.fillRect(toX(b.x0), toY(b.z0), (b.x1 - b.x0) * s, (b.z1 - b.z0) * s);
  }
  ctx.globalAlpha = 1;
}

// minimap: rotated so the camera's forward is up; zooms out with speed
function drawMinimap() {
  const { mini, mx, base, W0, PPM } = MAP, R0 = mini.width / 2, sp = P.vel.length();
  const mpp = 1.4 + Math.min(7, sp / 45);           // metres per pixel
  const s = 1 / mpp;
  mx.clearRect(0, 0, mini.width, mini.height);
  mx.save(); mx.beginPath(); mx.arc(R0, R0, R0 - 2, 0, 7); mx.clip();
  mx.fillStyle = '#23262c'; mx.fillRect(0, 0, mini.width, mini.height);
  mx.translate(R0, R0); mx.rotate(yaw); mx.scale(s, s); mx.translate(-P.pos.x, -P.pos.z);
  mx.imageSmoothingEnabled = true;
  mx.drawImage(base, W0, W0, base.width / PPM, base.height / PPM);
  drawTowers(mx, x => x, z => z, 1);
  mx.restore();
  // pins (kept upright); off-map pins ride the rim with an arrow
  const c = Math.cos(yaw), sn = Math.sin(yaw), pulse = (simT * 0.8) % 1;
  for (const [x, z, kind] of mapPins()) {
    const dx = (x - P.pos.x) * s, dz = (z - P.pos.z) * s;
    let px = dx * c - dz * sn, py = dx * sn + dz * c;
    const d = Math.hypot(px, py), lim = R0 - 12;
    if (d > lim) {
      px *= lim / d; py *= lim / d;
      mx.save(); mx.translate(R0 + px, R0 + py); mx.rotate(Math.atan2(py, px)); mx.fillStyle = PIN_COL[kind];
      mx.beginPath(); mx.moveTo(12, 0); mx.lineTo(4, -6); mx.lineTo(4, 6); mx.closePath(); mx.fill(); mx.restore();
    }
    drawPin(mx, R0 + px, R0 + py, kind, kind === 'inc' || kind === 'kryp' || kind === 'way' ? 7 : 5, kind === 'inc' || kind === 'kryp' ? pulse : 0);
  }
  // player arrow and the north tick on the rim
  mx.save(); mx.translate(R0, R0); mx.fillStyle = '#fff'; mx.strokeStyle = '#c4161c'; mx.lineWidth = 2;
  mx.beginPath(); mx.moveTo(0, -10); mx.lineTo(7, 8); mx.lineTo(0, 4); mx.lineTo(-7, 8); mx.closePath(); mx.fill(); mx.stroke(); mx.restore();
  const na = yaw - Math.PI / 2; // world -z after rotation
  mx.fillStyle = '#ffc531'; mx.font = '800 13px sans-serif'; mx.textAlign = 'center'; mx.textBaseline = 'middle';
  mx.fillText('N', R0 + (R0 - 11) * Math.cos(na), R0 + (R0 - 11) * Math.sin(na));
  mx.strokeStyle = 'rgba(255,255,255,.35)'; mx.lineWidth = 2; mx.beginPath(); mx.arc(R0, R0, R0 - 2, 0, 7); mx.stroke();
}

// full map: north up, street names, pins and a legend; click to set or clear a waypoint
function drawBigMap() {
  const { big, bigx, base, W0, PPM, bigView: v } = MAP;
  const w = big.width = big.clientWidth * Math.min(2, window.devicePixelRatio || 1), h = big.height = big.clientHeight * Math.min(2, window.devicePixelRatio || 1);
  const s = Math.min(w, h) / (v.mpp * 520);
  const toX = x => w / 2 + (x - v.cx) * s, toY = z => h / 2 + (z - v.cz) * s;
  bigx.fillStyle = '#1b1e23'; bigx.fillRect(0, 0, w, h);
  bigx.drawImage(base, toX(W0), toY(W0), base.width / PPM * s, base.height / PPM * s);
  drawTowers(bigx, toX, toY, s);
  // street and avenue names along the core's roads
  bigx.fillStyle = 'rgba(255,255,255,.75)'; bigx.font = `600 ${Math.max(10, 11 * s)}px sans-serif`; bigx.textAlign = 'center'; bigx.textBaseline = 'middle';
  for (let k = 0; k <= LOTS; k++) {
    const rc = -HALF + k * PITCH;
    if (k < LOTS) {
      bigx.save(); bigx.translate(toX(rc), toY(HALF + 6)); bigx.rotate(-Math.PI / 2); bigx.textAlign = 'right'; bigx.fillText(STREETS[k] || '', 0, 0); bigx.textAlign = 'center'; bigx.restore();
      bigx.fillText(AVES[k] || '', toX(-HALF - 40), toY(rc + PITCH / 2 - 30));
    }
  }
  bigx.fillStyle = 'rgba(155,200,255,.8)'; bigx.font = `700 ${Math.max(12, 16 * s)}px sans-serif`; bigx.fillText("HOB'S BAY", toX(0), toY(900));
  const pulse = (performance.now() / 1000 * 0.8) % 1;
  for (const [x, z, kind, label] of mapPins()) {
    drawPin(bigx, toX(x), toY(z), kind, kind === 'inc' || kind === 'kryp' || kind === 'way' ? 10 : 7, kind === 'inc' || kind === 'kryp' ? pulse : 0);
    if (kind === 'inc' || kind === 'kryp' || kind === 'way') { bigx.fillStyle = '#fff'; bigx.font = '700 14px sans-serif'; bigx.fillText(label.toUpperCase(), toX(x), toY(z) - 22); }
  }
  // Superman
  bigx.save(); bigx.translate(toX(P.pos.x), toY(P.pos.z)); bigx.rotate(-yaw); bigx.fillStyle = '#fff'; bigx.strokeStyle = '#c4161c'; bigx.lineWidth = 3;
  bigx.beginPath(); bigx.moveTo(0, -14); bigx.lineTo(10, 11); bigx.lineTo(0, 5); bigx.lineTo(-10, 11); bigx.closePath(); bigx.fill(); bigx.stroke(); bigx.restore();
  MAP.toWorld = (px, py) => ({ x: v.cx + (px * (w / big.clientWidth) - w / 2) / s, z: v.cz + (py * (h / big.clientHeight) - h / 2) / s });
}
// frame the downtown grid, Superman and every pin, with a margin, like Arkham's map opening on you
function fitBigMap() {
  let x0 = -HALF - 70, x1 = HALF + 20, z0 = -HALF - 70, z1 = HALF + 40;
  for (const [x, z] of [[P.pos.x, P.pos.z], ...mapPins()]) { x0 = Math.min(x0, x - 40); x1 = Math.max(x1, x + 40); z0 = Math.min(z0, z - 40); z1 = Math.max(z1, z + 40); }
  const w = MAP.big.clientWidth || 980, h = MAP.big.clientHeight || 720, sc = Math.min(w / (x1 - x0), h / (z1 - z0));
  MAP.bigView.cx = (x0 + x1) / 2; MAP.bigView.cz = (z0 + z1) / 2; MAP.bigView.mpp = clamp(Math.min(w, h) / (sc * 520), 0.6, 6);
}
function setMapOpen(open) {
  MAP.open = open; $('bigmap').hidden = !open;
  if (open) { fitBigMap(); drawBigMap(); if (document.pointerLockElement) document.exitPointerLock(); }
  else { try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { } }
}
$('bigmap-c').addEventListener('click', e => {
  const r = e.target.getBoundingClientRect(), w = MAP.toWorld(e.clientX - r.left, e.clientY - r.top);
  if (MAP.waypoint && Math.hypot(MAP.waypoint.x - w.x, MAP.waypoint.z - w.z) < 25) { MAP.waypoint = null; toast('Waypoint cleared', ''); }
  else { MAP.waypoint = new V3(w.x, 0, w.z); toast('Waypoint set — follow the blue beam', ''); }
  drawBigMap();
});
$('bigmap-c').addEventListener('wheel', e => { e.preventDefault(); MAP.bigView.mpp = clamp(MAP.bigView.mpp * (e.deltaY > 0 ? 1.15 : 0.87), 0.6, 6); drawBigMap(); }, { passive: false });
$('bigmap-close').addEventListener('click', () => setMapOpen(false));

// beacons: tall additive light columns rising from each alert, readable from kilometres away
const beaconGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true); beaconGeo.translate(0, 0.5, 0);
const BEACON_COL = { inc: new THREE.Color(2.6, 1.7, 0.35), kryp: new THREE.Color(0.9, 3, 0.4), hurt: new THREE.Color(2.4, 0.45, 0.45), trap: new THREE.Color(0.8, 2, 2.6), hosp: new THREE.Color(0.5, 2.4, 1.2), way: new THREE.Color(0.6, 1.4, 3) };
const beacons = [];
function updateBeacons() {
  const pins = mapPins().filter(p => p[2] !== 'trap' || P.xray || P.hear);
  while (beacons.length < pins.length && beacons.length < 12) {
    const core = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.55 }));
    const glow = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.12, side: THREE.DoubleSide }));
    core.renderOrder = glow.renderOrder = 5; core.frustumCulled = glow.frustumCulled = false; scene.add(core, glow); beacons.push({ core, glow });
  }
  for (let i = 0; i < beacons.length; i++) {
    const bc = beacons[i], pin = pins[i];
    if (!pin) { bc.core.visible = bc.glow.visible = false; continue; }
    const [x, z, kind] = pin, d = Math.hypot(x - P.pos.x, z - P.pos.z);
    const big = kind === 'inc' || kind === 'kryp' || kind === 'way';
    const hgt = big ? 900 : 260, r = (big ? 1.6 : 0.8) * (1 + d / 600);
    const fade = clamp((d - 25) / 60, 0, 1);  // fade out as you arrive so it doesn't blind you
    for (const [m, rr, op] of [[bc.core, r, 0.55], [bc.glow, r * 3.5, 0.12]]) {
      m.visible = fade > 0.01; m.position.set(x, 0, z); m.scale.set(rr, hgt, rr);
      m.material.color.copy(BEACON_COL[kind]); m.material.opacity = op * fade * (0.85 + 0.15 * Math.sin(simT * 4 + i));
    }
  }
  if (MAP.waypoint && Math.hypot(MAP.waypoint.x - P.pos.x, MAP.waypoint.z - P.pos.z) < 25) { MAP.waypoint = null; toast('Waypoint reached', 'good'); SFX.good(); }
}
function updateMaps(dt) {
  MAP.t += dt;
  if (MAP.t > 1) { MAP.t = 0; refreshBuildingDamage(); }
  if (started && !MAP.open) drawMinimap();
  if (MAP.open) drawBigMap();
  updateBeacons();
}

// ============================================================ main loop
let simT = 0, physAcc = 0, last = performance.now();
const onResize = () => {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); composer.setPixelRatio(PR); composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const sc = h * PR / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  for (const m of pMats) m.uniforms.uScale.value = sc;
};
addEventListener('resize', onResize); onResize();

function begin() {
  if (started) return;
  started = true; initAudio();
  yaw = 0; pitch = -0.08; // face up the avenue into the city
  $('title').classList.add('out'); setTimeout(() => { $('title').hidden = true; }, 650); hud.hidden = false;
  try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { }
  canvas.focus();
  toast('W A S D to fly, mouse to aim. Space climbs, C dives.', '');
  onboard.t0 = 0;
}
// ---------------------------------------------------------------- title screen
// Everything above has finished building the city by the time this runs, so Start is live.
const titleEl = $('title');
let titleReady = false;
function titleStart(e) {
  if (!titleReady || started) return;
  if (e && e.target && e.target.closest && e.target.closest('#controls-panel, #btn-controls, #btn-quality, #btn-bench')) return;
  begin();
}
titleEl.addEventListener('click', titleStart);
$('btn-bench').addEventListener('click', e => { e.stopPropagation(); if (titleReady) bench.start(); });
$('btn-controls').addEventListener('click', e => { e.stopPropagation(); $('controls-panel').hidden = false; });
$('close-controls').addEventListener('click', e => { e.stopPropagation(); $('controls-panel').hidden = true; });
const QNAMES = ['low', 'medium', 'high', 'ultra'], qLabel = q => q[0].toUpperCase() + q.slice(1);
$('btn-quality').textContent = 'Quality: ' + qLabel(SHOTQ ? 'high' : QUALITY);
$('btn-quality').addEventListener('click', e => {
  e.stopPropagation();
  const next = QNAMES[(QNAMES.indexOf(QUALITY) + 1) % QNAMES.length];
  try { localStorage.setItem('sm-quality', next); } catch (_) { /* storage blocked: URL still carries it */ }
  location.href = location.href.replace(/[?&]q=\w+/, '').replace(/[?&]bench\b/, '') + (location.href.includes('?') ? '&' : '?') + 'q=' + next;
});
requestAnimationFrame(() => requestAnimationFrame(() => {
  titleReady = true; titleEl.classList.remove('loading');
  $('press').textContent = 'PRESS ENTER OR CLICK TO START';
  $('menu').hidden = false; $('go').focus({ preventScroll: true });
  if (/[?&]bench\b/.test(location.search)) bench.start();
}));

// ---------------------------------------------------------------- benchmark
// Flies a fixed route through the heaviest scenes on the player's own GPU and reports real frame times.
const bench = {
  active: false, i: -1, t: 0, frames: [], results: [], calls: 0, tris: 0,
  stages: [
    { name: 'Street level', setup() { P.flying = false; P.pos.set(-150, 1.2, 152); }, tick(t) { yaw = -1.2 + t * 0.08; pitch = 0.06; P.vel.x = P.vel.z = 0; } },
    { name: 'Avenue flight', setup() { P.flying = true; P.pos.set(-90, 22, 200); }, tick() { yaw = 0; pitch = -0.02; P.vel.set(0, 0, -60); } },
    { name: 'Waterfront into the sun', setup() { P.flying = true; P.pos.set(40, 30, 236); }, tick(t) { yaw = Math.PI - 0.3 + t * 0.06; pitch = 0.05; P.vel.set(0, 0, 0); } },
    { name: 'Aerial skyline', setup() { P.flying = true; P.pos.set(0, 260, 380); }, tick(t) { yaw = t * 0.1; pitch = -0.18; P.vel.set(0, 0, 0); } },
    { name: 'Supersonic flight', setup() { P.flying = true; P.pos.set(0, 400, 1500); }, tick() { yaw = 0; pitch = 0; P.vel.set(0, 0, -480); } },
    { name: 'Tower collapse', setup() {
        const b = buildings.reduce((a, c) => (c.ny > a.ny ? c : a)); bench.tower = b;
        P.flying = true; P.pos.set(b.x0 - 90, 70, b.z0 - 60);
        for (let z = 0; z < b.nz; z++) for (let x = 0; x < b.nx; x++) for (let y = 0; y < 2; y++) breakBlock(cellIndex(b, x, y, z), T1.set(0, 0, 0), 4, 'blast');
      }, tick() { const b = bench.tower, dx = (b.x0 + b.x1) / 2 - P.pos.x, dz = (b.z0 + b.z1) / 2 - P.pos.z; yaw = Math.atan2(-dx, -dz); pitch = 0.05; P.vel.set(0, 0, 0); } }
  ],
  start() {
    if (!started) begin();
    this.active = true; this.i = -1; this.results = []; nextIncT = 1e9; if (currentInc) endIncident(false, 'Benchmark running');
    toast('Benchmark running \u2014 hands off for about 45 seconds', '');
    this.next();
  },
  next() {
    if (this.i >= 0) this.results.push(this.summarise());
    this.i++; this.t = 0; this.frames = []; this.calls = 0; this.tris = 0;
    if (this.i >= this.stages.length) return this.finish();
    this.stages[this.i].setup();
  },
  tick(dt) {
    const st = this.stages[this.i]; this.t += dt;
    st.tick(this.t);
    if (this.t > 1.2) { this.frames.push(dt); this.calls = Math.max(this.calls, renderer.info.render.calls); this.tris = Math.max(this.tris, renderer.info.render.triangles); }
    if (this.t > 7.2) this.next();
  },
  summarise() {
    const f = this.frames.slice().sort((a, b) => a - b), n = f.length || 1, sum = f.reduce((a, b) => a + b, 0) || 1;
    const p99 = f[Math.min(f.length - 1, Math.floor(f.length * 0.99))] || 0;
    return { name: this.stages[this.i].name, avgFps: Math.round(n / sum), low1: p99 ? Math.round(1 / p99) : 0, worstMs: Math.round((f[f.length - 1] || 0) * 1000), calls: this.calls, tris: this.tris };
  },
  finish() {
    this.active = false;
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const minAvg = Math.min(...this.results.map(r => r.avgFps)), minLow = Math.min(...this.results.map(r => r.low1));
    const advice = minAvg >= 80 && minLow >= 55 ? 'Plenty of headroom: try Ultra.' : minAvg >= 55 ? 'This preset suits your PC.' : minAvg >= 35 ? 'Try Medium for smoother play.' : 'Try Low for smoother play.';
    const res = `${Math.round(canvas.clientWidth * PR)}\u00d7${Math.round(canvas.clientHeight * PR)}`;
    const text = ['Superman Over Metropolis benchmark', `GPU: ${gpu}`, `Quality: ${QUALITY} \u00b7 render ${res} \u00b7 ${navigator.userAgent.match(/(Chrome|Firefox|Edg|Safari)\/[\d.]+/g)?.join(' ') || ''}`,
      ...this.results.map(r => `${r.name}: ${r.avgFps} fps avg, ${r.low1} fps 1% low, ${r.worstMs} ms worst, ${r.calls} draws, ${(r.tris / 1e6).toFixed(2)}M tris`), `Verdict: ${advice}`].join('\n');
    window.__bench = { gpu, quality: QUALITY, res, results: this.results, text };
    const el = document.createElement('div'); el.id = 'bench-results'; el.className = 'card';
    el.innerHTML = `<h2>Benchmark results</h2><p class="bench-gpu"></p><table><thead><tr><th>Scene</th><th>Avg fps</th><th>1% low</th><th>Worst</th><th>Draws</th></tr></thead><tbody>${
      this.results.map(r => `<tr><td>${r.name}</td><td>${r.avgFps}</td><td>${r.low1}</td><td>${r.worstMs} ms</td><td>${r.calls}</td></tr>`).join('')}</tbody></table>
      <p class="bench-verdict"></p><textarea readonly rows="5"></textarea><div class="bench-actions"><button id="bench-copy" type="button">Copy results</button><button id="bench-close" type="button">Play</button></div>`;
    el.querySelector('.bench-gpu').textContent = `${gpu} \u00b7 ${QUALITY} quality \u00b7 ${res}`;
    el.querySelector('.bench-verdict').textContent = advice + ' Paste the copied results to Claude to tune the game for your card.';
    el.querySelector('textarea').value = text;
    document.body.appendChild(el);
    if (document.pointerLockElement) document.exitPointerLock();
    el.querySelector('#bench-copy').addEventListener('click', () => {
      const ta = el.querySelector('textarea');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Results copied', 'good'), () => { ta.select(); document.execCommand('copy'); toast('Results selected \u2014 copy them with Ctrl+C', ''); });
    });
    el.querySelector('#bench-close').addEventListener('click', () => { el.remove(); nextIncT = 20; });
  }
};

// in-game performance meter (` or F3): real frame rate on the player's machine
const fpsEl = document.createElement('div'); fpsEl.id = 'fps'; fpsEl.hidden = true; document.body.appendChild(fpsEl);
let fpsN = 0, fpsT = 0, fpsWorst = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.max(0, (now - last) / 1000); // the first rAF stamp can predate `last`
  const dt = Math.min(0.05, rawDt); last = now;
  if (bench.active) bench.tick(rawDt);
  if (!fpsEl.hidden) {
    fpsN++; fpsT += rawDt; fpsWorst = Math.max(fpsWorst, rawDt);
    if (fpsT > 0.5) {
      const i = renderer.info.render;
      fpsEl.textContent = `${Math.round(fpsN / fpsT)} fps \u00b7 ${(1000 * fpsT / fpsN).toFixed(1)} ms avg \u00b7 ${(fpsWorst * 1000).toFixed(0)} ms worst \u00b7 ${i.calls} draws \u00b7 ${(i.triangles / 1e6).toFixed(2)}M tris \u00b7 ${liveDebrisCount} live debris`;
      fpsN = 0; fpsT = 0; fpsWorst = 0;
    }
  }
  pollPad();
  if (!paused && !MAP.open) update(dt);
  if (started || MAP.open) updateMaps(dt);
  renderer.info.reset();
  composer.render();
}
// lightweight section profiler: __game.prof() returns ms per section since the last reset
const PROF = { on: false, last: 0, acc: {}, t(name) { if (!this.on) return; const n = performance.now(); if (name !== '-') this.acc[name] = (this.acc[name] || 0) + n - this.last; this.last = n; } };
function update(dt) {
  if (hitStopT > 0) { hitStopT -= dt; dt *= 0.08; }
  const wdt = dt * (P.slow ? 0.12 : 1);
  simT += dt;
  if (started) { ledger.time += dt; updatePlayer(dt); }
  else {
    // title screen: hover above the waterfront facing the camera, skyline behind, sun on his face
    const ta = titleAngle();
    P.pos.set(-40, 128 + Math.sin(simT * 0.8) * 0.4, 200); P.vel.set(0, 0, 0); P.flying = true;
    yaw = Math.atan2(-Math.sin(ta), -Math.cos(ta)); pitch = 0;
    updateHeroPose(dt, aimDir(T1));
  }
  PROF.t('-'); updateCars(wdt); PROF.t('cars'); updatePeople(wdt); PROF.t('people'); updateIncident(wdt); updateFires(wdt); PROF.t('fires'); updateBullets(wdt);
  physAcc += wdt; let n = 0;
  PROF.t('-'); while (physAcc >= 1 / 60 && n < 3) { physStep(1 / 60); physAcc -= 1 / 60; n++; } PROF.t('physics');
  if (n === 3) physAcc = 0;
  PROF.t('-'); bodiesVsPeople();
  PROF.t('bodiesVsPeople'); for (const b of dirtyBuildings) structuralCheck(b); dirtyBuildings.clear(); PROF.t('structural');
  processFallQueue(wdt); PROF.t('fallQueue');
  // settled debris merges into static rubble; live chunks update their instances
  for (const b of bodies) {
    if (b.dead || b.kind !== 'debris') continue;
    // settle to static rubble once still, or once slow and old, so piles free their physics slots
    if (!b.held) {
      const slow = b.vel.lengthSq() < 6 && b.angVel.lengthSq() < 9;
      b.slowT = slow ? (b.slowT || 0) + wdt : Math.max(0, (b.slowT || 0) - wdt);
      if ((b.sleeping || b.slowT > 0.5 || (b.age > 12 && b.vel.lengthSq() < 25) || (fallQueue.length && b.age > 2.5 && slow && b.onGround)) && b.heat < 0.3) { settleToRubble(b); continue; }
    }
    if (!b.sleeping || b.held) writeDebris(b);
  }
  if (bodiesDirty) { for (let i = bodies.length - 1; i >= 0; i--) if (bodies[i].dead) bodies.splice(i, 1); bodiesDirty = false; }
  for (let t = 0; t < 3; t++) {
    if (typeDirty[t]) { typeMesh[t].instanceMatrix.needsUpdate = true; typeDirty[t] = false; }
    if (attrDirty[t]) { typeMesh[t].userData.aH.needsUpdate = true; typeMesh[t].userData.aF.needsUpdate = true; attrDirty[t] = false; }
    if (dDirty[t]) { debrisMeshes[t].instanceMatrix.needsUpdate = true; dDirty[t] = false; }
  }
  PROF.t('settle+upload'); cool(wdt); PROF.t('cool');
  for (const u of pluginUpdates) u(wdt, camera);
  if (window.__waterN) { window.__waterN.offset.x += wdt * 0.004; window.__waterN.offset.y += wdt * 0.0025; }
  updateBirds(wdt);
  updateRings(dt);
  PROF.t('-'); ADD.update(wdt); SMK.update(wdt); PROF.t('particles');
  updateCape(dt, simT);
  updateCamera(dt);
  updateAtmosphere(dt);
  if (started) updateHUD(dt);
}
window.__game = { liveCap: LIVE_CAP, quality: QUALITY, gpu: GPU_NAME, bench, renderer, composer, get started() { return started; }, get titleReady() { return titleReady; }, prof(reset) { const r = PROF.acc; if (reset !== false) PROF.acc = {}; PROF.on = true; return r; }, fires, fallQueue, get simT() { return simT; }, update: (dt) => update(dt), camera, scene, unsupportedAtStart() { let n = 0; for (const b of buildings) { structuralCheck(b); } n = fallQueue.length; fallQueue.forEach(g => pendingFall[g] = 0); fallQueue.length = 0; return n; }, step(n, dt) { for (let i = 0; i < n; i++) update(dt || 1 / 60); }, keys, render() { composer.render(); }, setMouse(l, r) { mouseL = l; mouseR = r; }, P, ledger, bodies, people, buildings, rubble, explode, startIncident, breakBlock, blockAt, cellIndex, get liveDebrisCount() { return liveDebrisCount; }, get currentInc() { return currentInc; }, begin, punch, clap, sonicBoom, grabOrRelease, throwHeld, setYawPitch(y, p) { yaw = y; pitch = p; }, MAP, setMapOpen, drawBigMap, mapPins };
requestAnimationFrame(frame);
})();
