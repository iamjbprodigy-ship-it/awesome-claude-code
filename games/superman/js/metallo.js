/* Metallo: the Kryptonite-hearted boss and finale of "Superman Over Metropolis"
 * (dream-features #13, demo step 10, decision T1(b): one villain).
 *
 * A 3 m chrome cyborg with a green Kryptonite heart smashes into a plaza and holds a crowd hostage.
 * He IS the restraint pillar: his heart is a Kryptonite source (through the game's own
 * kryptoniteNear(), so the existing weakening state applies: slowed flight, weaker punches,
 * shorter freeze breath, the green tint and droop pose), and it drains solar charge, so you
 * fight from range while protecting the crowd.
 *
 *   Phase 1  Arrival          he lands in the plaza, the crowd is pinned
 *   Phase 2  Kryptonite       telegraphed Kryptonite beam and radiation pulses (leave 40 m in 1.5 s)
 *   Phase 3  Protect          he hurls cars at the crowd (1.2 s coral telegraph): catch them (E)
 *   Phase 4  Armour failing   freeze breath (Q) makes plates brittle (frost > 0.75, the frost-shatter
 *                             rule); a charged punch or a thrown object shatters one. Ground pound added.
 *   Phase 5  Heart exposed    grab the lead-lined plate (spawned at the corner), carry it as a shield
 *                             (cuts exposure 80%), close in and rip the heart out (E). It's sealed in lead.
 *
 * Win: Metallo disabled and the heart contained. Medal from bystanders unhurt, property damage, time.
 * Soft fail (retry with F8 or the boss-bar button): solar charge hits 0, Kryptonite at full for 4 s,
 * too many casualties, or 180 s unattended (he escapes).
 *
 * Integration: a plugin (window.SM_PLUGINS) plus an incident type registered with
 * __game.registerIncident('metallo', ...). It is never in the random rotation: the demo sequencer
 * calls __game.metallo.start(), or press F8, or add ?metallo to the URL.
 * Power hooks used: __game.hooks.{kryp, punch, grab, clap, heat, freeze}.
 * Budget: 6 draw calls for his body (instanced chrome, joints, pistons, plates, eyes; the heart),
 * +2 shadow, +2 only while an attack telegraph or wave is visible, +1 for the lead plate.
 * No allocations in the per-frame paths (scratch vectors and matrices are preallocated).
 */
