/* A living city that reacts to Superman (js/citymood.js). Dream features #7, #8, #10 (and a little of #31).
 *
 *   1. Arrival and the wave (#7): when he flies low over a street (under 40 m, within 60 m), pedestrians stop,
 *      tilt their heads up to follow him, point, wave or raise a phone. The reaction ripples outward from his
 *      ground track at walking speed (people right under him react at once; the rest as word spreads), and
 *      traffic slows. Arriving at an emergency does the same for up to 40 people around him.
 *      T (remappable in Settings as "Wave to the crowd"; D-pad left on a gamepad) raises his arm: nearby
 *      citizens cheer back. +1 Hope, at most +3 in any 60 s.
 *   2. Hope-driven mood (#8), bands 0-30 / 30-55 / 55-80 / 80-100:
 *      low  - half the pedestrians stay indoors, people back away from him or flee a fly-over, police tape
 *             cordons the block around damage and incidents, more crime requests (missions.js scheduler);
 *      mid  - normal;
 *      high - more people out (+40, a third of them kids), more waving and photos, friendly honks, the street
 *             cheers when he lands, and "Metropolis loves Superman" banners unroll from the rooftops
 *             (ONE instanced quad mesh, visible at Hope 80+).
 *   3. Be the shield (#10): robbers sometimes turn their guns on a cowering witness. Stand in the line of fire
 *      and the slugs spark and ricochet off him; ricochets never hurt a bystander. +1 Hope per shielded shot
 *      (at most +3 per robbery). Small additive hooks in game.js: HOOKS.aim / HOOKS.shot / HOOKS.bullet.
 *   4. Panic and evacuation: fires, collapses, the meteor, the falling chopper, Metallo and the set pieces push
 *      pedestrians to run along the sidewalks (the lot grid) away from the danger. About 1 in 8 close by
 *      freezes in shock (cowering, marked at risk): carry them out. They calm down and walk home afterwards.
 *      Driving cars within 90 m pull over to the curb and stop until it's over.
 *
 * Contract: a window.SM_PLUGINS entry; its update runs inside the sim after game.js and missions.js have
 * posed the pedestrians, so the custom poses written here (head tilt, pointing, waving, phones, cowering)
 * win. Test / debug API: window.SM_CITYMOOD (= __game.citymood).
 * Performance: 10 Hz decision tick over the ~170 pedestrians, per-frame work only for the people being
 * posed and the cars pulled over; scratch objects only (no per-frame allocations). Draw calls: banners 1 and
 * police tape 1, each only while shown.
 */
