/* The Catch and Save Everyone (dream features 2 and 9).
 *
 * Catching is a skill: match their speed and absorb it gently, and everyone walks away.
 *   - Grab rule: the instant velocity change |target.vel - P.vel| at the grab hurts people above
 *     12 m/s (vehicle occupants above 18 m/s). Absorbed over ~0.1 s, more than 15 g (30 g for
 *     vehicles) is a severe injury.
 *   - Carry rule: the g on the carried body (|dv| over a 0.1 s window) above 6 g for 0.25 s hurts a
 *     person (15 g for vehicle occupants); above 15 g (30 g) it is severe at once. Hard turns, boosts,
 *     walls and stops all count. Coasting with a passenger brakes at 4 g at most ("soft hands").
 *   - Auto-assist: within 2 m of a faller with the relative speed under the limit, the catch happens
 *     on its own (or on E) and is cushioned: Superman takes their velocity, then brakes at 4 g.
 *   - Slow time (V, and the missions' slow-motion assist) compares on-screen velocities.
 *   - HUD: a g-arc around the crosshair (green < 3 g, amber 3-6 g, red > 6 g, thicker with "!" in the
 *     red), a mono readout, and a "match speed" bar while closing on a faller (within 30 m).
 *   - Triage: during an emergency, "Saved X / Y at risk" under the timer; everyone saved unhurt with
 *     gold earns an "Everyone home" ribbon.
 *
 * Contract: game.js calls SM_CATCH.onGrab(t) from grabBody (missions.js calls it for its fallers),
 * SM_CATCH.carry(h, dt) from the held-object block and SM_CATCH.coast(dt) from the coasting branch
 * of flight. The rest runs as a plugin, reading window.__game lazily. No per-frame allocations.
 */
