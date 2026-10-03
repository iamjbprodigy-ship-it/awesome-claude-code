/* Set pieces for "Superman Over Metropolis": the runaway bus (dream feature 12) and the falling
 * airliner (dream feature 4), demo steps 7 and 8.
 *
 * Runaway bus: a packed city bus loses its brakes on Centennial St and runs downhill toward the
 * waterfront crosswalk. Superman is more powerful than a locomotive, but the 15 standing passengers
 * (30 aboard) are hurt above about 1 g, so a dead stop hurts them. Get in front early (~40 m of
 * stopping distance at 25 m/s), press E on the front to brace, and HOLD E for a smooth "soft hands"
 * stop at 0.85 g (or W to push harder, S to ease off; the meter shows the deceleration). Tap E to
 * let go. Grabbing it from the side or punching it hurts the passengers and damages the bus.
 *
 * Falling airliner: an 80-tonne airliner with an engine fire glides down over the bay. Freeze breath
 * (Q) on the burning left engine for ~5 s puts it out; left burning, the wing fails at 25 s (roll rate
 * x2.5, 40 hurt). Four push points (nose, both wingtips, tail): E attaches, then W/Space push up,
 * S/C push down, A/D push sideways (up to 2.5 MN at that point: enough to steer pitch and roll, not
 * to hold 80 t up). Set it down on the water with vertical speed under 6 m/s and roll under 15 deg.
 * 140 passengers are counted, not modelled; 40 stand on the wings while it floats.
 *
 * Contract: registers 'bus' and 'airliner' in window.SM_INCIDENTS (consulted by game.js
 * startIncident), pushes a plugin onto window.SM_PLUGINS, reads everything else lazily from
 * window.__game. Test / demo API: window.SM_SETPIECES (= __game.setpieces).
 * Draw calls: bus 3 (body, glass, passengers), airliner 2 (+1 instanced wing standers).
 * No per-frame allocations in the sim loops.
 */