(function () {
  'use strict';
  const CFG = {
    limit: 180,              // s: unattended he escapes (criterion 10.7)
    arrive: 4,               // s of phase 1
    phase2: 14,              // s of beam / pulse before he starts throwing cars
    kryp: { full: 10, zero: 40, fullHeart: 12, zeroHeart: 46, shield: 0.2 }, // exposure 1 at `full` m -> 0 at `zero` m
    drain: { aura: 0.03, beam: 0.06, pulse: 0.15, pound: 0.06 },          // solar charge per s (aura, beam) or per hit
    brittle: 0.75,           // the frost-shatter rule (same threshold as cars and debris)
    thaw: 0.05,              // frost lost per s
    shakeOff: 0.5,           // a shattering plate knocks this much frost off the others
    charged: 2,              // punch power (1..4) that counts as charged (hold about 0.4 s)
    walk: 1.6,               // m/s
    tether: 9,               // m he roams from the plaza centre
    crowd: 8, crowdDist: 26, maxCasualties: 4,
    collapse: 4,             // s at full Kryptonite exposure before Superman collapses
    pulse: { tele: 1.5, r: 40 }, beam: { tele: 1.2, dur: 1.6, range: 140, track: 0.55, hitR: 1.4 },
    pound: { tele: 1.1, r: 22 }, toss: { yank: 0.45, tele: 1.2, flight: 1.7, every: [6, 8] },
    cooldown: [3.2, 2.6, 2.2, 3.0], // after an attack, by phase 2..5
    medal: { gold: { hurt: 0, damage: 1.5e6, time: 120 }, silver: { hurt: 1, damage: 4e6, time: 170 } }
  };
  const PHASES = ['', 'Arrival', 'Kryptonite assault', 'Protect the crowd', 'Armour failing', 'Heart exposed'];
  const NPL = 6;

  let THREE, scene, ctx, V3, M4, Q4;
  const G = () => window.__game;
  const S = {
    active: false, visible: false, down: false, leaving: 0, linger: 0, t: 0, phase: 0, phaseT: 0,
    pos: null, yaw: 0, center: null, crowdC: null, plaza: '', crowd: [], props: [], flying: [], lead: null,
    plates: [], heartOut: false, contained: false, spike: 0, beamHit: false, stag: 0, atk: null, atkCD: 0,
    tossCD: 0, alt: 0, collapseT: 0, caught: 0, hits: 0, startDamage: 0, startInj: 0, result: null,
    retryT: 0, frostAvg: 0, events: [], inc: null, walkPh: 0, speed: 0, autoT: -1
  };
  for (let i = 0; i < NPL; i++) S.plates.push({ alive: true, frost: 0, hp: 1, heat: 0 });

  // ================================================================ scratch (no per-frame allocation)
  let T1, T2, T3, T4, TA, TB, TM, TM2, TQ, TS, UP, HEARTW, CHESTW, HANDW, EYEW, MARK;
  const PLW = [];

  // ================================================================ rig
  const bones = {};
  let rig, body, chromeM, jointM, pistonM, plateM, eyeM, heart, heartLight, beam, teleRing, waveRing, leadMesh, chromeMat, plateMat;
  const SEG = [], JOINTS = [], PIST = [], PLATES = [], EYES = [];
  const pose = { lean: 0, crouch: 0, hipL: 0, hipR: 0, knL: 0, knR: 0, shL: 0, shR: 0, shLz: 0.12, shRz: -0.12, elL: -0.2, elR: -0.2, headP: 0, headY: 0, twist: 0, bob: 0, fall: 0 };
  const tgt = Object.assign({}, pose);

  function bone(name, parent, x, y, z) { const o = new THREE.Object3D(); o.position.set(x, y, z); (parent ? bones[parent] : rig).add(o); bones[name] = o; return o; }
  function local(px, py, pz, sx, sy, sz, rx, ry, rz) {
    const m = new M4(); m.compose(new V3(px, py, pz), new Q4().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)), new V3(sx, sy, sz)); return m;
  }
  function build() {
    V3 = THREE.Vector3; M4 = THREE.Matrix4; Q4 = THREE.Quaternion;
    T1 = new V3(); T2 = new V3(); T3 = new V3(); T4 = new V3(); TA = new V3(); TB = new V3(); TM = new M4(); TM2 = new M4(); TQ = new Q4(); TS = new V3();
    UP = new V3(0, 1, 0); HEARTW = new V3(); CHESTW = new V3(); HANDW = new V3(); EYEW = new V3(); MARK = new V3();
    for (let i = 0; i < NPL; i++) PLW.push(new V3());
    S.pos = new V3(); S.center = new V3(); S.crowdC = new V3();
    rig = new THREE.Object3D();
    bone('pelvis', null, 0, 1.42, 0); bone('spine', 'pelvis', 0, 0.18, 0); bone('chest', 'spine', 0, 0.5, 0);
    bone('neck', 'chest', 0, 0.5, 0); bone('head', 'neck', 0, 0.16, 0);
    for (const [s, x] of [['L', 1], ['R', -1]]) {
      bone('sh' + s, 'chest', 0.64 * x, 0.32, 0); bone('el' + s, 'sh' + s, 0, -0.62, 0); bone('ha' + s, 'el' + s, 0, -0.56, 0);
      bone('hip' + s, 'pelvis', 0.24 * x, -0.06, 0); bone('kn' + s, 'hip' + s, 0, -0.66, 0); bone('an' + s, 'kn' + s, 0, -0.62, 0);
    }
    // chrome shells: ellipsoids, one instanced draw
    const seg = (b, px, py, pz, sx, sy, sz) => SEG.push({ b: bones[b], m: local(px, py, pz, sx, sy, sz) });
    seg('pelvis', 0, 0, 0, 0.36, 0.2, 0.26); seg('spine', 0, 0.2, 0, 0.25, 0.26, 0.2); seg('chest', 0, 0.16, 0, 0.56, 0.42, 0.36);
    seg('neck', 0, 0.06, 0, 0.11, 0.12, 0.11); seg('head', 0, 0.14, 0.02, 0.19, 0.24, 0.21); seg('head', 0, 0.0, 0.07, 0.14, 0.1, 0.13);
    for (const s of ['L', 'R']) {
      seg('sh' + s, 0, -0.3, 0, 0.15, 0.3, 0.15); seg('el' + s, 0, -0.27, 0, 0.14, 0.28, 0.14); seg('ha' + s, 0, -0.1, 0.02, 0.12, 0.12, 0.09);
      seg('hip' + s, 0, -0.32, 0, 0.18, 0.33, 0.18); seg('kn' + s, 0, -0.3, 0, 0.15, 0.31, 0.15); seg('an' + s, 0, -0.03, 0.09, 0.13, 0.07, 0.24);
    }
    const joint = (b, px, py, pz, r) => JOINTS.push({ b: bones[b], m: local(px, py, pz, r, r, r) });
    joint('chest', 0, 0.46, 0, 0.13); joint('spine', 0, 0, 0, 0.2);
    for (const s of ['L', 'R']) { joint('sh' + s, 0, 0, 0, 0.16); joint('el' + s, 0, 0, 0, 0.12); joint('ha' + s, 0, 0, 0, 0.09); joint('hip' + s, 0, 0, 0, 0.15); joint('kn' + s, 0, 0, 0, 0.13); joint('an' + s, 0, 0, 0, 0.1); }
    // exposed pistons: each spans two bones, so they slide as he moves
    const pist = (a, ax, ay, az, b, bx, by, bz) => PIST.push({ a: bones[a], pa: new V3(ax, ay, az), b: bones[b], pb: new V3(bx, by, bz) });
    for (const x of [1, -1]) {
      pist('pelvis', 0.12 * x, 0.05, 0.16, 'chest', 0.14 * x, -0.2, 0.2); pist('pelvis', 0.14 * x, 0.05, -0.16, 'chest', 0.16 * x, -0.2, -0.22);
      pist('chest', 0.1 * x, 0.4, 0.05, 'head', 0.08 * x, 0.0, -0.02);
    }
    for (const s of ['L', 'R']) {
      pist('sh' + s, 0, -0.15, -0.12, 'el' + s, 0, -0.2, -0.1); pist('hip' + s, 0, -0.2, 0.15, 'kn' + s, 0, -0.22, 0.12); pist('kn' + s, 0, -0.1, -0.12, 'an' + s, 0, 0.05, -0.1);
    }
    // the six armour plates; 0 covers the heart and always goes last
    const plate = (b, px, py, pz, sx, sy, sz, rx, ry, rz) => PLATES.push({ b: bones[b], m: local(px, py, pz, sx, sy, sz, rx, ry, rz) });
    plate('chest', 0, 0.18, 0.36, 0.42, 0.36, 0.09); plate('chest', 0.31, 0.3, 0.29, 0.32, 0.3, 0.09, 0, 0.5, 0); plate('chest', -0.31, 0.3, 0.29, 0.32, 0.3, 0.09, 0, -0.5, 0);
    plate('spine', 0, 0.2, 0.21, 0.36, 0.34, 0.08); plate('shL', 0.06, 0.1, 0, 0.38, 0.14, 0.4, 0, 0, -0.35); plate('shR', -0.06, 0.1, 0, 0.38, 0.14, 0.4, 0, 0, 0.35);
    EYES.push({ b: bones.head, m: local(0.075, 0.17, 0.19, 0.035, 0.03, 0.03) }, { b: bones.head, m: local(-0.075, 0.17, 0.19, 0.035, 0.03, 0.03) });

    const bound = (geo) => { geo.boundingSphere = new THREE.Sphere(new V3(0, 1.7, 0), 3.2); return geo; };
    const lin = ctx.lin;
    chromeMat = new THREE.MeshStandardMaterial({ color: lin(0xdfe4ea), metalness: 1, roughness: 0.24 });
    const jointMat = new THREE.MeshStandardMaterial({ color: lin(0x2b2e33), metalness: 0.85, roughness: 0.42 });
    const pistMat = new THREE.MeshStandardMaterial({ color: lin(0xb8bec6), metalness: 1, roughness: 0.12 });
    plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.92, roughness: 0.3 });
    body = new THREE.Group(); body.visible = false; scene.add(body);
    chromeM = new THREE.InstancedMesh(bound(new THREE.SphereGeometry(1, 18, 12)), chromeMat, SEG.length);
    jointM = new THREE.InstancedMesh(bound(new THREE.SphereGeometry(1, 10, 8)), jointMat, JOINTS.length);
    const pg = new THREE.CylinderGeometry(0.032, 0.032, 1, 6); pg.translate(0, 0.5, 0); // unit length along +y
    pistonM = new THREE.InstancedMesh(bound(pg), pistMat, PIST.length);
    const bg = new THREE.BoxGeometry(1, 1, 1);
    plateM = new THREE.InstancedMesh(bound(bg), plateMat, NPL);
    for (let i = 0; i < NPL; i++) plateM.setColorAt(i, new THREE.Color(0.34, 0.36, 0.4));
    eyeM = new THREE.InstancedMesh(bound(new THREE.SphereGeometry(1, 8, 6)), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 0.5, 0.3), toneMapped: true }), 2);
    heart = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), new THREE.MeshStandardMaterial({ color: lin(0x1d3a1f), roughness: 0.4, flatShading: true, emissive: new THREE.Color(0.2, 2.5, 0.4), emissiveIntensity: 1 }));
    heart.matrixAutoUpdate = false;
    chromeM.castShadow = plateM.castShadow = true;
    for (const m of [chromeM, jointM, pistonM, plateM, eyeM]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); body.add(m); }
    body.add(heart);
    // attack visuals: one beam, a telegraph ring and a shock-wave ring (each visible only while in use)
    const beamG = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true); beamG.translate(0, 0.5, 0); beamG.rotateX(Math.PI / 2);
    beam = new THREE.Mesh(beamG, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 7, 1.4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    beam.visible = false; beam.frustumCulled = false; scene.add(beam);
    const rg = new THREE.RingGeometry(0.93, 1, 72); rg.rotateX(-Math.PI / 2);
    const ringMat = () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    teleRing = new THREE.Mesh(rg, ringMat()); waveRing = new THREE.Mesh(rg, ringMat());
    for (const r of [teleRing, waveRing]) { r.visible = false; r.frustumCulled = false; r.renderOrder = 2; scene.add(r); }
    // lead-lined construction plate: dull grey with hazard stripes
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 192; const x = cv.getContext('2d');
    x.fillStyle = '#6e7176'; x.fillRect(0, 0, 256, 192);
    for (let i = 0; i < 2500; i++) { x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.08})`; x.fillRect(Math.random() * 256, Math.random() * 192, 3, 3); }
    x.save(); x.beginPath(); x.rect(0, 0, 256, 192); x.rect(16, 16, 224, 160); x.clip('evenodd');
    for (let i = -192; i < 256; i += 24) { x.fillStyle = (i / 24) % 2 ? '#e8b923' : '#141414'; x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 12, 0); x.lineTo(i + 12 + 192, 192); x.lineTo(i + 192, 192); x.fill(); }
    x.restore(); x.fillStyle = '#2b2d30'; x.font = '900 72px sans-serif'; x.textAlign = 'center'; x.fillText('Pb', 128, 112);
    x.font = '700 18px sans-serif'; x.fillText('LEAD-LINED', 128, 148);
    const tex = new THREE.CanvasTexture(cv); if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    const side = new THREE.MeshStandardMaterial({ color: lin(0x55585d), roughness: 0.85, metalness: 0.35 });
    const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0.3 });
    leadMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.2), [side, side, face, face, side, side]);
    leadMesh.castShadow = true; leadMesh.visible = false; scene.add(leadMesh);
  }

  // ================================================================ rig evaluation
  function applyPose() {
    const b = bones, p = pose;
    b.pelvis.position.y = 1.42 - p.crouch + p.bob; b.pelvis.rotation.set(p.fall * 0.25, p.twist * 0.4, 0);
    b.spine.rotation.set(p.lean, p.twist * 0.6, 0); b.chest.rotation.set(p.lean * 0.5, p.twist, 0);
    b.head.rotation.set(p.headP, p.headY, 0);
    b.shL.rotation.set(p.shL, 0, p.shLz); b.shR.rotation.set(p.shR, 0, p.shRz);
    b.elL.rotation.set(p.elL, 0, 0); b.elR.rotation.set(p.elR, 0, 0);
    b.hipL.rotation.set(p.hipL, 0, 0.04); b.hipR.rotation.set(p.hipR, 0, -0.04);
    b.knL.rotation.set(p.knL, 0, 0); b.knR.rotation.set(p.knR, 0, 0);
    b.anL.rotation.set(-p.hipL - p.knL * 0.6, 0, 0); b.anR.rotation.set(-p.hipR - p.knR * 0.6, 0, 0);
    rig.updateMatrixWorld(true);
    for (let i = 0; i < SEG.length; i++) chromeM.setMatrixAt(i, TM.multiplyMatrices(SEG[i].b.matrixWorld, SEG[i].m));
    for (let i = 0; i < JOINTS.length; i++) jointM.setMatrixAt(i, TM.multiplyMatrices(JOINTS[i].b.matrixWorld, JOINTS[i].m));
    for (let i = 0; i < PIST.length; i++) {
      const q = PIST[i];
      TA.copy(q.pa).applyMatrix4(q.a.matrixWorld); TB.copy(q.pb).applyMatrix4(q.b.matrixWorld);
      T1.copy(TB).sub(TA); const L = T1.length() || 1e-3; T1.divideScalar(L);
      TQ.setFromUnitVectors(UP, T1); TM.compose(TA, TQ, TS.set(1, L, 1)); pistonM.setMatrixAt(i, TM);
    }
    for (let i = 0; i < NPL; i++) {
      if (S.plates[i].alive) plateM.setMatrixAt(i, TM.multiplyMatrices(PLATES[i].b.matrixWorld, PLATES[i].m));
      else plateM.setMatrixAt(i, TM.makeScale(0, 0, 0));
    }
    for (let i = 0; i < 2; i++) eyeM.setMatrixAt(i, TM.multiplyMatrices(EYES[i].b.matrixWorld, EYES[i].m));
    chromeM.instanceMatrix.needsUpdate = jointM.instanceMatrix.needsUpdate = pistonM.instanceMatrix.needsUpdate = true;
    plateM.instanceMatrix.needsUpdate = eyeM.instanceMatrix.needsUpdate = true;
    // world-space points the game logic needs
    body.position.copy(S.pos); body.rotation.set(0, S.yaw, 0); body.updateMatrixWorld(true);
    CHESTW.set(0, 0.15, 0.1).applyMatrix4(bones.chest.matrixWorld).applyMatrix4(body.matrixWorld);
    if (!S.heartOut) {
      TM.multiplyMatrices(bones.chest.matrixWorld, TM2.makeTranslation(0, 0.18, 0.28));
      HEARTW.set(0, 0, 0).applyMatrix4(TM).applyMatrix4(body.matrixWorld);
      const s = 1 + (S.phase >= 5 ? 0.35 : 0) + Math.max(0, Math.sin(S.t * 7.5)) ** 8 * 0.18;
      heart.matrix.copy(TM).multiply(TM2.makeRotationY(S.t * 1.3)).multiply(TM2.makeScale(s, s, s));
    }
    T1.set(0, 0, 0); for (const s of ['L', 'R']) T1.add(T2.set(0, -0.12, 0).applyMatrix4(bones['ha' + s].matrixWorld)); HANDW.copy(T1.multiplyScalar(0.5)).applyMatrix4(body.matrixWorld);
    EYEW.set(0, 0.17, 0.2).applyMatrix4(bones.head.matrixWorld).applyMatrix4(body.matrixWorld);
    for (let i = 0; i < NPL; i++) PLW[i].setFromMatrixPosition(PLATES[i].m).applyMatrix4(PLATES[i].b.matrixWorld).applyMatrix4(body.matrixWorld);
  }

  // ================================================================ helpers
  const R = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerpTo = (k) => { for (const n in tgt) pose[n] += (tgt[n] - pose[n]) * k; };
  function ev(type, data) {
    const g = G(); const e = Object.assign({ t: g ? +g.simT.toFixed(3) : 0, type, attacker: 'metallo' }, data || {});
    S.events.push(e); if (S.events.length > 400) S.events.shift();
    if (g && g.emit) g.emit(type, Object.assign({ attacker: 'metallo' }, data || {}));
  }
  function shielded() { const g = G(); return !!(g && S.lead && !S.lead.dead && g.P.hold === S.lead); }
  function hurtCount() { let n = 0; for (const p of S.crowd) if (p.injured) n++; return n; }
  function safeCount() { let n = 0; for (const p of S.crowd) if (!p.injured && p.mode !== 'stuck' && (p.mode === 'safe' || p.mode === 'gone' || p.pos.distanceTo(S.pos) > 35)) n++; return n; }
  function platesLeft() { let n = 0; for (const p of S.plates) if (p.alive) n++; return n; }
  // ray (o + t d) against his body capsule; returns t or -1
  function rayBody(o, d, maxT, rad) {
    const ax = S.pos.x, az = S.pos.z, y0 = S.pos.y + 0.3, y1 = S.pos.y + 3.0;
    // closest approach between the ray and the vertical axis segment
    const wx = o.x - ax, wy = o.y - y0, wz = o.z - az, a = d.x * d.x + d.y * d.y + d.z * d.z, b = d.y, c = 1, dd = d.x * wx + d.y * wy + d.z * wz, e = wy;
    const den = a * c - b * b; let t = den > 1e-6 ? (b * e - c * dd) / den : 0, s = den > 1e-6 ? (a * e - b * dd) / den : e;
    s = clamp(s, 0, y1 - y0); t = Math.max(0, (s * b - dd) / a);
    const px = o.x + d.x * t - ax, py = o.y + d.y * t - (y0 + s), pz = o.z + d.z * t - az, dist2 = px * px + py * py + pz * pz;
    const r = rad || 0.95; if (dist2 > r * r || t > maxT) return -1;
    return Math.max(0, t - Math.sqrt(r * r - dist2));
  }
  // the intact plate nearest a world point (the heart cover only once the rest are gone)
  function plateNear(p) {
    let best = -1, bd = Infinity;
    for (let i = 1; i < NPL; i++) if (S.plates[i].alive) { const d = PLW[i].distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
    if (best < 0 && S.plates[0].alive) best = 0;
    return best;
  }

  // ================================================================ Kryptonite exposure (a kryptoniteNear() source)
  function exposure(pos) {
    if (!S.visible || S.contained || S.leaving > 0) return 0;
    const heartPh = S.phase >= 5, full = heartPh ? CFG.kryp.fullHeart : CFG.kryp.full, zero = heartPh ? CFG.kryp.zeroHeart : CFG.kryp.zero;
    let k = clamp(1 - (pos.distanceTo(HEARTW) - full) / (zero - full), 0, 1);
    if (S.down) k *= 0.5; // the heart still radiates until it is sealed
    if (S.beamHit) k = Math.max(k, 0.85);
    k = Math.max(k, S.spike);
    if (shielded()) k *= CFG.kryp.shield;
    return k;
  }

  // ================================================================ damage
  function shatterPlate(i, cause) {
    const g = G(), pl = S.plates[i]; if (!pl.alive) return;
    pl.alive = false; pl.frost = 0; S.stag = Math.max(S.stag, 0.8); cancelAttack();
    const p = PLW[i];
    for (let k = 0; k < 60; k++) g.FX.ice(p.x, p.y, p.z, R(-9, 9), R(-2, 10), R(-9, 9));
    for (let k = 0; k < 30; k++) g.FX.glass(p.x, p.y, p.z, R(-8, 8), R(0, 8), R(-8, 8));
    for (let k = 0; k < 20; k++) g.FX.spark(p.x, p.y, p.z, R(-12, 12), R(-4, 12), R(-12, 12));
    g.SFX.glass(p); g.SFX.punch(p, 1.6);
    if (g.hitStop) g.hitStop(0.09); if (g.addShake) g.addShake(0.45);
    for (const q of S.plates) if (q.alive) q.frost = Math.max(0, q.frost - CFG.shakeOff);
    const n = platesLeft();
    ev('plateShatter', { plate: i, cause, left: n });
    g.toast(n ? `Armour plate shattered (${cause}). ${n} left.` : 'His armour is gone. The Kryptonite heart is exposed!', n ? 'ice' : 'alert');
    if (!n) g.toast('Grab the lead-lined plate (E): carry it as a shield, then rip the heart out (E).', '');
  }
  function chip(i, amt, p) {
    const g = G(), pl = S.plates[i]; pl.hp -= amt;
    for (let k = 0; k < 10; k++) g.FX.spark(p.x, p.y, p.z, R(-8, 8), R(-3, 8), R(-8, 8));
    if (pl.hp <= 0) shatterPlate(i, 'worn through');
  }
  // something hit him at point p with `power` (1 punch-equivalent); brittle plates shatter
  function strike(p, power, cause, charged) {
    const g = G(), i = plateNear(p);
    S.stag = Math.max(S.stag, 0.35 + 0.1 * power);
    if (i < 0) { g.toast('No armour left. Rip out the heart: E, behind the lead plate.', ''); return; }
    const pl = S.plates[i];
    if (pl.frost > CFG.brittle && charged) shatterPlate(i, cause);
    else if (pl.frost > CFG.brittle) { chip(i, 0.34, p); hint('charge', 'Brittle! Charge the punch (hold the button) to shatter it.'); }
    else { chip(i, 0.06 * power, p); hint('freeze', 'His armour is too tough. Freeze it first (Q), then hit it.'); }
  }
  const hinted = {};
  function hint(id, msg) { const g = G(); if (hinted[id] && g.simT - hinted[id] < 12) return; hinted[id] = g.simT; g.toast(msg, ''); }

  // ================================================================ power hooks
  function onPunch(o, d, power) {
    if (!S.active || S.down || S.phase < 2) return false;
    const t = rayBody(o, d, 5.5 + power + 0.6, 1.05); if (t < 0) return false;
    const g = G(), p = T3.copy(o).addScaledVector(d, t);
    g.SFX.punch(p, 0.9 + power * 0.25);
    if (g.ring) g.ring(p, d, 0.3, 2 + power, 0.35, null, 0.9);
    strike(p, power * (1 - g.P.kryp * 0.8), 'punch', power >= CFG.charged);
    ev('hit', { by: 'punch', power: +power.toFixed(2) });
    return true;
  }
  function onClap(o, d, reach, k) {
    if (!S.active || S.down) return;
    const rel = T3.copy(HEARTW).sub(o), dist = rel.length(); if (dist > 60 * reach || rel.dot(d) / dist < Math.cos(0.6)) return;
    S.stag = Math.max(S.stag, 0.9 * (1 - dist / (60 * reach))); cancelAttack();
    for (let i = 0; i < NPL; i++) if (S.plates[i].alive && S.plates[i].frost > CFG.brittle) { chip(i, 0.4 * k * (1 - dist / (60 * reach)), PLW[i]); break; }
  }
  function onFreeze(o, d, range, cos, dt) {
    if (!S.active || S.down) return;
    for (let i = 0; i < NPL; i++) {
      const pl = S.plates[i]; if (!pl.alive) continue;
      const rel = T3.copy(PLW[i]).sub(o), dist = rel.length(); if (dist > range || dist < 0.01 || rel.dot(d) / dist < cos) continue;
      const was = pl.frost; pl.frost = Math.min(1.2, pl.frost + dt * (1.2 - dist / range) * 0.9); pl.heat = Math.max(0, pl.heat - dt * 2);
      if (was <= CFG.brittle && pl.frost > CFG.brittle) { G().SFX.freezeHit(); if (i === plateNear(o)) hint('brittle', 'Frozen brittle! Now a charged punch or a thrown car shatters a plate.'); }
    }
  }
  function onHeat(o, d, hit, dt, power) {
    if (!S.visible || S.leaving > 0) return;
    const t = rayBody(o, d, hit.t, 0.95); if (t < 0 || t >= hit.t) return;
    hit.t = t; hit.type = 'metallo'; hit.body = null; hit.point.copy(o).addScaledVector(d, t); hit.normal.copy(hit.point).sub(S.pos).setY(0).normalize();
    if (!S.active || S.down) return;
    const i = plateNear(hit.point); if (i < 0) return;
    const pl = S.plates[i]; pl.frost = Math.max(0, pl.frost - dt * 1.5); pl.heat = Math.min(1.5, pl.heat + dt * power);
    pl.hp -= dt * 0.1 * power; if (pl.hp <= 0) shatterPlate(i, 'heat vision');
    if (Math.random() < 0.5) G().FX.molten(hit.point.x, hit.point.y, hit.point.z, R(-3, 3), R(0, 3), R(-3, 3));
  }
  function onGrab() {
    if (!S.active || S.down || S.phase < 5) return false;
    const g = G(), P = g.P, d = P.pos.distanceTo(HEARTW);
    if (d > 4.8) return false;
    if (!shielded()) { if (P.kryp > 0.45) { g.toast('Too close to the Kryptonite. Carry the lead plate as a shield.', 'alert'); return true; } }
    ripHeart(); return true;
  }

  // ================================================================ incident
  function pickPlaza() {
    const L0 = ctx.lotInfo.filter(l => l.type === 'park').sort((a, b) => Math.hypot(a.lx + 20, a.lz + 20) - Math.hypot(b.lx + 20, b.lz + 20))[0];
    if (L0) return { x: L0.lx + 20, z: L0.lz + 20, name: L0.name };
    const H = ctx.CONST.HALF, PI = ctx.CONST.PITCH; return { x: -H + 3 * PI, z: -H + 3 * PI, name: 'the city centre' };
  }
  function clearAt(x, z) { const g = G(); return g.blockAt(x, 1, z) < 0 && g.blockAt(x, 3, z) < 0; }
  function startInc() {
    const g = G(); if (!g) return null;
    if (S.visible) hideAll();
    const pz = pickPlaza();
    S.center.set(pz.x, 0, pz.z); S.plaza = pz.name;
    S.pos.set(pz.x, 120, pz.z); S.yaw = 0; S.t = 0; S.phase = 1; S.phaseT = 0; S.down = false; S.leaving = 0; S.linger = 0; S.heartOut = false; S.contained = false;
    S.spike = 0; S.beamHit = false; S.stag = 0; S.atk = null; S.atkCD = 1.5; S.tossCD = 0; S.collapseT = 0; S.caught = 0; S.hits = 0; S.result = null; S.retryT = 0; S.flying.length = 0;
    S.startDamage = g.ledger.damage; S.walkPh = 0; S.speed = 0; S.downT = 0; S.landT = 99;
    for (const pl of S.plates) { pl.alive = true; pl.frost = 0; pl.hp = 1; pl.heat = 0; }
    chromeMat.color.copy(ctx.lin(0xdfe4ea)); eyeM.material.color.setRGB(9, 0.5, 0.3);
    // the crowd he menaces: the clearest side of the plaza
    let best = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = pz.x + dx * CFG.crowdDist, z = pz.z + dz * CFG.crowdDist;
      if (clearAt(x, z) && clearAt(x + 3, z + 3) && clearAt(x - 3, z - 3)) { best = [dx, dz]; break; }
    }
    best = best || [1, 0];
    S.crowdC.set(pz.x + best[0] * CFG.crowdDist, 0, pz.z + best[1] * CFG.crowdDist);
    S.crowd.length = 0;
    for (let i = 0; i < CFG.crowd; i++) {
      const a = i / CFG.crowd * Math.PI * 2, r = 1.2 + (i % 3) * 0.9;
      const x = S.crowdC.x + Math.cos(a) * r, z = S.crowdC.z + Math.sin(a) * r;
      const p = g.placePerson('stuck', new THREE.Vector3(x, g.groundY(x, z) + 0.9, z), { danger: true, mCrowd: true });
      if (!p) continue; p.face = Math.atan2(pz.z - z, pz.x - x); S.crowd.push(p);
    }
    // the lead-lined plate: on the corner diagonally away from the crowd, outside the 40 m aura
    const lx = pz.x + (best[0] ? -best[0] : 1) * 30, lzz = pz.z + (best[1] ? -best[1] : 1) * 30;
    S.lead = g.makeBody('lead', new THREE.Vector3(lx, 0.07, lzz), 0.8, 0.06, 0.6, 2200);
    S.lead.sleeping = true; S.lead.mu = 0.9; leadMesh.visible = true;
    // cars he will throw: the nearest live ones get dragged into the plaza by the impact
    S.props.length = 0;
    const cand = g.cars.filter(c => !c.dead && !c.held && c.pos.distanceTo(S.center) < 160).sort((a, b) => a.pos.distanceToSquared(S.center) - b.pos.distanceToSquared(S.center)).slice(0, 4);
    cand.forEach((c, i) => {
      const a = Math.atan2(best[1], best[0]) + Math.PI * (0.5 + i * 0.33), r = 8 + (i % 2) * 2;
      c.drive = null; c.parked = false; c.sleeping = true; c.vel.set(0, 0, 0); c.angVel.set(0, 0, 0);
      c.pos.set(pz.x + Math.cos(a) * r, 0.85, pz.z + Math.sin(a) * r); c.quat.setFromAxisAngle(UP, R(0, 6.28)); c.mProp = true; S.props.push(c);
    });
    if (!heartLight) { heartLight = new THREE.PointLight(ctx.lin(0x4dff6a), 3, 90, 2); }
    if (!heartLight.parent) scene.add(heartLight);
    body.visible = true; S.visible = true; S.active = true; heart.visible = true;
    const env = g.cityEnv || scene.environment; if (env) { chromeMat.envMap = env; plateMat.envMap = env; chromeMat.needsUpdate = plateMat.needsUpdate = true; }
    setPhase(1);
    const inc = {
      type: 'metallo', label: 'Metallo', m: { kryp: true }, limit: CFG.limit, where: pz.name,
      title: `METALLO has landed at ${pz.name} with a crowd at his feet. His heart is Kryptonite: fight from range.`,
      marker() { return MARK.clone(); },
      update() { /* the fight runs in the plugin update, after the player and physics */ },
      timeout() { fail('escape'); },
      fallers() { return S.flying; }, // thrown cars: js/catch.js offers its match-speed catch on these
      cleanup() { onIncidentEnd(this); }
    };
    S.inc = inc; MARK.copy(S.center).setY(4);
    ev('incidentStart', { kind: 'metallo', where: pz.name });
    return inc;
  }
  function setPhase(n) {
    if (n <= S.phase && S.phase) { S.phase = Math.max(S.phase, n); return; }
    S.phase = n; S.phaseT = 0; ev('phase', { phase: n, name: PHASES[n] });
    const g = G(); if (n > 1 && g) g.toast(`Metallo · phase ${n}: ${PHASES[n]}`, n === 5 ? 'alert' : '');
  }
  function onIncidentEnd(inc) {
    if (S.inc !== inc) return;
    S.inc = null; S.active = false;
    for (const c of S.flying) { c.noDrag = false; c.mThrown = false; }
    S.flying.length = 0;
    if (S.atk && S.atk.car && S.atk.car.held && G().P.hold !== S.atk.car) S.atk.car.held = false;
    S.atk = null; beam.visible = false; teleRing.visible = false;
    for (const p of S.crowd) { p.mCrowd = false; if (p.mode === 'stuck') { p.mode = 'free'; p.fleeT = 6; p.danger = false; } }
    if (!S.result) { S.leaving = 3; S.result = { win: false, reason: 'abandoned' }; } // replaced by another emergency
    if (!S.down && S.leaving <= 0) S.leaving = 3;
    if (S.down) S.linger = 40;
  }
  function hideAll() {
    const g = G();
    body.visible = false; S.visible = false; beam.visible = teleRing.visible = waveRing.visible = false;
    if (heartLight && heartLight.parent) scene.remove(heartLight);
    if (S.lead && !S.lead.dead && g) g.removeBody(S.lead);
    S.lead = null; leadMesh.visible = false; heart.visible = false;
    for (const c of S.props) c.mProp = false; S.props.length = 0;
  }
  function medalOf(time, hurt, damage) {
    const M = CFG.medal;
    return hurt <= M.gold.hurt && damage <= M.gold.damage && time <= M.gold.time ? 'gold'
      : hurt <= M.silver.hurt && damage <= M.silver.damage && time <= M.silver.time ? 'silver' : 'bronze';
  }
  function ripHeart() {
    const g = G(); S.heartOut = true; S.contained = true; S.down = true; cancelAttack();
    ev('heartRipped', {}); g.SFX.punch(HEARTW, 2); g.SFX.glass(HEARTW); if (g.hitStop) g.hitStop(0.12); if (g.addShake) g.addShake(0.6);
    for (let k = 0; k < 50; k++) g.FX.kryp(HEARTW.x, HEARTW.y, HEARTW.z);
    for (let k = 0; k < 40; k++) g.FX.spark(HEARTW.x, HEARTW.y, HEARTW.z, R(-10, 10), R(-4, 10), R(-10, 10));
    const time = S.t, hurt = hurtCount(), damage = g.ledger.damage - S.startDamage, medal = medalOf(time, hurt, damage);
    S.result = { win: true, medal, time: +time.toFixed(1), hurt, safe: CFG.crowd - hurt, damage: Math.round(damage), caught: S.caught };
    const unhurt = [];
    for (const p of S.crowd) { if (p.mode === 'stuck') { p.mode = 'cheer'; p.cheerT = 6; p.photoT = R(0, 1); p.danger = false; } if (!p.injured) unhurt.push(p); }
    if (S.inc) { S.inc.medal = medal; S.inc.injuries = hurt; }
    ev('medal', { medal, time: S.result.time, hurt, damage: S.result.damage });
    if (unhurt.length) g.addSave(unhurt.length, S.crowdC, 'Hostages freed');
    if (g.currentInc === S.inc) g.endIncident(true, 'Metallo is down. The Kryptonite heart is sealed in lead');
    ev('incidentEnd', { kind: 'metallo', success: true });
  }
  function fail(reason) {
    if (!S.active) return; const g = G();
    const msg = { solar: 'Your solar charge ran dry. Metallo escapes.', collapse: 'The Kryptonite overwhelms you. You collapse and Metallo escapes.', casualties: 'Too many people hurt. Metallo escapes in the chaos.', escape: 'Metallo smashed his way out of the city. He got away.' }[reason] || 'Metallo escapes.';
    S.result = { win: false, reason, time: +S.t.toFixed(1), hurt: hurtCount() };
    S.leaving = 3; S.retryT = 25; cancelAttack();
    if (reason === 'collapse' || reason === 'solar') { g.P.flying = false; g.P.vel.set(0, -5, 0); }
    ev('fail', { reason });
    if (g.currentInc === S.inc) g.endIncident(false, msg + ' Press F8 to retry.');
    g.hopeHit(5); // with endIncident's 5: Hope -10
    ev('incidentEnd', { kind: 'metallo', success: false, reason });
  }
  function start() {
    const g = G(); if (!g) return false;
    if (!g.started) g.begin();
    if (g.P.solar < 0.6) g.P.solar = 0.6;
    g.startIncident('metallo');
    return g.currentInc && g.currentInc.type === 'metallo';
  }

  // ================================================================ attacks (all telegraphed >= 1.0 s)
  function cancelAttack() {
    const a = S.atk; if (!a) return;
    if (a.kind === 'toss' && a.car && !a.fired && a.car.held && G().P.hold !== a.car) { a.car.held = false; a.car.sleeping = false; a.car.vel.set(R(-2, 2), 0, R(-2, 2)); }
    if (!a.fired || a.kind === 'beam') { S.atk = null; beam.visible = false; teleRing.visible = false; S.atkCD = Math.max(S.atkCD, 1.2); }
  }
  function tossCar() {
    const g = G(); let best = null, bd = 70 * 70;
    for (const c of S.props) if (!c.dead && !c.held && !c.mThrown) { const d = c.pos.distanceToSquared(S.pos); if (d < bd) { bd = d; best = c; } }
    if (!best) for (const c of g.cars) if (!c.dead && !c.held && !c.mThrown && !c.drive) { const d = c.pos.distanceToSquared(S.pos); if (d < bd) { bd = d; best = c; } }
    return best;
  }
  function crowdTarget(o) {
    let n = 0; o.set(0, 0, 0);
    for (const p of S.crowd) if (p.mode === 'stuck' && !p.injured) { o.add(p.pos); n++; }
    if (n) return o.divideScalar(n).setY(0.9);
    return null;
  }
  function chooseAttack() {
    const g = G(), P = g.P, dh = P.pos.distanceTo(S.pos), ph = S.phase;
    const alt = S.alt++ % 2;
    let kind = alt ? 'pulse' : 'beam';
    if ((ph === 3 || ph === 4) && S.tossCD <= 0 && tossCar() && crowdTarget(T4)) kind = 'toss';
    else if (ph === 4 && dh < CFG.pound.r && P.pos.y - g.groundY(P.pos.x, P.pos.z) < 4 && Math.random() < 0.6) kind = 'pound';
    if (kind === 'beam' && dh > CFG.beam.range) kind = 'pulse';
    const a = { kind, t: 0, fired: false, tele: CFG[kind === 'toss' ? 'toss' : kind].tele, dur: 0, car: null, aim: new THREE.Vector3().copy(P.pos), target: new THREE.Vector3(), from: new THREE.Vector3() };
    if (kind === 'toss') {
      a.car = tossCar(); a.car.held = true; a.car.sleeping = true; a.from.copy(a.car.pos);
      crowdTarget(a.target); a.target.x += R(-1, 1); a.target.z += R(-1, 1); a.dur = 0.8; S.tossCD = R(CFG.toss.every[0], CFG.toss.every[1]);
      teleRing.material.color.setRGB(3, 0.9, 0.6); teleRing.position.set(a.target.x, g.groundY(a.target.x, a.target.z) + 0.15, a.target.z); teleRing.scale.setScalar(3.5);
    } else if (kind === 'pulse') {
      a.dur = 0.6; teleRing.material.color.setRGB(0.5, 3, 0.7); teleRing.position.set(S.pos.x, 0.15, S.pos.z); teleRing.scale.setScalar(CFG.pulse.r);
    } else if (kind === 'pound') {
      a.dur = 0.6; teleRing.material.color.setRGB(3, 0.9, 0.6); teleRing.position.set(S.pos.x, 0.15, S.pos.z); teleRing.scale.setScalar(CFG.pound.r);
    } else { a.dur = CFG.beam.dur; }
    teleRing.visible = kind !== 'beam';
    S.atk = a;
    ev('telegraph', { kind, dur: a.tele });
    if (kind === 'pulse') hint('pulse', 'Radiation pulse charging: get 40 m away!');
    if (kind === 'toss') hint('toss', 'He is throwing a car at the crowd. Catch it (E)!');
  }
  function fire(a) {
    const g = G(), P = g.P; a.fired = true; ev('attack', { kind: a.kind });
    if (a.kind === 'pulse') {
      waveRing.material.color.setRGB(0.6, 4, 0.9); waveRing.position.set(S.pos.x, 0.3, S.pos.z); waveRing.visible = true; S.wave = 0; S.waveR = CFG.pulse.r;
      for (let k = 0; k < 60; k++) g.FX.kryp(HEARTW.x, HEARTW.y, HEARTW.z);
      g.SFX.boom(HEARTW, 0.6); if (g.addShake) g.addShake(0.3);
      const d = P.pos.distanceTo(HEARTW);
      if (d < CFG.pulse.r) {
        if (shielded()) { hint('shieldok', 'The lead plate soaked up the pulse.'); for (let k = 0; k < 20; k++) g.FX.spark(S.lead.pos.x, S.lead.pos.y, S.lead.pos.z, R(-6, 6), R(-2, 6), R(-6, 6)); }
        else { P.solar = Math.max(0, P.solar - CFG.drain.pulse * (1 - d / (CFG.pulse.r + 10))); S.spike = 1; P.hitT = 0.3; T1.copy(P.pos).sub(S.pos).setY(0).normalize(); P.vel.addScaledVector(T1, 18); ev('hitHero', { kind: 'pulse' }); }
      }
    } else if (a.kind === 'pound') {
      waveRing.material.color.setRGB(2.6, 1.6, 0.9); waveRing.position.set(S.pos.x, 0.3, S.pos.z); waveRing.visible = true; S.wave = 0; S.waveR = CFG.pound.r;
      g.SFX.boom(S.pos, 1.2); if (g.addShake) g.addShake(0.6);
      for (let k = 0; k < 50; k++) g.FX.dust(S.pos.x + R(-3, 3), 0.4, S.pos.z + R(-3, 3), R(-14, 14), R(1, 5), R(-14, 14), 1.6);
      if (g.ring) g.ring(T1.set(S.pos.x, 0.3, S.pos.z), UP, 1, CFG.pound.r, 0.6, new THREE.Color(2.5, 1.6, 0.9), 0.7);
      const d = Math.hypot(P.pos.x - S.pos.x, P.pos.z - S.pos.z);
      if (d < CFG.pound.r && P.pos.y - g.groundY(P.pos.x, P.pos.z) < 4) { P.solar = Math.max(0, P.solar - CFG.drain.pound); P.hitT = 0.3; T1.set(P.pos.x - S.pos.x, 0, P.pos.z - S.pos.z).normalize(); P.vel.addScaledVector(T1, 22).y += 10; ev('hitHero', { kind: 'pound' }); }
    } else if (a.kind === 'toss') {
      const c = a.car; teleRing.visible = false;
      if (c.dead || !c.held || P.hold === c) return;
      c.held = false; c.sleeping = false; c.noDrag = true; c.mThrown = true; c.thrown = false; c.mT = 0; c.mLand = -1;
      const tf = CFG.toss.flight;
      c.vel.set((a.target.x - c.pos.x) / tf, (a.target.y - c.pos.y) / tf + 0.5 * 9.81 * tf, (a.target.z - c.pos.z) / tf);
      c.angVel.set(R(-1.5, 1.5), R(-1, 1), R(-1.5, 1.5));
      S.flying.push(c); g.SFX.whoosh();
    }
  }
  function updateAttack(dt) {
    const g = G(), P = g.P, a = S.atk; if (!a) return;
    a.t += dt;
    if (a.kind === 'beam') {
      // aim lags the hero, so moving dodges it
      T1.copy(P.pos).sub(a.aim); const L = T1.length(), maxStep = CFG.beam.track * Math.max(10, a.aim.distanceTo(HEARTW)) * dt;
      if (L > maxStep) T1.multiplyScalar(maxStep / L); a.aim.add(T1);
      const firing = a.t >= a.tele;
      if (firing && !a.fired) fire(a);
      T2.copy(a.aim).sub(HEARTW); const dist = T2.length(); T2.divideScalar(dist || 1);
      let len = CFG.beam.range; if (T2.y < -0.01) len = Math.min(len, (HEARTW.y - 0.05) / -T2.y);
      beam.visible = true; beam.position.copy(HEARTW); beam.lookAt(T3.copy(HEARTW).add(T2));
      const r = firing ? 0.22 + Math.sin(S.t * 50) * 0.04 : 0.025; beam.scale.set(r, r, len); beam.material.opacity = firing ? 0.95 : 0.5;
      S.beamHit = false;
      if (firing) {
        // the hero's distance to the beam segment
        T3.copy(P.pos).sub(HEARTW); const along = clamp(T3.dot(T2), 0, len); T4.copy(HEARTW).addScaledVector(T2, along);
        if (T4.distanceTo(P.pos) < CFG.beam.hitR) {
          if (shielded()) { const lp = S.lead.pos; if (Math.random() < 0.6) g.FX.spark(lp.x, lp.y, lp.z, R(-5, 5), R(-2, 5), R(-5, 5)); beam.scale.z = Math.max(0.5, along - 1); }
          else { S.beamHit = true; P.solar = Math.max(0, P.solar - CFG.drain.beam * dt); P.hitT = 0.1; }
        } else { T4.copy(HEARTW).addScaledVector(T2, len); if (Math.random() < 0.5) g.FX.kryp(T4.x, T4.y, T4.z); }
        if (a.t >= a.tele + a.dur) { S.atk = null; beam.visible = false; S.beamHit = false; S.atkCD = cd(); }
      }
      return;
    }
    if (a.kind === 'toss') {
      const c = a.car;
      if (!a.fired && (c.dead || P.hold === c)) { S.atk = null; teleRing.visible = false; S.atkCD = cd(); return; }
      if (!a.fired) {
        // yank the car into his hands, then hold it overhead until the telegraph ends
        const k = clamp(a.t / CFG.toss.yank, 0, 1);
        T1.copy(S.pos).setY(S.pos.y + 4.4); T1.addScaledVector(T2.set(Math.sin(S.yaw), 0, Math.cos(S.yaw)), -0.4);
        c.pos.copy(a.from).lerp(T1, k * k * (3 - 2 * k)); c.pos.y += Math.sin(k * Math.PI) * 2;
        c.quat.setFromAxisAngle(UP, S.yaw + Math.PI / 2); c.vel.set(0, 0, 0);
        teleRing.scale.setScalar(3.5 + Math.sin(S.t * 12) * 0.3);
        if (a.t >= a.tele) fire(a);
      } else if (a.t >= a.tele + a.dur) { S.atk = null; S.atkCD = cd(); }
      return;
    }
    // pulse / pound
    if (!a.fired) {
      const k = a.t / a.tele; teleRing.material.opacity = 0.35 + 0.45 * Math.abs(Math.sin(a.t * (6 + k * 10)));
      if (a.kind === 'pulse' && Math.random() < 0.5) g.FX.kryp(HEARTW.x, HEARTW.y, HEARTW.z);
      if (a.t >= a.tele) { teleRing.visible = false; fire(a); }
    } else if (a.t >= a.tele + a.dur) { S.atk = null; S.atkCD = cd(); }
  }
  const cd = () => CFG.cooldown[clamp(S.phase - 2, 0, 3)] * R(0.85, 1.15);

  // ================================================================ thrown cars vs the crowd; Superman's throws vs Metallo
  function updateProjectiles(dt) {
    const g = G(), P = g.P;
    for (let i = S.flying.length - 1; i >= 0; i--) {
      const c = S.flying[i]; c.mT += dt;
      if (c.dead || P.hold === c) {
        if (P.hold === c) { S.caught++; ev('catch', { what: 'car' }); g.toast('Caught it. Nobody hurt.', 'good'); }
        c.noDrag = false; c.mThrown = false; S.flying.splice(i, 1); continue;
      }
      const sp = c.vel.length();
      if (sp > 6 && c.pos.y < 3.2) {
        for (const p of S.crowd) {
          if (p.injured || (p.mode !== 'stuck' && p.mode !== 'free' && p.mode !== 'cheer')) continue;
          const dx = p.pos.x - c.pos.x, dz = p.pos.z - c.pos.z; if (dx * dx + dz * dz > 2.3 * 2.3) continue;
          p.mode = 'phys'; p.sleeping = false; p.onGround = false; p.age = 0; p.vel.copy(c.vel).multiplyScalar(0.55).setY(R(3, 5)); p.angVel.set(R(-3, 3), R(-1, 1), R(-3, 3));
          g.injurePerson(p); S.hits++; ev('injure', { by: 'thrownCar' });
        }
      }
      if (c.mLand < 0 && c.mT > 0.3 && c.pos.y < 1.4 && c.vel.y <= 0.5) { c.mLand = c.mT; c.noDrag = false; g.SFX.punch(c.pos, 1); for (let k = 0; k < 16; k++) g.FX.dust(c.pos.x, 0.4, c.pos.z, R(-6, 6), R(0, 3), R(-6, 6), 1.3); }
      if ((c.mLand >= 0 && c.mT - c.mLand > 1.2) || c.mT > 5) { c.noDrag = false; c.mThrown = false; S.flying.splice(i, 1); }
    }
    if (!S.active || S.down || S.phase < 2) return;
    // anything Superman throws (or punches) into him
    for (const b of g.bodies) {
      if (b.dead || b.held || b.mThrown || b.kind === 'person') continue;
      const v2 = b.vel.lengthSq(); if (v2 < 144 || (!b.thrown && v2 < 625)) continue;
      const dx = b.pos.x - S.pos.x, dz = b.pos.z - S.pos.z, rr = 1.1 + b.rad * 0.7;
      if (dx * dx + dz * dz > rr * rr || b.pos.y < S.pos.y - 0.5 || b.pos.y > S.pos.y + 3.6) continue;
      const sp = Math.sqrt(v2), power = clamp(Math.sqrt(b.mass * v2 / 2) / 2500, 0.5, 4);
      g.SFX.punch(b.pos, 1.4); if (g.addShake) g.addShake(0.3);
      strike(b.pos, power, b.kind === 'car' ? 'thrown car' : 'thrown ' + b.kind, sp > 14 && b.mass > 250);
      ev('hit', { by: 'throw', kind: b.kind, speed: Math.round(sp) });
      b.vel.multiplyScalar(-0.2); b.vel.y = 4; b.thrown = false;
      if (b.kind === 'car' && g.ring) g.ring(b.pos, UP, 0.5, 4, 0.3, null, 0.8);
    }
  }

  // ================================================================ the fight, every frame
  const LOOK = { x: 0, z: 0 };
  function updateFight(dt) {
    const g = G(), P = g.P;
    S.t += dt; S.phaseT += dt;
    if (S.stag > 0) S.stag -= dt; if (S.spike > 0) S.spike = Math.max(0, S.spike - dt * 0.67); if (S.tossCD > 0) S.tossCD -= dt;
    let fsum = 0; for (const pl of S.plates) if (pl.alive) { pl.frost = Math.max(0, pl.frost - dt * CFG.thaw); pl.heat = Math.max(0, pl.heat - dt * 0.3); fsum += pl.frost; }
    const n = platesLeft(); S.frostAvg = n ? fsum / n : 0;
    const slow = 1 - 0.65 * clamp(S.frostAvg, 0, 1);
    // phases
    if (S.phase === 1) {
      // falling from the sky into the plaza
      if (S.pos.y > 0) {
        S.pos.y = Math.max(0, 120 - 0.5 * 9.81 * 4 * S.t * S.t);
        if (S.pos.y <= 0) {
          S.landT = S.t; ev('landing', {}); g.SFX.boom(S.pos, 1.6); if (g.addShake) g.addShake(0.6); if (g.hitStop) g.hitStop(0.06);
          for (let k = 0; k < 80; k++) g.FX.dust(S.pos.x + R(-2, 2), 0.4, S.pos.z + R(-2, 2), R(-18, 18), R(1, 8), R(-18, 18), 2);
          for (let k = 0; k < 30; k++) g.FX.kryp(S.pos.x, 1.5, S.pos.z);
          if (g.ring) g.ring(T1.set(S.pos.x, 0.3, S.pos.z), UP, 1, 30, 0.8, new THREE.Color(2.5, 1.8, 1), 0.7);
          for (const p of g.people) if (p.mode === 'free' && !p.mCrowd && p.pos.distanceToSquared(S.pos) < 2500) { p.fleeT = 8; p.dir.set(p.pos.x - S.pos.x, 0, p.pos.z - S.pos.z).normalize(); }
        }
      }
      if (S.t >= CFG.arrive) setPhase(2);
    }
    if (S.phase === 2 && (S.phaseT >= CFG.phase2 || n < NPL)) setPhase(3);
    if (S.phase === 3 && n <= 3) setPhase(4);
    if (S.phase === 4 && n === 0) setPhase(5);
    if (S.phase < 5 && n === 0) setPhase(5);
    // movement: pace the plaza, keep between the hero and the crowd, face the threat
    let moving = false;
    if (S.phase >= 2 && S.stag <= 0) {
      const busy = S.atk && (S.atk.kind !== 'toss' || S.atk.fired);
      T1.copy(P.pos).sub(S.center).setY(0); const dl = T1.length(); if (dl > CFG.tether) T1.multiplyScalar(CFG.tether / dl);
      T1.add(S.center); T1.lerp(T2.copy(S.crowdC).setY(0), 0.18);
      T2.copy(T1).sub(S.pos).setY(0); const d = T2.length();
      if (d > 1.5 && !busy) { const step = Math.min(d, CFG.walk * slow * dt); S.pos.addScaledVector(T2.divideScalar(d), step); moving = true; }
      const face = S.atk && S.atk.kind === 'toss' ? S.atk.target : P.pos;
      LOOK.x = face.x - S.pos.x; LOOK.z = face.z - S.pos.z;
      let dy = Math.atan2(LOOK.x, LOOK.z) - S.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      S.yaw += clamp(dy, -2.2 * slow * dt, 2.2 * slow * dt);
    }
    S.speed = moving ? CFG.walk * slow : 0;
    // attacks
    if (S.phase >= 2 && !S.down) {
      if (S.atk) updateAttack(dt * (S.atk.fired ? 1 : slow));
      else if (S.stag <= 0) { S.atkCD -= dt * slow; if (S.atkCD <= 0) chooseAttack(); }
    }
    // the aura costs solar charge; the fail states are soft
    const k = exposure(P.pos);
    P.solar = Math.max(0, P.solar - (CFG.drain.aura * k) * dt);
    S.collapseT = P.kryp >= 0.98 ? S.collapseT + dt : 0;
    if (P.solar <= 0.002) fail('solar');
    else if (S.collapseT >= CFG.collapse) fail('collapse');
    else if (hurtCount() >= CFG.maxCasualties) fail('casualties');
    if (S.phase >= 4 && Math.random() < dt * 4 * S.frostAvg) { const i = (Math.random() * NPL) | 0; if (S.plates[i].alive) g.FX.ice(PLW[i].x, PLW[i].y, PLW[i].z, R(-1, 1), R(-2, 0), R(-1, 1)); }
  }

  // ================================================================ animation
  function animate(dt) {
    const t = S.t, a = S.atk;
    for (const n in tgt) tgt[n] = 0;
    tgt.shLz = 0.14; tgt.shRz = -0.14; tgt.elL = tgt.elR = -0.25;
    let rate = 8;
    if (S.leaving > 0 && !S.down) { tgt.crouch = 0.3; tgt.shL = tgt.shR = 0.6; tgt.lean = 0.3; }
    else if (S.down) {
      // collapse: knees, then face down
      const k = clamp(S.downT / 1.2, 0, 1);
      tgt.crouch = 0.75 * k; tgt.knL = tgt.knR = 1.5 * k; tgt.hipL = tgt.hipR = -0.4 * k; tgt.lean = 0.9 * k; tgt.headP = 0.5 * k; tgt.shL = tgt.shR = 0.2; tgt.shLz = 0.3; tgt.shRz = -0.3; rate = 3;
    } else if (S.phase === 1) {
      if (S.pos.y > 0) { tgt.shL = tgt.shR = -2.6; tgt.knL = 0.5; tgt.hipL = -0.6; tgt.hipR = 0.2; tgt.knR = 0.8; }
      else { const k = clamp((S.t - S.landT - 0.4) / 0.7, 0, 1); tgt.crouch = 0.5 * (1 - k); tgt.knL = tgt.knR = 1.0 * (1 - k); tgt.hipL = tgt.hipR = -0.6 * (1 - k); tgt.lean = 0.5 * (1 - k) - 0.25 * k; tgt.shLz = 0.14 + 0.9 * k; tgt.shRz = -0.14 - 0.9 * k; tgt.shL = tgt.shR = -0.3 * k; tgt.headP = -0.3 * k; }
    } else {
      if (S.speed > 0.1) {
        S.walkPh += dt * S.speed * 2.6;
        const s = Math.sin(S.walkPh), c = Math.cos(S.walkPh);
        tgt.hipL = -s * 0.42; tgt.hipR = s * 0.42; tgt.knL = Math.max(0, c) * 0.7; tgt.knR = Math.max(0, -c) * 0.7;
        tgt.shL = s * 0.3; tgt.shR = -s * 0.3; tgt.bob = -Math.abs(c) * 0.06; tgt.twist = s * 0.12; tgt.crouch = 0.06;
        if (Math.sign(c) !== S.lastStep) { S.lastStep = Math.sign(c); const g = G(); if (g) g.SFX.punch(S.pos, 0.35); }
      } else { tgt.lean = Math.sin(t * 1.3) * 0.03; tgt.headY = Math.sin(t * 0.7) * 0.3; tgt.bob = Math.sin(t * 2) * 0.015; }
      if (a && !a.fired || a && a.kind === 'beam') {
        const k = clamp(a.t / a.tele, 0, 1);
        if (a.kind === 'beam') { tgt.lean = -0.25 * k; tgt.shL = tgt.shR = 0.5 * k; tgt.shLz = 0.5 * k + 0.14; tgt.shRz = -0.5 * k - 0.14; tgt.headP = -0.1; }
        else if (a.kind === 'pulse') { tgt.lean = -0.4 * k; tgt.shLz = 0.14 + 1.3 * k; tgt.shRz = -0.14 - 1.3 * k; tgt.headP = -0.4 * k; tgt.crouch = 0.15 * k; tgt.knL = tgt.knR = 0.3 * k; tgt.hipL = tgt.hipR = -0.2 * k; }
        else if (a.kind === 'pound') { tgt.shL = tgt.shR = -2.9 * k; tgt.elL = tgt.elR = -0.6 * k; tgt.lean = -0.25 * k; tgt.crouch = -0.05; }
        else if (a.kind === 'toss') { tgt.shL = tgt.shR = -2.85; tgt.elL = tgt.elR = -0.5; tgt.lean = -0.3 * k; tgt.shLz = 0.25; tgt.shRz = -0.25; }
      } else if (a && a.fired) {
        if (a.kind === 'pound') { tgt.shL = tgt.shR = 0.4; tgt.lean = 0.6; tgt.crouch = 0.45; tgt.knL = tgt.knR = 0.9; tgt.hipL = tgt.hipR = -0.6; rate = 18; }
        else if (a.kind === 'toss') { tgt.shL = tgt.shR = 0.5; tgt.lean = 0.35; tgt.twist = -0.2; rate = 16; }
        else if (a.kind === 'pulse') { tgt.shLz = 1.4; tgt.shRz = -1.4; tgt.lean = -0.2; }
      }
      if (S.stag > 0) { const j = S.stag; tgt.lean = -0.45 * j + Math.sin(t * 31) * 0.06 * j; tgt.twist = Math.sin(t * 17) * 0.25 * j; tgt.headP = -0.4 * j; tgt.shL = 0.6 * j; tgt.shR = 0.9 * j; tgt.knL = 0.3 * j; tgt.crouch = 0.1 * j; rate = 14; }
    }
    lerpTo(1 - Math.exp(-rate * dt * (1 - 0.6 * clamp(S.frostAvg, 0, 1))));
    applyPose();
  }

  // ================================================================ visuals: frost tint, heart glow, lead plate, eyes
  const CF = { r: 0, g: 0, b: 0 };
  function updateLooks(dt) {
    const g = G(), P = g.P;
    let dirty = false;
    for (let i = 0; i < NPL; i++) {
      const pl = S.plates[i], f = clamp(pl.frost / 0.9, 0, 1), h = clamp(pl.heat, 0, 1);
      CF.r = 0.34 + (0.72 - 0.34) * f + h * 1.6; CF.g = 0.36 + (0.9 - 0.36) * f + h * 0.4; CF.b = 0.4 + (1.15 - 0.4) * f;
      plateM.instanceColor.setXYZ(i, CF.r, CF.g, CF.b); dirty = true;
    }
    if (dirty) plateM.instanceColor.needsUpdate = true;
    const fa = clamp(S.frostAvg, 0, 1);
    chromeMat.color.setRGB(0.74 + 0.0 * fa, 0.78 + 0.08 * fa, 0.82 + 0.2 * fa); chromeMat.roughness = 0.24 + 0.3 * fa;
    // heart + light
    const a = S.atk, charge = a && !a.fired && (a.kind === 'pulse' || a.kind === 'beam') ? clamp(a.t / a.tele, 0, 1) : 0;
    const beat = Math.max(0, Math.sin(S.t * 7.5)) ** 8;
    const glow = S.contained ? 0.25 : (S.phase >= 5 ? 1.8 : 1) * (1 + beat * 0.6 + charge * 1.5);
    heart.material.emissiveIntensity = glow;
    if (heartLight) { heartLight.position.copy(HEARTW); heartLight.intensity = S.contained ? 0.4 : (S.phase >= 5 ? 6 : 3) * (0.8 + beat * 0.4 + charge); }
    eyeM.material.color.setRGB(S.down || S.leaving > 0 ? 0.08 : 9 + charge * 6, S.down ? 0.01 : 0.5, S.down ? 0.01 : 0.3);
    // shock wave
    if (waveRing.visible) {
      S.wave += dt / 0.5; const k = clamp(S.wave, 0, 1); waveRing.scale.setScalar(1 + (S.waveR - 1) * (1 - (1 - k) * (1 - k))); waveRing.material.opacity = 0.9 * (1 - k);
      if (k >= 1) waveRing.visible = false;
    }
    // lead plate: follows its body; carried, it is held upright between Superman and the heart
    const L = S.lead;
    if (L && !L.dead) {
      if (P.hold === L) {
        T1.copy(HEARTW).sub(P.pos); const dl = T1.length() || 1; T1.divideScalar(dl);
        L.pos.copy(P.pos).addScaledVector(T1, 0.95).y += 0.25;
        L.quat.setFromUnitVectors(UP, T1);
      }
      leadMesh.position.copy(L.pos); leadMesh.quaternion.copy(L.quat);
      if (S.contained) { heart.matrix.compose(L.pos, L.quat, TS.set(0.6, 0.6, 0.6)); heart.matrix.premultiply(TM2.copy(body.matrixWorld).invert()); HEARTW.copy(L.pos); }
    } else if (leadMesh.visible) leadMesh.visible = false;
  }

  // ================================================================ HUD: boss bar
  let hud = null, hudKey = '', segEls = [], phaseEl, crowdEl, teleEl, retryBtn;
  function buildHud() {
    const host = document.getElementById('hud'); if (!host) return;
    const st = document.createElement('style');
    st.textContent = `#boss{position:absolute;top:14px;left:50%;transform:translateX(-50%);width:min(560px,62vw);padding:10px 14px 9px;pointer-events:auto}
