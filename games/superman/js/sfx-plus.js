/*
 * Sound feel upgrade (design/dream-features.md, "Game feel: audio"). Wrappers only: the original
 * SFX calls in game.js stay as they are and keep their sfxOK gaps; this file layers around them.
 *
 *   - Three-layer impacts: a high-passed transient click (0-15 ms) + the original body + a low-passed
 *     rumble/debris tail (0.6-2 s), with +-6 % pitch and +-2 dB gain variation per instance.
 *     Heavy hits duck the music -6 dB for 350 ms (SM_AUDIO.impact).
 *   - Physical delay: booms, collapses and glass more than 150 m from the camera play d / 343 s late.
 *   - Doppler-ish fly-bys: anything you pass within 22 m at more than 60 m/s relative speed
 *     whooshes past, pitch falling through the closest approach (c / (c -+ v), v capped at 0.85 c).
 *     A short whoosh on hard banks (more than 60 deg/s above 60 m/s).
 *   - Altitude ambience beds: street traffic (below ~200 m), wind (100 m - 6 km), thin high air
 *     (above ~3 km), plus a 40-60 Hz sub-rumble that rises with speed.
 * Everything routes into AU.master, so K mute, the SFX volume and the super-hearing muffle apply.
 * Debug: SM_AUDIO.debug.sfx = { beds, lastDelay, delayed, layered, dopplers, banks }.
 */