(function () {
  'use strict';

  // ================================================================== tuning
  const CFG = {
    bus: {
      x: -33.5,            // lane centre on Centennial St (road x = -30, northbound lane)
      z0: -228,            // front of the bus at the start
      stopZ: 199,          // crosswalk stop line (front of the bus must stay short of it)
      crowd: 10,           // people waiting on the crosswalk
      v0: 9, vmax: 25,     // m/s
      slope: 0.62,         // m/s^2 downhill run-away acceleration
      len: 12, w: 2.5, h: 3.0, mass: 15000,
      aboard: 30, standing: 15,
      hurtG: 1.0,          // standing passengers are hurt above this (sustained)
      softG: 0.85,         // hold E: controlled deceleration
      pushMaxG: 3.2, pushRamp: 1.1, jerk: 1.6,
      blockInj: 12,        // a stationary block at 25 m/s
      sideInj: 8, punchInj: 4,
      limit: 45
    },
    plane: {
      start: [-1500, 450, 1100], heading: -Math.PI / 2, v0: 105,
      mass: 80000, S: 200, rho: 1.225, cd0: 0.032, k: 0.055, cl: 0.12, clMax: 1.6, alphaTrim: 4,
      ka: 0.9, cq: 1.4, Ith: 1.9e8, Iph: 1.06e8, Ips: 2.5e8, drift: 0.035, kr: 0.12, cp: 1.6, kbeta: 1.2,
      push: 2.5e6, pushLin: 0.15, attachR: 9,
      fireBreath: 5,       // s of freeze breath on the engine
      wingFailT: 25,       // s: the wing fails if the fire is still burning
      limit: 75, pax: 140, wingHurt: 40,
      vsOK: 6, vsHard: 12, rollOK: 15, rollHard: 30
    },
    rotation: { busAfter: 180, planeAfter: 300, every: 6 }
  };
  const D2R = Math.PI / 180, G0 = 9.81;

  let THREE, V3, ready = false, scene = null;
  const G = () => window.__game;
  let T1, T2, T3, T4, TM, TM2, TQ, TE;
  const held = { KeyE: false };
  let eDownAt = 0, ignoreUp = false, clock = 0;
  const API_PUSH = { on: false, u: 0, s: 0 };

  // ================================================================== geometry helpers
  function col(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }
  function merge(parts) {
    let n = 0; const gs = [];
    for (const [geo, c] of parts) { const g = geo.index ? geo.toNonIndexed() : geo; n += g.attributes.position.count; gs.push([g, c]); }
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), cl = new Float32Array(n * 3);
    let o = 0;
    for (const [g, c] of gs) {
      const k = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
      for (let i = 0; i < k; i++) { cl[(o + i) * 3] = c.r; cl[(o + i) * 3 + 1] = c.g; cl[(o + i) * 3 + 2] = c.b; }
      o += k;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(cl, 3));
    out.computeBoundingSphere(); return out;
  }
  const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  function zcyl(r0, r1, len, seg, x, y, z) { const g = new THREE.CylinderGeometry(r1, r0, len, seg); g.rotateX(Math.PI / 2); g.translate(x, y, z); return g; }

  // ---- people: one instanced mesh for bus passengers and wing standers
  const PCAP = 64;
  let pplMesh = null, pplN = 0;
  function makePeople() {
    const skin = col(0xd9a07a), shirt = col(0xe8e8e8), pants = col(0x2c3240);
    const legs = new THREE.CylinderGeometry(0.17, 0.14, 0.85, 7).translate(0, 0.43, 0);
    const body = new THREE.CylinderGeometry(0.2, 0.18, 0.65, 7).translate(0, 1.18, 0);
    const head = new THREE.SphereGeometry(0.12, 8, 6).translate(0, 1.64, 0);
    const geo = merge([[legs, pants], [body, shirt], [head, skin]]);
    pplMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), PCAP);
    pplMesh.castShadow = true; pplMesh.frustumCulled = false; pplMesh.count = 0;
    const shirts = [0x7a2b2b, 0x2b4a7a, 0x3c3c3c, 0x6b5a3a, 0x2f6b55, 0x8a6d9c, 0xb0a07a, 0xd8d4c8, 0xa8322d, 0x404d60];
    for (let i = 0; i < PCAP; i++) pplMesh.setColorAt(i, col(shirts[i % shirts.length]).lerp(new THREE.Color(1, 1, 1), 0.25));
    pplMesh.instanceColor.needsUpdate = true;
    scene.add(pplMesh);
  }

  // ================================================================== the bus
  let bus = null;           // state while a bus exists (running, stopped or wrecked)
  let busMesh = null;
  const PAX = [];           // standing passenger local poses: {x, z, f (fallen)}
  function makeBusMesh() {
    const cream = col(0xdcd6c6), blue = col(0x2a4f8f), dark = col(0x1a1b1e), amber = col(0xffb030), lamp = col(0xfff3d0), grey = col(0x5a5d63);
    const parts = [
      [box(2.5, 1.25, 12, 0, 0.975, 0), cream], [box(2.52, 0.18, 12.02, 0, 1.45, 0), blue],
      [box(2.5, 0.3, 12, 0, 2.95, 0), cream], [box(2.52, 0.12, 12.02, 0, 2.78, 0), blue],
      [box(2.5, 1.4, 0.1, 0, 2.1, -5.95), cream], [box(2.5, 0.3, 0.1, 0, 2.65, 5.97), dark],
      [box(1.8, 0.22, 0.05, 0, 2.65, 6.03), amber], [box(2.56, 0.3, 0.25, 0, 0.5, 6.05), grey], [box(2.56, 0.3, 0.25, 0, 0.5, -6.05), grey],
      [box(0.35, 0.18, 0.05, -0.85, 0.95, 6.03), lamp], [box(0.35, 0.18, 0.05, 0.85, 0.95, 6.03), lamp]
    ];
    for (const sx of [-1.21, 1.21]) for (let z = -5.8; z <= 5.85; z += 1.93) parts.push([box(0.1, 1.2, 0.16, sx, 2.2, z), cream]);
    for (const sx of [-1.15, 1.15]) for (const z of [-4, 4]) { const w = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 12); w.rotateZ(Math.PI / 2); w.translate(sx, 0.5, z); parts.push([w, dark]); }
    const body = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }));
    body.castShadow = true; body.receiveShadow = true;
    const glassGeo = merge([[box(0.04, 1.15, 11.7, -1.2, 2.18, 0), new THREE.Color(1, 1, 1)], [box(0.04, 1.15, 11.7, 1.2, 2.18, 0), new THREE.Color(1, 1, 1)], [box(2.35, 1.05, 0.04, 0, 2.05, 5.98), new THREE.Color(1, 1, 1)]]);
    const glass = new THREE.Mesh(glassGeo, new THREE.MeshStandardMaterial({ color: 0x2a3a4a, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.6, depthWrite: false }));
    glass.renderOrder = 2;
    const g = new THREE.Group(); g.add(body, glass); g.visible = false; scene.add(g);
    for (let i = 0; i < CFG.bus.standing; i++) PAX.push({ x: (i % 2 ? 0.55 : -0.55) + (Math.random() - 0.5) * 0.3, z: -5 + i * 0.66, f: 0 });
    return g;
  }

  function busStart() {
    const g = G(), B = CFG.bus;
    if (!THREE || !g) return null;
    if (!ready) firstRun(g);
    if (!busMesh) busMesh = makeBusMesh();
    const crowd = [];
    for (let i = 0; i < B.crowd; i++) {
      const x = i < 3 ? B.x - 1 + i : B.x + (i % 2 ? -1 : 1) * (3 + (i * 1.7) % 4.5);
      const p = g.placePerson('free', new V3(x, 0.9, B.stopZ + 2.5 + (i * 1.3) % 3.5), { spd: 0.05 });
      if (p) crowd.push(p);
    }
    bus = { s: B.z0, sPrev: B.z0, v: B.v0, vPrev: B.v0, gS: 0, aboveT: 0, hurt: 0, hurtToast: 0, hurtT: -9, attached: false, push: 0,
      phase: 'run', stopT: 0, dmg: 0, maxG: 0, crowd, removeT: -1, insideBlock: false, nan: false, lost: 0, disembarked: 0, blocked: false };
    for (const q of PAX) q.f = 0;
    // clear our lane ahead of the bus
    for (const c of g.cars) if (!c.dead && c.drive && c.drive.axis === 'z' && Math.abs(c.drive.lane - B.x) < 0.6 && c.pos.z > B.z0 - 16) c.pos.z = -244;
    busMesh.visible = true;
    const inc = {
      type: 'bus', label: 'Runaway bus', limit: B.limit, where: 'Centennial St',
      title: 'Runaway bus on Centennial St! Brakes gone, heading for the waterfront crosswalk. Get in front early and hold E.',
      marker() { return T4.set(B.x, 4, bus ? bus.s - 6 : 0).clone(); },
      update() {
        if (!bus || bus.inc !== this) return;
        if (bus.phase === 'crash' && !bus.ended) finishBus(false);
        else if (bus.phase === 'stopped' && bus.stopT > 1 && !bus.ended) finishBus(true);
      },
      timeout() { if (bus && !bus.ended) { bus.phase = 'stopped'; bus.v = 0; finishBus(false, 'Out of time: the bus is still loose.'); } },
      cleanup() { if (bus) { if (bus.phase === 'run') { bus.v = 0; bus.phase = 'stopped'; } bus.attached = false; bus.ended = true; if (bus.removeT < 0) bus.removeT = 25; for (const p of bus.crowd) if (p.spd < 0.1) p.spd = 1.2 + Math.random() * 0.4; } }
    };
    bus.inc = inc;
    return inc;
  }

  function busPaySaves(g, n, why) { if (n > 0) g.addSave(n, T1.set(CFG.bus.x, 1, bus.s - 6).clone(), why); }
  function finishBus(success, msg) {
    const g = G(), B = CFG.bus; if (!bus || bus.ended) return;
    bus.ended = true; bus.attached = false;
    // passengers step off at the doors (right-hand side); the hurt ones need the hospital
    const hurt = Math.min(B.aboard, bus.hurt);
    for (let i = 0; i < B.aboard; i++) {
      const p = g.placePerson('free', new V3(B.x - 2.6 - (i % 3) * 0.8, 0.9, bus.s - 1.5 - (i * 0.37) % 10));
      if (!p) continue; bus.disembarked++;
      if (i < hurt) { g.injurePerson(p); p.mode = 'down'; }
    }
    const res = { type: 'bus', success, hurt, saved: B.aboard - hurt, lost: bus.lost, stopZ: bus.s, short: B.stopZ - bus.s, maxG: +bus.maxG.toFixed(2), blocked: bus.blocked, vBlock: bus.vBlock || 0, disembarked: bus.disembarked, insideBlock: bus.insideBlock, nan: bus.nan };
    API.last = res; API.results.push(res);
    if (success) {
      busPaySaves(g, B.aboard - hurt, 'Bus passengers safe');
      g.endIncident(true, msg || `Bus stopped ${Math.max(0, Math.round(B.stopZ - bus.s))} m short of the crosswalk${hurt ? ` · ${hurt} hurt` : ', nobody hurt'}`);
    } else {
      bus.inc.lost = bus.lost;
      g.endIncident(false, msg || `The bus ploughed into the crosswalk. ${bus.lost} lost.`);
    }
    bus.removeT = 30;
  }

  function busHurt(n, why) {
    const g = G(); if (!bus || n <= 0) return;
    const was = bus.hurt; bus.hurt = Math.min(CFG.bus.aboard, bus.hurt + n); const d = bus.hurt - was; if (!d) return;
    bus.hurtToast += d;
    // fallen standing passengers in the cabin
    let k = Math.ceil(bus.hurt * CFG.bus.standing / CFG.bus.aboard); for (const q of PAX) if (k-- > 0) q.f = 1;
    if (clock - bus.hurtT > 1.2) { g.toast(`${why}: ${bus.hurtToast} passenger${bus.hurtToast > 1 ? 's' : ''} hurt`, 'alert'); bus.hurtToast = 0; bus.hurtT = clock; }
  }
  function standingG() {
    const c = window.SM_CATCH && window.SM_CATCH.cfg;
    return (c && (c.gStanding || c.gStandingPerson)) || CFG.bus.hurtG;
  }

  function simBus(g, dt) {
    const B = CFG.bus, P = g.P;
    if (bus.phase === 'run') {
      let a = bus.v < B.vmax ? B.slope : 0;
      if (bus.attached) {
        const W = g.keys.has('KeyW'), S = g.keys.has('KeyS'), soft = held.KeyE || g.keys.has('KeyE');
        let cmd = bus.push;
        if (soft) cmd = B.softG; else if (W) cmd = Math.min(B.pushMaxG, bus.push + B.pushRamp * dt * 2); else if (S) cmd = 0;
        bus.push += Math.max(-B.jerk * dt * (S ? 3 : 1), Math.min(B.jerk * dt, cmd - bus.push));
        a -= bus.push * G0;
      }
      bus.vPrev = bus.v; bus.v += a * dt;
      if (bus.v > B.vmax) bus.v = B.vmax;
      if (bus.v <= 0) { bus.v = 0; bus.phase = 'stopped'; bus.attached = false; g.toast('The bus is stopped.', 'good'); }
      bus.sPrev = bus.s; bus.s += bus.v * dt;
      // stationary block: running into Superman when he isn't braced
      if (!bus.attached && Math.abs(P.pos.x - B.x) < 1.7 && P.pos.y < B.h + 0.4 && P.pos.z >= bus.sPrev - 0.4 && P.pos.z <= bus.s + 0.6) {
        const rel = bus.v - P.vel.z;
        if (rel > 3) {
          const v0 = bus.v; bus.vPrev = bus.v; bus.v = Math.max(0, P.vel.z); bus.blocked = true; bus.vBlock = +v0.toFixed(1);
          busHurt(Math.ceil(B.blockInj * (v0 - bus.v) / 25), 'You stopped it dead');
          bus.dmg += 180000; g.ledger.damage += 180000; if (g.currentInc === bus.inc) bus.inc.damage += 180000;
          g.SFX.punch(P.pos, 1.5); for (let k = 0; k < 18; k++) g.FX.spark(P.pos.x, P.pos.y, P.pos.z, (Math.random() - 0.5) * 12, Math.random() * 6, -Math.random() * 8);
          bus.gS = Math.max(bus.gS, (v0 - bus.v) / 0.1 / G0); bus.maxG = Math.max(bus.maxG, bus.gS);
          if (g.hitStop) g.hitStop(0.09); if (g.addShake) g.addShake(0.8); if (g.emit) g.emit('impact', { what: 'bus', v: v0 });
          if (bus.v <= 0.01) { bus.v = 0; bus.phase = 'stopped'; }
        } else attachBus(g);
      }
      // cars in the way get shoved aside; cars behind queue up
      for (const c of g.cars) {
        if (c.dead || c.held) continue;
        const dx = c.pos.x - B.x;
        if (Math.abs(dx) < 2.6 && c.pos.z > bus.s - B.len - 2 && c.pos.z < bus.s + 2.2 && c.pos.y < 3) {
          if (c.pos.z < bus.s - B.len + 1 && c.drive) { c.pos.z = bus.s - B.len - 2.5; c.drive.v = Math.min(c.drive.v, bus.v); continue; }
          if (c.drive && c.drive.axis === 'z') { c.pos.z = bus.s - B.len - 2.5; c.drive.v = Math.min(c.drive.v, bus.v); continue; }
          c.drive = null; c.parked = false; c.sleeping = false; c.sleepT = 0;
          const sx = dx >= 0 ? 1 : -1; c.pos.x = B.x + sx * 2.7; c.vel.set(sx * 9, 2.5, bus.v * 0.7);
          bus.v = Math.max(0, bus.v - 0.15); bus.dmg += 25000; g.ledger.damage += 25000; if (g.currentInc === bus.inc) bus.inc.damage += 25000;
          g.SFX.crumble(c.pos); g.toast('The bus clipped a car', '');
        }
      }
      // the crosswalk
      if (bus.s > B.stopZ + 1 && bus.v > 1) {
        bus.phase = 'crash';
        let lost = 0;
        for (const p of bus.crowd) {
          if (p.mode === 'gone' || p.mode === 'held') continue;
          const d = Math.abs(p.pos.x - B.x);
          if (d < 1.9 && p.pos.z > B.stopZ - 1 && lost < 4) { p.mode = 'gone'; lost++; }
          else if (d < 5) { g.injurePerson(p); p.mode = 'down'; }
        }
        if (!lost) lost = 1;
        bus.lost = lost; g.ledger.lost += lost;
        busHurt(Math.ceil(6 * bus.v / 25), 'Impact');
        g.SFX.crumble(T1.set(B.x, 1, bus.s)); g.SFX.punch(T1, 1.2);
      }
    } else if (bus.phase === 'crash') {
      bus.vPrev = bus.v; bus.v = Math.max(0, bus.v - 7 * dt); bus.sPrev = bus.s; bus.s += bus.v * dt;
      if (bus.v === 0) bus.phase = 'wreck';
    } else {
      bus.vPrev = bus.v = 0; if (bus.phase === 'stopped') bus.stopT += dt;
    }
    // passenger deceleration in g (smoothed over the catch window), the standing-passenger rule
    const win = (window.SM_CATCH && window.SM_CATCH.cfg && window.SM_CATCH.cfg.window) || 0.1;
    const sustain = (window.SM_CATCH && window.SM_CATCH.cfg && window.SM_CATCH.cfg.sustain) || 0.25;
    const gi = dt > 0 ? Math.max(0, (bus.vPrev - bus.v) / dt / G0) : 0;
    bus.gS += (gi - bus.gS) * Math.min(1, dt / win);
    if (bus.phase === 'run' || bus.phase === 'stopped') {
      bus.maxG = Math.max(bus.maxG, bus.gS);
      const lim = standingG();
      if (bus.gS > lim + 1e-3) { bus.aboveT += dt; while (bus.aboveT >= sustain) { bus.aboveT -= sustain; busHurt(Math.ceil((bus.gS - lim) * 6), 'Braked too hard'); } }
      else bus.aboveT = 0;
    }
    // Superman braced on the front bumper
    if (bus.attached) {
      P.flying = true; P.pos.set(B.x, 1.7, bus.s + 0.75); P.vel.set(0, 0, bus.v);
    }
    // invariants for the bot
    if (g.blockAt(B.x, 1.5, bus.s - 1) >= 0 || g.blockAt(B.x, 1.5, bus.s - B.len + 1) >= 0) bus.insideBlock = true;
    if (!isFinite(bus.s) || !isFinite(bus.v)) { bus.nan = true; bus.s = B.z0; bus.v = 0; }
    // punches
    if (P.punchT > bus.lastPunch + 0.05 && bus.phase === 'run' && nearBus(P.pos, 2.5)) {
      busHurt(Math.ceil(B.punchInj * (0.5 + bus.v / 25)), 'You punched the bus');
      bus.v *= 0.8; bus.dmg += 90000; g.ledger.damage += 90000; if (g.currentInc === bus.inc) bus.inc.damage += 90000;
    }
    bus.lastPunch = P.punchT;
  }
  function nearBus(p, m) { const B = CFG.bus; return Math.abs(p.x - B.x) < B.w / 2 + m && p.z > bus.s - B.len - m && p.z < bus.s + m && p.y < B.h + m; }
  function attachBus(g) {
    if (!bus || bus.phase !== 'run' || bus.attached) return false;
    bus.attached = true; bus.push = 0; g.setYawPitch(0, -0.05); g.SFX.punch(g.P.pos, 0.4);
    g.toast('Braced on the bus. Hold E for a smooth stop (W pushes harder, S eases off; tap E to let go)', 'good');
    return true;
  }
  function busKey(g) {
    if (!bus || bus.ended || bus.phase !== 'run') return false;
    const P = g.P, B = CFG.bus;
    if (bus.attached) return 'held';
    const dz = P.pos.z - bus.s;
    if (Math.abs(P.pos.x - B.x) < 2.3 && dz > -1.2 && dz < 6 && P.pos.y < 4.8) { if (P.hold) { g.toast('Hands full. Set it down first.', ''); return true; } attachBus(g); ignoreUp = true; return true; }
    if (nearBus(P.pos, 2.2)) {
      // grabbed from the side: a lurch that throws the standing passengers
      busHurt(Math.ceil(B.sideInj * bus.v / 25) + 1, 'Grabbed from the side');
      bus.v *= 0.55; bus.dmg += 120000; g.ledger.damage += 120000; if (g.currentInc === bus.inc) bus.inc.damage += 120000;
      g.SFX.crumble(P.pos); g.toast('Not from the side! Get in front of it.', 'alert');
      return true;
    }
    return false;
  }
  function drawBus(g, dt) {
    const B = CFG.bus;
    busMesh.position.set(B.x, 0, bus.s - 6);
    busMesh.rotation.set(Math.min(0.05, bus.gS * 0.012), 0, 0);
    busMesh.updateMatrixWorld();
    // standing passengers lean with the deceleration
    const lean = Math.min(0.55, bus.gS * 0.2);
    for (let i = 0; i < PAX.length; i++) {
      const q = PAX[i];
      TE.set(q.f ? 1.45 : lean, 0, 0); TQ.setFromEuler(TE);
      T1.set(q.x, q.f ? 0.9 : 0.68, q.z); T2.set(1, 1, 1);
      TM.compose(T1, TQ, T2); TM2.multiplyMatrices(busMesh.matrixWorld, TM);
      pplMesh.setMatrixAt(pplN++, TM2);
    }
  }

  // ================================================================== the airliner
  let plane = null, planeMesh = null, wingL = null;
  const HP = {};            // hardpoints, local
  function makePlaneMesh() {
    const white = col(0xe8e6e0), grey = col(0x8a9099), stripe = col(0x6c7480), win = col(0x2a3038), wingC = col(0xd2d2d0), eng = col(0xb8bcc2), dark = col(0x25272b);
    function wing(sign, span, root, chord, sweep, y, z, th) {
      const g = new THREE.BoxGeometry(span, th, chord, 4, 1, 1); g.translate(span / 2, 0, 0);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const t = p.getX(i) / span; p.setZ(i, p.getZ(i) * (1 - 0.6 * t) + t * sweep); p.setX(i, sign * (p.getX(i) + root)); }
      if (sign < 0) { const idx = g.index.array; for (let i = 0; i < idx.length; i += 3) { const a = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = a; } }
      g.computeVertexNormals(); g.translate(0, y, z); return g;
    }
    const fin = new THREE.BoxGeometry(0.35, 6.5, 4.5, 1, 2, 1); { const p = fin.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * (1 - 0.35 * (p.getY(i) + 3.25) / 6.5) + (p.getY(i) + 3.25) * 0.55); fin.computeVertexNormals(); fin.translate(0, 4.6, 15.5); }
    const main = [
      [zcyl(2, 2, 30, 14, 0, 0, 0), white], [zcyl(0.35, 2, 5, 14, 0, 0, -17.5), white], [zcyl(2, 0.55, 7, 14, 0, 0.4, 18.5), white],
      [box(0.06, 0.45, 30, -2.0, -0.2, 0), stripe], [box(0.06, 0.45, 30, 2.0, -0.2, 0), stripe],
      [box(0.05, 0.26, 26, -1.97, 0.75, -1), win], [box(0.05, 0.26, 26, 1.97, 0.75, -1), win],
      [wing(1, 15, 1.5, 6, 5, -1.0, 0.5, 0.45), wingC], [zcyl(1.0, 1.15, 4.2, 12, 6.5, -2.2, -1.5), eng], [zcyl(0.8, 0.8, 0.1, 12, 6.5, -2.2, -3.65), dark],
      [box(0.4, 0.9, 1.6, 6.5, -1.2, -1.3), wingC], [fin, grey],
      [wing(1, 5.5, 0.4, 3, 2.2, 0.6, 17, 0.25), wingC], [wing(-1, 5.5, 0.4, 3, 2.2, 0.6, 17, 0.25), wingC]
    ];
    const left = [[wing(-1, 15, 1.5, 6, 5, -1.0, 0.5, 0.45), wingC], [zcyl(1.0, 1.15, 4.2, 12, -6.5, -2.2, -1.5), eng], [zcyl(0.8, 0.8, 0.1, 12, -6.5, -2.2, -3.65), dark], [box(0.4, 0.9, 1.6, -6.5, -1.2, -1.3), wingC]];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3 });
    const m = new THREE.Mesh(merge(main), mat), l = new THREE.Mesh(merge(left), mat);
    m.castShadow = l.castShadow = true;
    const grp = new THREE.Group(); grp.add(m, l); grp.visible = false; scene.add(grp);
    wingL = l;
    HP.nose = new V3(0, -2.3, -17); HP.left = new V3(-16.2, -1.2, 4.6); HP.right = new V3(16.2, -1.2, 4.6); HP.tail = new V3(0, -1.6, 17);
    HP.engine = new V3(-6.5, -2.2, -1.5); HP.engineR = new V3(6.5, -2.2, -1.5); HP.wingRoot = new V3(-3.5, -1.0, 0.5);
    return grp;
  }
  function planeStart() {
    const g = G(), C = CFG.plane; if (!THREE || !g) return null;
    if (!ready) firstRun(g);
    if (!planeMesh) planeMesh = makePlaneMesh();
    if (wingL.parent !== planeMesh) { wingL.parent.remove(wingL); wingL.position.set(0, 0, 0); wingL.quaternion.identity(); planeMesh.add(wingL); }
    wingL.visible = true; planeMesh.visible = true;
    plane = { pos: new V3(C.start[0], C.start[1], C.start[2]), vel: new V3(), th: 0, ph: 0, ps: C.heading, q: 0, p: 0,
      quat: new THREE.Quaternion(), f: new V3(), up: new V3(), right: new V3(), alpha: 0,
      fire: 1, breath: 0, wing: true, phase: 'fly', attached: null, pu: 0, ps2: 0, age: 0, fall: null,
      outcome: null, vsTouch: 0, rollTouch: 0, removeT: -1, standers: 0, maxVs: 0, nan: false, smokeT: 0, sinkT: 0 };
    plane.vel.set(-Math.sin(C.heading), -0.05, -Math.cos(C.heading)).normalize().multiplyScalar(C.v0);
    planeAxes();
    const inc = {
      type: 'airliner', label: 'Falling airliner', limit: C.limit, where: 'the bay',
      title: 'Airliner in trouble over the bay! Engine fire. Freeze it (Q), then grab a push point (E) and set it down on the water.',
      marker() { return plane ? plane.pos.clone() : new V3(); },
      update() {
        if (!plane || plane.inc !== this || plane.ended) return;
        if (plane.outcome) finishPlane();
      },
      timeout() { if (plane && !plane.ended) { plane.outcome = { kind: 'timeout' }; finishPlane(); } },
      cleanup() { if (plane) { plane.attached = null; plane.ended = true; if (plane.phase === 'fly') { plane.phase = 'gone'; planeMesh.visible = false; } if (plane.removeT < 0) plane.removeT = 40; } }
    };
    plane.inc = inc;
    return inc;
  }
  const planeEuler = () => TE.set(plane.th, plane.ps, -plane.ph, 'YXZ');
  function planeAxes() { plane.quat.setFromEuler(planeEuler()); plane.f.set(0, 0, -1).applyQuaternion(plane.quat); plane.up.set(0, 1, 0).applyQuaternion(plane.quat); plane.right.set(1, 0, 0).applyQuaternion(plane.quat); }
  function hpWorld(name, o) { return o.copy(HP[name]).applyQuaternion(plane.quat).add(plane.pos); }

  function planeStep(g, dt) {
    const C = CFG.plane, pl = plane;
    planeAxes();
    const V = pl.vel.length() || 1, vh = T1.copy(pl.vel).divideScalar(V);
    const alpha = Math.atan2(-pl.vel.dot(pl.up), pl.vel.dot(pl.f)), ad = alpha / D2R; pl.alpha = alpha;
    let CL = ad <= 13.3 ? C.cl * ad : Math.max(0.5, C.clMax - (ad - 13.3) * 0.08); CL = Math.max(-0.8, Math.min(C.clMax, CL));
    const qd = 0.5 * C.rho * V * V, S = C.S * (pl.wing ? 1 : 0.6);
    const acc = T2.set(0, -G0, 0);
    const ld = T3.copy(pl.up).addScaledVector(vh, -pl.up.dot(vh)); if (ld.lengthSq() > 1e-6) ld.normalize();
    acc.addScaledVector(ld, qd * S * CL / C.mass);
    acc.addScaledVector(vh, -qd * S * (C.cd0 + C.k * CL * CL) / C.mass);
    const beta = Math.atan2(pl.vel.dot(pl.right), pl.vel.dot(pl.f));
    acc.addScaledVector(pl.right, -qd * C.S * 0.25 * beta / C.mass);
    let Mth = 0, Mph = 0, Mps = 0;
    if (pl.attached) {
      // push at the hardpoint: torque r x F in body axes, a fraction of F as net force
      const r = T3.copy(HP[pl.attached === 'left' && !pl.wing ? 'wingRoot' : pl.attached]).applyQuaternion(pl.quat);
      const F = T4.copy(pl.up).multiplyScalar(pl.pu * C.push).addScaledVector(pl.right, pl.ps2 * C.push);
      const tx = r.y * F.z - r.z * F.y, ty = r.z * F.x - r.x * F.z, tz = r.x * F.y - r.y * F.x;
      Mth = tx * pl.right.x + ty * pl.right.y + tz * pl.right.z;
      Mph = tx * pl.f.x + ty * pl.f.y + tz * pl.f.z;
      Mps = tx * pl.up.x + ty * pl.up.y + tz * pl.up.z;
      acc.addScaledVector(F, C.pushLin / C.mass);
    }
    pl.vel.addScaledVector(acc, dt); pl.pos.addScaledVector(pl.vel, dt);
    const qs = Math.min(2.5, (V / 80) * (V / 80));
    pl.q += (-C.ka * qs * (alpha - C.alphaTrim * D2R) - C.cq * pl.q + Mth / C.Ith) * dt;
    const drift = C.drift * (pl.fire > 0 ? 1 : 0.05) * (pl.wing ? 1 : 2.5);
    pl.p += (-drift - C.kr * pl.ph * (pl.wing ? 1 : 0.2) - C.cp * pl.p + Mph / C.Iph) * dt;
    pl.th = Math.max(-1.2, Math.min(1.2, pl.th + pl.q * dt)); pl.ph += pl.p * dt;
    pl.ps += (-C.kbeta * beta + Mps / C.Ips) * dt;
    if (!isFinite(pl.pos.x + pl.pos.y + pl.pos.z + pl.vel.x + pl.vel.y + pl.vel.z + pl.th + pl.ph)) { pl.nan = true; pl.outcome = { kind: 'breakup', why: 'nan' }; return; }
    planeAxes();
  }
  function planeContacts(g) {
    const C = CFG.plane, pl = plane, WY = g.WATER_Y !== undefined ? g.WATER_Y : -0.6;
    let low = pl.pos.y - 2.0 * Math.abs(Math.cos(pl.ph)), hitB = false, overLand = false;
    for (const k of ['nose', 'left', 'right', 'tail']) {
      if (k === 'left' && !pl.wing) continue;
      hpWorld(k, T3); if (T3.y < low) low = T3.y;
      if (T3.y < 200 && g.blockAt(T3.x, T3.y, T3.z) >= 0) hitB = true;
    }
    if (pl.pos.y < 200 && g.blockAt(pl.pos.x, pl.pos.y, pl.pos.z) >= 0) hitB = true;
    const inBay = pl.pos.z > 240 && pl.pos.z < 1800;
    if (!inBay && low <= 0.3) overLand = true;
    if (hitB || overLand) { pl.outcome = { kind: 'breakup', why: hitB ? 'building' : 'land' }; return; }
    if (inBay && low <= WY) {
      const vs = Math.max(0, -pl.vel.y), roll = Math.abs(((pl.ph / D2R + 540) % 360) - 180);
      pl.vsTouch = vs; pl.rollTouch = roll;
      if (vs < C.vsOK && roll < C.rollOK) pl.outcome = { kind: 'ditch', hurt: 0 };
      else if (vs <= C.vsHard && roll < C.rollHard) pl.outcome = { kind: 'hard', hurt: Math.round(Math.max(0, vs - C.vsOK) * 10 + Math.max(0, roll - C.rollOK) * 2) };
      else pl.outcome = { kind: 'breakup', why: 'water' };
    }
  }
  function finishPlane() {
    const g = G(), C = CFG.plane, pl = plane; if (!pl || pl.ended) return;
    pl.ended = true; const o = pl.outcome; const P = g.P;
    if (pl.attached) { pl.attached = null; P.pos.y = Math.max(P.pos.y, pl.pos.y + 6); P.vel.set(0, 4, 0); }
    const WY = -0.6;
    const res = { type: 'airliner', kind: o.kind, why: o.why || '', vs: +pl.vsTouch.toFixed(2), roll: +pl.rollTouch.toFixed(1), fireOut: pl.fire <= 0, wing: pl.wing, saved: 0, hurt: 0, lost: 0, success: false, nan: pl.nan, age: +pl.age.toFixed(1), pos: [Math.round(pl.pos.x), Math.round(pl.pos.z)] };
    if (o.kind === 'ditch' || o.kind === 'hard') {
      const hurt = Math.min(C.pax, (o.hurt || 0) + (pl.wing ? 0 : C.wingHurt));
      res.hurt = hurt; res.saved = C.pax - hurt; res.success = true;
      pl.phase = 'float'; pl.pos.y = Math.max(pl.pos.y, WY + 1.0);
      splash(g, pl.pos, 160); if (g.addShake) g.addShake(0.6);
      const inc = pl.inc; inc.injuries += hurt; if (hurt) g.hopeHit(Math.min(10, hurt * 0.25));
      g.addSave(res.saved, pl.pos.clone(), 'Airliner passengers safe');
      API.last = res; API.results.push(res);
      g.endIncident(true, o.kind === 'ditch' ? `Set down on the bay at ${pl.vsTouch.toFixed(1)} m/s. All ${res.saved} aboard safe${hurt ? `, ${hurt} hurt` : ''}` : `Hard ditching at ${pl.vsTouch.toFixed(1)} m/s · ${hurt} hurt, ${res.saved} safe`);
    } else {
      res.lost = o.kind === 'timeout' ? 0 : C.pax; pl.inc.lost = res.lost; g.ledger.lost += res.lost;
      if (o.kind === 'breakup') {
        pl.phase = 'sink';
        if (o.why === 'water') splash(g, pl.pos, 220); else { try { g.explode(pl.pos.clone(), 6e7, {}); } catch (e) { /* ignore */ } planeMesh.visible = false; pl.phase = 'gone'; }
      } else { pl.phase = 'gone'; planeMesh.visible = false; }
      API.last = res; API.results.push(res);
      g.endIncident(false, o.kind === 'timeout' ? 'The airliner went down out of reach.' : o.why === 'water' ? `The airliner broke up hitting the water at ${pl.vsTouch.toFixed(0)} m/s.` : 'The airliner crashed into the city.');
    }
    pl.removeT = 45;
  }
  function splash(g, p, n) {
    for (let k = 0; k < n; k++) g.FX.water(p.x + (Math.random() - 0.5) * 30, -0.4, p.z + (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 22, 6 + Math.random() * 26, (Math.random() - 0.5) * 22);
    g.SFX.splash(p); g.SFX.boom(p, 0.8);
  }
  function simPlane(g, dt) {
    const C = CFG.plane, pl = plane, P = g.P;
    if (pl.phase === 'fly') {
      pl.age += dt;
      // pushing input (keys, or the analog test/gamepad override)
      if (pl.attached) {
        const k = g.keys;
        let u = ((k.has('KeyW') || k.has('Space')) ? 1 : 0) - ((k.has('KeyS') || k.has('KeyC')) ? 1 : 0), s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
        if (API_PUSH.on) { u = API_PUSH.u; s = API_PUSH.s; }
        const a = Math.min(1, dt * 4); pl.pu += (u - pl.pu) * a; pl.ps2 += (s - pl.ps2) * a;
      } else { pl.pu = pl.ps2 = 0; }
      planeStep(g, dt);
      if (!pl.outcome) planeContacts(g);
      // engine fire: freeze breath on it, or the wing fails
      if (pl.fire > 0 && pl.wing) {
        hpWorld('engine', T3);
        if (P.freeze) {
          const ad = g.aimDir(T4), mx = P.pos.x, my = P.pos.y + 0.66, mz = P.pos.z;
          const dx = T3.x - mx, dy = T3.y - my, dz = T3.z - mz, d = Math.hypot(dx, dy, dz);
          const range = 45 * (g.PWR ? g.PWR.freeze[(g.POWER || 3) - 1] : 1);
          if (d < range && (dx * ad.x + dy * ad.y + dz * ad.z) / (d || 1) > Math.cos(0.32)) {
            pl.breath += dt; pl.fire = Math.max(0, 1 - pl.breath / C.fireBreath);
            if (Math.random() < 0.5) g.FX.steam(T3.x, T3.y, T3.z);
            if (pl.fire <= 0) { g.toast('Engine fire out!', 'ice'); g.SFX.freezeHit(); API.fireOutAt = pl.age; API.fireBreath = pl.breath; }
          }
        }
        const grow = 1 + Math.min(2, pl.age / 12);
        if (pl.fire > 0) {
          for (let i = 0; i < 2; i++) g.FX.fire(T3.x, T3.y + 0.5, T3.z, 0.8 * grow * pl.fire + 0.3);
          if (pl.age > 12) { hpWorld('wingRoot', T4); g.FX.fire(T4.x, T4.y + 0.4, T4.z, 0.6 * pl.fire); }
        }
        if (pl.age >= C.wingFailT * (window.SM_SETTINGS && SM_SETTINGS.get('qteAssist') ? 1.6 : 1) && pl.fire > 0) breakWing(g); // QTE assist (js/settings.js): 60% longer to put the fire out
      }
      pl.smokeT -= dt;
      if (pl.smokeT <= 0) { pl.smokeT = 0.04; hpWorld(pl.wing ? 'engine' : 'wingRoot', T3); g.FX.smoke(T3.x, T3.y, T3.z, pl.fire > 0 ? 1.4 : 0.8, pl.fire > 0 ? 0.04 : 0.12); }
      if (pl.attached) {
        hpWorld(pl.attached === 'left' && !pl.wing ? 'wingRoot' : pl.attached, T3); T3.addScaledVector(pl.up, -1.25);
        P.flying = true; P.pos.copy(T3); P.vel.copy(pl.vel);
      }
      pl.maxVs = Math.max(pl.maxVs, -pl.vel.y);
    } else if (pl.phase === 'float') {
      // floating: settle level, skid to a stop throwing spray, then people climb onto the wings
      const hs = Math.hypot(pl.vel.x, pl.vel.z), k = Math.exp(-0.9 * dt);
      pl.vel.x *= k; pl.vel.z *= k; pl.vel.y = 0;
      pl.pos.x += pl.vel.x * dt; pl.pos.z += pl.vel.z * dt;
      pl.pos.y += (-0.6 + 1.1 + Math.sin(clock * 0.9) * 0.15 - pl.pos.y) * Math.min(1, dt * 2);
      pl.th *= Math.exp(-1.5 * dt); pl.ph *= Math.exp(-1.2 * dt); planeAxes();
      if (hs > 4 && Math.random() < 0.9) for (let i = 0; i < 3; i++) g.FX.water(pl.pos.x + (Math.random() - 0.5) * 30, -0.4, pl.pos.z + (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 3 + Math.random() * 8 * Math.min(1, hs / 40), (Math.random() - 0.5) * 8);
      if (hs < 3) pl.standers = Math.min(40, pl.standers + dt * 10);
      if (pl.fire > 0) { hpWorld('engine', T3); g.FX.smoke(T3.x, T3.y, T3.z, 1, 0.1); }
    } else if (pl.phase === 'sink') {
      pl.sinkT += dt; pl.pos.y -= dt * 0.8; pl.vel.multiplyScalar(Math.exp(-2 * dt)); pl.pos.addScaledVector(pl.vel, dt);
      if (Math.random() < 0.5) g.FX.smoke(pl.pos.x, Math.max(0, pl.pos.y + 2), pl.pos.z, 2, 0.05);
      if (pl.sinkT > 15) { pl.phase = 'gone'; planeMesh.visible = false; }
      planeAxes();
    }
    // the detached wing tumbles into the bay
    if (pl.fall) {
      const w = pl.fall; w.vel.y -= G0 * dt; w.vel.multiplyScalar(Math.exp(-0.3 * dt)); w.pos.addScaledVector(w.vel, dt);
      TQ.setFromAxisAngle(w.axis, w.spin * dt); w.quat.premultiply(TQ);
      wingL.position.copy(w.pos); wingL.quaternion.copy(w.quat);
      if (!w.splashed && w.pos.y < -0.5) { w.splashed = true; splash(g, w.pos, 50); }
      if (w.pos.y < -12) { wingL.visible = false; pl.fall = null; }
      if (Math.random() < 0.6) g.FX.smoke(w.pos.x, w.pos.y, w.pos.z, 1.2, 0.04);
    }
  }
  function breakWing(g) {
    const pl = plane; if (!pl.wing) return;
    pl.wing = false; pl.fire = 0;
    if (pl.attached === 'left') g.toast('The wing tore away under you!', 'alert');
    planeMesh.updateMatrixWorld();
    wingL.matrixWorld.decompose(T1, TQ, T2);
    planeMesh.remove(wingL); scene.add(wingL); wingL.position.copy(T1); wingL.quaternion.copy(TQ);
    pl.fall = { pos: T1.clone(), vel: pl.vel.clone().add(T2.set(0, 3, 0)).addScaledVector(pl.right, -6), quat: TQ.clone(), axis: pl.f.clone(), spin: 1.5, splashed: false };
    g.toast('The burning wing failed! It\'s rolling. 40 hurt aboard.', 'alert'); if (g.addShake) g.addShake(0.5); g.SFX.crumble(pl.pos); g.SFX.boom(pl.pos, 0.6);
    for (let k = 0; k < 40; k++) g.FX.spark(T1.x, T1.y, T1.z, (Math.random() - 0.5) * 20, Math.random() * 10, (Math.random() - 0.5) * 20);
  }
  function planeKey(g) {
    if (!plane || plane.phase !== 'fly' || plane.ended) return false;
    const P = g.P;
    if (plane.attached) return 'held';
    let best = null, bd = CFG.plane.attachR;
    for (const k of ['nose', 'left', 'right', 'tail']) {
      hpWorld(k === 'left' && !plane.wing ? 'wingRoot' : k, T3); const d = T3.distanceTo(P.pos);
      if (d < bd) { bd = d; best = k; }
    }
    if (!best) return false;
    if (P.hold) { g.toast('Hands full. Set it down first.', ''); return true; }
    attachPlane(g, best); ignoreUp = true; return true;
  }
  const HP_NAME = { nose: 'the nose', left: 'the left wingtip', right: 'the right wingtip', tail: 'the tail' };
  function attachPlane(g, k) {
    plane.attached = k; plane.pu = plane.ps2 = 0;
    g.setYawPitch(plane.ps, -0.1); g.SFX.punch(g.P.pos, 0.5);
    g.toast(`Holding ${HP_NAME[k]}. W/Space push up, S/C down, A/D sideways. Tap E to let go.`, 'good');
  }
  function drawPlane(g) {
    planeMesh.position.copy(plane.pos); planeMesh.quaternion.copy(plane.quat);
    if (plane.phase === 'float' && plane.standers > 0) {
      planeMesh.updateMatrixWorld();
      const n = Math.floor(plane.standers);
      for (let i = 0; i < n && pplN < PCAP; i++) {
        const side = (i % 2) ? 1 : -1; if (side < 0 && !plane.wing) { T1.set((i % 5) * 0.5 - 1, 2.0, -10 + (i % 20)); } else {
          const t = ((i >> 1) % 10) / 10; T1.set(side * (3 + t * 10), -0.55, 0.5 + t * 5 + ((i >> 1) % 3 - 1) * 0.8);
        }
        TQ.identity(); T2.set(1, 1, 1); TM.compose(T1, TQ, T2); TM2.multiplyMatrices(planeMesh.matrixWorld, TM);
        pplMesh.setMatrixAt(pplN++, TM2);
      }
    }
  }

  // ================================================================== HUD: card, meter, hardpoint tags
  const UI = {};
  function buildDOM() {
    const css = document.createElement('style');
    css.textContent = `
#sp-card { position: absolute; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 86px); transform: translateX(-50%); width: min(460px, calc(100% - 40px)); box-sizing: border-box;
  padding: 8px 14px 10px; background: rgba(8, 12, 28, 0.82); border: 1px solid var(--edge, rgba(150,180,255,.2)); border-left: 4px solid var(--sun, #ffc531); border-radius: 6px; pointer-events: none; z-index: 6; }
#sp-card .who { font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sun, #ffc531); }
#sp-card p { margin: 3px 0 0; font-size: 17px; font-weight: 600; line-height: 1.25; }
#sp-card .row { display: flex; gap: 14px; margin-top: 6px; font-family: var(--f-num, monospace); font-size: 13px; color: var(--dim, #9aa9cf); }
#sp-card .row b { color: var(--text, #eef3ff); font-weight: 600; }
#sp-card .bad b { color: #ff6b6b; }
.sp-meter { position: relative; height: 12px; margin-top: 7px; border-radius: 3px; overflow: hidden;
  background: linear-gradient(90deg, rgba(87,227,154,.45) 0 31.25%, rgba(255,197,49,.4) 31.25% 62.5%, rgba(255,107,107,.45) 62.5% 100%); }
.sp-meter i { position: absolute; top: 0; bottom: 0; left: 0; width: 0; background: rgba(255,255,255,.85); }
.sp-meter s { position: absolute; top: -2px; bottom: -2px; left: 31.25%; width: 2px; background: #fff; text-decoration: none; }
.sp-scale { display: flex; justify-content: space-between; font-family: var(--f-num, monospace); font-size: 11px; color: var(--dim, #9aa9cf); }
.sp-tag { position: absolute; transform: translate(-50%, -50%); font: 700 12px var(--f-ui, sans-serif); color: #fff; background: rgba(8,12,28,.75); border: 1px solid rgba(255,197,49,.7);
  border-radius: 10px; padding: 1px 7px; pointer-events: none; white-space: nowrap; z-index: 5; text-shadow: 0 1px 2px #000; }
.sp-tag.near { background: rgba(255,197,49,.9); color: #111; text-shadow: none; }
.sp-tag.fire { border-color: #ff6a2b; color: #ffcf9a; }`;
    document.head.appendChild(css);
    const hud = document.getElementById('hud') || document.body;
    UI.card = document.createElement('div'); UI.card.id = 'sp-card'; UI.card.hidden = true;
    UI.card.innerHTML = '<div class="who"></div><p></p><div class="row"></div><div class="sp-meter"><i></i><s></s></div><div class="sp-scale"><span>0 g</span><span>1 g: hurts standing passengers</span><span>3.2 g</span></div>';
    hud.appendChild(UI.card);
    UI.who = UI.card.querySelector('.who'); UI.p = UI.card.querySelector('p'); UI.row = UI.card.querySelector('.row');
    UI.meter = UI.card.querySelector('.sp-meter'); UI.bar = UI.card.querySelector('.sp-meter i'); UI.scale = UI.card.querySelector('.sp-scale');
    UI.tags = [];
    for (let i = 0; i < 5; i++) { const d = document.createElement('div'); d.className = 'sp-tag'; d.hidden = true; hud.appendChild(d); UI.tags.push(d); }
    UI.t = 0; UI.txt = {};
  }
  function setText(el, key, s) { if (UI.txt[key] !== s) { UI.txt[key] = s; el.innerHTML = s; } }
  function tag(i, pos, text, cls, camera) {
    const d = UI.tags[i]; d.frame = UI.frame; T1.copy(pos).project(camera);
    if (T1.z > 1 || T1.x < -1.1 || T1.x > 1.1 || T1.y < -1.1 || T1.y > 1.1) { if (!d.hidden) d.hidden = true; return; }
    d.hidden = false; d.style.left = ((T1.x * 0.5 + 0.5) * innerWidth).toFixed(0) + 'px'; d.style.top = ((-T1.y * 0.5 + 0.5) * innerHeight).toFixed(0) + 'px';
    if (d.textContent !== text) d.textContent = text; const c = 'sp-tag' + (cls ? ' ' + cls : ''); if (d.className !== c) d.className = c;
  }
  function updateUI(g, camera, dt) {
    if (!UI.card) return;
    const inc = g.currentInc, P = g.P;
    UI.frame = (UI.frame || 0) + 1;
    if (bus && inc && inc === bus.inc && !bus.ended) {
      UI.card.hidden = false; UI.meter.hidden = UI.scale.hidden = false;
      const left = Math.max(0, CFG.bus.stopZ - bus.s), need = bus.v * bus.v / (2 * CFG.bus.softG * G0 - 2 * CFG.bus.slope);
      setText(UI.who, 'w', 'Runaway bus · ' + CFG.bus.aboard + ' aboard');
      setText(UI.p, 'p', bus.attached ? (g.keys.has('KeyE') || held.KeyE ? 'Soft hands: easing it down…' : 'Hold E for a smooth stop. W pushes harder, S eases off.')
        : (Math.abs(P.pos.x - CFG.bus.x) < 3 && P.pos.z > bus.s && P.pos.z < bus.s + 8 ? 'E: brace against the front' : 'Get in front of it with room to stop'));
      UI.t -= dt;
      if (UI.t <= 0) {
        UI.t = 0.1;
        setText(UI.row, 'r', `<span>${(bus.v * 3.6).toFixed(0)} <b>km/h</b></span><span class="${left < need ? 'bad' : ''}"><b>${left.toFixed(0)} m</b> to crosswalk</span><span>stop needs <b>${need.toFixed(0)} m</b></span><span class="${bus.hurt ? 'bad' : ''}"><b>${bus.hurt}</b> hurt</span>`);
        UI.bar.style.width = Math.min(100, bus.gS / 3.2 * 100).toFixed(1) + '%';
        UI.bar.style.background = bus.gS > standingG() ? '#ff6b6b' : '#fff';
      }
      if (!bus.attached && bus.phase === 'run') { T2.set(CFG.bus.x, 2, bus.s + 0.4); tag(0, T2, 'E · brace here', T2.distanceTo(P.pos) < 6 ? 'near' : '', camera); }
    } else if (plane && inc && inc === plane.inc && !plane.ended) {
      UI.card.hidden = false; UI.meter.hidden = UI.scale.hidden = true;
      setText(UI.who, 'w', 'Falling airliner · ' + CFG.plane.pax + ' aboard');
      setText(UI.p, 'p', plane.fire > 0 ? `Engine fire! Freeze it (Q) · wing fails in ${Math.max(0, CFG.plane.wingFailT * (window.SM_SETTINGS && SM_SETTINGS.get('qteAssist') ? 1.6 : 1) - plane.age).toFixed(0)} s` :
        plane.attached ? `Holding ${HP_NAME[plane.attached]}: nose up to bleed speed, level the wings, touch the water gently` : 'Grab a push point (E): nose, wingtips or tail');
      UI.t -= dt;
      if (UI.t <= 0) {
        UI.t = 0.1;
        const vs = -plane.vel.y, roll = plane.ph / D2R;
        setText(UI.row, 'r', `<span>alt <b>${Math.max(0, plane.pos.y).toFixed(0)} m</b></span><span class="${vs >= CFG.plane.vsOK ? 'bad' : ''}">v/s <b>${vs.toFixed(1)}</b> (&lt;6)</span><span class="${Math.abs(roll) >= CFG.plane.rollOK ? 'bad' : ''}">roll <b>${roll.toFixed(0)}°</b> (&lt;15)</span><span>pitch <b>${(plane.th / D2R).toFixed(0)}°</b></span>${plane.fire > 0 ? `<span class="bad">fire <b>${Math.round(plane.fire * 100)}%</b></span>` : ''}`);
      }
      if (!plane.attached && plane.pos.distanceTo(P.pos) < 220) {
        let i = 0;
        for (const k of ['nose', 'left', 'right', 'tail']) {
          if (k === 'left' && !plane.wing) continue;
          hpWorld(k, T2); tag(i++, T2, 'E · ' + k, T2.distanceTo(P.pos) < CFG.plane.attachR ? 'near' : '', camera);
        }
      }
      if (plane.fire > 0 && plane.pos.distanceTo(P.pos) < 300) { hpWorld('engine', T2); tag(4, T2, 'Q · fire', 'fire', camera); }
    } else if (!UI.card.hidden) UI.card.hidden = true;
    for (const d of UI.tags) if (d.frame !== UI.frame && !d.hidden) d.hidden = true;
  }

  // ================================================================== input
  function keyAllowed() {
    const g = G(); if (!g || !g.started || (g.MAP && g.MAP.open)) return false;
    const pz = document.getElementById('paused'); return !pz || pz.hidden;
  }
  function attachedAny() { return (bus && bus.attached) || (plane && plane.attached); }
  function detach(g) {
    if (bus && bus.attached) { bus.attached = false; g.toast('You let go of the bus.', ''); }
    if (plane && plane.attached) { plane.attached = null; g.toast('You let go of the airliner.', ''); }
  }
  function handleKey(code, down) {
    if (code !== 'KeyE') return false;
    const g = G();
    if (!down) {
      held.KeyE = false;
      if (ignoreUp) { ignoreUp = false; return attachedAny() ? true : false; }
      if (attachedAny() && clock - eDownAt < 0.25) { detach(g); return true; }
      return !!attachedAny();
    }
    held.KeyE = true; eDownAt = clock;
    if (!keyAllowed()) return false;
    if (attachedAny()) return true;   // a hold (soft hands) or the start of a tap-to-release
    return !!(busKey(g) || planeKey(g));
  }
  addEventListener('keydown', e => {
    if (e.code !== 'KeyE') return;
    if (e.repeat) { if (attachedAny()) { e.preventDefault(); e.stopImmediatePropagation(); } return; }
    if (handleKey('KeyE', true)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  addEventListener('keyup', e => { if (e.code === 'KeyE' && handleKey('KeyE', false)) e.stopImmediatePropagation(); }, true);
  addEventListener('blur', () => { held.KeyE = false; });

  // ================================================================== plugin
  function firstRun(g) {
    ready = true; if (!g) return;
    if (g.PIN_COL) g.PIN_COL.sp = '#ff9a3c';
    if (g.BEACON_COL) g.BEACON_COL.sp = new THREE.Color(2.8, 1.1, 0.3);
    if (g.mapPinHooks) g.mapPinHooks.push(pins => {
      const inc = g.currentInc;
      if (bus && inc && inc === bus.inc && !bus.ended) pins.push([CFG.bus.x, CFG.bus.stopZ + 4, 'sp', 'Crosswalk']);
      if (plane && inc && inc === plane.inc && !plane.ended && plane.fire > 0) { hpWorld('engine', T3); pins.push([T3.x + 30, T3.z, 'sp', 'Engine fire']); }
    });
    if (!g.setpieces) g.setpieces = API;
  }
  function update(wdt, camera) {
    const g = G(); if (!g) return;
    if (!ready) firstRun(g);
    const dt = Math.min(0.1, wdt); clock += dt;
    pplN = 0;
    if (bus) {
      if (!bus.ended || bus.phase !== 'gone') simBus(g, dt);
      if (bus.removeT >= 0) { bus.removeT -= dt; if (bus.removeT <= 0) { busMesh.visible = false; bus = null; } }
      if (bus) drawBus(g, dt);
    }
    if (plane) {
      simPlane(g, dt);
      if (plane.removeT >= 0) { plane.removeT -= dt; if (plane.removeT <= 0) { planeMesh.visible = false; if (wingL) wingL.visible = false; plane = null; } }
      if (plane && planeMesh.visible) drawPlane(g);
    }
    if (pplMesh) { pplMesh.count = pplN; if (pplN) pplMesh.instanceMatrix.needsUpdate = true; }
    if (g.started) updateUI(g, camera, dt);
  }

  // ================================================================== registry + test / demo API
  window.SM_INCIDENTS = window.SM_INCIDENTS || {};
  window.SM_INCIDENTS.bus = { start: busStart, want: (n, t) => t >= CFG.rotation.busAfter && n % CFG.rotation.every === 5 };
  window.SM_INCIDENTS.airliner = { start: planeStart, want: (n, t) => t >= CFG.rotation.planeAfter && n % CFG.rotation.every === 0 };

  const API = {
    cfg: CFG, results: [], last: null, fireOutAt: null, fireBreath: null,
    start(type) { const g = G(); g.startIncident(type === 'plane' ? 'airliner' : type); const inc = g.currentInc; return !!(inc && (inc.type === type || (type === 'plane' && inc.type === 'airliner'))); },
    press(code) { const used = handleKey(code, true); if (!used && code === 'KeyE' && keyAllowed()) G().grabOrRelease(); return used; },
    release(code) { return handleKey(code, false); },
    tapRelease() { const g = G(); detach(g); },
    push(u, s) { if (u === null || u === undefined) { API_PUSH.on = false; return; } API_PUSH.on = true; API_PUSH.u = Math.max(-1, Math.min(1, u)); API_PUSH.s = Math.max(-1, Math.min(1, s || 0)); },
    attach(k) { const g = G(); if (k === 'bus') return attachBus(g); if (!plane || plane.phase !== 'fly') return false; attachPlane(g, k); return true; },
    hardpoint(k, o) { if (!plane) return null; return hpWorld(k, o || new V3()); },
    get bus() { return bus ? { s: bus.s, v: bus.v, g: bus.gS, maxG: bus.maxG, hurt: bus.hurt, attached: bus.attached, push: bus.push, phase: bus.phase, insideBlock: bus.insideBlock, nan: bus.nan } : null; },
    get plane() { return plane ? { pos: plane.pos.clone(), vel: plane.vel.clone(), vs: -plane.vel.y, roll: plane.ph / D2R, rollRate: plane.p, pitch: plane.th / D2R, pitchRate: plane.q, alpha: plane.alpha / D2R, heading: plane.ps,
      fire: plane.fire, breath: plane.breath, wing: plane.wing, phase: plane.phase, attached: plane.attached, age: plane.age, standers: Math.floor(plane.standers), nan: plane.nan } : null; },
    get people() { return pplMesh ? pplMesh.count : 0; }
  };
  window.SM_SETPIECES = API;

  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function setpieces(c) {
    THREE = c.THREE; V3 = THREE.Vector3; scene = c.scene;
    T1 = new V3(); T2 = new V3(); T3 = new V3(); T4 = new V3();
    TM = new THREE.Matrix4(); TM2 = new THREE.Matrix4(); TQ = new THREE.Quaternion(); TE = new THREE.Euler();
    makePeople();
    buildDOM();
    return { update };
  });
})();