(function () {
  'use strict';
  const CFG = {
    dvPerson: 12,        // m/s instant change a person survives unhurt
    gPerson: 6,          // sustained g a carried person survives
    gSevere: 15,         // above this a person's injury is severe
    dvVehicle: 18,       // looser: vehicle occupants are belted in a crumple zone
    gVehicle: 15,
    gVehicleSevere: 30,
    sustain: 0.25,       // s above the g limit before it hurts
    window: 0.1,         // s smoothing window for the g sample
    absorbT: 0.1,        // s an arm-catch spreads an instant dv over (dv -> g)
    softG: 4,            // coasting brake with a passenger
    assistR: 2,          // m catch window (to the body's surface)
    hudR: 30,            // m: show the meter when this close to a faller
    gMax: 12,            // arc full scale
    slowScale: 0.12,     // must match game.js wdt scale in slow time
    heliCrew: 3,
    regrabT: 1.5         // s after letting go before auto-assist will catch again
  };
  const G0 = 9.81;
  const G = () => window.__game;

  // ---- velocity history of the carried body (ring buffer, no allocations)
  const N = 64, RV = new Float64Array(N * 3), RT = new Float64Array(N);
  let head = 0, count = 0, clock = 0;
  function seed(v) { head = 0; count = 0; push(v); }
  function push(v) {
    head = (head + 1) % N; RV[head * 3] = v.x; RV[head * 3 + 1] = v.y; RV[head * 3 + 2] = v.z; RT[head] = clock;
    if (count < N) count++;
  }
  // |v_now - v_then| / (t_now - t_then) / g, with "then" the newest sample at least one window old
  function sampleG() {
    if (count < 2) return 0;
    let k = -1;
    for (let i = 1; i < count; i++) { const j = (head - i + N) % N; k = j; if (clock - RT[j] >= CFG.window - 1e-6) break; }
    const age = clock - RT[k]; if (age <= 1e-6) return 0;
    const dx = RV[head * 3] - RV[k * 3], dy = RV[head * 3 + 1] - RV[k * 3 + 1], dz = RV[head * 3 + 2] - RV[k * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / age / G0;
  }

  const st = {
    held: null, g: 0, peak: 0, overT: 0,
    faller: null, fallerDv: 0, fallerD: 0, fallerVel: null, fallerClose: false,
    lastHeld: null, releasedT: -99, log: [], catches: 0, softCatches: 0, hardCatches: 0
  };
  const ts = () => (G().P.slow ? CFG.slowScale : 1);
  function occupied(t) {
    if (!t) return false;
    if (t.kind === 'person') return !t.thug;
    if (t.kind === 'heli') return !t.crashed;
    if (t.kind === 'car') return !!t.occupied && !t.exploded;
    return false;
  }
  function rule(t) {
    return t.kind === 'person' ? { dv: CFG.dvPerson, g: CFG.gPerson, sev: CFG.gSevere }
      : { dv: CFG.dvVehicle, g: CFG.gVehicle, sev: CFG.gVehicleSevere };
  }
  function log(e) { e.t = +clock.toFixed(3); st.log.push(e); if (st.log.length > 60) st.log.shift(); }

  function injure(t, sev, why, dv, g) {
    const game = G(), inc = game.currentInc;
    if (t.kind === 'person') {
      if (t.injured) return false;
      game.injurePerson(t);
      if (!t.injured) return false;
      if (sev > 1) { t.severe = true; if (inc) inc.injuries++; game.hopeHit(3); }
    } else {
      if (t.occHurt) return false;
      const n = t.kind === 'heli' ? CFG.heliCrew : 1;
      t.occHurt = sev;
      if (inc) inc.injuries += n * sev;
      game.ledger.occInjuries = (game.ledger.occInjuries || 0) + n;
      game.hopeHit(4 * sev);
    }
    const who = t.kind === 'person' ? 'They' : t.kind === 'heli' ? 'The crew' : 'The driver';
    const what = why === 'catch' ? `Caught too hard (${dv.toFixed(0)} m/s).` : `${g.toFixed(0)} g is too much.`;
    game.toast(`${what} ${who} ${sev > 1 ? 'are badly hurt' : 'are hurt'}. Match their speed.`, 'alert');
    log({ kind: 'injure', why, who: t.kind, sev, dv: dv && +dv.toFixed(2), g: g && +g.toFixed(2) });
    return true;
  }

  // called by game.js grabBody (and missions.js fallers) before the body is attached
  function onGrab(t) {
    const game = G(); if (!game) return false;
    const P = game.P, s = ts();
    if (t.kind === 'car' && t.drive && !t.exploded) t.occupied = true;
    const tvx = t.vel.x * s, tvy = t.vel.y * s, tvz = t.vel.z * s;
    const dv = Math.hypot(tvx - P.vel.x, tvy - P.vel.y, tvz - P.vel.z);
    const d = t.pos.distanceTo(P.pos), close = d <= CFG.assistR + (t.kind === 'person' ? 0.6 : t.rad);
    const moving = Math.hypot(tvx, tvy, tvz) > 4;
    let hurt = false, cushioned = false;
    if (occupied(t)) {
      const r = rule(t);
      if (dv > r.dv) {
        const gEq = dv / CFG.absorbT / G0;
        hurt = injure(t, gEq > r.sev ? 2 : 1, 'catch', dv, gEq);
        st.hardCatches++;
      } else if (close) {
        // cushioned: he takes their velocity and the brake does the rest at <= 4 g
        P.vel.set(tvx, tvy, tvz); cushioned = true;
        if (moving) { st.softCatches++; game.toast(`Soft catch · ${dv.toFixed(1)} m/s`, 'good'); }
      }
    }
    st.catches++; st.held = t; st.overT = 0; st.g = 0; st.peak = 0;
    seed(P.vel); P.catchG = 0;
    log({ kind: 'catch', who: t.kind, dv: +dv.toFixed(2), close, cushioned, hurt });
    return hurt;
  }

  // called each frame while holding, after the hero's move and collisions (real dt)
  function carry(h, dt) {
    const P = G().P;
    clock += dt;
    if (h !== st.held) { st.held = h; seed(P.vel); st.overT = 0; st.peak = 0; }
    else push(P.vel);
    const g = sampleG(); st.g = g; P.catchG = g; if (g > st.peak) st.peak = g;
    if (!occupied(h)) return;
    const r = rule(h);
    if (g > r.sev) injure(h, 2, 'carry', 0, g);
    else if (g > r.g) { st.overT += dt; if (st.overT >= CFG.sustain) injure(h, 1, 'carry', 0, g); }
    else st.overT = 0;
  }

  // soft hands: coasting with a passenger never brakes harder than 4 g
  function coast(dt) {
    const P = G().P;
    if (!occupied(P.hold)) return false;
    const sp = P.vel.length(); if (sp < 1e-6) return true;
    const drop = Math.min(sp * (1 - Math.exp(-2.4 * dt)), CFG.softG * G0 * dt);
    P.vel.multiplyScalar((sp - drop) / sp);
    return true;
  }

  // ---- fallers: who can be caught right now
  let V3, TV, TV2;
  function scanFallers(game) {
    const P = game.P, s = ts();
    let best = null, bd = CFG.hudR, bvx = 0, bvy = 0, bvz = 0, mission = false;
    const consider = (b, vx, vy, vz, isMsn) => {
      const d = b.pos.distanceTo(P.pos); if (d >= bd) return;
      bd = d; best = b; bvx = vx; bvy = vy; bvz = vz; mission = isMsn;
    };
    for (const p of game.people) {
      if (p.mode !== 'phys' || p.onGround || p.thug || p.held) continue;
      if (!(p.danger || p.vel.y < -3)) continue;
      if (p.pos.y - Math.max(0, game.groundY(p.pos.x, p.pos.z)) < 1.5) continue;
      if (p === st.lastHeld && clock - st.releasedT < 3) continue;
      consider(p, p.vel.x * s, p.vel.y * s, p.vel.z * s, false);
    }
    const M = game.missions, m = M && M.current && M.current();
    if (m && m.phase === 'fall' && m.victim) consider(m.victim, 0, (m.fallV || 0) * s, 0, true);
    const inc = game.currentInc;
    if (inc && inc.type === 'heli' && inc.h && inc.h.phase === 'falling' && !inc.h.held && !inc.h.landed && !inc.h.crashed) {
      const h = inc.h; consider(h, h.vel.x * s, h.vel.y * s, h.vel.z * s, false);
    }
    st.faller = best; st.fallerMission = mission;
    if (best) {
      st.fallerD = bd; TV.set(bvx, bvy, bvz); st.fallerVel = TV;
      st.fallerDv = Math.hypot(bvx - P.vel.x, bvy - P.vel.y, bvz - P.vel.z);
      st.fallerClose = bd <= CFG.assistR + (best.kind === 'person' ? 0.6 : best.rad);
    } else { st.fallerDv = 0; st.fallerD = 0; st.fallerClose = false; }
  }

  // ---- triage: who is still in danger during an emergency
  const risk = [];   // { p, st: 'risk' | 'saved' | 'lost' } or { heli, n, st }
  let trInc = null, gold0 = 0, scanT = 0;
  function tracked(p) { for (const e of risk) if (e.p === p) return true; return false; }
  function trackIncident(game, dt) {
    const inc = game.currentInc;
    if (inc !== trInc) {
      if (trInc) finishIncident(game, trInc);
      trInc = inc; risk.length = 0; scanT = 0;
      if (!inc) return;
      gold0 = game.ledger.medals.gold;
      if (inc.trapped) for (const p of inc.trapped) risk.push({ p, st: 'risk' });
      if (inc.type === 'heli' && inc.h) risk.push({ heli: inc.h, n: CFG.heliCrew, st: 'risk' });
    }
    if (!inc) return;
    scanT -= dt;
    if (scanT <= 0) {
      scanT = 0.2;
      // newly endangered people (thrown, knocked off a roof); trapped ones belong to their own fire's list
      for (const p of game.people) if (p.danger && !p.thug && p.mode !== 'gone' && p.mode !== 'trapped' && !tracked(p)) risk.push({ p, st: 'risk' });
    }
    let total = 0, saved = 0, lost = 0, hurt = 0;
    for (const e of risk) {
      if (e.heli) {
        const h = e.heli;
        if (e.st === 'risk') e.st = h.landed ? 'saved' : h.crashed ? 'lost' : 'risk';
        total += e.n; if (e.st === 'saved') saved += e.n; if (e.st === 'lost') lost += e.n; if (h.occHurt) hurt += e.n;
        continue;
      }
      const p = e.p;
      if (e.st !== 'lost') {
        if (p.mode === 'safe') e.st = 'saved';
        else if (p.mode === 'gone') { if (e.st === 'risk') e.st = 'lost'; }
        else if (p.danger || p.mode === 'trapped' || p.mode === 'held' || (p.mode === 'phys' && !p.onGround)) e.st = 'risk';
        else e.st = 'saved';
      }
      total++; if (e.st === 'saved') saved++; if (e.st === 'lost') lost++; if (p.injured && e.st !== 'lost') hurt++;
    }
    inc.atRisk = total; inc.safe = saved; inc.riskLeft = total - saved - lost; inc.riskLost = lost; inc.riskHurt = hurt;
  }
  function finishIncident(game, inc) {
    const gold = game.ledger.medals.gold > gold0;
    if (gold && inc.atRisk > 0 && inc.safe === inc.atRisk && !inc.injuries) {
      inc.everyoneHome = true; st.everyoneHome = (st.everyoneHome || 0) + 1;
      setTimeout(() => game.toast(`Everyone home · ${inc.atRisk} of ${inc.atRisk} saved unhurt`, 'good'), 900);
    }
  }

  // ---- HUD
  const UI = {};
  const R_ARC = 50, CIRC = 2 * Math.PI * R_ARC, SWEEP = CIRC * 240 / 360, K = SWEEP / CFG.gMax;
  function band(cls, g0, g1) {
    return `<circle class="cg-band ${cls}" cx="60" cy="60" r="${R_ARC}" stroke-dasharray="${((g1 - g0) * K).toFixed(2)} ${CIRC.toFixed(2)}" stroke-dashoffset="${(-g0 * K).toFixed(2)}" transform="rotate(150 60 60)"/>`;
  }
  function buildDOM() {
    const hud = document.getElementById('hud'); if (!hud || UI.root) return;
    const css = document.createElement('style');
    css.textContent = `
#catch-hud { position: absolute; left: 50%; top: 50%; width: 120px; height: 120px; margin: -60px 0 0 -60px; pointer-events: none; opacity: 0; transition: opacity 0.18s; }
#catch-hud.on { opacity: 1; }
#catch-hud svg { position: absolute; inset: 0; overflow: visible; }
#catch-hud .cg-band { fill: none; stroke-width: 3; opacity: 0.35; }
#catch-hud .cg-ok { stroke: var(--ok); } #catch-hud .cg-warn { stroke: var(--sun); } #catch-hud .cg-bad { stroke: var(--cape); }
#catch-hud .cg-val { fill: none; stroke-width: 4; stroke-linecap: round; stroke: var(--ok); filter: drop-shadow(0 0 2px rgba(0,0,0,0.6)); }
#catch-hud.warn .cg-val { stroke: var(--sun); } #catch-hud.bad .cg-val { stroke: var(--cape); stroke-width: 7; }
#catch-hud .cg-read { position: absolute; left: 0; right: 0; top: 92px; text-align: center; font-family: var(--f-num); font-size: 13px; font-weight: 600;
  color: var(--text); text-shadow: 0 1px 2px rgba(0,0,0,0.8); font-variant-numeric: tabular-nums; white-space: nowrap; }
#catch-hud .cg-read i { font-style: normal; color: var(--cape); font-weight: 800; margin-left: 4px; display: none; }
#catch-hud.bad .cg-read i { display: inline; }
#catch-hud .cg-match { position: absolute; left: -20px; right: -20px; top: 112px; display: none; text-align: center; }
#catch-hud.closing .cg-match { display: block; }
#catch-hud .cg-bar { position: relative; height: 5px; margin: 0 14px 3px; border-radius: 3px; background: var(--panel); border: 1px solid var(--edge); overflow: hidden; }
#catch-hud .cg-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--ok); }
#catch-hud.fast .cg-bar i { background: var(--cape); }
#catch-hud .cg-bar u { position: absolute; left: 50%; top: -1px; bottom: -1px; width: 2px; background: var(--text); }
#catch-hud .cg-match span { font-family: var(--f-ui); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim);
  text-shadow: 0 1px 2px rgba(0,0,0,0.8); white-space: nowrap; }
#catch-hud .cg-match em { font-style: normal; font-family: var(--f-num); letter-spacing: 0; }
#catch-hud .cg-match b { font-family: var(--f-num); color: var(--text); font-weight: 600; letter-spacing: 0; }
#catch-hud.ready .cg-match span { color: var(--ok); }
#triage { color: var(--text); }
#triage b { font-family: var(--f-num); color: var(--sun); }
#triage.all b { color: var(--ok); }`;
    document.head.appendChild(css);
    const root = document.createElement('div'); root.id = 'catch-hud'; root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `<svg viewBox="0 0 120 120">${band('cg-ok', 0, 3)}${band('cg-warn', 3, 6)}${band('cg-bad', 6, CFG.gMax)}
<circle class="cg-val" cx="60" cy="60" r="${R_ARC}" stroke-dasharray="0 ${CIRC.toFixed(2)}" transform="rotate(150 60 60)"/></svg>
<div class="cg-read"><b>0.0</b> g<i>!</i></div>
<div class="cg-match"><div class="cg-bar"><i></i><u></u></div><span>Match speed <b>0.0</b> / <em>${CFG.dvPerson}</em> m/s</span></div>`;
    hud.appendChild(root);
    UI.root = root; UI.val = root.querySelector('.cg-val'); UI.read = root.querySelector('.cg-read b');
    UI.bar = root.querySelector('.cg-bar i'); UI.match = root.querySelector('.cg-match span');
    UI.mdv = root.querySelector('.cg-match b'); UI.lim = root.querySelector('.cg-match em');
    const tri = document.createElement('div'); tri.id = 'triage'; tri.className = 'mode'; tri.hidden = true;
    const mode = document.getElementById('mode');
    if (mode && mode.parentNode) mode.parentNode.insertBefore(tri, mode.nextSibling); else hud.appendChild(tri);
    UI.tri = tri; UI.last = {};
  }
  function set(key, el, prop, v) { if (UI.last[key] !== v) { UI.last[key] = v; el[prop] = v; } }
  function cls(name, on) { if (!!UI.last['c' + name] !== on) { UI.last['c' + name] = on; UI.root.classList.toggle(name, on); } }
  let hudT = 0;
  function updateHUD(game, dt) {
    if (!UI.root) return;
    hudT -= dt; if (hudT > 0) return; hudT = 1 / 30;
    const P = game.P, carrying = occupied(P.hold), closing = !P.hold && !!st.faller;
    const show = carrying || closing;
    cls('on', show);
    // carrying: the g on them; closing: what the catch would cost, if made now
    const lim = st.faller ? rule(st.faller).dv : CFG.dvPerson;
    const g = carrying ? st.g : closing ? st.fallerDv / CFG.absorbT / G0 : 0;
    // arc position on the person scale: the red band starts at the body's own limit (6 g, or the dv limit)
    const gs = carrying ? g * CFG.gPerson / rule(P.hold).g : closing ? st.fallerDv / lim * CFG.gPerson : 0;
    const warn = gs >= 3 && gs <= 6, bad = gs > 6;
    cls('warn', show && warn); cls('bad', show && bad);
    const dash = `${(Math.min(gs, CFG.gMax) * K).toFixed(1)} ${CIRC.toFixed(1)}`;
    if (UI.last.dash !== dash) { UI.last.dash = dash; UI.val.setAttribute('stroke-dasharray', dash); }
    set('read', UI.read, 'textContent', show ? g.toFixed(1) : '0.0');
    cls('closing', closing);
    if (closing) {
      const dv = st.fallerDv, ok = dv <= lim;
      set('mdv', UI.mdv, 'textContent', dv.toFixed(1));
      set('lim', UI.lim, 'textContent', String(lim));
      const w = Math.min(100, dv / (2 * lim) * 100).toFixed(0) + '%';
      if (UI.last.w !== w) { UI.last.w = w; UI.bar.style.width = w; }
      cls('fast', !ok); cls('ready', ok && st.fallerD < 8);
    } else { cls('fast', false); cls('ready', false); }
    // triage counter
    const inc = game.currentInc, n = inc && inc.atRisk;
    UI.tri.hidden = !n;
    if (n) {
      set('tri', UI.tri, 'innerHTML', `Saved <b>${inc.safe} / ${n}</b> at risk${inc.riskHurt ? ` · ${inc.riskHurt} hurt` : ''}${inc.riskLost ? ` · ${inc.riskLost} lost` : ''}`);
      if (!!UI.last.triAll !== (inc.safe === n)) { UI.last.triAll = inc.safe === n; UI.tri.classList.toggle('all', inc.safe === n); }
    }
  }

  function update(dt) {
    const game = G(); if (!game || !game.started) return;
    if (!UI.root) buildDOM();
    const P = game.P;
    if (P.hold) st.lastHeld = P.hold;
    else {
      if (st.held) { st.releasedT = clock; st.held = null; st.g = 0; P.catchG = 0; }
      clock += dt;   // carry() advances the clock while holding
    }
    scanFallers(game);
    // auto-assist: close and matched means caught, gently
    if (!P.hold && st.faller && !st.fallerMission && st.fallerClose && clock - st.releasedT > CFG.regrabT
        && st.fallerDv <= rule(st.faller).dv && game.grabBody) game.grabBody(st.faller);
    trackIncident(game, dt);
    updateHUD(game, dt);
  }

  window.SM_CATCH = {
    cfg: CFG, onGrab, carry, coast, occupied,
    get g() { return st.g; }, get peak() { return st.peak; },
    state() {
      return { g: +st.g.toFixed(3), peak: +st.peak.toFixed(3), overT: st.overT, faller: st.faller ? st.faller.kind : null, fallerDv: +st.fallerDv.toFixed(2),
        fallerD: +st.fallerD.toFixed(2), close: st.fallerClose, catches: st.catches, soft: st.softCatches, hard: st.hardCatches,
        everyoneHome: st.everyoneHome || 0, hud: !!(UI.root && UI.root.classList.contains('on')), tri: UI.tri && !UI.tri.hidden ? UI.tri.textContent : '' };
    },
    log: st.log,
    triage() { return risk.map(e => (e.heli ? 'heli×' + e.n : e.p.mode) + ':' + e.st); }
  };
  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function catchPlugin(c) {
    V3 = c.THREE.Vector3; TV = new V3(); TV2 = new V3();
    return { update };
  });
})();