(function () {
  'use strict';

  // ================================================================== tuning
  const CFG = {
    tick: 0.1,                       // s between decision ticks
    bands: [30, 55, 80],             // Hope band edges: 0-30 low, 30-55, 55-80, 80-100 high
    // reaction weights per band: [flee, gather (look / point / wave), photograph] (design: dream feature #8)
    weights: [[0.6, 0.1, 0.3], [0.2, 0.5, 0.3], [0.1, 0.55, 0.35], [0.05, 0.6, 0.35]],
    look: {
      maxH: 40, radius: 60,          // a low pass: under 40 m above the street, people within 60 m
      instant: 20,                   // m: right under him, people react at once...
      ripple: 1.5,                   // ...beyond that the reaction spreads at walking speed (m/s)
      dur: [3.5, 6.5],               // s a reaction lasts
      cool: 16,                      // s before the same person reacts again
      cancel: 110,                   // m: if he's gone this far before word reaches them, they missed him
      maxActive: 60,
      passEvery: 5,                  // s between traffic / horn effects of a pass
      carSlow: 45, carSlowT: 4       // cars within 45 m slow to a crawl for 4 s
    },
    arrival: { radius: 60, speed: 20, crowd: 80, max: 40 },
    wave: { dur: 1.3, radius: 40, maxH: 45, cap: 3, window: 60 },
    crowd: { extra: 40, kidShare: 0.35, visible: [0.5, 1, 1, 1], extraShare: [0, 0, 0.5, 1], perTick: 4, every: 0.25, hideDist: 90 },
    keepAway: { radius: 10, maxH: 3, p: 0.6 },
    land: { radius: 22 },
    crime: { every: [40, 70] },
    evac: {
      r: { fire: 70, meteor: 85, heli: 50, collapse: 60, metallo: 75, bus: 30, airliner: 0, plane: 0, robbery: 0 }, def: 55,
      margin: 15, freeze: 0.12, freezeR: 40, freezeMax: 3, calm: 6, frozenCalm: 3, retMax: 60, collapseT: 20, carR: 90, every: 0.5
    },
    shield: { civR: 1.5, r: 1.0, civChance: 0.4, hopeCap: 3, engage: 100 },
    banners: { max: 36, w: 9, h: 2.4, on: 80, off: 76, minH: 16, maxH: 120 },
    tape: { maxLots: 4, seg: 7, keep: 180 }
  };

  // ================================================================== module state
  let THREE = null, C = null, ctx = null, ready = false, clock = 0, tickAcc = 0, crowdAcc = 0, scanAcc = 0, dangerAcc = 0, tapeAcc = 0, bannerAcc = 0;
  let V3, T1, T2, TP, TS, TQ, TQ2, TM, TL, TR, TX, BASE, UPV, ZAX, XAX;
  const stats = { lookUps: 0, react: { look: 0, point: 0, wave: 0, photo: 0, flee: 0 }, passes: 0, arrivals: 0, carsSlowed: 0, carsPulled: 0,
    honks: 0, waves: 0, waveCheers: 0, waveHope: 0, landCheers: 0, avoid: 0, fled: 0, frozen: 0, calmed: 0, returned: 0, carried: 0,
    civShots: 0, civAims: 0, deflected: 0, shielded: 0, shieldHope: 0, hidden: 0, shown: 0, extras: 0, crimes: 0 };
  const pool = [];          // ambient pedestrians this module manages (the street crowd, plus extras at high Hope)
  const reactors = [];      // people currently posed by a look-up reaction
  const pending = [];       // people the ripple hasn't reached yet
  const frozen = [];        // frozen in shock
  const witnesses = [];     // cowering bystanders at the current robbery
  const myKids = [];        // kid-sized extras (missions.js lowers only its own kids)
  const cmCars = [];        // cars slowed or pulled over
  const waveHope = [];      // clock times of wave-back Hope grants (rolling 60 s window)
  let extras = 0, base0 = 0, walkLots = null;
  // danger sources: slot 0 the current emergency, 1 Metallo, 2.. recent collapses
  const D = []; for (let i = 0; i < 8; i++) D.push({ on: false, x: 0, z: 0, r: 0, kind: '', until: 0, frozen: 0 });
  let nd = -1, ndD = 0;     // nearestDanger() results
  const S = { waveT: 0, passT: -99, arrInc: null, robInc: null, shieldInc: null, shieldHope: 0, pendCiv: null, seenEv: null, crimeT: 0,
    hintCiv: false, shieldToastT: -99, waveToastT: -99, tapeBarkT: -99, incOk: false, incX: 0, incY: 0, incZ: 0, incKind: '', padPrev: false,
    collapseSlot: 2, lastBand: 1, landT: -99, forceCiv: 0 };
  const G = () => window.__game;
  const R = (a, b) => a + Math.random() * (b - a);
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const hd2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
  function band(h) { const B = CFG.bands; return h < B[0] ? 0 : h < B[1] ? 1 : h < B[2] ? 2 : 3; }
  function curBand() { const g = G(); return g ? band(g.ledger.hope) : 1; }
  const M = () => { const g = G(); return (g && g.missions) || window.SM_MISSIONS || null; };

  // ================================================================== who this module may steer
  // ambient, walking, not part of a mission, a set piece's scripted crowd (they walk at spd < 0.5), Metallo's hostages or a robbery
  function ambient(p) { return p.mode === 'free' && !p.thug && !p.msnRole && !p.mCrowd && !p.cmWit && !p.cmFrozen && p.spd >= 0.5; }
  const missionKid = p => p.kid && !p.cmKidMine;

  // run along the sidewalks: lots are 40 m squares on a 60 m pitch, with a sidewalk ring inside each edge.
  // On an east-west sidewalk only x is open, on a north-south one only z; at a corner (or in the road) pick the
  // axis that gets them furthest along (ax, az).
  function sidewalkDir(p, ax, az) {
    const u = ((p.pos.x + C.HALF - 10) % C.PITCH + C.PITCH) % C.PITCH, v = ((p.pos.z + C.HALF - 10) % C.PITCH + C.PITCH) % C.PITCH;
    const zWalk = u < 3.5 || u > 36.5, xWalk = v < 3.5 || v > 36.5;
    const useX = zWalk === xWalk ? Math.abs(ax) >= Math.abs(az) : xWalk;
    if (useX) p.dir.set(ax >= 0 ? 1 : -1, 0, 0); else p.dir.set(0, 0, az >= 0 ? 1 : -1);
  }

  // ================================================================== poses (written straight into the instanced people)
  // matches game.js placePart(): local +X forward, limbs swing about Z; the head pivots at the neck
  function part(mesh, slot, px, py, pz, az, ax) {
    TL.makeTranslation(px, py, pz); if (az) TL.multiply(TR.makeRotationZ(az)); if (ax) TL.multiply(TR.makeRotationX(ax));
    TM.multiplyMatrices(BASE, TL); mesh.setMatrixAt(slot, TM);
  }
  function head(mesh, slot, tilt) {
    TL.makeTranslation(0, 0.6, 0); if (tilt) TL.multiply(TR.makeRotationZ(tilt)); TL.multiply(TX.makeTranslation(0, -0.6, 0));
    TM.multiplyMatrices(BASE, TL); mesh.setMatrixAt(slot, TM);
  }
  function pose(g, p, kind, t) {
    const PPL = g.PPL, P = g.P.pos;
    const hx = P.x - p.pos.x, hz = P.z - p.pos.z, hd = Math.sqrt(hx * hx + hz * hz);
    const elev = Math.atan2(P.y - (p.pos.y + 0.7), Math.max(hd, 0.5));
    let tilt = clamp(elev, -0.2, 0.8), aL = 0.08, aR = 0.08, xL = 0, xR = 0, legA = 0;
    TQ.setFromAxisAngle(UPV, -p.face); TP.copy(p.pos);
    switch (kind) {
      case 'look': aL = 0.12; aR = 0.12; if (elev > 0.5) TQ.multiply(TQ2.setFromAxisAngle(ZAX, 0.08)); break;   // lean back a touch
      case 'point': aR = Math.PI / 2 + clamp(elev, 0, 1.3); aL = 0.15; break;
      case 'wave': aR = Math.PI * 0.86; xR = -0.15 + Math.sin(t * 9 + p.slot) * 0.38; aL = 0.12; TP.y += Math.abs(Math.sin(t * 4.5)) * 0.03; break;
      case 'photo': aL = aR = Math.PI / 2 + clamp(elev, 0, 1.2) * 0.75 - 0.15; xL = 0.35; xR = -0.35; break;
      case 'cower': aL = aR = 2.35 + Math.sin(t * 8 + p.slot) * 0.08; xL = 0.25; xR = -0.25; tilt = -0.35; TP.y -= 0.14; legA = 0.25; break;
      default: break;
    }
    if (p.kid) TP.y -= 0.9 * (1 - (p.hs || 1));
    TM.compose(TP, TQ, TS.set(p.ws || 1, p.hs || 1, p.ws || 1)); BASE.copy(TM);
    const s = p.slot;
    part(PPL.torso, s, 0, 0, 0, 0, 0); part(PPL.hips, s, 0, 0, 0, 0, 0);
    head(PPL.head, s, tilt); head(PPL.hair, s, tilt);
    part(PPL.legL, s, 0, -0.06, -0.095, legA, 0); part(PPL.legR, s, 0, -0.06, 0.095, legA * 0.4, 0);
    part(PPL.armL, s, 0, 0.5, -0.235, aL, xL); part(PPL.armR, s, 0, 0.5, 0.235, aR, xR);
  }
  function posePass(g) {
    const PPL = g.PPL; if (!PPL) return;
    let dirty = false;
    for (let i = reactors.length - 1; i >= 0; i--) {
      const p = reactors[i];
      if (p.mode !== 'cheer' || !p.cmR || p.cheerT <= 0) { p.cmR = null; reactors.splice(i, 1); continue; }
      pose(g, p, p.cmR, clock); dirty = true;
    }
    for (const p of frozen) if (p.mode === 'free') { pose(g, p, 'cower', clock); dirty = true; }
    for (const p of witnesses) if (p.mode === 'free' && p.cmWit) { pose(g, p, 'cower', clock); dirty = true; }
    // kid-sized extras: lower the scaled body onto the pavement (missions.js does this for its own kids)
    for (const k of myKids) {
      if ((k.mode !== 'free' && k.mode !== 'cheer') || k.cmR) continue;
      const off = 0.9 * (1 - k.hs), i = k.slot * 16 + 13;
      for (const name in PPL) PPL[name].instanceMatrix.array[i] -= off;
      dirty = true;
    }
    if (dirty) for (const name in PPL) PPL[name].instanceMatrix.needsUpdate = true;
  }

  // ================================================================== reactions to a low pass / an arrival
  function react(g, p, kind) {
    p.cmCool = clock + CFG.look.cool;
    stats.react[kind]++;
    if (kind === 'flee') {
      p.fleeT = R(2, 3.5); sidewalkDir(p, p.pos.x - g.P.pos.x, p.pos.z - g.P.pos.z); return;
    }
    stats.lookUps++;
    p.mode = 'cheer'; p.cheerT = R(CFG.look.dur[0], CFG.look.dur[1]); p.photoT = kind === 'photo' ? R(0.2, 1.2) : 99;
    p.cmR = kind; if (!reactors.includes(p)) reactors.push(p);
    if (kind === 'photo' && Math.random() < 0.3) { const m = M(); if (m && m.say) m.say(p, 'photo'); }
  }
  function chooseReaction(g, p) {
    const b = curBand(), w = CFG.weights[b], r = Math.random();
    if (p.kid) return b === 0 ? 'look' : 'wave';
    if (r < w[0]) return 'flee';
    if (r < w[0] + w[1]) { const q = Math.random(); return b >= 2 ? (q < 0.45 ? 'wave' : q < 0.75 ? 'point' : 'look') : (q < 0.45 ? 'look' : q < 0.8 ? 'point' : 'wave'); }
    return 'photo';
  }
  // queue everyone in range: delay = distance beyond the "instant" ring / walking speed
  function ripple(g, cx, cz, radius, instant, max) {
    const r2 = radius * radius; let n = reactors.length + pending.length;
    for (const p of g.people) {
      if (n >= max) break;
      if (!ambient(p) || p.cmHidden || p.cmPendOn || p.cmR || p.fleeT > 0 || p.cmFlee || (p.cmCool || 0) > clock) continue;
      const d2 = hd2(p.pos.x, p.pos.z, cx, cz); if (d2 > r2) continue;
      p.cmPend = Math.max(0, Math.sqrt(d2) - instant) / CFG.look.ripple + R(0, 0.35); p.cmPendOn = true; pending.push(p); n++;
    }
  }
  function tickPending(g, td) {
    const P = g.P.pos;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]; p.cmPend -= td;
      if (!ambient(p) || p.cmHidden || p.fleeT > 0 || p.cmFlee) { p.cmPendOn = false; pending.splice(i, 1); continue; }
      if (p.cmPend > 0) continue;
      p.cmPendOn = false; pending.splice(i, 1);
      if (hd2(p.pos.x, p.pos.z, P.x, P.z) > CFG.look.cancel * CFG.look.cancel || P.y - p.pos.y > 90) continue;   // missed him
      react(g, p, chooseReaction(g, p));
    }
  }
  function scanPass(g) {
    const P = g.P, L = CFG.look, gy = Math.max(0, g.groundY(P.pos.x, P.pos.z)), h = P.pos.y - gy;
    if (P.flying && h > 1.5 && h < L.maxH) {
      ripple(g, P.pos.x, P.pos.z, L.radius, L.instant, L.maxActive);
      if (clock > S.passT) {
        S.passT = clock + L.passEvery; stats.passes++;
        slowCars(g, P.pos.x, P.pos.z, L.carSlow, L.carSlowT);
        const b = curBand();
        if (b === 3 || (b === 2 && Math.random() < 0.5)) honk(g, true);
        else if (b === 0 && Math.random() < 0.6) honk(g, false);
      }
    }
    // arriving at an emergency: the crowd around him turns to look (once per emergency)
    const inc = g.currentInc;
    if (inc && inc !== S.arrInc && S.incOk && P.vel.length() < CFG.arrival.speed &&
        (P.pos.x - S.incX) ** 2 + (P.pos.y - S.incY) ** 2 + (P.pos.z - S.incZ) ** 2 < CFG.arrival.radius * CFG.arrival.radius) {
      S.arrInc = inc; stats.arrivals++;
      ripple(g, P.pos.x, P.pos.z, CFG.arrival.crowd, 25, CFG.arrival.max);
      if (window.SM_AUDIO && SM_AUDIO.stinger) { try { SM_AUDIO.stinger('takeoff'); } catch (_) { /* optional */ } }
      const m = M(); if (m && m.bark) m.bark(curBand() === 0 ? 'landLow' : 'flyHigh');
    }
  }

  // ================================================================== traffic: slow for a pass, pull over for emergencies, horns
  function carState(c) {
    if (!c.cmS) c.cmS = { on: false, tgt0: 0, lane0: 0, side: 0, slowT: 0, pull: false };
    const s = c.cmS;
    if (!s.on) {
      s.on = true; s.tgt0 = c.drive.target; s.lane0 = c.drive.lane; s.slowT = 0; s.pull = false;
      const rc = Math.round((s.lane0 + C.HALF) / C.PITCH) * C.PITCH - C.HALF; s.side = Math.sign(s.lane0 - rc) || 1;
      cmCars.push(c);
    }
    return s;
  }
  function slowCars(g, x, z, r, t) {
    for (const c of g.cars) {
      if (c.dead || !c.drive || c.held || c.parked) continue;
      if (hd2(c.pos.x, c.pos.z, x, z) > r * r) continue;
      const s = carState(c); if (s.slowT <= 0) stats.carsSlowed++; s.slowT = t;
    }
  }
  function pullCars(g) {
    for (const c of cmCars) if (c.cmS) c.cmS.pull = false;
    for (const c of g.cars) {
      if (c.dead || !c.drive || c.held || c.parked) continue;
      for (const d of D) {
        if (!d.on || d.r <= 0) continue;
        if (hd2(c.pos.x, c.pos.z, d.x, d.z) > CFG.evac.carR * CFG.evac.carR) continue;
        const s = carState(c); if (!s.pull) { s.pull = true; if (!s.pulledOnce) { s.pulledOnce = true; stats.carsPulled++; } } break;
      }
    }
  }
  function carsFrame(dt) {
    for (let i = cmCars.length - 1; i >= 0; i--) {
      const c = cmCars[i], s = c.cmS, d = c.drive;
      if (!d || c.dead || c.held) { s.on = false; s.pulledOnce = false; cmCars.splice(i, 1); continue; }
      const want = s.pull ? s.lane0 + s.side * 2.2 : s.lane0;
      d.lane += clamp(want - d.lane, -1.6 * dt, 1.6 * dt);
      s.slowT -= dt;
      d.target = s.pull ? 0 : s.slowT > 0 ? s.tgt0 * 0.3 : s.tgt0;
      if (!s.pull && s.slowT <= 0 && Math.abs(d.lane - s.lane0) < 0.02) { d.lane = s.lane0; d.target = s.tgt0; s.on = false; s.pulledOnce = false; cmCars.splice(i, 1); }
    }
  }
  // two-tone car horn (friendly: two short toots; grumpy: one long blast) from the nearest moving car
  function honk(g, friendly) {
    const AU = g.AU; if (!AU || !AU.ctx || AU.muted || !AU.master || AU.ctx.state === 'closed') return;
    let best = null, bd = 60 * 60;
    for (const c of g.cars) { if (c.dead || c.parked) continue; const d = hd2(c.pos.x, c.pos.z, g.P.pos.x, g.P.pos.z); if (d < bd) { bd = d; best = c; } }
    if (!best) return;
    stats.honks++;
    try {
      const ac = AU.ctx, t0 = ac.currentTime + R(0.15, 0.5), cam = g.camera.position;
      const dist = Math.sqrt((best.pos.x - cam.x) ** 2 + (best.pos.y - cam.y) ** 2 + (best.pos.z - cam.z) ** 2);
      const vol = 0.06 / (1 + dist / 25);
      const f = friendly ? [415, 523] : [311, 370], beeps = friendly ? [[0, 0.11], [0.17, 0.16]] : [[0, 0.65]];
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
      const gn = ac.createGain(); gn.gain.setValueAtTime(0, t0); lp.connect(gn); gn.connect(AU.master);
      for (const fr of f) { const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = fr; o.connect(lp); o.start(t0); o.stop(t0 + 0.9); }
      for (const b of beeps) { gn.gain.setValueAtTime(0, t0 + b[0]); gn.gain.linearRampToValueAtTime(vol, t0 + b[0] + 0.015); gn.gain.setValueAtTime(vol, t0 + b[0] + b[1]); gn.gain.linearRampToValueAtTime(0, t0 + b[0] + b[1] + 0.03); }
    } catch (_) { /* audio is optional */ }
  }

  // ================================================================== danger sources and evacuation
  function incRadius(kind) { const r = CFG.evac.r[kind]; return r !== undefined ? r : CFG.evac.def; }
  function updateDangers(g) {
    const inc = g.currentInc, d0 = D[0];
    S.incOk = false;
    if (inc && inc.marker) {
      let m = null; try { m = inc.marker(); } catch (_) { m = null; }
      if (m) { S.incOk = true; S.incX = m.x; S.incY = m.y; S.incZ = m.z; S.incKind = inc.type; }
    }
    const r = inc ? incRadius(inc.type) : 0;
    if (S.incOk && r > 0 && S.incY < 220 && S.incZ < C.WATER_Z) {
      if (!d0.on || d0.kind !== inc.type) d0.frozen = 0;
      d0.on = true; d0.x = S.incX; d0.z = S.incZ; d0.r = r; d0.kind = inc.type;
    } else d0.on = false;
    // Metallo (he runs as his own encounter)
    const mt = g.metallo, d1 = D[1];
    const ms = mt && mt.state;
    if (ms && ms.active && !ms.down && ms.pos) { if (!d1.on) d1.frozen = 0; d1.on = true; d1.x = ms.pos.x; d1.z = ms.pos.z; d1.r = CFG.evac.r.metallo; d1.kind = 'metallo'; }
    else d1.on = false;
    for (let i = 2; i < D.length; i++) if (D[i].on && clock > D[i].until) D[i].on = false;
  }
  function addCollapse(x, z) {
    for (let i = 2; i < D.length; i++) if (D[i].on && hd2(D[i].x, D[i].z, x, z) < 400) { D[i].until = clock + CFG.evac.collapseT; return; }
    const d = D[S.collapseSlot]; S.collapseSlot = S.collapseSlot + 1 >= D.length ? 2 : S.collapseSlot + 1;
    d.on = true; d.x = x; d.z = z; d.r = CFG.evac.r.collapse; d.kind = 'collapse'; d.until = clock + CFG.evac.collapseT; d.frozen = 0;
    tapeSites.push({ x, z, t: clock }); if (tapeSites.length > 8) tapeSites.shift();
  }
  function nearestDanger(x, z) {
    nd = -1; ndD = 1e9;
    for (let i = 0; i < D.length; i++) {
      const d = D[i]; if (!d.on || d.r <= 0) continue;
      const dd = Math.sqrt(hd2(x, z, d.x, d.z)) - d.r;           // distance relative to that source's radius
      if (dd < ndD) { ndD = dd; nd = i; }
    }
    return nd;                                                      // ndD < 0: inside the zone
  }
  function freeze(g, p, d) {
    p.cmFrozen = true; p.cmSpd0 = p.spd; p.spd = 0; p.fleeT = 0; p.cmCalmT = 0; p.danger = true;
    p.face = Math.atan2(d.z - p.pos.z, d.x - p.pos.x); d.frozen++; stats.frozen++;
    frozen.push(p);
    const m = M(); if (m && m.say && Math.random() < 0.5) m.say(p, 'plead', { prio: true, text: Math.random() < 0.5 ? "I can't move... I can't move!" : 'Somebody help me!' });
  }
  function unfreeze(p, calm) {
    p.cmFrozen = false; if (p.cmSpd0) p.spd = p.cmSpd0; p.cmSpd0 = 0;
    if (calm) { p.danger = false; stats.calmed++; } else stats.carried++;
    const i = frozen.indexOf(p); if (i >= 0) frozen.splice(i, 1);
  }
  function evacTick(g, td) {
    const E = CFG.evac;
    for (let i = frozen.length - 1; i >= 0; i--) {
      const p = frozen[i];
      if (p.mode !== 'free') { unfreeze(p, false); continue; }                 // carried off (or knocked down)
      p.fleeT = 0;
      if (nearestDanger(p.pos.x, p.pos.z) < 0 || ndD > 0) { p.cmCalmT += td; if (p.cmCalmT > E.frozenCalm) unfreeze(p, true); }
      else p.cmCalmT = 0;
    }
    let anyOn = false; for (const d of D) if (d.on && d.r > 0) { anyOn = true; break; }
    for (const p of pool) {
      if (p.cmHidden || p.cmFrozen) continue;
      if (!anyOn && !p.cmFlee && !p.cmRet) continue;
      // someone stopped to look up or cheer drops it and runs when the danger is on top of them
      if (p.mode === 'cheer' && anyOn && !p.msnRole && !p.thug && nearestDanger(p.pos.x, p.pos.z) >= 0 && ndD < 0) { p.mode = 'free'; p.cheerT = 0; p.cmR = null; }
      if (p.mode !== 'free' || p.msnRole) { if (p.cmFlee || p.cmRet) { p.cmFlee = false; p.cmRet = false; } continue; }
      const k = anyOn ? nearestDanger(p.pos.x, p.pos.z) : -1;
      if (k >= 0 && ndD < 0) {
        const d = D[k];
        if (!p.cmFlee) {
          p.cmFlee = true; p.cmRet = false; p.cmHx = p.pos.x; p.cmHz = p.pos.z; p.cmDirT = 0; stats.fled++;
          if (p.cmPendOn) { p.cmPendOn = false; const j = pending.indexOf(p); if (j >= 0) pending.splice(j, 1); }
          if (!p.kid && ndD < E.freezeR - d.r && d.frozen < E.freezeMax && Math.random() < E.freeze) { freeze(g, p, d); continue; }
        }
        p.fleeT = Math.max(p.fleeT, 1.5); p.cmCalmT = 0;
        p.cmDirT -= td; if (p.cmDirT <= 0) { p.cmDirT = 0.5; sidewalkDir(p, p.pos.x - d.x, p.pos.z - d.z); }
      } else if (p.cmFlee) {
        if (k >= 0 && ndD < E.margin) { p.fleeT = Math.max(p.fleeT, 1); p.cmCalmT = 0; }   // clear the zone first
        else {
          p.cmCalmT = (p.cmCalmT || 0) + td;
          if (p.cmCalmT > E.calm && (nearestDanger(p.cmHx, p.cmHz) < 0 || ndD > 0)) { p.cmFlee = false; p.cmRet = true; p.cmRetT = 0; p.cmDirT = 0; stats.calmed++; }
        }
      } else if (p.cmRet) {
        p.cmRetT += td;
        if (k >= 0 && ndD < 0) { p.cmRet = false; continue; }
        const dx = p.cmHx - p.pos.x, dz = p.cmHz - p.pos.z;
        if (dx * dx + dz * dz < 36 || p.cmRetT > E.retMax) { p.cmRet = false; stats.returned++; }
        else if (p.fleeT <= 0) { p.cmDirT -= td; if (p.cmDirT <= 0) { p.cmDirT = 1; sidewalkDir(p, dx, dz); } }
      }
    }
  }

  // ================================================================== mood: crowd size, keeping away, landing cheers, crime
  function sidewalkPoint(L, out) {
    const r = R(1.6, 38.4), side = Math.floor(R(0, 4));
    if (side === 0) out.set(L.lx + r, 0, L.lz + 1.6); else if (side === 1) out.set(L.lx + r, 0, L.lz + 38.4);
    else if (side === 2) out.set(L.lx + 1.6, 0, L.lz + r); else out.set(L.lx + 38.4, 0, L.lz + r);
    return out;
  }
  function outOfView(g, x, z) {
    const cam = g.camera.position, dx = x - cam.x, dz = z - cam.z, d2 = dx * dx + dz * dz;
    if (d2 > CFG.crowd.hideDist * CFG.crowd.hideDist) return true;
    g.camera.getWorldDirection(T2);
    return dx * T2.x + dz * T2.z < -0.2 * Math.sqrt(d2);          // behind the camera
  }
  function dropPool(p, i) {
    pool[i] = pool[pool.length - 1]; pool.pop();
    if (p.cmKidMine) { const j = myKids.indexOf(p); if (j >= 0) myKids.splice(j, 1); if (!p.msnRole) { p.kid = false; p.hs = 1; p.ws = 1; } }
    p.cmPool = false; p.cmHidden = false; p.cmKidMine = false; p.cmFlee = false; p.cmRet = false; p.cmR = null; p.cmPendOn = false;
  }
  function placeOut(g, p) {
    for (let k = 0; k < 6; k++) {
      const L = walkLots[Math.floor(Math.random() * walkLots.length)];
      sidewalkPoint(L, T1);
      if (!outOfView(g, T1.x, T1.z) || g.blockAt(T1.x, 1, T1.z) >= 0) continue;
      p.pos.set(T1.x, g.groundY(T1.x, T1.z) + 0.9, T1.z);
      const a = Math.floor(Math.random() * 4) * Math.PI / 2; p.dir.set(Math.cos(a), 0, Math.sin(a));
      return true;
    }
    return false;
  }
  function crowdTick(g) {
    let vis = 0, hid = 0;
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      if (p.cmHidden) { if (p.mode !== 'gone') dropPool(p, i); else hid++; continue; }   // the slot was reused by another system
      if (p.mode === 'gone') { dropPool(p, i); continue; }                                  // lost, or carried away: let the slot go
      vis++;
    }
    const b = curBand(), Cc = CFG.crowd;
    const target = Math.round(base0 * Cc.visible[b] + Cc.extra * Cc.extraShare[b]);
    let budget = Cc.perTick;
    if (vis < target) {
      for (const p of pool) {
        if (budget <= 0 || vis >= target) break;
        if (!p.cmHidden || p.mode !== 'gone') continue;
        if (!placeOut(g, p)) { budget--; continue; }
        p.mode = 'free'; p.cmHidden = false; p.vel.set(0, 0, 0); p.quat.identity(); p.fleeT = 0; p.cheerT = 0; p.injured = false; p.danger = false; p.sleeping = false;
        budget--; vis++; hid--; stats.shown++;
      }
      // still short (high Hope): bring extra people out, a third of them kids
      while (budget > 0 && vis < target && hid <= 0 && extras < Cc.extra && g.people.length < 185) {
        budget--;
        const L = walkLots[Math.floor(Math.random() * walkLots.length)]; sidewalkPoint(L, T1);
        if (!outOfView(g, T1.x, T1.z) || g.blockAt(T1.x, 1, T1.z) >= 0) continue;
        const p = g.placePerson('free', T1.set(T1.x, g.groundY(T1.x, T1.z) + 0.9, T1.z));
        if (!p) break;
        extras++; stats.extras++; vis++;
        p.cmPool = true; p.cmHidden = false; p.hs = 1; p.ws = 1; p.kid = false; p.msnRole = null; p.msnPose = null;
        if (Math.random() < Cc.kidShare) { p.kid = true; p.hs = 0.62; p.ws = 0.8; p.cmKidMine = true; myKids.push(p); }
        const a = Math.floor(Math.random() * 4) * Math.PI / 2; p.dir.set(Math.cos(a), 0, Math.sin(a));
        pool.push(p);
      }
    } else if (vis > target + 2) {
      for (const p of pool) {
        if (budget <= 0 || vis <= target) break;
        if (p.cmHidden || p.mode !== 'free' || p.fleeT > 0 || p.cmFlee || p.cmRet || p.cmPendOn || p.cmR || p.danger || p.msnRole || missionKid(p)) continue;
        if (!outOfView(g, p.pos.x, p.pos.z)) continue;
        p.mode = 'gone'; p.cmHidden = true; budget--; vis--; stats.hidden++;
      }
    }
    S.visible = vis;
  }
  // low Hope: people step away from him when he's on the street
  function keepAway(g) {
    const P = g.P, K = CFG.keepAway;
    if (P.pos.y - Math.max(0, g.groundY(P.pos.x, P.pos.z)) > K.maxH) return;
    for (const p of pool) {
      if (!ambient(p) || p.cmHidden || p.fleeT > 0 || p.cmR || (p.cmCool || 0) > clock) continue;
      if (hd2(p.pos.x, p.pos.z, P.pos.x, P.pos.z) > K.radius * K.radius) continue;
      p.cmCool = clock + 6;
      if (Math.random() > K.p) continue;
      p.fleeT = R(1.5, 2.5); sidewalkDir(p, p.pos.x - P.pos.x, p.pos.z - P.pos.z); stats.avoid++;
    }
  }
  function landCheer(g) {
    if (curBand() < 3 || clock - S.landT < 3) return;
    S.landT = clock;
    const P = g.P.pos; let n = 0;
    for (const p of g.people) {
      if (!ambient(p) || p.cmHidden || p.fleeT > 0 || p.cmFlee) continue;
      if (hd2(p.pos.x, p.pos.z, P.x, P.z) > CFG.land.radius * CFG.land.radius) continue;
      p.mode = 'cheer'; p.cheerT = R(4, 6.5); p.photoT = Math.random() < 0.35 ? R(0.3, 1.5) : 99; p.cmR = null; n++;
    }
    if (n) { stats.landCheers += n; if (g.SFX && g.SFX.cheer) g.SFX.cheer(P); }
  }
  function crimeTick(g, td) {
    if (curBand() > 0) { S.crimeT = Math.min(S.crimeT, CFG.crime.every[1]); return; }
    S.crimeT -= td; if (S.crimeT > 0) return;
    S.crimeT = R(CFG.crime.every[0], CFG.crime.every[1]);
    const m = M();
    if (!m || !m.spawnAmbient || g.currentInc || m.state !== 'idle' || (g.nextIncT !== undefined && g.nextIncT < 20)) return;
    if (m.spawnAmbient('crime')) stats.crimes++;
  }
  function scanEvents(g) {
    const ev = g.events; if (!ev || !ev.length) return;
    const last = ev[ev.length - 1]; if (last === S.seenEv) return;
    if (S.seenEv === null) { S.seenEv = last; return; }
    let i = ev.length - 1; while (i > 0 && ev[i - 1] !== S.seenEv && ev.length - i < 64) i--;
    for (; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'collapse') addCollapse(e.x, e.z);
      else if (e.type === 'land' && e.tier !== 'water') landCheer(g);
    }
    S.seenEv = last;
  }

  // ================================================================== be the shield (#10)
  function lotOf(x, z) {
    const i = Math.floor((x + C.HALF - 10) / C.PITCH), j = Math.floor((z + C.HALF - 10) / C.PITCH);
    return { lx: -C.HALF + i * C.PITCH + 10, lz: -C.HALF + j * C.PITCH + 10 };
  }
  function spawnWitnesses(g, inc) {
    witnesses.length = 0;
    const c = inc.corner; if (!c) return;
    const L = lotOf(c.x, c.z);
    for (const off of [-12, 19]) {
      const z = clamp(c.z + off, L.lz + 2, L.lz + 38), x = c.x;
      const p = g.placePerson('free', T1.set(x, g.groundY(x, z) + 0.9, z), { spd: 0.02 });
      if (!p) continue;
      p.cmWit = true; p.fleeT = 0; p.face = Math.atan2(c.z - z, c.x - x); p.hs = 1; p.ws = 1; p.kid = false; p.msnRole = null; p.msnPose = null;
      witnesses.push(p);
    }
  }
  function releaseWitnesses(g) {
    for (const p of witnesses) {
      if (!p.cmWit) continue;
      p.cmWit = false; p.spd = R(1.1, 1.6);
      if (p.mode === 'free' && !p.injured) { p.mode = 'cheer'; p.cheerT = R(4, 6); p.photoT = 99; }
    }
    witnesses.length = 0;
  }
  function liveWitness(p) { return p && p.cmWit && p.mode === 'free' && !p.injured; }
  function robberyTick(g) {
    const inc = g.currentInc;
    if (!inc || inc.type !== 'robbery') { if (S.robInc) { releaseWitnesses(g); S.robInc = null; } return; }
    if (S.robInc !== inc) { if (S.robInc) releaseWitnesses(g); S.robInc = inc; S.shieldHope = 0; spawnWitnesses(g, inc); }
    for (const p of witnesses) if (p.cmWit && p.mode === 'free') p.fleeT = 0;
    const P = g.P.pos;
    for (const t of inc.crew || []) {
      if (t.cuffed || t.mode !== 'thug') { t.cmTgt = null; continue; }
      if (t.tele > 0 && !t.cmAimDone) {
        t.cmAimDone = true;
        let best = null, bd = 1e9;
        for (const w of witnesses) { if (!liveWitness(w)) continue; const d = hd2(w.pos.x, w.pos.z, t.pos.x, t.pos.z); if (d < bd) { bd = d; best = w; } }
        const engaged = hd2(P.x, P.z, t.pos.x, t.pos.z) < CFG.shield.engage * CFG.shield.engage;
        if (best && (S.forceCiv > 0 || (engaged && Math.random() < CFG.shield.civChance))) {
          if (S.forceCiv > 0) S.forceCiv--;
          t.cmTgt = best; stats.civAims++;
          const m = M();
          if (m && m.say) { m.say(t, 'taunt', { prio: true, text: Math.random() < 0.5 ? 'Nobody move!' : "Try it, hero, and they get it!" }); m.say(best, 'plead', { prio: true, text: "Please! Don't shoot!" }); }
          if (!S.hintCiv) { S.hintCiv = true; g.toast && g.toast("A robber is aiming at a bystander. Get in the line of fire!", 'alert'); }
        }
      }
      if (t.tele <= 0 && !(t.burst > 0)) { t.cmAimDone = false; t.cmTgt = null; }
    }
  }
  // HOOKS.aim: the next shot of a burst goes at the chosen bystander
  function aimHook(p, out) {
    const t = p.cmTgt;
    if (liveWitness(t)) { out.set(t.pos.x, t.pos.y + 0.35, t.pos.z); S.pendCiv = t; } else S.pendCiv = null;
  }
  // HOOKS.shot: tag the bullet that fireBullet just made
  function shotHook(b) { b.civ = S.pendCiv; S.pendCiv = null; if (b.civ) stats.civShots++; }
  // HOOKS.bullet: a bullet whose path this frame crosses his body (a 1.5 m bodyblock when it was meant for a
  // bystander, 1 m otherwise) sparks and ricochets; a ricochet never hurts anyone (b.safe). True = handled.
  function bulletHook(b, p0) {
    const g = G(); if (!g || !g.started || b.safe) return false;
    const P = g.P.pos, Rr = b.civ ? CFG.shield.civR : CFG.shield.r;
    const sx = b.p.x - p0.x, sy = b.p.y - p0.y, sz = b.p.z - p0.z, L2 = sx * sx + sz * sz;
    const t = L2 > 0 ? clamp(((P.x - p0.x) * sx + (P.z - p0.z) * sz) / L2, 0, 1) : 0;
    const cx = p0.x + sx * t, cy = p0.y + sy * t, cz = p0.z + sz * t, dx = cx - P.x, dz = cz - P.z, d2 = dx * dx + dz * dz;
    if (d2 > Rr * Rr || cy < P.y - 1.15 || cy > P.y + 1.0) return false;
    let nx, nz; const dl = Math.sqrt(d2);
    if (dl > 0.05) { nx = dx / dl; nz = dz / dl; } else { const sl = Math.sqrt(L2) || 1; nx = -sx / sl; nz = -sz / sl; }
    const v = b.v, vn = v.x * nx + v.z * nz;
    if (vn > 0) return false;                                       // already leaving him
    v.x -= 2 * vn * nx; v.z -= 2 * vn * nz; v.multiplyScalar(0.45);
    v.x += R(-40, 40); v.z += R(-40, 40); v.y = Math.abs(v.y) * 0.5 + R(10, 60);
    b.p.set(P.x + nx * 1.05, cy, P.z + nz * 1.05); b.life = Math.min(b.life, 0.45); b.safe = true; b.reflected = true;
    for (let k = 0; k < 10; k++) g.FX.spark(cx, cy, cz, nx * 8 + R(-5, 5), R(0, 8), nz * 8 + R(-5, 5));
    g.SFX.ping(T1.set(cx, cy, cz)); g.P.hitT = 0.12; g.ledger.deflected++; stats.deflected++;
    if (b.civ) {
      stats.shielded++;
      if (S.shieldHope < CFG.shield.hopeCap) { S.shieldHope++; stats.shieldHope++; g.hopeAdd(1); }
      if (clock - S.shieldToastT > 3) { S.shieldToastT = clock; g.toast && g.toast('Shielded! The shots spark off his chest.' + (S.shieldHope <= CFG.shield.hopeCap ? ' +1 Hope' : ''), 'good'); }
      const w = b.civ, m = M();
      if (m && m.say && Math.random() < 0.5) m.say(w, 'thanks', { prio: true, text: Math.random() < 0.5 ? 'He... he stopped the bullets!' : 'He stood right in front of me!' });
      if (g.emit) g.emit('shield', { x: +cx.toFixed(1), z: +cz.toFixed(1) });
    }
    return true;
  }

  // ================================================================== wave back (#7)
  function canAct(g) { return g && g.started && !g.paused && !(g.MAP && g.MAP.open) && !(g.freeze && g.freeze.on) && !(window.SM_SETTINGS && SM_SETTINGS.isOpen); }
  function wave() {
    const g = G(); if (!canAct(g)) return -1;
    S.waveT = CFG.wave.dur; stats.waves++;
    const P = g.P.pos, W = CFG.wave, b = curBand(), w = CFG.weights[b];
    const answer = clamp(w[1] + w[2] + (b >= 2 ? 0.15 : 0), 0, 1);
    let n = 0;
    for (const p of g.people) {
      if ((p.mode !== 'free' && p.mode !== 'cheer') || p.thug || p.msnRole || p.cmHidden || p.cmFrozen || p.cmWit || p.mCrowd || p.fleeT > 0) continue;
      if (hd2(p.pos.x, p.pos.z, P.x, P.z) > W.radius * W.radius || P.y - p.pos.y > W.maxH) continue;
      if (!p.kid && Math.random() > answer) continue;
      p.mode = 'cheer'; p.cheerT = R(2.5, 4.5); p.photoT = Math.random() < 0.3 ? R(0.2, 1.2) : 99; p.cmR = null; n++;
    }
    stats.waveCheers += n;
    if (n) {
      if (g.SFX && g.SFX.cheer) g.SFX.cheer(P);
      const m = M(); if (m && m.bark) m.bark(b === 0 ? 'passLow' : 'passHigh');
    }
    while (waveHope.length && clock - waveHope[0] > W.window) waveHope.shift();
    if (n >= 2 && waveHope.length < W.cap) {
      waveHope.push(clock); stats.waveHope++; g.hopeAdd(1);
      if (clock - S.waveToastT > 2) { S.waveToastT = clock; g.toast && g.toast('The crowd waves back. +1 Hope', 'good'); }
    } else if (n >= 2 && clock - S.waveToastT > 4) { S.waveToastT = clock; g.toast && g.toast('The crowd waves back.', ''); }
    return n;
  }
  // his arm: a raised, waving right hand for 1.3 s (layered over game.js updateHeroPose)
  function heroWave(g, dt) {
    if (S.waveT <= 0) return;
    S.waveT -= dt;
    const h = g.hero; if (!h || !h.armR || g.P.hold) return;
    const t = CFG.wave.dur - S.waveT, k = clamp(Math.min(t / 0.18, S.waveT / 0.22), 0, 1);
    h.armR.rotation.x = lerp(h.armR.rotation.x, Math.PI * 0.92, k);
    h.armR.rotation.z = lerp(h.armR.rotation.z, 0.22 + Math.sin(clock * 11) * 0.32, k);
    if (h.elbowR) { h.elbowR.rotation.x = lerp(h.elbowR.rotation.x, 0.35, k); h.elbowR.rotation.z = lerp(h.elbowR.rotation.z, 0, k); }
  }
  addEventListener('keydown', e => {
    if (e.code !== 'KeyT' || e.repeat) return;
    const g = G(); if (!canAct(g)) return;
    wave();
  });
  function pollPad() {
    if (!navigator.getGamepads) return;
    const list = navigator.getGamepads(); let gp = null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].connected) { gp = list[i]; break; }
    const down = !!(gp && gp.buttons[14] && gp.buttons[14].pressed);   // D-pad left (right is photo mode)
    if (down && !S.padPrev && !(window.SM_SETTINGS && SM_SETTINGS.padOwned && SM_SETTINGS.padOwned())) wave();
    S.padPrev = down;
  }

  // ================================================================== banners: ONE instanced quad mesh on rooftops
  const BAN = { mesh: null, list: [], s: 0, want: false, dirty: true };
  function canvasTex(w, h, draw) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d'); draw(c2, w, h);
    const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
  }
  function drawBanner(c, w, h) {
    c.fillStyle = '#e8dcc2'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#2d3f6e'; c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
    c.fillStyle = '#a3262a'; c.fillRect(0, 12, w, 3); c.fillRect(0, h - 15, w, 3);
    const shield = (x) => {    // a small five-sided shield
      c.save(); c.translate(x, h / 2);
      c.beginPath(); c.moveTo(-26, -24); c.lineTo(26, -24); c.lineTo(34, -10); c.lineTo(0, 30); c.lineTo(-34, -10); c.closePath();
      c.fillStyle = '#b5312c'; c.fill(); c.lineWidth = 4; c.strokeStyle = '#d9b44a'; c.stroke();
      c.beginPath(); c.moveTo(-12, -12); c.lineTo(12, -12); c.lineTo(16, -5); c.lineTo(0, 14); c.lineTo(-16, -5); c.closePath(); c.fillStyle = '#d9b44a'; c.fill();
      c.restore();
    };
    shield(46); shield(w - 46);
    c.fillStyle = '#7d1c22'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 50px Georgia, "Times New Roman", serif';
    c.fillText('METROPOLIS ♥ SUPERMAN', w / 2, h / 2 + 3);
  }
  function topInset(b) { let ins = 0; for (const t of b.tiers || []) if (b.ny - 1 >= t.y) ins = t.ins; return ins; }
  function buildBanners(scene, buildings) {
    const B = CFG.banners;
    const cands = buildings.filter(b => b.h >= B.minH && b.h <= B.maxH);
    // spread them out: every n-th suitable tower
    const step = Math.max(1, cands.length / B.max);
    for (let k = 0; k < cands.length && BAN.list.length < B.max; k += step) {
      const b = cands[Math.floor(k)], ins = topInset(b) * C.CELL, f = (Math.floor(k) * 7 + 3) % 4;
      const x0 = b.x0 + ins, x1 = b.x1 - ins, z0 = b.z0 + ins, z1 = b.z1 - ins;
      let x, z, nx = 0, nz = 0, fw;
      if (f === 0) { x = x0; z = (z0 + z1) / 2; nx = -1; fw = z1 - z0; } else if (f === 1) { x = x1; z = (z0 + z1) / 2; nx = 1; fw = z1 - z0; }
      else if (f === 2) { z = z0; x = (x0 + x1) / 2; nz = -1; fw = x1 - x0; } else { z = z1; x = (x0 + x1) / 2; nz = 1; fw = x1 - x0; }
      const w = Math.min(B.w, fw - 3); if (w < 5) continue;
      BAN.list.push({ x: x + nx * 0.3, z: z + nz * 0.3, top: b.h - 0.5, yaw: Math.atan2(nx, nz), w, nx, nz, alive: true, ph: Math.random() * 6 });
    }
    const tex = canvasTex(512, 136, drawBanner);
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, Math.max(1, BAN.list.length));
    m.name = 'citymood:banners'; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; m.visible = false;
    m.count = BAN.list.length;
    scene.add(m); BAN.mesh = m;
  }
  function bannersFrame(g, dt) {
    if (!BAN.mesh || !BAN.list.length) return;
    const h = g.ledger.hope, B = CFG.banners;
    if (h >= B.on) BAN.want = true; else if (h < B.off) BAN.want = false;
    const s0 = BAN.s; BAN.s = clamp(BAN.s + (BAN.want ? 0.7 : -1.2) * dt, 0, 1);
    bannerAcc += dt;
    if (BAN.s > 0 && bannerAcc > 2) {       // a tower that lost its top takes its banner down
      bannerAcc = 0;
      for (const b of BAN.list) if (b.alive && g.blockAt(b.x - b.nx * 2.8, b.top - 1.5, b.z - b.nz * 2.8) < 0) { b.alive = false; BAN.dirty = true; }
    }
    BAN.mesh.visible = BAN.s > 0.001;
    if (!BAN.mesh.visible || (s0 === BAN.s && !BAN.dirty && BAN.s >= 1)) return;
    // unroll from the parapet (eased), with a slow sway once out
    const e = BAN.s * BAN.s * (3 - 2 * BAN.s), HH = B.h;
    for (let i = 0; i < BAN.list.length; i++) {
      const b = BAN.list[i];
      if (!b.alive) { TM.makeScale(0, 0, 0); BAN.mesh.setMatrixAt(i, TM); continue; }
      TP.set(b.x, b.top - HH * e / 2, b.z); TQ.setFromAxisAngle(UPV, b.yaw);
      TM.compose(TP, TQ, TS.set(b.w, Math.max(0.001, HH * e), 1)); BAN.mesh.setMatrixAt(i, TM);
    }
    BAN.mesh.instanceMatrix.needsUpdate = true; BAN.dirty = false;
  }

  // ================================================================== police tape (low Hope): cordon the block around damage
  const TAPE = { mesh: null, n: 0, key: '' };
  const tapeSites = [];                    // {x, z, t} recent collapses
  const tapeLots = [];
  function buildTape(scene) {
    const tex = canvasTex(512, 48, (c, w, h) => {
      c.fillStyle = '#f2c516'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#111'; c.font = 'bold 30px Arial, Helvetica, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('POLICE LINE  •  DO NOT CROSS', w / 2, h / 2 + 1);
    });
    tex.wrapS = THREE.RepeatWrapping;
    const geo = new THREE.PlaneGeometry(1, 0.2), uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 2.5);    // 2.5 text tiles per 5.8 m segment
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.6 });
    const max = CFG.tape.maxLots * 4 * CFG.tape.seg;
    const m = new THREE.InstancedMesh(geo, mat, max);
    m.name = 'citymood:tape'; m.frustumCulled = false; m.castShadow = false; m.visible = false; m.count = 0;
    scene.add(m); TAPE.mesh = m;
  }
  function tapeTick(g) {
    if (!TAPE.mesh) return;
    tapeLots.length = 0;
    if (curBand() === 0) {
      const add = (x, z) => {
        if (z > C.WATER_Z - 5 || Math.abs(x) > C.HALF || Math.abs(z) > C.HALF) return;
        const L = lotOf(x, z); for (const q of tapeLots) if (q.lx === L.lx && q.lz === L.lz) return;
        if (tapeLots.length < CFG.tape.maxLots) tapeLots.push(L);
      };
      if (S.incOk && g.currentInc && g.currentInc.type !== 'airliner' && S.incY < 200) add(S.incX, S.incZ);
      for (let i = tapeSites.length - 1; i >= 0; i--) { const s = tapeSites[i]; if (clock - s.t > CFG.tape.keep) { tapeSites.splice(i, 1); continue; } add(s.x, s.z); }
    }
    let key = ''; for (const L of tapeLots) key += L.lx + ',' + L.lz + ';';
    if (key === TAPE.key) return;
    TAPE.key = key;
    const segN = CFG.tape.seg, m = TAPE.mesh; let n = 0;
    for (const L of tapeLots) {
      const a0 = -0.5, a1 = 40.5, len = (a1 - a0) / segN;
      for (let side = 0; side < 4; side++) for (let k = 0; k < segN; k++) {
        const a = a0 + (k + 0.5) * len;
        let x, z, yaw;
        if (side === 0) { x = L.lx + a; z = L.lz - 0.5; yaw = 0; } else if (side === 1) { x = L.lx + a; z = L.lz + 40.5; yaw = 0; }
        else if (side === 2) { x = L.lx - 0.5; z = L.lz + a; yaw = Math.PI / 2; } else { x = L.lx + 40.5; z = L.lz + a; yaw = Math.PI / 2; }
        TP.set(x, Math.max(0, g.groundY(x, z)) + 0.95 + (k % 2 ? -0.06 : 0), z); TQ.setFromAxisAngle(UPV, yaw);
        TM.compose(TP, TQ, TS.set(len, 1, 1)); m.setMatrixAt(n++, TM);
      }
    }
    m.count = n; m.visible = n > 0; m.instanceMatrix.needsUpdate = true; TAPE.n = n;
  }
  // the police ask him to stand back when he walks into a cordon
  function tapeBark(g) {
    if (!tapeLots.length || clock - S.tapeBarkT < 12) return;
    const P = g.P.pos; if (P.y - Math.max(0, g.groundY(P.x, P.z)) > 4) return;
    for (const L of tapeLots) {
      if (P.x > L.lx - 3 && P.x < L.lx + 43 && P.z > L.lz - 3 && P.z < L.lz + 43) {
        S.tapeBarkT = clock; const m = M();
        if (m && m.bark) m.bark('landLow', Math.random() < 0.5 ? 'Sir, please stand back from the tape.' : "Police line. We've got this, thanks.");
        return;
      }
    }
  }

  // ================================================================== frame
  function firstRun(g) {
    ready = true;
    walkLots = ctx.lotInfo.filter(l => l.type !== 'park' && l.type !== 'hospital');
    if (!walkLots.length) walkLots = ctx.lotInfo.slice();
    for (const p of g.people) if (p.mode === 'free' && !p.thug && !p.msnRole && p.spd >= 1) { p.cmPool = true; pool.push(p); }
    base0 = pool.length;
    if (g.hooks) {
      if (g.hooks.aim) g.hooks.aim.push(aimHook);
      if (g.hooks.shot) g.hooks.shot.push(shotHook);
      if (g.hooks.bullet) g.hooks.bullet.push(bulletHook);
    }
    S.crimeT = R(CFG.crime.every[0], CFG.crime.every[1]);
    if (!g.citymood) g.citymood = API;
  }
  function tick(g, td) {
    scanEvents(g);
    dangerAcc += td; if (dangerAcc >= CFG.evac.every) { dangerAcc = 0; updateDangers(g); pullCars(g); }
    crowdAcc += td; if (crowdAcc >= CFG.crowd.every) { crowdAcc = 0; crowdTick(g); }
    tickPending(g, td);
    scanAcc += td;
    if (scanAcc >= 0.2) { scanAcc = 0; scanPass(g); if (curBand() === 0) { keepAway(g); tapeBark(g); } }
    evacTick(g, td);
    robberyTick(g);
    crimeTick(g, td);
    tapeAcc += td; if (tapeAcc >= 1) { tapeAcc = 0; tapeTick(g); }
  }
  function update(wdt) {
    const g = G(); if (!g) return;
    if (!ready) { if (!g.people || !g.people.length) return; firstRun(g); }
    if (!g.started) return;
    const dt = Math.min(0.1, wdt); clock += dt;
    tickAcc += dt; if (tickAcc >= CFG.tick) { const td = tickAcc; tickAcc = 0; tick(g, td); }
    carsFrame(dt);
    heroWave(g, dt);
    posePass(g);
    bannersFrame(g, dt);
    pollPad();
  }

  // ================================================================== debug / test API (__game.citymood)
  const API = {
    cfg: CFG, stats,
    band: () => curBand(),
    get clock() { return clock; },
    wave,
    get waving() { return S.waveT > 0; },
    reactors: () => reactors.length,
    pending: () => pending.length,
    poolSize: () => pool.length,
    visible: () => S.visible || 0,
    witnesses: () => witnesses.slice(),
    frozen: () => frozen.slice(),
    dangers: () => D.filter(d => d.on).map(d => ({ kind: d.kind, x: Math.round(d.x), z: Math.round(d.z), r: d.r })),
    pulledOver: () => cmCars.filter(c => c.cmS && c.cmS.pull).length,
    // the next robber to wind up turns his gun on the nearest witness (tests)
    forceCivAim(n) { S.forceCiv = n || 1; },
    banners: () => ({ count: BAN.list.length, alive: BAN.list.filter(b => b.alive).length, s: +BAN.s.toFixed(3), visible: !!(BAN.mesh && BAN.mesh.visible), first: BAN.list[0] ? { x: BAN.list[0].x, z: BAN.list[0].z, top: BAN.list[0].top, nx: BAN.list[0].nx, nz: BAN.list[0].nz } : null }),
    tape: () => ({ segments: TAPE.n, lots: tapeLots.length, visible: !!(TAPE.mesh && TAPE.mesh.visible) })
  };
  window.SM_CITYMOOD = API;

  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function citymood(c) {
    ctx = c; THREE = c.THREE; C = c.CONST;
    V3 = THREE.Vector3; UPV = new V3(0, 1, 0); ZAX = new V3(0, 0, 1); XAX = new V3(1, 0, 0);
    T1 = new V3(); T2 = new V3(); TP = new V3(); TS = new V3();
    TQ = new THREE.Quaternion(); TQ2 = new THREE.Quaternion();
    TM = new THREE.Matrix4(); TL = new THREE.Matrix4(); TR = new THREE.Matrix4(); TX = new THREE.Matrix4(); BASE = new THREE.Matrix4();
    try { buildBanners(c.scene, c.buildings); } catch (e) { console.warn('[citymood] banners', e); }
    try { buildTape(c.scene); } catch (e) { console.warn('[citymood] tape', e); }
    return { update };
  });
})();