(function () {
  'use strict';
  const G = () => window.__game;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const C_AIR = 343, FAR = 150;

  const D = { beds: { traffic: 0, wind: 0, thin: 0, sub: 0 }, lastDelay: 0, delayed: 0, layered: 0, dopplers: 0, banks: 0, wrapped: false };
  const attachDebug = () => { if (window.SM_AUDIO && window.SM_AUDIO.debug && !window.SM_AUDIO.debug.sfx) window.SM_AUDIO.debug.sfx = D; };

  const vary = () => 0.94 + Math.random() * 0.12;            // +-6 % pitch
  const gainVar = () => Math.pow(10, (Math.random() * 4 - 2) / 20); // +-2 dB

  function noise(c, AU, t, vol, dur, type, f0, f1, q, delay) {
    const s = c.createBufferSource(); s.buffer = AU.noise;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(f0, t); f.Q.value = q || 0.7;
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + (delay || 0.003)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(AU.master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  // the transient (0-15 ms click) and the tail (rumble + debris), around the original body
  function layers(AU, vol, tailDur, tailF) {
    const c = AU.ctx, t = c.currentTime, p = vary(), gv = gainVar();
    noise(c, AU, t, 0.9 * vol * gv, 0.015, 'highpass', 2500 * p, null, 0.8, 0.001);
    noise(c, AU, t + 0.02, 0.5 * vol * gv, tailDur, 'lowpass', tailF * p, 45, 0.6, 0.08);
    noise(c, AU, t + 0.05, 0.12 * vol * gv, tailDur * 0.7, 'bandpass', 2600 * p, 900, 1.5, 0.05); // debris patter
    D.layered++;
  }

  function wrap(g) {
    const SFX = g.SFX, AU = g.AU; if (!SFX || D.wrapped) return;
    D.wrapped = true;
    const dist = p => p ? g.camera.position.distanceTo(p) : 0;
    const distVol = p => p ? 1 / (1 + dist(p) / 70) : 1;
    // call the original; report whether its sfxOK gate let it through
    const fired = (name, fn) => { const before = AU.last[name]; fn(); return AU.last[name] !== before; };
    const later = (p, fn) => {
      const d = dist(p);
      if (d > FAR) { const s = d / C_AIR; D.lastDelay = s; D.delayed++; const P = p.clone ? p.clone() : p; setTimeout(() => fn(P), s * 1000); return; }
      fn(p);
    };
    const o = { punch: SFX.punch, boom: SFX.boom, crumble: SFX.crumble, glass: SFX.glass };
    SFX.punch = function (p, k) {
      const ok = fired('punch', () => o.punch.call(SFX, p, k));
      if (!ok || !AU.ctx || AU.muted) return;
      const kk = k || 1, v = distVol(p) * kk;
      layers(AU, Math.min(1.2, 0.6 * v), 0.6 + 0.5 * Math.min(2, kk), 700);
      if (kk >= 1 && window.SM_AUDIO) window.SM_AUDIO.impact(kk);
    };
    SFX.boom = function (p, k) {
      later(p, q => {
        const ok = fired('boom', () => o.boom.call(SFX, q, k));
        if (!ok || !AU.ctx || AU.muted) return;
        const kk = k || 1, v = distVol(q) * kk;
        layers(AU, Math.min(1.3, 0.8 * v), 1.4 + 0.6 * Math.min(1, kk), 500);
        if (window.SM_AUDIO && v > 0.15) window.SM_AUDIO.impact(Math.min(2, kk));
      });
    };
    SFX.crumble = function (p, k) {
      later(p, q => {
        const ok = fired('crumble', () => o.crumble.call(SFX, q, k));
        if (!ok || !AU.ctx || AU.muted) return;
        const v = distVol(q) * (k || 1);
        layers(AU, Math.min(1, 0.5 * v), 1.2 + 0.8 * Math.min(1, k || 1), 380);
      });
    };
    SFX.glass = function (p) { later(p, q => o.glass.call(SFX, q)); };
  }

  // ------------------------------------------------------------------ beds + sub-rumble
  const B = { ctx: null };
  function beds(g) {
    const AU = g.AU; if (!AU || !AU.ctx || !AU.master || !AU.noise) return false;
    if (B.ctx === AU.ctx) return true;
    const c = AU.ctx; B.ctx = c;
    const loop = (type, f, q, extra) => {
      const s = c.createBufferSource(); s.buffer = AU.noise; s.loop = true; s.loopStart = Math.random(); s.playbackRate.value = 0.97 + Math.random() * 0.06;
      const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g2 = c.createGain(); g2.gain.value = 0; s.connect(fl);
      let last = fl; if (extra) { last = extra(fl); }
      last.connect(g2); g2.connect(AU.master); s.start(); return { g: g2, f: fl };
    };
    // traffic: low rumble + tyre hiss with a slow swell
    B.traffic = loop('lowpass', 320, 0.5);
    B.hiss = loop('bandpass', 1100, 0.8);
    const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.13; lg.gain.value = 0.35;
    const hissMod = c.createGain(); hissMod.gain.value = 0.65; lfo.connect(lg); lg.connect(hissMod.gain); lfo.start();
    B.hiss.g.disconnect(); B.hiss.g.connect(hissMod); hissMod.connect(AU.master);
    // wind: a broad band that gusts
    B.wind = loop('bandpass', 520, 0.45);
    const gust = c.createOscillator(), gg = c.createGain(); gust.frequency.value = 0.21; gg.gain.value = 180; gust.connect(gg); gg.connect(B.wind.f.frequency); gust.start();
    // thin air: a cold high hiss over a very low hum
    B.thin = loop('highpass', 3200, 0.6);
    const hum = c.createOscillator(); hum.frequency.value = 38; const hg = c.createGain(); hg.gain.value = 0; hum.connect(hg); hg.connect(AU.master); hum.start(); B.hum = hg;
    // speed sub-rumble, 40-60 Hz
    const s1 = c.createOscillator(), s2 = c.createOscillator(); s1.frequency.value = 44; s2.frequency.value = 51;
    const sg = c.createGain(); sg.gain.value = 0; s1.connect(sg); s2.connect(sg); sg.connect(AU.master); s1.start(); s2.start(); B.sub = sg; B.s1 = s1;
    B.last = { traffic: -1, wind: -1, thin: -1, sub: -1 };
    return true;
  }
  const setG = (k, node, v, t, tc) => { if (Math.abs(B.last[k] - v) > 0.002) { node.gain.setTargetAtTime(v, t, tc); B.last[k] = v; } };

  // ------------------------------------------------------------------ fly-bys and banks
  const F = { t: 0, gate: 0, prevVx: 0, prevVz: 0, prevVy: 0, bankGate: 0 };
  function doppler(g, AU, tca, miss, vrel, vol) {
    const c = AU.ctx, t = c.currentTime, v = Math.min(vrel, C_AIR * 0.85);
    const f0 = 420 * vary(), hi = f0 * C_AIR / (C_AIR - v), lo = f0 * C_AIR / (C_AIR + v);
    const tp = t + clamp(tca, 0.02, 0.4), dur = tp - t + 0.45;
    const s = c.createBufferSource(); s.buffer = AU.noise;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(hi * 2.2, t); bp.frequency.setValueAtTime(hi * 2.2, Math.max(t, tp - 0.06)); bp.frequency.exponentialRampToValueAtTime(lo * 2.2, tp + 0.08); bp.frequency.exponentialRampToValueAtTime(lo * 1.6, t + dur);
    const o = c.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(hi, t); o.frequency.setValueAtTime(hi, Math.max(t, tp - 0.06)); o.frequency.exponentialRampToValueAtTime(lo, tp + 0.08);
    const og = c.createGain(); og.gain.value = 0.08;
    const g2 = c.createGain(); const pk = vol * clamp(1 - miss / 26, 0.2, 1);
    g2.gain.setValueAtTime(0.0001, t); g2.gain.exponentialRampToValueAtTime(pk, tp); g2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(g2); o.connect(og); og.connect(g2); g2.connect(AU.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05); o.start(t); o.stop(t + dur + 0.05);
  }
  function flyBys(g, dt) {
    const P = g.P, AU = g.AU, sp = P.vel.length();
    F.gate -= dt; F.bankGate -= dt;
    // hard bank whoosh: heading change rate above 60 deg/s at more than 60 m/s
    if (sp > 60 && P.flying) {
      const ph = Math.hypot(F.prevVx, F.prevVz), h = Math.hypot(P.vel.x, P.vel.z);
      if (ph > 1 && h > 1 && dt > 0) {
        const cos = clamp((F.prevVx * P.vel.x + F.prevVz * P.vel.z) / (ph * h), -1, 1), rate = Math.acos(cos) / dt * 57.3;
        if (rate > 60 && F.bankGate <= 0) { F.bankGate = 0.8; D.banks++; if (AU && AU.ctx && !AU.muted) noise(AU.ctx, AU, AU.ctx.currentTime, 0.35, 0.5, 'bandpass', 300, 2200, 1.1, 0.12); }
      }
    }
    F.prevVx = P.vel.x; F.prevVz = P.vel.z;
    if ((F.t -= dt) > 0 || sp < 40) return;
    F.t = 0.1;
    const list = g.bodies; if (!list) return;
    let best = null, bt = 0, bm = 0, bv = 0;
    const n = Math.min(list.length, 500);
    for (let i = 0; i < n; i++) {
      const b = list[i]; if (!b || !b.pos) continue;
      const rx = b.pos.x - P.pos.x, ry = b.pos.y - P.pos.y, rz = b.pos.z - P.pos.z;
      if (rx * rx + ry * ry + rz * rz > 160 * 160) continue;
      const bvx = b.vel ? b.vel.x : 0, bvy = b.vel ? b.vel.y : 0, bvz = b.vel ? b.vel.z : 0;
      const vx = bvx - P.vel.x, vy = bvy - P.vel.y, vz = bvz - P.vel.z, vv = vx * vx + vy * vy + vz * vz;
      if (vv < 3600) continue; // under 60 m/s relative
      const tca = -(rx * vx + ry * vy + rz * vz) / vv; if (tca < 0 || tca > 0.12) continue;
      const mx = rx + vx * tca, my = ry + vy * tca, mz = rz + vz * tca, miss = Math.sqrt(mx * mx + my * my + mz * mz);
      if (miss > 22 || b === P.hold) continue;
      if (!best || miss < bm) { best = b; bt = tca; bm = miss; bv = Math.sqrt(vv); }
    }
    if (best && F.gate <= 0) {
      F.gate = 0.18; D.dopplers++; D.lastDoppler = { tca: +bt.toFixed(3), miss: +bm.toFixed(1), v: Math.round(bv) };
      if (AU && AU.ctx && !AU.muted) doppler(g, AU, bt, bm, bv, best.kind === 'car' ? 0.5 : 0.3);
    }
  }

  function update(dt) {
    const g = G(); if (!g || !g.P) return;
    attachDebug();
    if (!D.wrapped && g.SFX && g.AU) wrap(g);
    const P = g.P, y = P.pos.y, sp = P.vel.length();
    // bed levels are computed even without audio so tests can read them
    const traffic = 0.11 * (1 - smooth(25, 220, y)) * (g.started ? 1 : 0.5);
    const wind = 0.06 * smooth(60, 260, y) * (1 - smooth(2500, 7000, y));
    const thin = 0.035 * smooth(2500, 8000, y);
    const sub = 0.22 * smooth(40, 600, sp);
    D.beds.traffic = +traffic.toFixed(4); D.beds.wind = +wind.toFixed(4); D.beds.thin = +thin.toFixed(4); D.beds.sub = +sub.toFixed(4);
    flyBys(g, dt);
    if (!beds(g)) return;
    const AU = g.AU, t = AU.ctx.currentTime, m = AU.muted ? 0 : 1;
    setG('traffic', B.traffic.g, traffic * m, t, 0.4); B.hiss.g.gain.value = traffic * 0.45 * m;
    setG('wind', B.wind.g, wind * m, t, 0.5);
    setG('thin', B.thin.g, thin * m, t, 0.6); B.hum.gain.value = thin * 0.8 * m;
    setG('sub', B.sub, sub * m, t, 0.15);
    const sf = Math.round(40 + 20 * smooth(40, 900, sp)); if (sub > 0.01 && sf !== B.lastSf) { B.lastSf = sf; B.s1.frequency.setTargetAtTime(sf, t, 0.3); }
  }

  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function sfxPlus() {
    return { update(dt) { try { update(Math.min(dt, 0.1)); } catch (e) { if (!D.err) { D.err = String(e && e.stack || e); console.warn('sfx-plus', e); } } } };
  });
})();