#boss .bt{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
#boss .bn{font-family:var(--f-display);font-weight:900;font-size:22px;letter-spacing:.16em;color:#a6ff3d;text-shadow:0 0 12px rgba(120,255,90,.35)}
#boss .bp{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--sun);font-weight:700}
#boss .bar{display:flex;gap:4px;margin:7px 0 6px}
#boss .seg{flex:1;height:11px;border:1px solid var(--edge);background:linear-gradient(180deg,#e9eef5,#8c96a3);border-radius:2px;transition:background .2s,opacity .2s}
#boss .seg.frost{background:linear-gradient(180deg,#e6fbff,#7fd8ff);box-shadow:0 0 8px rgba(155,230,255,.7)}
#boss .seg.gone{background:transparent;opacity:.45}
#boss .seg.heart{flex:.8;background:linear-gradient(180deg,#b9ff8a,#2fae3b);box-shadow:0 0 10px rgba(90,255,110,.6)}
#boss .seg.heart.gone{background:transparent;box-shadow:none}
#boss .bs{display:flex;justify-content:space-between;gap:10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
#boss .bs b{font-family:var(--f-num);color:var(--text);font-weight:600}
#boss .tele{color:#ff7b5c;font-weight:700;letter-spacing:.12em}
#boss .tele.k{color:#a6ff3d}
#boss button{margin-left:8px;font:inherit;font-size:12px;letter-spacing:.12em;text-transform:uppercase;background:var(--cape);color:#fff;border:0;border-radius:3px;padding:3px 10px;cursor:pointer}`;
    document.head.appendChild(st);
    hud = document.createElement('div'); hud.id = 'boss'; hud.className = 'panel'; hud.hidden = true;
    hud.innerHTML = '<div class="bt"><span class="bn">METALLO</span><span class="bp" id="boss-phase"></span></div><div class="bar" id="boss-bar"></div>' +
      '<div class="bs"><span>Crowd <b id="boss-crowd"></b></span><span class="tele" id="boss-tele"></span></div>';
    host.appendChild(hud);
    const bar = hud.querySelector('#boss-bar');
    for (let i = 0; i <= NPL; i++) { const s = document.createElement('i'); s.className = 'seg' + (i === NPL ? ' heart' : ''); bar.appendChild(s); segEls.push(s); }
    phaseEl = hud.querySelector('#boss-phase'); crowdEl = hud.querySelector('#boss-crowd'); teleEl = hud.querySelector('#boss-tele');
    retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.textContent = 'Retry (F8)';
    retryBtn.addEventListener('click', e => { e.stopPropagation(); start(); });
  }
  let hudAcc = 0;
  function updateHud(dt) {
    if (!hud) return; hudAcc += dt; if (hudAcc < 0.1) return; hudAcc = 0;
    const show = S.active || S.retryT > 0 || (S.result && S.result.win && S.linger > 30);
    if (hud.hidden === show) hud.hidden = !show;
    if (!show) return;
    const a = S.atk, tele = !S.active ? '' : a && !a.fired ? ({ beam: '! Kryptonite beam', pulse: '! Radiation pulse: get 40 m away', pound: '! Ground pound: get airborne', toss: '! Car incoming: catch it (E)' }[a.kind]) : a && a.kind === 'beam' ? '! Beam firing' : '';
    let key = S.phase + '|' + tele + '|' + (S.result ? S.result.win + S.result.medal : '') + '|' + safeCount() + hurtCount();
    for (const pl of S.plates) key += pl.alive ? (pl.frost > CFG.brittle ? 'f' : 'a') : 'x';
    key += S.contained ? 'c' : '';
    if (key === hudKey) return; hudKey = key;
    for (let i = 0; i < NPL; i++) { const pl = S.plates[i]; segEls[i].className = 'seg' + (!pl.alive ? ' gone' : pl.frost > CFG.brittle ? ' frost' : ''); }
    segEls[NPL].className = 'seg heart' + (S.contained ? ' gone' : '');
    const hurt = hurtCount();
    crowdEl.textContent = `${CFG.crowd - hurt}/${CFG.crowd} unhurt${S.caught ? ` · ${S.caught} caught` : ''}`;
    if (S.result && S.result.win) { phaseEl.textContent = `Defeated · ${S.result.medal.toUpperCase()} · ${S.result.time}s`; teleEl.textContent = 'Heart contained'; teleEl.className = 'tele k'; }
    else if (S.result && !S.result.win) { phaseEl.textContent = 'He got away'; teleEl.textContent = ''; teleEl.appendChild(retryBtn); teleEl.className = 'tele'; }
    else { phaseEl.textContent = `Phase ${S.phase}/5 · ${PHASES[S.phase]}`; teleEl.textContent = tele; teleEl.className = 'tele' + (a && (a.kind === 'pulse' || a.kind === 'beam') ? ' k' : ''); }
  }

  // ================================================================ plugin
  let attached = false;
  function attach() {
    const g = G(); if (!g || attached || !g.hooks) return;
    attached = true;
    g.hooks.kryp.push(exposure); g.hooks.punch.push(onPunch); g.hooks.clap.push(onClap);
    g.hooks.freeze.push(onFreeze); g.hooks.heat.push(onHeat); g.hooks.grab.push(onGrab);
    g.registerIncident('metallo', { start: startInc, want: () => false }); // the finale: never in the random rotation
    if (g.mapPinHooks) g.mapPinHooks.push(pins => { if (S.active && S.lead && !S.lead.dead) pins.push([S.lead.pos.x, S.lead.pos.z, 'trap', 'Lead plate']); });
    g.metallo = API;
    if (/[?&]metallo\b/.test(location.search)) { S.autoT = 2; if (g.deferIncident) g.deferIncident(1e9); }
  }
  function update(dt) {
    if (!attached) attach(); if (!attached) return;
    const g = G();
    if (S.autoT > 0 && g.started) { S.autoT -= dt; if (S.autoT <= 0) start(); }
    if (S.retryT > 0) S.retryT -= dt;
    if (!S.visible) { updateHud(dt); return; }
    if (S.active) updateFight(dt);
    else S.t += dt;
    if (S.down) { S.downT = (S.downT || 0) + dt; }
    if (S.leaving > 0 && !S.down) {
      // escape: a leap into the sky
      S.leaving -= dt; S.pos.y += dt * (8 + (3 - S.leaving) * 40);
      if (Math.random() < 0.6) g.FX.kryp(S.pos.x, S.pos.y + 1, S.pos.z);
      if (S.leaving <= 0) hideAll();
    }
    if (S.linger > 0) { S.linger -= dt; if (S.linger <= 0) hideAll(); }
    if (!S.visible) { updateHud(dt); return; }
    // he is solid: Superman can't fly through him
    const P = g.P, dx = P.pos.x - S.pos.x, dz = P.pos.z - S.pos.z, d2 = dx * dx + dz * dz;
    if (!S.down && d2 < 1.21 && P.pos.y > S.pos.y - 0.5 && P.pos.y < S.pos.y + 3.4) { const d = Math.sqrt(d2) || 1e-3; P.pos.x = S.pos.x + dx / d * 1.1; P.pos.z = S.pos.z + dz / d * 1.1; }
    updateProjectiles(dt);
    animate(dt);
    updateLooks(dt);
    MARK.copy(S.pos).setY(S.pos.y + 4);
    updateHud(dt);
  }

  // ================================================================ API (tests, demo sequencer)
  const API = {
    cfg: CFG, events: S.events,
    start, retry: start,
    get state() { return S; },
    info() {
      const g = G();
      return {
        active: S.active, visible: S.visible, phase: S.phase, phaseName: PHASES[S.phase], t: +S.t.toFixed(2), plates: platesLeft(),
        frost: S.plates.map(p => +p.frost.toFixed(2)), atk: S.atk ? S.atk.kind + (S.atk.fired ? ':fired' : ':tele') : null,
        crowd: S.crowd.length, hurt: hurtCount(), safe: safeCount(), caught: S.caught, flying: S.flying.length,
        heartOut: S.heartOut, contained: S.contained, down: S.down, result: S.result,
        pos: S.pos.toArray().map(v => +v.toFixed(2)), heart: HEARTW.toArray().map(v => +v.toFixed(2)),
        lead: S.lead && !S.lead.dead ? S.lead.pos.toArray().map(v => +v.toFixed(2)) : null, kryp: g ? +g.P.kryp.toFixed(3) : 0
      };
    },
    exposureAt(x, y, z) { return exposure(T4.set(x, y, z)); },
    // aim Superman at a part: 'heart' | 'chest' | 'lead' | 'car' (the one in flight) | [x, y, z]
    aim(what, from) {
      const g = G(), P = g.P; let p = null;
      if (Array.isArray(what)) p = T1.fromArray(what);
      else if (what === 'heart') p = T1.copy(HEARTW);
      else if (what === 'chest') p = T1.copy(CHESTW);
      else if (what === 'lead' && S.lead) p = T1.copy(S.lead.pos);
      else if (what === 'car' && S.flying.length) p = T1.copy(S.flying[0].pos);
      else if (what === 'car' && S.atk && S.atk.car) p = T1.copy(S.atk.car.pos);
      if (!p) return false;
      const o = T2.copy(P.pos); o.y += from === undefined ? 0.35 : from;
      const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z;
      g.setYawPitch(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      return true;
    },
    calm(sec) { cancelAttack(); S.atk = null; beam.visible = teleRing.visible = false; S.beamHit = false; S.spike = 0; S.atkCD = sec; S.tossCD = Math.max(S.tossCD, sec); },
    forceAttack(kind) { if (!S.active) return false; cancelAttack(); S.atk = null; S.alt = kind === 'pulse' ? 1 : 0; S.tossCD = kind === 'toss' ? 0 : 99; if (kind === 'pound') S.phase = Math.max(S.phase, 4); chooseAttack(); return S.atk && S.atk.kind; },
    meshes() { let n = 0; body.traverse(o => { if (o.isMesh && o.visible) n++; }); return n + (beam.visible ? 1 : 0) + (teleRing.visible ? 1 : 0) + (waveRing.visible ? 1 : 0); },
    medalOf
  };
  window.SM_METALLO = API;

  window.addEventListener('keydown', e => {
    if (e.code !== 'F8') return; const g = G(); if (!g || !g.started) return;
    e.preventDefault(); if (!S.active) start();
  });

  (window.SM_PLUGINS = window.SM_PLUGINS || []).push(c => {
    ctx = c; THREE = c.THREE; scene = c.scene;
    build(); buildHud();
    return { update };
  });
})();
