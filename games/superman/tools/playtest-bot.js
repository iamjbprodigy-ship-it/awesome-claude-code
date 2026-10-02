#!/usr/bin/env node
/* Automated playtest bot for Superman Over Metropolis.
 *
 *   node tools/playtest-bot.js [--shots] [--out DIR] [--quality low|shot] [--only name,name]
 *   (--only missions,dialogue,mission-shots for the street-level missions; mission-shots writes DIR/missions/*.png)
 *   (--only power-levels,ground-run,hearing for the power set; powers-shots writes DIR/powers/*.png)
 *   (--only feel for hit-stop, shake, camera framing and the landing tiers; feel-shots writes DIR/feel/*.png)
 *   (--only comms for the radio calls; comms-shots writes DIR/comms/*.png)
 *   Hang protection: --slow N scales every scenario's watchdog (default 8 min each), --max-minutes N caps the run,
 *   --timeout MS caps page loads; a hung scenario is a FAIL row, the browser is relaunched and the run goes on.
 *
 * Drives the real game in headless Chromium (Playwright) through every power, every emergency
 * type and a full tower collapse, asserting physics and gameplay invariants, timing the CPU
 * simulation, and optionally capturing screenshots from fixed camera rigs so each build can be
 * compared with the last. Writes DIR/report.json and prints a pass/fail table.
 */
'use strict';
const path = require('path');
const fs = require('fs');

let chromium;
for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require(p)); break; } catch (_) { /* try next */ }
}
if (!chromium) { console.error('Playwright is required: npm i -D playwright'); process.exit(2); }

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('out', path.join(__dirname, '..', '.playtest')));
const QUALITY = opt('quality', 'low');
// --quality also drives the gameplay scenarios (it used to reach only the --shots rigs, so `--quality high`
// never played the game at high); scenarios that pin a preset (render-budget, depth-buffer) keep theirs
const SCEN_QUALITY = args.includes('--quality') ? QUALITY : 'low';
// SwiftShader on a shared CPU can take minutes to build the city: generous timeouts, so a slow machine
// produces slow results instead of an uncaught TimeoutError that kills the whole run without a report
const LOAD_TIMEOUT = +opt('timeout', 600000);
const SHOTS = flag('shots');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const GAME = 'file://' + path.resolve(opt('file', path.join(__dirname, '..', 'index.html')));
fs.mkdirSync(OUT, { recursive: true });

// Each scenario runs in a fresh page. `run` executes in the browser and returns a result object;
// `check` turns it into a list of [label, pass, detail] assertions.
// Sim-cost budgets are judged on main-thread CPU time (CDP Performance.ThreadTime over the scenario's
// evaluate, divided by its frame count) when available. Wall-clock per frame on a shared, overloaded box
// measured 2-3x the CPU cost with single "frames" of 1.3 s that were the process being descheduled, which
// made these checks fail at random. Wall time is still printed next to it.
const simCost = r => (r.cpuMs > 0 ? r.cpuMs : r.ms);
const costNote = r => (r.cpuMs > 0 ? r.cpuMs.toFixed(2) + ' ms CPU avg (' + r.ms.toFixed(2) + ' wall)' : r.ms.toFixed(2) + ' ms wall avg');
const SCENARIOS = [
  {
    name: 'title-start',
    // real user path: wait for the title to say it's ready, then click Start / press Enter
    page: async (p) => {
      await p.waitForFunction(() => window.__game && window.__game.titleReady, null, { timeout: LOAD_TIMEOUT });
      const press = await p.textContent('#press');
      await p.click('#go');
      await p.waitForTimeout(500);
      const clicked = await p.evaluate(() => window.__game.started);
      return { press, clicked };
    },
    check: r => [['title says ready', /START/.test(r.press), r.press], ['clicking Start starts the game', r.clicked, '']]
  },
  {
    name: 'boot',
    run: `(() => { const g = __game; const unsupported = g.unsupportedAtStart(); g.begin(); g.step(60);
      return { unsupported, people: g.people.length, cars: g.bodies.filter(b => b.kind === 'car').length, buildings: g.buildings.length }; })()`,
    check: r => [['no floor starts unsupported', r.unsupported === 0, r.unsupported],
      ['city populated', r.people > 50 && r.cars > 40 && r.buildings > 30, `${r.people} people, ${r.cars} cars, ${r.buildings} towers`]]
  },
  {
    name: 'map',
    // a real emergency should put a pin on the minimap; M opens the city map, a click sets a waypoint
    page: async (p) => {
      await p.waitForFunction(() => window.__game && window.__game.titleReady, null, { timeout: LOAD_TIMEOUT });
      await p.evaluate(() => { const g = __game; g.begin(); g.P.pos.set(0, 120, 300); g.startIncident('fire'); g.step(30); g.render(); });
      const pins = await p.evaluate(() => __game.mapPins().map(q => q[2]));
      const miniShown = await p.isVisible('#minimap');
      if (SHOTS) await p.screenshot({ path: path.join(OUT, 'map-minimap.png'), timeout: 300000 });
      await p.keyboard.press('KeyM');
      await p.waitForTimeout(300);
      const opened = await p.isVisible('#bigmap');
      const t0 = await p.evaluate(() => __game.simT);
      await p.waitForTimeout(400);
      const paused = (await p.evaluate(() => __game.simT)) === t0;
      const box = await p.locator('#bigmap-c').boundingBox();
      await p.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.4);
      await p.waitForTimeout(300);
      const way = await p.evaluate(() => !!__game.MAP.waypoint);
      if (SHOTS) await p.screenshot({ path: path.join(OUT, 'map-city.png'), timeout: 300000 });
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
      const closed = !(await p.isVisible('#bigmap'));
      return { pins, miniShown, opened, paused, way, closed };
    },
    check: r => [['emergency has a map pin', r.pins.includes('inc'), r.pins.join(',')], ['minimap shows in game', r.miniShown, ''],
      ['M opens the city map', r.opened, ''], ['game pauses under the map', r.paused, ''],
      ['clicking the map sets a waypoint', r.way, ''], ['Esc closes the map', r.closed, '']]
  },
  {
    name: 'flight',
    // the subsonic street cap is a level 1-2 rule now (level 3 is allowed Mach 5 low), so test it at level 2
    run: `(() => { const g = __game; g.begin(); g.setPower(2); g.P.pos.set(0, 400, 0); g.setYawPitch(0, 0.1);
      g.keys.add('KeyW'); g.keys.add('ShiftLeft'); let boomed = false, maxSp = 0;
      for (let i = 0; i < 240; i++) { g.step(1); maxSp = Math.max(maxSp, g.P.vel.length()); boomed = boomed || g.P.boomed; }
      g.keys.clear(); g.P.pos.set(0, 60, 150); g.P.vel.set(0, 0, 0); g.keys.add('ShiftLeft'); g.keys.add('KeyW'); g.setYawPitch(0, 0);
      let lowMax = 0; for (let i = 0; i < 120; i++) { g.step(1); if (g.P.pos.y < 150) lowMax = Math.max(lowMax, g.P.vel.length()); }
      g.keys.clear(); return { maxSp, boomed, lowMax, alt: g.P.pos.y }; })()`,
    check: r => [['boost goes supersonic up high', r.maxSp > 340 && r.boomed, `${r.maxSp.toFixed(0)} m/s`],
      ['boost capped below 150 m (level 2)', r.lowMax <= 305, `${r.lowMax.toFixed(0)} m/s`]]
  },
  {
    name: 'power-levels',
    // boosted flight at 400 m for 5 s at each level, plus the low-altitude cap per level. `v` is the
    // SUSTAINED speed (mean of the last second), so a momentary spike can't pass for a top speed
    run: `(() => { const g = __game; g.begin(); const out = { stored: g.POWER };
      const fly = (lvl, alt) => { g.setPower(lvl); g.P.flying = true; g.P.pos.set(0, alt, 1500); g.P.vel.set(0, 0, 0); g.setYawPitch(0, 0);
        g.keys.clear(); g.keys.add('KeyW'); g.keys.add('ShiftLeft'); let mx = 0, sum = 0;
        for (let i = 0; i < 300; i++) { g.step(1); const v = g.P.vel.length(); mx = Math.max(mx, v); if (i >= 240) sum += v; }
        const v = sum / 60, a = g.P.pos.y; g.keys.clear();
        return { v: Math.round(v), peak: Math.round(mx), mach: +(v / Math.max(295, 340.3 - 0.0041 * a)).toFixed(2), alt: Math.round(a) }; };
      for (const l of [1, 2, 3]) { out['high' + l] = fly(l, 400); out['low' + l] = fly(l, 60); }
      let saved = null; try { saved = localStorage.getItem('sm-power'); } catch (_) {}
      out.saved = saved; g.setPower(3);
      // Mach 5 straight through the tallest tower at 30 m: he should come out the far side still fast
      const b = g.buildings.reduce((a, c) => c.ny > a.ny ? c : a), cx = (b.x0 + b.x1) / 2;
      g.P.flying = true; g.P.pos.set(cx, 30, b.z1 + 400); g.P.vel.set(0, 0, -1700); g.setYawPitch(0, 0); g.keys.clear(); g.keys.add('KeyW'); g.keys.add('ShiftLeft');
      let vIn = 0, vOut = 0, smashed = 0;
      for (let i = 0; i < 120 && !vOut; i++) { const z = g.P.pos.z; g.step(1); if (z > b.z1 + 2 && g.P.pos.z <= b.z1 + 2) vIn = g.P.vel.length(); if (g.P.pos.z < b.z0 - 20) vOut = g.P.vel.length(); }
      g.keys.clear(); out.smash = { vIn: Math.round(vIn), vOut: Math.round(vOut) }; return out; })()`,
    check: r => [['starts at level 3 (max)', r.stored === 3, r.stored],
      ['top speed rises with each level', r.high1.v < r.high2.v && r.high2.v < r.high3.v, `sustained ${r.high1.v} < ${r.high2.v} < ${r.high3.v} m/s`],
      ['level 1 is about Mach 1', r.high1.mach >= 1.0 && r.high1.mach < 1.3, 'Mach ' + r.high1.mach],
      ['level 2 reaches Mach 3', r.high2.mach >= 2.95, 'Mach ' + r.high2.mach],
      ['level 3 reaches Mach 10', r.high3.mach >= 10, 'Mach ' + r.high3.mach],
      ['levels 1-2 stay subsonic below 150 m', r.low1.v <= 305 && r.low2.v <= 305, `${r.low1.v}, ${r.low2.v} m/s`],
      ['level 3 goes much faster low down', r.low3.mach >= 4, 'Mach ' + r.low3.mach],
      ['choice is remembered (sm-power)', r.saved === '1' || r.saved === '2' || r.saved === '3', r.saved],
      ['smashing through a tower at Mach 5 keeps most of the speed', r.smash.vIn > 1000 && r.smash.vOut > r.smash.vIn * 0.7, `${r.smash.vIn} -> ${r.smash.vOut} m/s`]]
  },
  {
    name: 'ground-run',
    // Shift + W on foot along an avenue: a planted sprint at each level's speed, never flying
    run: `(() => { const g = __game; g.begin(); const out = {};
      for (const l of [1, 2, 3]) {
        g.setPower(l); g.P.flying = false; g.P.pos.set(-150, 0.97, 200); g.P.vel.set(0, 0, 0); g.setYawPitch(0, 0); g.step(5);
        g.keys.clear(); g.keys.add('KeyW'); g.keys.add('ShiftLeft'); let mx = 0, dev = 0, flew = false, sum = 0;
        for (let i = 0; i < 150; i++) { g.step(1); const hs = Math.hypot(g.P.vel.x, g.P.vel.z); if (i >= 120) sum += hs; mx = Math.max(mx, hs); flew = flew || g.P.flying;
          if (i > 10) dev = Math.max(dev, Math.abs(g.P.pos.y - 0.97 - g.groundY(g.P.pos.x, g.P.pos.z))); }
        out[l] = { v: +(sum / 30).toFixed(1), peak: +mx.toFixed(1), target: g.PWR.run[l - 1], dev: +dev.toFixed(3), flew, runK: +g.P.runK.toFixed(2), fov: Math.round(g.camera.fov) };
        g.keys.clear();
      }
      return out; })()`,
    check: r => [1, 2, 3].flatMap(l => [[`level ${l} sprint reaches ${r[l].target} m/s`, r[l].v >= r[l].target * 0.99, r[l].v + ' m/s'],
      [`level ${l} stays on the ground (within 0.5 m)`, r[l].dev <= 0.5 && !r[l].flew, `max ${r[l].dev} m off, flying ${r[l].flew}`],
      [`level ${l} run pose and camera engage`, r[l].runK > 0.9 && r[l].fov > 75, `runK ${r[l].runK}, fov ${r[l].fov}`]])
  },
  {
    name: 'hearing',
    // an injured bystander and an active robbery nearby; holding H must hear them and mark them
    run: `(() => { const g = __game; g.begin(); g.setPower(3); g.P.flying = true; g.P.pos.set(0, 60, 100); g.P.vel.set(0, 0, 0); g.step(2);
      const v = g.people.find(p => p.mode === 'free'); v.pos.set(30, 0.9, 120); g.injurePerson(v); v.mode = 'down';
      g.startIncident('robbery'); g.step(5); g.keys.add('KeyH'); g.step(30);
      const heard = g.heard(), on = g.hearOn;
      const marks = [...document.querySelectorAll('#markers .mk')].filter(d => d.style.display !== 'none').map(d => d.textContent);
      const toasts = [...document.querySelectorAll('#toasts .toast')].map(d => d.textContent);
      g.keys.clear(); g.step(10); const off = !g.hearOn;
      // a minor need: listening again after the crime has been heard picks up an ambient call
      g.HEAR.minorCD = 0; g.keys.add('KeyH'); g.step(5); const minor = g.HEAR.minor.map(n => n.kind); g.keys.clear(); g.step(5);
      // a missions.js help request is heard too, and listening in a calm moment can bring one forward
      const M = g.missions; let msn = null, surfaced = null;
      if (M) { M.spawn('cat'); g.keys.add('KeyH'); g.step(5); msn = g.heard().find(h => h.kind === 'help') || null; g.keys.clear(); g.step(2); M.cancel();
        for (const p of g.people) if (p.mode === 'thug' || p.mode === 'stuck' || p.mode === 'down') p.mode = 'gone';
        if (g.currentInc) g.currentInc.age = 1e9; g.step(30); g.HEAR.minor.length = 0; g.HEAR.minorCD = 0; g.HEAR.nextMsn = true; g.deferIncident(300);
        const was = !!g.currentInc; g.keys.add('KeyH'); g.step(40);
        surfaced = { state: M.state, heard: g.heard().some(h => h.kind === 'help'), inc: was, toast: [...document.querySelectorAll('#toasts .toast')].map(d => d.textContent).find(t => /crying for help/.test(t)) || '' };
        g.keys.clear(); g.step(5); }
      return { heard, on, marks, toasts, off, minor, msn, surfaced }; })()`,
    check: r => [['holding H listens', r.on, ''],
      ['hears at least one source', r.heard.length > 0, r.heard.map(h => h.label + ' ' + h.d + ' m').join(', ')],
      ['hears the injured person', r.heard.some(h => h.kind === 'hurt'), ''],
      ['hears the robbery', r.heard.some(h => h.kind === 'crime'), ''],
      ['heard sources get markers', r.marks.some(m => /Heartbeat|Cry for help|shots fired/.test(m)), r.marks.slice(0, 4).join(' | ')],
      ['fresh crime toast', r.toasts.some(t => /You hear: .*robbery/.test(t)), r.toasts.find(t => /You hear/.test(t)) || ''],
      ['releasing H stops listening', r.off, ''],
      ['listening between emergencies can find a minor need', r.minor.length === 1, r.minor.join(',')],
      ['hears an active missions.js help request', !!r.msn, r.msn ? r.msn.label + ' ' + r.msn.d + ' m' : 'none'],
      ['listening when calm surfaces a missions.js request', !!r.surfaced && r.surfaced.heard && r.surfaced.state === 'flag', JSON.stringify(r.surfaced)]]
  },
  {
    name: 'punch-and-collapse', minutes: 10, cpuFrames: 1805,
    run: `(() => { const g = __game; g.begin(); const b = g.buildings.reduce((a, c) => c.ny > a.ny ? c : a);
      const blocks0 = b.nx * b.ny * b.nz; let alive0 = 0;
      for (let k = 0; k < blocks0; k++) if (g.blockAt) {}
      g.P.pos.set(b.x0 - 3, 3, (b.z0 + b.z1) / 2); g.setYawPitch(-Math.PI / 2, -0.05); g.punch(4); g.step(5);
      const afterPunch = g.liveDebrisCount + g.rubble.length;
      for (let z = 0; z < b.nz; z++) for (let x = 0; x < b.nx; x++) for (let y = 0; y < 2; y++) g.breakBlock(g.cellIndex(b, x, y, z), new THREE.Vector3(), 4, 'blast');
      let peakLive = 0, nan = 0, t0 = performance.now(), worstFrame = 0;
      for (let i = 0; i < 1800; i++) { const a = performance.now(); g.update(1 / 60); worstFrame = Math.max(worstFrame, performance.now() - a); peakLive = Math.max(peakLive, g.liveDebrisCount); }
      const ms = (performance.now() - t0) / 1800;
      for (const o of g.bodies) if (!isFinite(o.pos.x + o.pos.y + o.pos.z)) nan++;
      return { cap: g.liveCap, afterPunch, peakLive, live: g.liveDebrisCount, rubble: g.rubble.length, queue: g.fallQueue.length, nan, ms, worstFrame, damage: g.ledger.damage }; })()`,
    check: r => [['punch breaks the wall', r.afterPunch > 0, r.afterPunch + ' pieces'],
      ['tower comes down', r.rubble + r.live > 150, `${r.rubble} rubble, ${r.live} live`],
      ['live debris stays under cap', r.peakLive <= r.cap, r.peakLive + ' / ' + r.cap],
      ['collapse finishes (queue drains)', r.queue === 0, r.queue],
      ['no NaN bodies', r.nan === 0, r.nan],
      ['collapse sim cost (ms/frame, CPU)', simCost(r) < 12, costNote(r) + ', ' + r.worstFrame.toFixed(1) + ' ms worst wall frame']]
  },
  {
    name: 'superpowers', minutes: 10,
    run: `(() => { const g = __game; g.begin(); const out = {};
      const b = g.buildings.reduce((a, c) => c.ny > a.ny ? c : a);
      const zc = (b.z0 + b.z1) / 2, y = 30, alive0 = g.bodies.length + g.rubble.length;
      // fly straight through the tallest tower at 90 m/s
      g.P.flying = true; g.P.pos.set(b.x0 - 25, y, zc); g.setYawPitch(-Math.PI / 2, 0); g.keys.add('KeyW');
      for (let i = 0; i < 120; i++) { g.P.vel.set(Math.max(g.P.vel.x, 90), 0, 0); g.step(1); if (g.P.pos.x > b.x1 + 8) break; }
      g.keys.clear(); out.exitX = g.P.pos.x - b.x1; out.speed = g.P.vel.length(); out.pieces = g.bodies.length + g.rubble.length - alive0;
      // heat vision cutting the base of another tower for 3 s
      const t2 = g.buildings.filter(c => c !== b && c.ny > 10)[0];
      g.P.flying = true; g.P.pos.set(t2.x0 - 30, 6, (t2.z0 + t2.z1) / 2); g.P.vel.set(0, 0, 0); g.step(2);
      let melted = 0; const count = () => { let n = 0; for (let z = 0; z < t2.nz; z++) for (let x = 0; x < t2.nx; x++) for (let yy = 0; yy < 3; yy++) if (g.blockAt(t2.x0 + (x + 0.5) * 5, yy * 4 + 2, t2.z0 + (z + 0.5) * 5) < 0) n++; return n; };
      const before = count(); g.keys.add('KeyR');
      for (let i = 0; i < 180; i++) { const c = g.camera.position, tx = t2.x0 + 2.5, tz = t2.z0 + 2.5 + ((i * 0.15) % (t2.z1 - t2.z0 - 5)); const dx = tx - c.x, dy = 4 - c.y, dz = tz - c.z; g.setYawPitch(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))); g.step(1); }
      g.keys.clear(); out.melted = count() - before; return out; })()`,
    check: r => [['flies clean through a tower', r.exitX > 0, `exited ${r.exitX.toFixed(1)} m past the far wall`],
      ['keeps his speed through the building', r.speed > 50, r.speed.toFixed(0) + ' m/s'],
      ['leaves a hole (debris made)', r.pieces > 10, r.pieces + ' pieces'],
      ['heat vision cuts through the structure', r.melted >= 4, r.melted + ' blocks melted in 3 s']]
  },
  {
    name: 'powers',
    run: `(() => { const g = __game; g.begin(); const out = {};
      const car = g.bodies.find(b => b.kind === 'car' && b.parked);
      g.P.flying = true; g.P.pos.copy(car.pos).add(new THREE.Vector3(-12, 3, 0)); g.P.vel.set(0, 0, 0);
      g.setYawPitch(-Math.PI / 2, -0.12); g.step(2);
      const aim = () => { const c = g.camera.position, d = car.pos.clone().sub(c); g.setYawPitch(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))); };
      aim(); g.step(30); aim();
      g.keys.add('KeyR'); let t = 0; while (!car.exploded && t < 600) { aim(); g.step(1); t++; } g.keys.delete('KeyR');
      out.heatSeconds = t / 60; out.exploded = !!car.exploded;
      const car2 = g.bodies.find(b => b.kind === 'car' && b.parked && !b.exploded && b !== car);
      g.P.pos.copy(car2.pos).add(new THREE.Vector3(-3, 1.5, 0)); g.setYawPitch(-Math.PI / 2, -0.2); g.step(2);
      g.grabOrRelease(); out.grabbed = !!g.P.hold; g.step(10); g.setYawPitch(-Math.PI / 2, 0.3); g.throwHeld(4);
      // peak launch speed over the next 20 frames (a level-3 throw is fast enough to reach a wall and stop in that time)
      let tv = 0; for (let i = 0; i < 20; i++) { g.step(1); tv = Math.max(tv, car2.vel.length()); } out.thrownSpeed = tv;
      g.P.pos.set(0, 80, 0); g.P.vel.set(0, 0, 0); g.clap(); g.step(5); out.clap = true;
      g.keys.add('KeyQ'); g.step(30); g.keys.delete('KeyQ'); out.freeze = true;
      g.P.pos.set(0, 120, 0); g.P.flying = false; let landed = false; for (let i = 0; i < 400 && !landed; i++) { g.step(1); landed = g.P.grounded; }
      out.landed = landed; return out; })()`,
    check: r => [['heat vision ignites a car', r.exploded, r.heatSeconds.toFixed(1) + ' s'],
      ['grab works', r.grabbed, ''], ['throw launches by weight', r.thrownSpeed > 40, r.thrownSpeed.toFixed(0) + ' m/s'],
      ['clap and freeze run', r.clap && r.freeze, ''], ['fall and land', r.landed, '']]
  },
  {
    name: 'emergencies', minutes: 15,
    run: `(() => { const g = __game; g.begin(); const res = {};
      for (const type of ['heli', 'meteor', 'kryptonite', 'fire', 'robbery']) {
        g.startIncident(type); const inc = g.currentInc; res[type] = { started: !!inc, title: inc && inc.title };
        let t = 0; while (g.currentInc === inc && t < 60 * 160) { g.step(10); t += 10; }
        res[type].ended = g.currentInc !== inc; res[type].seconds = Math.round(t / 60);
      }
      res.ledger = { saves: g.ledger.saves, lost: g.ledger.lost, hope: Math.round(g.ledger.hope), resolved: g.ledger.resolved };
      return res; })()`,
    check: r => ['heli', 'meteor', 'kryptonite', 'fire', 'robbery'].map(t => [`${t} starts and ends unattended`, r[t].started && r[t].ended, `${r[t].seconds} s`])
      .concat([['ledger sane', r.ledger.hope >= 0 && r.ledger.hope <= 100, JSON.stringify(r.ledger)]])
  },
  {
    name: 'look-up', minutes: 10,
    // looking straight up must show sky, not holes: the 380 km sky dome sat one float32 ulp inside the far
    // plane, so dome triangles near the zenith were clipped and the clear colour showed as black shards
    // one render + readback per evaluate, yielding in between: long synchronous render loops can wedge SwiftShader
    page: async (p) => {
      if (process.env.BOT_DEBUG) console.log('  look-up: page ready');
      await p.evaluate(() => { __game.begin(); __game.deferIncident(1e6); });
      const out = {};
      for (const alt of [100, 400, 2000]) for (const pitch of [1.45, Math.PI / 2]) {
        out[alt + 'm@' + pitch.toFixed(2)] = await p.evaluate(([alt, pitch]) => { const g = __game;
          g.keys.clear(); g.P.flying = true; g.P.pos.set(-30, alt, 120); g.P.vel.set(0, 0, 0); g.setYawPitch(0.4, pitch); g.step(30);
          // render the scene into an 8-bit target and read that back (reading the default framebuffer
          // between frames could wedge headless SwiftShader); clear to magenta so a hole in the dome is unmistakable
          const w = 480, h = 270, r = g.renderer, rt = window.__lookRT = window.__lookRT || new THREE.WebGLRenderTarget(w, h, { stencilBuffer: true }), px = new Uint8Array(w * h * 4);
          const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(); r.setClearColor(0xff00ff, 1);
          r.setRenderTarget(rt); r.clear(); r.render(g.scene, g.camera); r.setRenderTarget(null); r.setClearColor(cc, ca); r.readRenderTargetPixels(rt, 0, 0, w, h, px);
          let n = 0, tot = 0; for (let y = h >> 2; y < h * 3 >> 2; y++) for (let x = w >> 2; x < w * 3 >> 2; x++) { const i = (y * w + x) * 4; tot++; if (px[i] > 200 && px[i + 1] < 40 && px[i + 2] > 200) n++; }
          return n / tot; }, [alt, pitch]);
        if (process.env.BOT_DEBUG) console.log('  look-up', alt, pitch.toFixed(2), out[alt + 'm@' + pitch.toFixed(2)]);
        await p.waitForTimeout(30);
      }
      if (SHOTS) await p.screenshot({ path: path.join(OUT, 'look-up.png'), timeout: 300000 });
      return out;
    },
    check: r => [['no holes in the sky dome looking up (clear colour < 0.05% of centre)', Object.values(r).every(v => v < 0.0005), Object.entries(r).map(([k, v]) => k + ' ' + (v * 100).toFixed(2) + '%').join(', ')]]
  },
  {
    name: 'depth-buffer', quality: 'high',
    // the scene targets must have a 24-bit depth buffer: three r128 gives 16-bit depth to any render target
    // without a stencil buffer, which made stacked road layers z-fight away at range
    run: `(() => { const g = __game, r = g.renderer, gl = r.getContext(), out = {};
      for (const k of ['renderTarget1', 'renderTarget2']) { r.setRenderTarget(g.composer[k]); out[k] = gl.getParameter(gl.DEPTH_BITS); }
      r.setRenderTarget(null); out.samples = g.composer.renderTarget1.samples || 0; return out; })()`,
    check: r => [['scene render targets have >= 24-bit depth', r.renderTarget1 >= 24 && r.renderTarget2 >= 24, `${r.renderTarget1} / ${r.renderTarget2} bits, ${r.samples}x MSAA`]]
  },
  {
    name: 'emergency-endings', minutes: 10,
    // every emergency must end: a chopper set down on a roof or in the bay, a meteor dropped in the bay, and
    // a meteor carried around past its limit all used to leave the incident running forever (no new alerts)
    run: `(() => { const g = __game, P = g.P; g.begin(); g.deferIncident(1e6); g.step(5); const out = {};
      const aimAt = v => { const d = v.clone().sub(P.pos); g.setYawPitch(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))); };
      const grab = body => { P.flying = true; P.vel.set(0, 0, 0); P.pos.copy(body.pos).add(new THREE.Vector3(0, 0, 4)); aimAt(body.pos); g.grabOrRelease(); return P.hold === body; };
      const run = (name, setup, place, maxS) => {
        const r0 = g.ledger.resolved, m0 = JSON.stringify(g.ledger.medals), h0 = g.ledger.hope;
        g.startIncident(setup); const inc = g.currentInc; const body = inc.h || inc.m; const res = { grabbed: grab(body) };
        place(body); let t = 0; while (g.currentInc === inc && t < 60 * maxS) { g.step(10); t += 10; }
        Object.assign(res, { ended: g.currentInc !== inc, seconds: Math.round(t / 60), limit: inc.limit, resolved: g.ledger.resolved - r0, medals: m0 !== JSON.stringify(g.ledger.medals), hope: Math.round(g.ledger.hope - h0) });
        if (P.hold) g.grabOrRelease(); g.deferIncident(1e6); out[name] = res; };
      const roof = g.buildings.filter(b => b.ny > 6 && b.ny < 20)[0];
      // after letting go he flies clear, so the auto-catch of a falling chopper doesn't grab it straight back
      const away = () => { g.step(1); P.pos.y += 80; P.vel.set(0, 0, 0); };
      run('heliOnRoof', 'heli', h => { P.pos.set((roof.x0 + roof.x1) / 2, roof.h + 1.2, (roof.z0 + roof.z1) / 2); P.vel.set(0, 0, 0); g.step(2); g.grabOrRelease(); away(); }, 60);
      run('heliInBay', 'heli', h => { P.pos.set(0, 4, 420); P.vel.set(0, 0, 0); g.step(2); g.grabOrRelease(); away(); }, 60);
      run('meteorInBay', 'meteor', m => { P.pos.set(40, 5, 420); P.vel.set(0, 0, 0); g.step(2); g.grabOrRelease(); away(); }, 60);
      run('meteorHeld', 'meteor', m => { P.pos.set(0, 300, 0); P.vel.set(0, 0, 0); }, 120);
      return out; })()`,
    check: r => ['heliOnRoof', 'heliInBay', 'meteorInBay', 'meteorHeld'].map(k => [`${k}: grabbed, then the emergency ends`, r[k].grabbed && r[k].ended && r[k].seconds <= r[k].limit + 35, `${r[k].seconds} s (limit ${r[k].limit})`])
      .concat(['heliOnRoof', 'heliInBay', 'meteorInBay', 'meteorHeld'].map(k => [`${k}: counted as a save (medal, Hope up)`, r[k].resolved === 1 && r[k].medals && r[k].hope > 0, `resolved ${r[k].resolved}, Hope ${r[k].hope >= 0 ? '+' : ''}${r[k].hope}`]))
  },
  {
    name: 'render-budget', minutes: 12, quality: 'high',
    // GPU work per frame in the heaviest views (draw calls and triangles, all passes incl. shadows and post)
    run: `(() => { const g = __game, out = {}; g.begin(); const info = g.renderer.info; info.autoReset = false;
      const rigs = { street: [-150, 1.2, 152, -1.2, 0.06, false], waterfront: [40, 30, 236, Math.PI, -0.05, true], aerial: [0, 260, 380, 0, -0.18, true] };
      for (const k in rigs) { const r = rigs[k]; g.P.flying = r[5]; g.P.pos.set(r[0], r[1], r[2]); g.P.vel.set(0, 0, 0); g.setYawPitch(r[3], r[4]); g.step(20);
        info.reset(); g.composer.render(); out[k] = { calls: info.render.calls, tris: info.render.triangles }; }
      g.P.pos.set(0, 300, 400); g.P.vel.set(0, 0, -680); g.setYawPitch(0, 0); g.keys.add('KeyW'); g.keys.add('ShiftLeft');
      const t0 = performance.now(); g.step(240); out.fastFlightMs = (performance.now() - t0) / 240; g.keys.clear();
      info.reset(); g.composer.render(); out.fast = { calls: info.render.calls, tris: info.render.triangles, speed: Math.round(g.P.vel.length()) };
      return out; })()`,
    check: r => ['street', 'waterfront', 'aerial', 'fast'].map(k => [`${k} draw calls within budget (400)`, r[k].calls <= 400, `${r[k].calls} calls, ${(r[k].tris / 1e6).toFixed(2)}M tris`])
      .concat(['street', 'waterfront', 'aerial', 'fast'].map(k => [`${k} triangles within budget (3M incl. shadow pass)`, r[k].tris <= 3e6, (r[k].tris / 1e6).toFixed(2) + 'M']))
      .concat([['supersonic flight sim cost (ms/frame, CPU)', r.fastFlightMs < 6, r.fastFlightMs.toFixed(2) + ' ms at ' + r.fast.speed + ' m/s']])
  },
  {
    name: 'robustness',
    // bad inputs must be rejected, not poison the sim: a NaN dt froze simT, and a NaN position made
    // buildingAt() index lotInfo[NaN] and throw every frame
    run: `(() => { const g = __game; g.begin(); g.step(5); const out = { threw: [] };
      for (const dt of [undefined, NaN, Infinity, -0.02]) { try { g.update(dt); } catch (e) { out.threw.push(String(dt) + ': ' + e.message); } }
      try { out.nanBlock = g.blockAt(NaN, 2, NaN); } catch (e) { out.threw.push('blockAt(NaN): ' + e.message); }
      try { g.step(10); } catch (e) { out.threw.push('step after: ' + e.message); }
      out.simT = g.simT; out.pos = g.P.pos.toArray(); return out; })()`,
    check: r => [['bad dt / NaN position never throw', r.threw.length === 0, r.threw.join(' | ')],
      ['simT stays finite', Number.isFinite(r.simT), String(r.simT)], ['NaN lookup is a miss', r.nanBlock === -1, String(r.nanBlock)],
      ['player position stays finite', r.pos.every(Number.isFinite), r.pos.join(',')]]
  },
  {
    name: 'idle-sim-cost', cpuFrames: 660,
    run: `(() => { const g = __game; g.begin(); g.step(60); const t0 = performance.now(); g.step(600); return { ms: (performance.now() - t0) / 600 }; })()`,
    check: r => [['idle sim cost (ms/frame, CPU)', simCost(r) < 6, costNote(r)]]
  }
];

// Street-level help missions (js/missions.js): drives one mission of the given type to success with
// scripted inputs (teleports plus __game.missions.press/release, which route through the real key handler).
const MISSION_TYPES = ['pinned', 'beam', 'ledge', 'bay', 'crime', 'kid', 'worker', 'cat', 'washer'];
const DRIVE_MISSION = `(type) => {
  const g = __game, M = g.missions, P = g.P, V = THREE.Vector3;
  if (M.current()) M.cancel();
  g.ledger.hope = 50; P.slow = false; if (P.hold) g.grabOrRelease();
  const tp = (v, dx, dy, dz, fly) => { P.pos.set(v.x + dx, v.y + dy, v.z + dz); P.vel.set(0, 0, 0); P.flying = fly; };
  const aim = v => { const d = new V().copy(v).sub(P.pos); g.setYawPitch(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))); };
  const until = (fn, n) => { for (let i = 0; i < n; i++) { if (fn()) return true; g.step(1); } return !!fn(); };
  if (!M.spawn(type)) return { type, spawned: false };
  const m = M.current(), real = m.type, h0 = g.ledger.hope, n0 = g.ledger.missions, s0 = g.ledger.saves;
  tp(m.giver.pos, 1.5, 0.1, 0, false); g.step(2);
  M.press('KeyE'); M.release('KeyE');
  const talked = M.state; g.step(60);
  const out = { type: real, spawned: true, talked, active: M.state };
  if (real === 'pinned') { tp(m.victim.pos, 1.6, 0.75, 0, false); g.step(2); M.press('KeyE'); g.step(150); M.release('KeyE'); }
  else if (real === 'beam') { tp(m.victim.pos, 1.6, 0.75, 0, false); g.step(2); for (let i = 0; i < 40 && M.state === 'active'; i++) { M.press('Space'); M.release('Space'); g.step(5); } }
  else if (real === 'ledge') { const v = m.victim.pos; tp(v, m.f.nx * 2.2, 0, m.f.nz * 2.2, true); g.step(2); out.sawWindow = until(() => { const q = M.qte(); return q && q.inWindow; }, 400); M.press('KeyE'); }
  else if (real === 'bay') {
    const c = m.car; g.step(30); tp(c.pos, 0, 3.2, 0, true); aim(c.pos); g.step(1); aim(c.pos); M.press('KeyE'); out.grabbed = !!c.held;
    P.pos.set(c.pos.x, 2.6, 226); P.vel.set(0, 0, 0); g.step(3); M.press('KeyE'); until(() => M.state !== 'active', 300);
  }
  else if (real === 'crime') {
    const r = m.robber; out.robber = !!r;
    out.qte = until(() => { if (M.phase === 'chase') { tp(r.pos, 1.2, 0.1, 0, false); } return M.phase === 'qte'; }, 200);
    out.sawWindow = until(() => { const q = M.qte(); return q && q.inWindow; }, 200); M.press('KeyE');
    out.phase = M.phase; g.step(3);
    tp(m.giver.pos, 1.5, 0.1, 0, false); g.step(2); M.press('KeyE');
  }
  else if (real === 'kid' || real === 'worker') {
    const who = real === 'kid' ? m.giver : m.victim, dest = real === 'kid' ? m.parent.pos : g.HOSP;
    tp(who.pos, 1.5, 0.3, 0, false); g.step(1); aim(who.pos); M.press('KeyE'); out.carried = who.mode === 'held';
    g.step(2); tp(dest, 2, 0.97 - dest.y + (real === 'kid' ? dest.y - 0.9 : 0), 0, false); g.step(3); M.press('KeyE'); g.step(5);
  }
  else if (real === 'cat') { tp(m.cat, 1, 0, 0, true); g.step(2); M.press('KeyE'); out.carried = M.phase; g.step(2); tp(m.giver.pos, 1.5, 0.1, 0, false); g.step(3); M.press('KeyE'); }
  else if (real === 'washer') { out.fell = until(() => M.phase === 'fall', 600); g.step(2); const v = m.victim.pos; tp(v, 0.6, -0.8, 0, true); g.step(2); }
  g.step(2);
  Object.assign(out, { state: M.state, phase: M.phase, hope0: Math.round(h0), hope1: Math.round(g.ledger.hope), missions: g.ledger.missions - n0, saves: g.ledger.saves - s0 });
  g.step(400);
  out.after = M.state; P.slow = false; if (P.hold) g.grabOrRelease();
  return out;
}`;
SCENARIOS.push(
  {
    name: 'missions', minutes: 12,
    run: `(() => { const g = __game, M = g.missions; g.begin(); g.step(30); const drive = ${DRIVE_MISSION}; const out = { types: {} };
      for (const t of ${JSON.stringify(MISSION_TYPES)}) out.types[t] = drive(t);
      // a request nobody finishes times out gracefully and costs Hope
      g.ledger.hope = 50; M.spawn('cat'); M.talk(); g.step(60); const lim = M.cfg.types.cat.limit;
      for (let i = 0; i < lim + 5 && M.state === 'active'; i++) g.step(60);
      out.timeout = { state: M.state, hope: Math.round(g.ledger.hope), failed: g.ledger.missionsFailed }; g.step(400);
      // the scheduler opens a request on its own when the city is calm...
      g.deferIncident(120); M.setSpawnTimer(0.5); g.step(60); out.sched = M.state;
      // ...and the person waves you off when a major emergency starts
      g.startIncident('robbery'); g.step(5); out.waveOff = M.state; g.step(200);
      M.setSpawnTimer(0.5); g.step(120); out.duringInc = { state: M.state, inc: !!g.currentInc };
      out.pins = g.mapPins().map(p => p[2]); out.lines = M.lineCount(); out.hud = !!document.getElementById('st-help');
      return out; })()`,
    check: r => MISSION_TYPES.map(t => { const x = r.types[t] || {};
      return [`${t}: talk -> task -> success`, x.spawned && x.talked === 'talk' && x.active === 'active' && x.state === 'success' && x.after === 'idle', `${x.state} (${x.phase})`]; })
      .concat(MISSION_TYPES.map(t => { const x = r.types[t] || {}; return [`${t}: Hope up, ledger counts it`, x.hope1 > x.hope0 && x.missions === 1, `Hope ${x.hope0} -> ${x.hope1}`]; }))
      .concat([['unfinished request times out (fail, Hope down)', r.timeout.state === 'fail' && r.timeout.hope < 50 && r.timeout.failed >= 1, JSON.stringify(r.timeout)],
        ['scheduler opens a request when calm', r.sched === 'flag', r.sched],
        ['request waved off when an emergency starts', r.waveOff === 'expired' || r.waveOff === 'idle', r.waveOff],
        ['no request while an emergency runs', r.duringInc.state === 'idle' && r.duringInc.inc, JSON.stringify(r.duringInc)],
        ['150+ lines of dialogue', r.lines >= 150, r.lines + ' lines'], ['HUD shows help requests', r.hud, '']])
  },
  {
    name: 'dialogue',
    run: `(() => { const g = __game, M = g.missions; g.begin(); g.step(30); g.ledger.hope = 50;
      const p = g.people.filter(q => q.mode === 'free' && !q.thug && Math.abs(q.pos.x) < 200 && q.pos.z < 200 && q.pos.z > -200)[0];
      g.P.flying = false; g.P.pos.set(p.pos.x + 2.5, 14, p.pos.z); g.P.vel.set(0, 0, 0);
      const n0 = M.barkLog().length, t0 = M.clock; let first = -1;
      for (let i = 0; i < 300; i++) { g.step(1); if (M.barkLog().length > n0) { first = M.clock - t0; break; } }
      const firstCat = (M.barkLog()[n0] || {}).cat;
      // rate limit: hammer the bark API for 10 s of game time
      const L0 = M.barkLog().length; let maxVis = 0;
      for (let i = 0; i < 300; i++) { M.bark('landHigh'); M.bark('flyHigh'); M.bark('damage'); g.step(2); maxVis = Math.max(maxVis, M.visibleBarks()); }
      const log = M.barkLog().slice(L0).filter(b => !b.prio); let minGap = 99;
      for (let i = 1; i < log.length; i++) minGap = Math.min(minGap, log[i].t - log[i - 1].t);
      return { first, firstCat, spam: log.length, attempts: 900, minGap, maxVis, gap: M.cfg.bark.minGap, cap: M.cfg.bark.maxVisible }; })()`,
    check: r => [['landing near people gets a bark within 3 s', r.first >= 0 && r.first < 3, r.first >= 0 ? `${r.first.toFixed(2)} s (${r.firstCat})` : 'none'],
      ['rate limit: min gap between ordinary barks', r.spam > 1 && r.minGap >= r.gap - 1e-6, `${r.spam} of ${r.attempts} requests shown, min gap ${r.minGap.toFixed(2)} s`],
      ['rate limit: bubbles on screen capped', r.maxVis <= r.cap, `${r.maxVis} / ${r.cap}`]]
  },
  {
    name: 'mission-shots', shotsOnly: true,
    // screenshots of a QTE and of dialogue bubbles: OUT/missions/*.png
    page: async (p) => {
      const dir = path.join(OUT, 'missions'); fs.mkdirSync(dir, { recursive: true });
      const shots = [];
      const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
      await p.evaluate(() => { __game.begin(); __game.step(30); });
      // 1. the ledge timing ring
      const ledge = await p.evaluate(() => { const g = __game, M = g.missions, P = g.P; if (!M.spawn('ledge')) return false; const m = M.current();
        P.pos.set(m.giver.pos.x + 1.5, 1, m.giver.pos.z); P.flying = false; g.step(2); M.press('KeyE'); g.step(60);
        const v = m.victim.pos; P.flying = true; P.pos.set(v.x + m.f.nx * 3.2, v.y - 0.6, v.z + m.f.nz * 3.2); P.vel.set(0, 0, 0);
        const d = v.clone().sub(P.pos); g.setYawPitch(Math.atan2(-d.x, -d.z) + 0.35, 0.12);
        for (let i = 0; i < 200; i++) { g.step(1); const q = M.qte(); if (q && q.ring < 0.55 && q.ring > 0.45) break; } g.render(); return !!M.qte(); });
      await snap('qte-ledge.png');
      // 2. pinned under a car: the hold ring half full
      const pinned = await p.evaluate(() => { const g = __game, M = g.missions, P = g.P; M.cancel(); if (!M.spawn('pinned')) return false; const m = M.current();
        P.pos.set(m.giver.pos.x + 1.5, 1, m.giver.pos.z); P.flying = false; g.step(2); M.press('KeyE'); g.step(60);
        const v = m.victim.pos; P.pos.set(v.x + 2.2, 1, v.z + 1.2); P.vel.set(0, 0, 0); const d = v.clone().sub(P.pos); g.setYawPitch(Math.atan2(-d.x, -d.z) + 0.3, -0.12);
        g.step(2); M.press('KeyE'); g.step(50); g.render(); return M.qte() && M.qte().p; });
      await snap('qte-pinned-hold.png');
      // 3. dialogue: a request waving him down, the talk card and street barks
      const talk = await p.evaluate(() => { const g = __game, M = g.missions, P = g.P; M.release('KeyE'); M.cancel(); g.ledger.hope = 80;
        M.cfg.bark.dur = 60; // the page keeps running while a slow software-GL screenshot is taken
        if (!M.spawn('crime')) return false; const m = M.current(), v = m.giver.pos;
        P.flying = false; P.pos.set(v.x + 3.5, 1, v.z + 2.5); P.vel.set(0, 0, 0); const d = v.clone().sub(P.pos); g.setYawPitch(Math.atan2(-d.x, -d.z) + 0.4, -0.05);
        g.step(30); M.press('KeyE'); g.step(20); M.bark('passHigh'); g.step(100); M.bark('photo'); g.step(10); g.render(); return M.visibleBarks(); });
      await snap('dialogue-bubbles.png');
      return { ledge, pinned, talk, shots };
    },
    check: r => [['ledge QTE on screen', r.ledge, ''], ['hold QTE fills', r.pinned > 0.1, String(r.pinned)], ['bubbles visible', r.talk >= 1, r.talk + ' bubbles'],
      ['screenshots written', r.shots.length === 3, r.shots.join(', ')]]
  }
);

// screenshots of the ground super-speed run at each level, the hearing markers and Mach 10 flight: OUT/powers/*.png
SCENARIOS.push({
  name: 'powers-shots', shotsOnly: true,
  page: async (p) => {
    const dir = path.join(OUT, 'powers'); fs.mkdirSync(dir, { recursive: true });
    const shots = [], info = {};
    const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
    await p.evaluate(() => { __game.begin(); __game.step(30); });
    for (const l of [1, 2, 3]) {
      info['run' + l] = await p.evaluate((l) => { const g = __game; g.setPower(l); g.P.flying = false; g.P.pos.set(-150, 0.97, 200); g.P.vel.set(0, 0, 0);
        g.setYawPitch(0, -0.04); g.step(5); g.keys.clear(); g.keys.add('KeyW'); g.keys.add('ShiftLeft'); g.step(100); g.render();
        return { hs: Math.round(Math.hypot(g.P.vel.x, g.P.vel.z)), y: +(g.P.pos.y - 0.97 - g.groundY(g.P.pos.x, g.P.pos.z)).toFixed(2), fov: Math.round(g.camera.fov) }; }, l);
      await snap(`ground-run-L${l}.png`);
      await p.evaluate(() => __game.keys.clear());
    }
    info.hear = await p.evaluate(() => { const g = __game; g.setPower(3); g.P.flying = true; g.P.pos.set(0, 60, 100); g.P.vel.set(0, 0, 0); g.setYawPitch(0, -0.15);
      const v = g.people.find(q => q.mode === 'free'); v.pos.set(20, 0.9, 20); g.injurePerson(v); v.mode = 'down';
      g.startIncident('robbery'); g.step(5); g.keys.add('KeyH'); g.step(30); g.render(); return g.heard().length; });
    await snap('hearing-markers.png');
    info.mach = await p.evaluate(() => { const g = __game; g.keys.clear(); g.step(5); g.P.pos.set(0, 2000, 1500); g.P.vel.set(0, 0, 0); g.setYawPitch(0, -0.05);
      g.keys.add('KeyW'); g.keys.add('ShiftLeft'); g.step(240); g.render(); return +(g.P.vel.length() / Math.max(295, 340.3 - 0.0041 * g.P.pos.y)).toFixed(1); });
    await snap('flight-mach10.png');
    return { info, shots };
  },
  check: r => [['ground-run shots at speed', [1, 2, 3].every(l => r.info['run' + l].hs > 30 && Math.abs(r.info['run' + l].y) < 0.5), JSON.stringify(r.info)],
    ['screenshots written', r.shots.length === 5, r.shots.join(', ')]]
});

// The Catch (js/catch.js): velocity matching, the g rule, the g-meter, triage and the Hope cap
const CATCH_LIB = `
  const g = __game, C = window.SM_CATCH, P = g.P, V = THREE.Vector3;
  // let go; a test passenger is taken off the board so they can't land on a later test
  const clearAll = () => { g.keys.clear(); P.slow = false; const h = P.hold; if (h) g.grabOrRelease(); if (h && h.kind === 'person') { h.mode = 'gone'; h.danger = false; } };
  // a fresh, unhurt pedestrian turned into a free body at pos with velocity vel
  const body = (pos, vel) => { const p = g.people.find(q => q.mode === 'free' && !q.thug && !q.msnRole && !q.injured);
    p.mode = 'phys'; p.pos.copy(pos); p.vel.copy(vel); p.onGround = false; p.sleeping = false; p.sleepT = 0; p.danger = true; p.injured = false; p.severe = false; return p; };
  const air = new V(-90, 220, 150);
  const lastLog = k => { for (let i = C.log.length - 1; i >= 0; i--) if (C.log[i].kind === k) return C.log[i]; return null; };
  const injCount = () => C.log.filter(e => e.kind === 'injure').length;
  // carry the helicopter down to a street, let go 2 m up and wait for it to settle
  const landHeli = (h) => { const gy = Math.max(0, g.groundY(-90, 150)); P.vel.set(0, 0, 0); P.pos.set(-90, gy + 2 + 1.5 - 2.45, 150); g.step(3);
    g.grabOrRelease(); P.pos.x += 12; let n = 0; while (!h.landed && !h.crashed && n < 900) { g.step(3); n += 3; } g.step(3); return { landed: h.landed, crashed: h.crashed }; };
`;
SCENARIOS.push({
  name: 'catch',
  run: `(() => { ${CATCH_LIB} g.begin(); g.setPower(3); g.deferIncident(1e6); g.step(30); const out = {};
    if (g.missions) g.missions.setSpawnTimer(1e6);
    // 1. a faller met at matched velocity: auto-assist catches, cushioned, unhurt
    clearAll(); P.flying = true; P.pos.copy(air); P.vel.set(0, -19.5, 0);
    let p = body(new V(air.x + 1.2, air.y, air.z), new V(0, -20, 0)); g.step(2);
    out.matched = { held: p.mode === 'held', hurt: p.injured, log: lastLog('catch') };
    let pk = 0; for (let i = 0; i < 150; i++) { g.step(1); pk = Math.max(pk, C.g); }
    out.matched.peak = +pk.toFixed(2); out.matched.after = p.injured; out.matched.speed = +P.vel.length().toFixed(2);
    out.hud = { on: C.state().hud, cls: document.getElementById('catch-hud').className, read: document.querySelector('#catch-hud .cg-read b').textContent };
    clearAll(); g.step(2);
    // 2. a hard-stop catch: hovering still, the faller arrives at 25 m/s
    P.pos.copy(air); P.vel.set(0, 0, 0); p = body(new V(air.x + 1.2, air.y, air.z), new V(0, -25, 0));
    let i0 = injCount(); g.grabBody(p); g.step(2);
    out.hard = { held: P.hold === p, hurt: p.injured, severe: !!p.severe, log: lastLog('catch'), injureEvents: injCount() - i0 };
    clearAll(); g.step(2);
    // 3. carry: a 4 g ramp is fine, a 10 g turn is not; P.catchG matches |dv|/dt/g over the 0.1 s window
    P.pos.copy(air); P.vel.set(0, 0, 0); p = body(new V(air.x + 1, air.y, air.z), new V(0, 0, 0)); g.grabBody(p); g.step(2);
    const dt = 1 / 60, hist = []; let maxErr = 0, rampPeak = 0;
    const rec = () => { hist.push(P.vel.clone()); if (hist.length > 6) { const a = hist[hist.length - 1], b = hist[hist.length - 7];
      const bot = a.distanceTo(b) / (6 * dt) / 9.81; maxErr = Math.max(maxErr, Math.abs(bot - P.catchG)); } };
    let v = 0; for (let i = 0; i < 60; i++) { v += 4 * 9.81 * dt * 0.98; P.vel.set(v, 0, 0); g.step(1); rec(); rampPeak = Math.max(rampPeak, C.g); }
    out.ramp = { speed: +v.toFixed(1), peak: +rampPeak.toFixed(2), hurt: p.injured };
    const sp = v, w = 10 * 9.81 / sp; let ang = 0, turnPeak = 0;
    for (let i = 0; i < 40; i++) { ang += w * dt; P.vel.set(Math.cos(ang) * sp, 0, Math.sin(ang) * sp); g.step(1); rec(); turnPeak = Math.max(turnPeak, C.g); }
    out.turn = { peak: +turnPeak.toFixed(2), hurt: p.injured, severe: !!p.severe, gErr: +maxErr.toFixed(3) };
    clearAll(); g.step(2);
    // 3b. boosting from a standstill with a passenger hurts them
    P.pos.copy(air); P.vel.set(0, 0, 0); g.setYawPitch(0, 0.3); p = body(new V(air.x + 1, air.y, air.z), new V(0, 0, 0)); g.grabBody(p); g.step(2);
    g.keys.add('KeyW'); g.keys.add('ShiftLeft'); let bp = 0; for (let i = 0; i < 60 && !p.injured; i++) { g.step(1); bp = Math.max(bp, C.g); }
    out.boost = { hurt: p.injured, peak: +bp.toFixed(1), speed: Math.round(P.vel.length()) };
    clearAll(); g.step(2);
    // 4. T5: per-person save Hope from one incident is capped at +10; the triage counter is on screen
    g.startIncident('fire'); let inc = g.currentInc; g.ledger.hope = 40; for (let i = 0; i < 12; i++) g.addSave(1, null, 'test'); const hopeGain = g.ledger.hope - 40;
    g.step(4); const tri = document.getElementById('triage');
    out.cap = { hopeGain, cap: g.SAVE_HOPE_CAP, saveHope: inc.saveHope };
    out.triage = { atRisk: inc.atRisk, safe: inc.safe, text: tri && !tri.hidden ? tri.textContent : '', want: 'Saved ' + inc.safe + ' / ' + inc.atRisk + ' at risk' };
    // explosion-thrown people are at risk and catchable
    const gx = -90, gz = 150, gy = Math.max(0, g.groundY(gx, gz)); const q = g.people.find(r => r.mode === 'free' && !r.thug && !r.msnRole && !r.injured);
    q.pos.set(gx + 15, gy + 0.9, gz); g.explode(new V(gx, gy + 1, gz), 2.5e7);
    const thrown = { mode: q.mode, danger: q.danger, injured: q.injured, vy: +q.vel.y.toFixed(1), risk0: inc.atRisk };
    g.step(15); thrown.tracked = inc.atRisk > thrown.risk0;
    let ok = false; for (let i = 0; i < 120 && !ok; i++) { if (q.mode === 'phys' && !q.onGround && q.vel.y < 0) { P.flying = true; P.pos.copy(q.pos).add(new V(1.2, 0, 0)); P.vel.copy(q.vel); g.step(1); ok = q.mode === 'held'; } else g.step(1); }
    thrown.caught = ok; thrown.hurt = q.injured; out.thrown = thrown; clearAll(); g.step(2);
    // let everyone the blast threw come down before the next emergency starts counting who is at risk
    let settle = 0; while (g.people.some(r => r.danger && r.mode === 'phys') && settle < 900) { g.step(10); settle += 10; }
    // 5. the helicopter, caught at matched speed, then set down: no injuries, success
    g.startIncident('heli'); inc = g.currentInc; let h = inc.h; let n = 0;
    while (h.phase !== 'falling' && n < 900) { g.step(5); n += 5; } for (let i = 0; i < 90; i++) g.step(1);
    P.flying = true; P.pos.copy(h.pos).add(new V(2.6, 0, 0)); P.vel.copy(h.vel); const hv = +h.vel.length().toFixed(1); g.grabBody(h); g.step(1);
    let hp = 0; for (let i = 0; i < 240; i++) { g.step(1); hp = Math.max(hp, C.g); }
    const res0 = g.ledger.resolved, gold0 = g.ledger.medals.gold, eh0 = C.state().everyoneHome;
    out.heliSoft = { fallSpeed: hv, injuries: inc.injuries, occHurt: !!h.occHurt, peak: +hp.toFixed(2), log: lastLog('catch'), atRisk: inc.atRisk };
    Object.assign(out.heliSoft, landHeli(h)); g.step(20);
    out.heliSoft.ended = g.currentInc !== inc; out.heliSoft.success = g.ledger.resolved > res0; out.heliSoft.gold = g.ledger.medals.gold > gold0;
    out.heliSoft.everyoneHome = C.state().everyoneHome > eh0; out.heliSoft.age = Math.round(inc.age); out.heliSoft.damage = Math.round(inc.damage);
    clearAll(); g.step(2);
    // 6. the helicopter grabbed by a hovering hero at 20+ m/s: the crew are hurt, no gold
    g.startIncident('heli'); inc = g.currentInc; h = inc.h; n = 0;
    while (h.phase !== 'falling' && n < 900) { g.step(5); n += 5; } n = 0; while (h.vel.length() < 21 && n < 900 && !h.crashed) { g.step(1); n++; }
    P.flying = true; P.pos.copy(h.pos).add(new V(2.6, 0, 0)); P.vel.set(0, 0, 0); const hv2 = +h.vel.length().toFixed(1);
    i0 = injCount(); g.grabBody(h); g.step(3);
    out.heliHard = { dv: hv2, injuries: inc.injuries, occHurt: !!h.occHurt, injureEvents: injCount() - i0 };
    const r1 = g.ledger.resolved, g1 = g.ledger.medals.gold; g.step(60); Object.assign(out.heliHard, landHeli(h)); g.step(20);
    out.heliHard.success = g.ledger.resolved > r1; out.heliHard.gold = g.ledger.medals.gold > g1;
    clearAll(); g.step(2);
    // 7. missions: the window washer goes through the same rule (matched: unhurt; hovering at 13+ m/s: hurt)
    const M = g.missions, washer = (matched) => {
      if (M.current()) M.cancel(); clearAll(); if (!M.spawn('washer')) return { spawned: false }; const m = M.current();
      P.flying = false; P.pos.set(m.giver.pos.x + 1.5, m.giver.pos.y + 0.1, m.giver.pos.z); P.vel.set(0, 0, 0); g.step(2); M.press('KeyE'); M.release('KeyE'); g.step(10);
      // stand well back so the slow-motion assist stays off
      P.flying = true; P.pos.set(m.victim.pos.x + m.f.nx * 60, m.victim.pos.y, m.victim.pos.z + m.f.nz * 60); P.vel.set(0, 0, 0);
      let k = 0; while (M.phase !== 'fall' && k < 900) { g.step(1); k++; }
      k = 0; while (M.phase === 'fall' && m.fallV > (matched ? -10 : -13.5) && k < 300) { g.step(1); k++; }
      if (M.phase !== 'fall') return { spawned: true, phase: M.phase, fallV: m.fallV };
      const fv = m.fallV; P.slow = false; m.slowOn = true;
      P.pos.copy(m.victim.pos).add(new V(m.f.nx * 1.3, 0, m.f.nz * 1.3)); P.vel.set(0, matched ? fv : 0, 0); g.step(1);
      const vic = m.victim, r = { spawned: true, fallV: +fv.toFixed(1), held: vic.mode === 'held', hurt: !!vic.injured, state: M.state, log: lastLog('catch') };
      g.step(3); clearAll(); g.step(400); return r; };
    out.washerSoft = washer(true); out.washerHard = washer(false);
    return out; })()`,
  check: r => [
    ['matched faller: auto-assist catches, unhurt', r.matched.held && !r.matched.hurt && !r.matched.after && !!r.matched.log && r.matched.log.cushioned, JSON.stringify(r.matched)],
    ['soft hands: the cushioned stop stays under 6 g', r.matched.peak < 6, r.matched.peak + ' g'],
    ['g-meter shows while carrying', r.hud.on && /\bon\b/.test(r.hud.cls), JSON.stringify(r.hud)],
    ['hard-stop catch at 25 m/s injures (severe)', r.hard.held && r.hard.hurt && r.hard.severe && r.hard.injureEvents === 1, JSON.stringify(r.hard)],
    ['carry: 4 g ramp leaves them unhurt', !r.ramp.hurt && r.ramp.peak < 5, JSON.stringify(r.ramp)],
    ['carry: a 10 g turn injures', r.turn.hurt && r.turn.peak >= 9, JSON.stringify(r.turn)],
    ['P.catchG within 0.5 g of |dv|/dt/g (bot, same window)', r.turn.gErr < 0.5, r.turn.gErr + ' g max error'],
    ['boost from a standstill with a passenger injures', r.boost.hurt, JSON.stringify(r.boost)],
    ['Hope from one incident capped at +10', Math.round(r.cap.hopeGain) === 10, JSON.stringify(r.cap)],
    ['triage counter on the HUD', r.triage.atRisk >= 3 && r.triage.text === r.triage.want, JSON.stringify(r.triage)],
    ['explosion-thrown person is at risk, tracked and catchable', r.thrown.danger && r.thrown.tracked && r.thrown.caught && !r.thrown.hurt, JSON.stringify(r.thrown)],
    ['heli caught at matched speed: 0 injuries, lands, success', r.heliSoft.injuries === 0 && !r.heliSoft.occHurt && r.heliSoft.landed && r.heliSoft.success && !!r.heliSoft.log && r.heliSoft.log.cushioned, JSON.stringify(r.heliSoft)],
    ['heli soft catch: gold and "Everyone home"', r.heliSoft.gold && r.heliSoft.everyoneHome, ''],
    ['heli grabbed at 20+ m/s: crew hurt, injure event, no gold', r.heliHard.dv >= 20 && r.heliHard.occHurt && r.heliHard.injuries >= 3 && r.heliHard.injureEvents === 1 && !r.heliHard.gold, JSON.stringify(r.heliHard)],
    ['missions washer, matched catch: unhurt, success', r.washerSoft.held && !r.washerSoft.hurt && r.washerSoft.state === 'success', JSON.stringify(r.washerSoft)],
    ['missions washer, caught standing still at 13+ m/s: hurt', r.washerHard.held && r.washerHard.hurt && !!r.washerHard.log && r.washerHard.log.dv > 12, JSON.stringify(r.washerHard)]
  ]
});

// screenshots of the g-meter mid-catch and a smooth window-washer catch: OUT/catch/*.png
SCENARIOS.push({
  name: 'catch-shots', shotsOnly: true,
  page: async (p) => {
    const dir = path.join(OUT, 'catch'); fs.mkdirSync(dir, { recursive: true });
    const shots = [], info = {};
    const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
    // the bot drives every frame from here on: stop the page's own loop so slow screenshots don't advance the sim
    await p.evaluate(() => { __game.begin(); __game.step(30); window.requestAnimationFrame = () => 0; __game.deferIncident(1e6); if (__game.missions) __game.missions.setSpawnTimer(1e6); });
    // 1. g-meter mid-catch: a faller met at matched speed, braking at 4 g in his arms
    info.meter = await p.evaluate(() => { const g = __game, P = g.P, V = THREE.Vector3, C = window.SM_CATCH;
      const q = g.people.find(r => r.mode === 'free' && !r.thug && !r.msnRole);
      const at = new V(-60, 120, 120); q.mode = 'phys'; q.pos.copy(at); q.vel.set(0, -24, 0); q.onGround = false; q.sleeping = false; q.danger = true;
      P.flying = true; P.pos.copy(at).add(new V(1.2, 0, 0)); P.vel.set(0, -23.5, 0); g.setYawPitch(-0.6, -0.25);
      g.step(1); g.step(5); g.render(); return C.state(); });
    await snap('g-meter-mid-catch.png');
    // 2. window washer: closing in at matched speed (match bar green), then the catch
    info.washer = await p.evaluate(() => { const g = __game, P = g.P, M = g.missions, V = THREE.Vector3, C = window.SM_CATCH;
      if (P.hold) g.grabOrRelease(); if (!M.spawn('washer')) return { spawned: false }; const m = M.current();
      P.flying = false; P.pos.set(m.giver.pos.x + 1.5, m.giver.pos.y + 0.1, m.giver.pos.z); P.vel.set(0, 0, 0); g.step(2); M.press('KeyE'); M.release('KeyE'); g.step(60);
      P.flying = true; P.pos.set(m.victim.pos.x + m.f.nx * 60, m.victim.pos.y, m.victim.pos.z + m.f.nz * 60); P.vel.set(0, 0, 0);
      let k = 0; while (M.phase !== 'fall' && k < 900) { g.step(1); k++; }
      k = 0; while (M.phase === 'fall' && m.fallV > -8 && k < 300) { g.step(1); k++; }
      P.slow = false; m.slowOn = true;
      const v = m.victim.pos; P.pos.set(v.x + m.f.nx * 4.5, v.y - 0.4, v.z + m.f.nz * 4.5); P.vel.set(0, m.fallV, 0);
      g.setYawPitch(Math.atan2(m.f.nx, m.f.nz) + 0.5, 0.05); g.step(3); g.render();
      return { fallV: +m.fallV.toFixed(1), state: C.state() }; });
    await snap('washer-closing.png');
    info.caught = await p.evaluate(() => { const g = __game, P = g.P, M = g.missions, C = window.SM_CATCH, m = M.current();
      if (!m) return null; const v = m.victim.pos; P.pos.set(v.x + m.f.nx * 1.4, v.y, v.z + m.f.nz * 1.4); P.vel.set(0, m.fallV, 0);
      g.step(1); for (let i = 0; i < 8; i++) g.step(1); g.render();
      return { held: m.victim.mode === 'held', hurt: !!m.victim.injured, state: M.state, catchLog: C.log[C.log.length - 1], g: C.state() }; });
    await snap('washer-smooth-catch.png');
    return { info, shots };
  },
  check: r => [['g-meter on mid-catch', r.info.meter.hud, JSON.stringify(r.info.meter)],
    ['match-speed shown while closing on the washer', r.info.washer.state && r.info.washer.state.faller === 'person' && r.info.washer.state.hud, JSON.stringify(r.info.washer)],
    ['washer caught smoothly, unhurt', r.info.caught && r.info.caught.held && !r.info.caught.hurt, JSON.stringify(r.info.caught)],
    ['screenshots written', r.shots.length === 3, r.shots.join(', ')]]
});

// Set pieces (js/setpieces.js): the runaway bus and the falling airliner, demo steps 7 and 8.
// SP_DRIVE runs in the page: helpers that drive each outcome with real inputs (positioning,
// E through setpieces.press/release, Q held in keys, an analog push like a gamepad stick).
const SP_DRIVE = `(() => {
  const g = __game, S = g.setpieces || window.SM_SETPIECES, P = g.P, V = THREE.Vector3, D2R = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const aimAt = (v) => { const d = new V().copy(v).sub(P.pos); d.y -= 0.66; d.normalize(); g.setYawPitch(Math.atan2(-d.x, -d.z), Math.asin(d.y)); };
  const reset = () => { g.keys.clear(); S.push(null); if (P.hold) g.grabOrRelease(); if (g.currentInc) g.endIncident(false, 'test reset'); g.deferIncident(1e9); P.vel.set(0, 0, 0); };
  function bus(mode) {
    reset(); P.flying = true; P.pos.set(-90, 60, 0); g.step(2);
    const h0 = g.ledger.hope, r0 = g.ledger.resolved; S.start('bus'); const inc = g.currentInc; const lane = S.cfg.bus.x;
    let t = 0, ms = 0, frames = 0, dist = 0, attached = false, inside = false, nan = false;
    const step = () => { const a = performance.now(); g.step(1); ms += performance.now() - a; frames++; t++; const b = S.bus; if (b) { inside = inside || b.insideBlock; nan = nan || b.nan || !isFinite(b.s); } };
    if (mode === 'gentle') {
      while (S.bus.v < 20 && t < 1800) step();
      const b = S.bus; dist = S.cfg.bus.stopZ - b.s;
      P.flying = true; P.pos.set(lane, 1.7, b.s + 2); P.vel.set(0, 0, b.v); g.setYawPitch(0, 0);
      S.press('KeyE'); attached = S.bus.attached;   // grab and keep holding E
    } else if (mode === 'hard') {
      while (S.bus.v < 23.5 && S.bus.s < S.cfg.bus.stopZ - 70 && t < 2400) step();
      const b = S.bus; dist = S.cfg.bus.stopZ - b.s;
      P.flying = true; P.pos.set(lane, 1.7, b.s + 3); P.vel.set(0, 0, 0);
    }
    while (g.currentInc === inc && t < 60 * 70) { if (mode === 'hard') P.vel.set(0, 0, 0); step(); }
    S.release('KeyE');
    return Object.assign({ mode, seconds: +(t / 60).toFixed(1), dist: Math.round(dist), attached, ended: g.currentInc !== inc, resolved: g.ledger.resolved - r0,
      simMs: +(ms / frames).toFixed(2), insideAny: inside, nanAny: nan, hope: +(g.ledger.hope - h0).toFixed(1) }, S.last || {});
  }
  function plane(mode) {
    reset(); P.flying = true; P.pos.set(-1400, 300, 900); g.step(2);
    const h0 = g.ledger.hope, med0 = Object.assign({}, g.ledger.medals); S.start('airliner'); const inc = g.currentInc;
    let t = 0, ms = 0, frames = 0, fire = null;
    const step = () => { const a = performance.now(); g.step(1); ms += performance.now() - a; frames++; t++; };
    const eng = new V(), hp = new V();
    if (mode !== 'none') {
      // fly alongside the burning engine and hold freeze breath on it
      g.keys.add('KeyQ');
      while (S.plane && S.plane.fire > 0 && t < 60 * 15) {
        const pl = S.plane; S.hardpoint('engine', eng);
        P.flying = true; P.pos.copy(eng).addScaledVector(pl.vel, -10 / pl.vel.length()).add(new V(0, -4, 0)); P.vel.copy(pl.vel); aimAt(eng); step();
      }
      g.keys.delete('KeyQ'); fire = S.plane ? { out: S.plane.fire <= 0, breath: +S.plane.breath.toFixed(2), age: +S.plane.age.toFixed(1) } : null;
    }
    if (mode === 'guide') {
      S.hardpoint('nose', hp); P.pos.copy(hp); P.vel.copy(S.plane.vel); S.press('KeyE'); S.release('KeyE');
      while (g.currentInc === inc && t < 60 * 90) {
        const pl = S.plane; const alt = pl.pos.y - 2, vsT = clamp(alt * 0.08, 3, 14);
        const thDes = clamp(0.025 * (pl.vs - vsT) + 0.05, -0.15, 0.3);
        S.push(clamp(4 * (thDes - pl.pitch * D2R) - 3 * pl.pitchRate, -1, 1), 0); step();
      }
      S.push(null);
    } else while (g.currentInc === inc && t < 60 * 90) step();
    const res = Object.assign({ mode, seconds: +(t / 60).toFixed(1), ended: g.currentInc !== inc, fire, simMs: +(ms / frames).toFixed(2) }, S.last || {});
    const medal = ['gold', 'silver', 'bronze'].find(k => g.ledger.medals[k] > med0[k]) || null;
    res.medal = medal; res.hopeGain = +(g.ledger.hope - h0).toFixed(1);
    g.step(360); const pl = S.plane; res.after = pl ? { phase: pl.phase, y: +pl.pos.y.toFixed(2), standers: pl.standers, speed: +Math.hypot(pl.vel.x, pl.vel.z).toFixed(1) } : null;
    return res;
  }
  return { bus, plane };
})()`;
SCENARIOS.push(
  {
    name: 'setpieces',
    run: `(() => { const g = __game; g.begin(); g.step(30); const D = ${SP_DRIVE}; const out = {};
      out.gentle = D.bus('gentle'); out.hard = D.bus('hard'); out.alone = D.bus('none');
      out.guide = D.plane('guide'); out.wild = D.plane('none');
      out.reg = { bus: !!(window.SM_INCIDENTS && SM_INCIDENTS.bus), airliner: !!(window.SM_INCIDENTS && SM_INCIDENTS.airliner),
        rotBus: SM_INCIDENTS.bus.want(5, 400) && !SM_INCIDENTS.bus.want(5, 60), rotPlane: SM_INCIDENTS.airliner.want(6, 400) && !SM_INCIDENTS.airliner.want(6, 60) };
      return out; })()`,
    check: r => [
      ['both set pieces registered and in the late rotation', r.reg.bus && r.reg.airliner && r.reg.rotBus && r.reg.rotPlane, JSON.stringify(r.reg)],
      ['bus: braced 40 m+ early and held E, it stops before the crosswalk', r.gentle.dist >= 40 && r.gentle.attached && r.gentle.success && r.gentle.short > 0, `${r.gentle.dist} m out, stopped ${(r.gentle.short || 0).toFixed(1)} m short, peak ${r.gentle.maxG} g`],
      ['bus: gentle stop hurts nobody, 30 step off', r.gentle.hurt === 0 && r.gentle.disembarked === 30, `${r.gentle.hurt} hurt, ${r.gentle.disembarked} off`],
      ['bus: a stationary block at 25 m/s hurts 10+', r.hard.blocked && r.hard.hurt >= 10, `${r.hard.hurt} hurt (block at ${r.hard.vBlock} m/s)`],
      ['bus: left alone it fails within its limit (+5 s) with lives lost', r.alone.ended && r.alone.success === false && r.alone.seconds <= 50 && r.alone.lost > 0, `${r.alone.seconds} s, ${r.alone.lost} lost`],
      ['bus: never inside a live block, no NaN', ![r.gentle, r.hard, r.alone].some(x => x.insideAny || x.nanAny), ''],
      ['bus: sim cost under 6 ms/frame', r.alone.simMs < 6 && r.gentle.simMs < 6, `${r.gentle.simMs} / ${r.alone.simMs} ms`],
      ['airliner: freeze breath puts the fire out in 6 s or less', r.guide.fire && r.guide.fire.out && r.guide.fire.breath <= 6, JSON.stringify(r.guide.fire)],
      ['airliner: guided down within limits (v/s < 6, roll < 15), 140 saved', r.guide.success && r.guide.kind === 'ditch' && r.guide.vs < 6 && r.guide.roll < 15 && r.guide.saved === 140, `v/s ${r.guide.vs}, roll ${r.guide.roll}, ${r.guide.saved} saved at ${r.guide.seconds} s`],
      ['airliner: floats afterwards, people on the wings', r.guide.after && r.guide.after.phase === 'float' && Math.abs(r.guide.after.y - 0.5) < 1 && r.guide.after.standers > 0, JSON.stringify(r.guide.after)],
      ['airliner: Hope gain capped (+10 passengers + medal)', r.guide.hopeGain <= 10 + ({ gold: 10, silver: 5, bronze: 1 }[r.guide.medal] || 0), `+${r.guide.hopeGain} (${r.guide.medal})`],
      ['airliner: uncontrolled it fails before the limit', r.wild.ended && r.wild.success === false && r.wild.age < 75, `${r.wild.kind}/${r.wild.why} at ${r.wild.age} s, v/s ${r.wild.vs}`],
      ['airliner: sim cost under 6 ms/frame, no NaN', r.guide.simMs < 6 && !r.guide.nan && !r.wild.nan, r.guide.simMs + ' ms']]
  },
  {
    name: 'setpieces-budget', quality: 'high',
    run: `(() => { const g = __game, S = g.setpieces, P = g.P, out = {}; g.begin(); g.deferIncident(1e9); const info = g.renderer.info; info.autoReset = false;
      S.start('bus'); g.step(240); const b = S.bus; P.flying = true; P.pos.set(S.cfg.bus.x - 6, 4, b.s + 14); P.vel.set(0, 0, 0); g.setYawPitch(-0.35, -0.12); g.step(3);
      info.reset(); g.composer.render(); out.bus = { calls: info.render.calls, tris: info.render.triangles, people: S.people };
      S.start('airliner'); g.step(60); const v = S.hardpoint('left'); P.pos.set(v.x - 10, v.y - 6, v.z + 30); g.setYawPitch(0.3, 0.15); g.step(1);
      info.reset(); g.composer.render(); out.plane = { calls: info.render.calls, tris: info.render.triangles };
      return out; })()`,
    check: r => ['bus', 'plane'].map(k => [`${k} set piece within draw-call budget (400)`, r[k].calls <= 400, `${r[k].calls} calls, ${(r[k].tris / 1e6).toFixed(2)}M tris`])
      .concat(['bus', 'plane'].map(k => [`${k} set piece triangles within budget (3M)`, r[k].tris <= 3e6, (r[k].tris / 1e6).toFixed(2) + 'M']))
  }
);
SCENARIOS.push({
  name: 'setpieces-shots', shotsOnly: true, quality: 'high',
  page: async (p) => {
    const dir = path.join(OUT, 'setpieces'); fs.mkdirSync(dir, { recursive: true });
    const shots = [], info = {};
    const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
    info.bus = await p.evaluate(() => { const g = __game, S = g.setpieces, P = g.P; g.begin(); g.deferIncident(1e9); g.step(20);
      S.start('bus'); while (S.bus.v < 20) g.step(1); const b = S.bus; P.flying = true; P.pos.set(S.cfg.bus.x, 1.7, b.s + 2); P.vel.set(0, 0, b.v); S.press('KeyE');
      g.step(50); g.setYawPitch(0.55, -0.12); g.step(4); g.render(); return S.bus; });
    await snap('bus-holding-front.png');
    info.plane = await p.evaluate(() => { const g = __game, S = g.setpieces, P = g.P; S.release('KeyE'); g.endIncident(true, 'shot'); g.step(2);
      S.start('airliner'); g.step(30); g.keys.add('KeyQ');
      for (let i = 0; i < 420 && S.plane.fire > 0; i++) { const e = S.hardpoint('engine'); P.pos.copy(e).add(new THREE.Vector3(-10, -4, 0)); P.vel.copy(S.plane.vel); const d = e.clone().sub(P.pos); d.y -= 0.66; d.normalize(); g.setYawPitch(Math.atan2(-d.x, -d.z), Math.asin(d.y)); g.step(1); }
      g.keys.delete('KeyQ'); const v = S.hardpoint('left'); P.pos.copy(v); S.press('KeyE'); S.release('KeyE'); S.push(0.6, 0); g.step(40);
      g.setYawPitch(2.2, 0.12); g.step(3); g.render(); S.push(null); return S.plane; });
    await snap('airliner-wing-push-sunset.png');
    return { info, shots };
  },
  check: r => [['bus braced in the shot', r.info.bus && r.info.bus.attached, JSON.stringify(r.info.bus && { v: r.info.bus.v, g: r.info.bus.g })],
    ['Superman on the airliner wing in the shot', r.info.plane && r.info.plane.attached === 'left', JSON.stringify(r.info.plane && { y: r.info.plane.pos.y, attached: r.info.plane.attached })],
    ['screenshots written', r.shots.length === 2, r.shots.join(', ')]]
});
// feel pass (dream-features step 1 and §3): hit-stop, trauma shake, Mach 10 framing, charged takeoff, landing tiers
SCENARIOS.push({
  name: 'feel',
  run: `(() => { const g = __game, F = g.feel, out = {}; g.begin(); g.setPower(3); g.step(30);
    const sinceEv = (i, type) => g.events.slice(i).filter(e => e.type === type);
    // 1) a full-charge punch on a parked car: the sim freezes for <= 150 ms of real time, the camera keeps shaking
    const c = g.bodies.filter(b => b.kind === 'car' && !b.dead && b.pos.y < 3).sort((a, b) => Math.hypot(a.pos.x + 150, a.pos.z - 200) - Math.hypot(b.pos.x + 150, b.pos.z - 200))[0];
    g.P.flying = true; g.P.vel.set(0, 0, 0); g.P.pos.set(c.pos.x, c.pos.y + 0.5, c.pos.z + 3.2); g.setYawPitch(0, -0.15); g.step(3); F.reset();
    g.punch(4);
    let frozen = 0, slow = 0, camMoved = 0; const q = g.camera.quaternion.clone();
    for (let i = 0; i < 40; i++) { const s0 = g.simT; g.step(1); const ds = g.simT - s0;
      if (ds < 1e-7) { frozen += 1000 / 60; if (q.angleTo(g.camera.quaternion) > 1e-6) camMoved++; } else if (ds < 1 / 60 - 1e-6) slow += 1000 / 60 - ds * 1000;
      q.copy(g.camera.quaternion); }
    out.punch = { ms: F.lastHitStopMs, frozen: Math.round(frozen), frozenMs: Math.round(F.frozenMs), rampLostMs: Math.round(slow), camMoved, carV: +c.vel.length().toFixed(1) };
    // 2) a sonic boom: trauma rises, the shake is rotational and bounded, and it drains below 0.05 within 1.5 s
    g.P.pos.set(0, 600, 0); g.P.vel.set(0, 0, 0); g.step(5); F.reset();
    const p0 = g.camera.position.clone(); g.sonicBoom(); const tr0 = F.trauma;
    let maxRot = 0, maxRoll = 0, trAt = []; const deg = 180 / Math.PI;
    for (let i = 1; i <= 90; i++) { g.step(1); maxRot = Math.max(maxRot, Math.abs(F.pitch), Math.abs(F.yaw)) ; maxRoll = Math.max(maxRoll, Math.abs(F.roll)); if (i % 15 === 0) trAt.push(+F.trauma.toFixed(3)); }
    out.boom = { tr0: +tr0.toFixed(2), tr15: F.trauma, curve: trAt, maxRotDeg: +(maxRot * deg).toFixed(2), maxRollDeg: +(maxRoll * deg).toFixed(2), maxPos: +Math.hypot(F.ox, F.oy, F.oz).toFixed(3) };
    // shake slider at 0 kills it
    window.SM_SETTINGS = { get: k => k === 'shake' ? 0 : undefined }; F.reset(); g.sonicBoom(); g.step(3);
    out.boomOff = +(Math.abs(F.pitch) + Math.abs(F.yaw) + Math.abs(F.roll)).toFixed(6); delete window.SM_SETTINGS;
    // 3) level 3 top speed (about Mach 10) at 2000 m: the camera stays within the screen-space band
    g.P.flying = true; g.P.pos.set(0, 2000, 1500); g.P.vel.set(0, 0, 0); g.setYawPitch(0, -0.05); g.keys.clear(); g.keys.add('KeyW'); g.keys.add('ShiftLeft');
    let dMin = 1e9, dMax = 0, fMin = 1, fMax = 0, bad = 0;
    for (let i = 0; i < 300; i++) { g.step(1); if (i < 20) continue; const d = g.camera.position.distanceTo(g.P.pos), C = g.camState;
      dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); fMin = Math.min(fMin, C.heroFrac); fMax = Math.max(fMax, C.heroFrac);
      if (d > C.maxDist + 0.05 || (g.P.vel.length() > 150 && d < C.minDist - 0.05)) bad++; }
    const mach = g.P.vel.length() / Math.max(295, 340.3 - 0.0041 * g.P.pos.y); g.keys.clear();
    out.mach10 = { mach: +mach.toFixed(1), dMin: +dMin.toFixed(2), dMax: +dMax.toFixed(2), fMin: +fMin.toFixed(3), fMax: +fMax.toFixed(3), bad, fov: Math.round(g.camera.fov), limits: [+g.camState.minDist.toFixed(2), +g.camState.maxDist.toFixed(2)] };
    // 4) launch and land on the avenue
    const street = () => { g.keys.clear(); g.P.flying = false; g.P.vel.set(0, 0, 0); g.P.pos.set(-150, 0.97, 200); g.setYawPitch(0, -0.1); g.step(20); F.reset(); };
    street(); let i0 = g.events.length, dmg0 = g.ledger.damage;
    g.keys.add('Space'); g.step(36); const crouchDrop = +g.P.poseDrop.toFixed(2); g.keys.delete('Space');
    g.step(1); const vy1 = g.P.vel.y; g.step(1); const vy2 = g.P.vel.y; const tk = sinceEv(i0, 'takeoff')[0];
    out.takeoff = { vy: +Math.max(vy1, vy2).toFixed(1), ev: tk || null, dmg: g.ledger.damage - dmg0, crouchDrop, tr: +F.peakTrauma.toFixed(2) };
    const land = (setup, frames) => { street(); setup(); i0 = g.events.length; dmg0 = g.ledger.damage; F.reset(); F.peakTrauma = 0; let ev = null, dmgAt = 0, drop = 0;
      for (let i = 0; i < frames && !ev; i++) { g.step(1); ev = sinceEv(i0, 'land')[0] || null; if (ev) dmgAt = g.ledger.damage - dmg0; }
      g.step(12); drop = g.P.poseDrop; g.keys.clear(); return { tier: ev && ev.tier, v: ev && ev.v, dmg: dmgAt, tr: +F.peakTrauma.toFixed(2), stop: F.lastHitStopMs, drop: +drop.toFixed(2), n: sinceEv(i0, 'land').length }; };
    out.soft = land(() => { g.P.pos.set(-150, 40, 200); g.step(1); g.keys.add('Space'); }, 900);
    out.hero = land(() => { g.P.pos.set(-150, 5, 200); g.P.vel.set(0, -30, 0); }, 120);
    out.crater = land(() => { g.P.pos.set(-150, 5, 200); g.P.vel.set(0, -60, 0); }, 120);
    out.braked = land(() => { g.P.pos.set(-150, 6, 200); g.P.vel.set(0, -60, 0); g.step(1); g.keys.add('Space'); }, 120);
    return out; })()`,
  check: r => [
    ['full-charge punch hit-stop is 100 ms (min(100, 20 + 20 x power))', r.punch.ms === 100, `${r.punch.ms} ms`],
    ['sim freeze <= 150 ms of real time', r.punch.frozen <= 150 && r.punch.frozen >= 80, `${r.punch.frozen} ms frozen (feel ${r.punch.frozenMs}), ramp lost ${r.punch.rampLostMs} ms`],
    ['camera shake keeps animating during hit-stop', r.punch.camMoved >= 3, `${r.punch.camMoved} frozen frames with camera motion`],
    ['boom raises trauma', r.boom.tr0 >= 0.45, r.boom.tr0],
    ['trauma decays below 0.05 within 1.5 s', r.boom.tr15 < 0.05, r.boom.curve.join(' ')],
    ['shake is rotational and bounded (2.5 deg pitch/yaw, 4 deg roll, small position)', r.boom.maxRotDeg <= 2.5 && r.boom.maxRollDeg <= 4 && r.boom.maxPos <= 0.16, `${r.boom.maxRotDeg} / ${r.boom.maxRollDeg} deg, ${r.boom.maxPos} m`],
    ['shake setting 0 removes the shake', r.boomOff === 0, r.boomOff],
    ['level 3 reaches about Mach 10', r.mach10.mach >= 9, 'Mach ' + r.mach10.mach],
    ['camera distance stays within the screen-space band at Mach 10', r.mach10.bad === 0, `${r.mach10.bad} frames outside; d ${r.mach10.dMin}-${r.mach10.dMax} m while accelerating, final limits ${r.mach10.limits} m, fov ${r.mach10.fov}`],
    ['hero stays ~12-18% of screen height at speed', r.mach10.fMin >= 0.115 && r.mach10.fMax <= 0.25, `${r.mach10.fMin}-${r.mach10.fMax}`],
    ['charged takeoff: vy >= 80 within 2 frames, charge >= 0.9', r.takeoff.vy >= 80 && r.takeoff.ev && r.takeoff.ev.charge >= 0.9, `vy ${r.takeoff.vy}, ${JSON.stringify(r.takeoff.ev)}`],
    ['full-charge takeoff crouches, cracks the pavement ($5K) and shakes', r.takeoff.crouchDrop > 0.25 && r.takeoff.dmg === 5000 && r.takeoff.tr > 0.2, `drop ${r.takeoff.crouchDrop} m, $${r.takeoff.dmg}, trauma ${r.takeoff.tr}`],
    ['flared drop from 40 m lands soft, no damage', r.soft.tier === 'soft' && r.soft.dmg === 0 && r.soft.n === 1, JSON.stringify(r.soft)],
    ['30 m/s lands as a hero landing: kneel, small shake, no damage', r.hero.tier === 'hero' && r.hero.dmg === 0 && r.hero.drop > 0.3 && r.hero.tr > 0.1 && r.hero.tr < 0.4, JSON.stringify(r.hero)],
    ['60 m/s unbraked lands as a crater: +$25K, big shake, 80 ms hit-stop', r.crater.tier === 'crater' && Math.abs(r.crater.dmg - 25000) <= 1 && r.crater.tr >= 0.3 && r.crater.stop === 80, JSON.stringify(r.crater)],
    ['60 m/s braked lands as a hero landing, no crater bill', r.braked.tier === 'hero' && r.braked.dmg === 0, JSON.stringify(r.braked)]
  ]
});
// screenshots: the hero landing (gameplay camera and a side view) and the flight framing at Mach 10: OUT/feel/*.png
SCENARIOS.push({
  name: 'feel-shots', shotsOnly: true,
  page: async (p) => {
    const dir = path.join(OUT, 'feel'); fs.mkdirSync(dir, { recursive: true });
    const shots = [], info = {};
    const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
    await p.evaluate(() => { __game.begin(); __game.setPower(3); __game.step(30); });
    info.hero = await p.evaluate(() => { const g = __game; g.keys.clear(); g.P.flying = false; g.P.pos.set(-150, 6, 200); g.P.vel.set(0, -32, 0); g.setYawPitch(0.5, -0.12);
      let ev = null; const i0 = g.events.length; for (let i = 0; i < 60 && !ev; i++) { g.step(1); ev = g.events.slice(i0).find(e => e.type === 'land'); }
      g.step(10); g.P.landT = 99; g.render(); return ev; }); // hold the pose while the live loop renders the shot
    await snap('hero-landing.png');
    await p.evaluate(() => { const g = __game, P = g.P; g.camState.hold = true; const f = new g.camera.position.constructor(-Math.sin(0.5), 0, -Math.cos(0.5)), r = new g.camera.position.constructor(Math.cos(0.5), 0, -Math.sin(0.5));
      g.camera.position.copy(P.pos).addScaledVector(f, 3.4).addScaledVector(r, 2.2).setY(1.1); g.camera.lookAt(P.pos.x, 0.55, P.pos.z); g.camera.fov = 55; g.camera.updateProjectionMatrix(); g.render(); });
    await snap('hero-landing-side.png');
    await p.evaluate(() => { __game.camState.hold = false; });
    info.crouch = await p.evaluate(() => { const g = __game; g.P.landT = 0; g.step(30); g.keys.add('Space'); g.step(34); g.render(); return +g.P.jumpCharge.toFixed(2); });
    await snap('takeoff-crouch.png');
    info.mach = await p.evaluate(() => { const g = __game; g.keys.clear(); g.step(5); g.P.flying = true; g.P.pos.set(0, 2000, 1500); g.P.vel.set(0, 0, 0); g.setYawPitch(0, -0.05);
      g.keys.add('KeyW'); g.keys.add('ShiftLeft'); g.step(240); g.render();
      return { mach: +(g.P.vel.length() / Math.max(295, 340.3 - 0.0041 * g.P.pos.y)).toFixed(1), frac: +g.camState.heroFrac.toFixed(3), d: +g.camera.position.distanceTo(g.P.pos).toFixed(2) }; });
    await snap('flight-mach10.png');
    return { info, shots };
  },
  check: r => [['hero landing captured', r.info.hero && r.info.hero.tier === 'hero', JSON.stringify(r.info)],
    ['Mach 10 framing keeps him readable', r.info.mach.mach >= 9 && r.info.mach.frac >= 0.115, JSON.stringify(r.info.mach)],
    ['screenshots written', r.shots.length === 4, r.shots.join(', ')]]
});

// Metallo finale (dream-features #13, demo step 10): spawn + budget, radiation and the lead shield,
// freeze-then-punch cracks a plate, a thrown car is intercepted, a scripted win under 180 s, the loss path.
const METALLO_LIB = `const g = __game, M = g.metallo, P = g.P;
  const S = () => M.state, I = () => M.info();
  // put Superman d m from Metallo (horizontally, on the side away from the crowd), hovering at height h
  const place = (d, h, side) => { const s = S(); const ax = s.pos.x - s.crowdC.x, az = s.pos.z - s.crowdC.z, a = Math.atan2(az, ax) + (side || 0);
    P.flying = true; P.pos.set(s.pos.x + Math.cos(a) * d, (h === undefined ? 2.2 : h), s.pos.z + Math.sin(a) * d); P.vel.set(0, 0, 0); };
  const heartD = () => P.pos.distanceTo(S().pos.clone().setY(S().pos.y + 2.2));
  const catchCar = () => { const c = S().flying[0]; if (!c) return false; P.pos.copy(c.pos); P.pos.x += 1.6; P.pos.y += 0.4; P.vel.copy(c.vel); M.aim('car');
    g.grabOrRelease(); const ok = P.hold === c; g.step(2); if (P.hold === c) { P.vel.set(0, 0, 0); g.grabOrRelease(); } return ok; };
  const grabLead = () => { const L = S().lead; P.pos.copy(L.pos); P.pos.x += 1.5; P.pos.y += 1.2; P.vel.set(0, 0, 0); M.aim('lead'); g.grabOrRelease(); return P.hold === L; };`;
SCENARIOS.push({
  name: 'metallo', quality: 'high',
  run: `(() => { ${METALLO_LIB}
    const out = {}; g.begin(); g.step(5); const info = g.renderer.info; info.autoReset = false;
    // 1. spawn: draw calls with him in view
    out.started = M.start(); g.step(300); place(22, 3); M.aim('chest'); g.step(3); info.reset(); g.composer.render();
    out.calls = info.render.calls; out.meshes = M.meshes(); out.phase = I().phase; out.label = g.currentInc && g.currentInc.label;
    // 2. radiation: 10 m and 45 m from the heart, then 10 m behind the lead plate
    M.calm(30); place(9.6, 2.2); g.step(1); out.k10 = +P.kryp.toFixed(3); out.heart10 = +heartD().toFixed(1);
    const s0 = P.solar; g.step(120); out.solarDrop10 = +(s0 - P.solar).toFixed(3); out.k10b = +P.kryp.toFixed(3);
    place(44.8, 2.2); g.step(1); out.k45 = +P.kryp.toFixed(3);
    out.leadHeld = grabLead();
    M.calm(30); place(9.6, 2.2); g.step(2); out.k10lead = +P.kryp.toFixed(3); out.leadCut = +(1 - out.k10lead / Math.max(1e-3, out.k10)).toFixed(3);
    if (P.hold) g.grabOrRelease(); P.solar = 1;
    // 3. armour: a charged punch on unfrozen armour does nothing; freeze breath (from range) then a charged punch cracks a plate
    M.calm(30); place(6, 2.2); M.aim('chest'); g.punch(3); g.step(2); out.platesNoFreeze = I().plates;
    place(26, 2.4); M.aim('chest', 0.66); g.keys.add('KeyQ'); let ft = 0; for (; ft < 300 && Math.max(...I().frost) <= 0.8; ft++) g.step(1); g.keys.delete('KeyQ'); out.freezeS = +(ft / 60).toFixed(2);
    out.frost = I().frost; place(6, 2.2); M.aim('chest'); g.punch(3); g.step(2); out.platesAfter = I().plates;
    // 4. a thrown car: caught = no bystander hit; then one left alone does hit the crowd
    P.solar = 1; M.calm(0); M.forceAttack('toss'); let n = 0; while (!S().flying.length && n++ < 200) g.step(1);
    g.step(20); const hurt0 = I().hurt; out.caughtCar = catchCar(); M.calm(5); g.step(180); out.hurtAfterCatch = I().hurt - hurt0; out.caught = I().caught;
    M.calm(0); M.forceAttack('toss'); n = 0; while (!S().flying.length && n++ < 200) g.step(1); place(40, 30); M.calm(5); g.step(240); out.hurtUncaught = I().hurt - hurt0;
    // telegraphs: every attack has a telegraph >= 1.0 s earlier (10.6)
    const ev = M.events; out.badTele = ev.filter(e => e.type === 'attack').filter(a => !ev.some(t => t.type === 'telegraph' && t.kind === a.kind && t.t <= a.t - 0.999 && t.t > a.t - 3)).length;
    out.attacks = ev.filter(e => e.type === 'attack').length;
    // 5. scripted win: freeze, punch, intercept cars, dodge pulses, lead shield, rip the heart
    P.solar = 1; M.start(); const t0 = g.simT; let guard = 0;
    while (I().phase < 2) g.step(10);
    while (I().plates > 0 && I().active && guard++ < 4000) {
      const s = S(), a = s.atk;
      if (s.flying.length) { catchCar(); continue; }
      if (a && a.kind === 'pulse' && !a.fired) { place(48, 3); g.step(10); continue; }
      const fr = s.plates.filter(p => p.alive).map(p => p.frost);
      if (Math.max(...fr) <= 0.8) { place(28, 2.4); M.aim('chest', 0.66); g.keys.add('KeyQ'); g.step(10); g.keys.delete('KeyQ'); continue; }
      place(6, 2.2); M.aim('chest'); g.punch(3); g.step(3); place(28, 2.4); g.step(3);
    }
    out.platesWin = I().plates; out.phaseWin = I().phase; out.solarWin = +P.solar.toFixed(2);
    out.leadHeld2 = grabLead();
    place(3.2, 2.0); M.aim('heart'); g.step(1); out.kShield = +P.kryp.toFixed(3); g.grabOrRelease(); g.step(30);
    out.win = I().result; out.winSim = +(g.simT - t0).toFixed(1); out.contained = I().contained; out.incAfterWin = g.currentInc ? g.currentInc.type : null;
    out.medalEvt = (g.events || []).some(e => e.type === 'medal' && e.attacker === 'metallo');
    if (P.hold) g.grabOrRelease();
    // 6. loss: solar charge runs dry -> soft fail, he escapes, and a retry works
    M.start(); g.step(400); P.solar = 0; g.step(2); out.loss = I().result; out.incAfterLoss = g.currentInc ? g.currentInc.type : null; g.step(240);
    out.goneAfterLoss = !I().visible; out.retry = M.start(); g.step(2); out.retryPhase = I().phase;
    // 7. unattended: he escapes when time runs out, no softlock (10.7)
    for (let i = 0; i < 190; i++) { P.solar = 1; P.pos.set(0, 600, 400); P.vel.set(0, 0, 0); g.step(60); }
    out.unattended = I().result; out.incAfterTimeout = g.currentInc ? g.currentInc.type : null;
    return out; })()`,
  check: r => [
    ['he spawns in the plaza (phase 2+)', r.started && r.phase >= 2 && r.label === 'Metallo', `phase ${r.phase}, label ${r.label}`],
    ['draw calls within budget (400) with Metallo in view', r.calls <= 400, `${r.calls} calls, ${r.meshes} Metallo meshes`],
    ['his model is 6-10 draw calls', r.meshes >= 6 && r.meshes <= 10, r.meshes],
    ['radiation weakens at 10 m (P.kryp >= 0.5)', r.k10 >= 0.5 && r.k10b >= 0.5, `kryp ${r.k10} at ${r.heart10} m`],
    ['radiation drains solar charge close in', r.solarDrop10 > 0.02, `-${r.solarDrop10} in 2 s`],
    ['radiation fades by 45 m (<= 0.05)', r.k45 <= 0.05, r.k45],
    ['the lead plate blocks >= 70% at 10 m', r.leadHeld && r.leadCut >= 0.7, `kryp ${r.k10} -> ${r.k10lead} (${Math.round(r.leadCut * 100)}%)`],
    ['unfrozen armour shrugs off a punch', r.platesNoFreeze === 6, r.platesNoFreeze],
    ['freeze then a charged punch cracks a plate', r.platesAfter === r.platesNoFreeze - 1, `frozen in ${r.freezeS} s ${JSON.stringify(r.frost)}; plates ${r.platesNoFreeze} -> ${r.platesAfter}`],
    ['a thrown car is intercepted: no bystander hit', r.caughtCar && r.caught >= 1 && r.hurtAfterCatch === 0, `caught ${r.caught}, hurt +${r.hurtAfterCatch}`],
    ['an uncaught car does hit the crowd', r.hurtUncaught >= 1, `hurt +${r.hurtUncaught}`],
    ['every attack telegraphed >= 1.0 s earlier', r.attacks > 0 && r.badTele === 0, `${r.attacks} attacks, ${r.badTele} untelegraphed`],
    ['scripted win: armour stripped, heart exposed', r.platesWin === 0 && r.phaseWin === 5, `plates ${r.platesWin}, phase ${r.phaseWin}, solar ${r.solarWin}`],
    ['lead shield lets him close in', r.leadHeld2 && r.kShield < 0.45, `kryp ${r.kShield} at 3 m`],
    ['win: heart contained, under 180 s of sim, medal computed', !!(r.win && r.win.win && r.contained && r.winSim < 180 && r.win.medal && r.medalEvt && r.incAfterWin !== 'metallo'), JSON.stringify(r.win) + ` sim ${r.winSim} s`],
    ['loss: solar charge 0 -> soft fail', !!(r.loss && !r.loss.win && r.loss.reason === 'solar' && r.incAfterLoss !== 'metallo' && r.goneAfterLoss), JSON.stringify(r.loss)],
    ['retry after a loss', r.retry && r.retryPhase === 1, `phase ${r.retryPhase}`],
    ['unattended 180 s: he escapes, no softlock', !!(r.unattended && r.unattended.reason === 'escape' && r.incAfterTimeout !== 'metallo'), JSON.stringify(r.unattended)]
  ]
});
// screenshots: OUT/metallo/*.png (reveal in the plaza, freezing him, the heart torn out)
SCENARIOS.push({
  name: 'metallo-shots', shotsOnly: true, quality: 'high',
  page: async (p) => {
    const dir = path.join(OUT, 'metallo'); fs.mkdirSync(dir, { recursive: true });
    const shots = [];
    const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
    const info = {};
    info.reveal = await p.evaluate(`(() => { ${METALLO_LIB} g.begin(); g.step(5); M.start(); g.step(330); M.calm(60); place(15, 1.6, 0.5); M.aim('chest', 1.2); g.step(40); M.aim('chest', 1.2); g.step(2); g.render(); return I(); })()`);
    await snap('metallo-reveal.png');
    info.freeze = await p.evaluate(`(() => { ${METALLO_LIB} M.calm(60); place(13, 2.6, 0.35); M.aim('chest', 0.66); g.keys.add('KeyQ'); g.step(70); M.aim('chest', 0.66); g.step(2); g.render(); g.keys.delete('KeyQ'); return I().frost; })()`);
    await snap('metallo-freeze.png');
    info.heart = await p.evaluate(`(() => { ${METALLO_LIB} for (const pl of S().plates) pl.alive = false; g.step(5);
      grabLead(); place(3.2, 1.8, 0.7); M.aim('heart'); g.step(1); g.grabOrRelease(); g.step(50); place(5.5, 2.4, 0.9); M.aim('heart', 0.2); g.step(10); g.render(); return I(); })()`);
    await snap('metallo-heart.png');
    return { info, shots };
  },
  check: r => [['Metallo revealed', r.info.reveal.visible && r.info.reveal.phase >= 2, ''], ['plates frozen in the shot', Math.max(...r.info.freeze) > 0.5, JSON.stringify(r.info.freeze)],
    ['heart torn out and contained', r.info.heart.contained, ''], ['screenshots written', r.shots.length === 3, r.shots.join(', ')]]
});

// radio comms (js/comms.js, dream-features #6 / demo step 5): dispatch on every emergency within 1 s,
// a newsroom verdict on a medal, no overlapping calls, the 20-40 s chatter limit over 3 simulated
// minutes, the card showing and hiding, and silent (but subtitled) calls with no audio context
SCENARIOS.push({
  name: 'comms',
  page: async (p) => {
    const out = {};
    // 1. an emergency start -> one Dispatch callout within 1 s, on the card with the speaker's name
    out.start = await p.evaluate(() => {
      const g = __game, C = SM_COMMS; g.begin(); g.step(30); C.clear();
      const tS = C.clock; g.startIncident('robbery');
      let lat = -1, shown = false, name = '', said = '';
      for (let i = 0; i < 90; i++) {
        g.step(1);
        const c = C.current;
        if (lat < 0 && c && c.who === 'dispatch' && /^start_/.test(c.trigger)) lat = C.clock - tS;
        if (lat >= 0 && !shown) { shown = C.cardVisible(); name = C.cardText().name; }
      }
      said = C.cardText().said;
      const inWin = C.history.filter(h => h.t0 >= tS - 1e-6 && h.t0 <= tS + 1 && h.who === 'dispatch').length;
      const tag = (C.history.find(h => h.t0 >= tS - 1e-6 && /^start_/.test(h.trigger)) || {}).incidentType;
      return { lat: +lat.toFixed(3), shown, name, said, inWin, tag, audio: !!(g.AU && g.AU.ctx) };
    });
    // 2. a medal -> Perry or Lois reacts. Let the callout finish, then shatter a meteor (a clean save)
    out.medal = await p.evaluate(() => {
      const g = __game, C = SM_COMMS;
      for (let i = 0; i < 400 && C.current; i++) g.step(1, 1 / 30);
      g.startIncident('meteor'); g.step(10, 1 / 30);
      const inc = g.currentInc; inc.m.done = 'shattered';
      const m0 = g.ledger.medals.gold + g.ledger.medals.silver + g.ledger.medals.bronze;
      for (let i = 0; i < 30 && g.currentInc; i++) g.step(1, 1 / 30);
      const tEnd = C.clock, medal = g.ledger.medals.gold + g.ledger.medals.silver + g.ledger.medals.bronze - m0;
      let r = null;
      for (let i = 0; i < 900 && !r; i++) { g.step(1, 1 / 30); r = C.history.find(h => h.t0 >= tEnd && /^(gold|silver|bronze)$/.test(h.trigger)) || null; }
      return { medal, who: r && r.who, trigger: r && r.trigger, after: r ? +(r.t0 - tEnd).toFixed(1) : -1, text: r && r.text };
    });
    // 3. three minutes of busy play: emergencies, speed, powers, damage and Hope swings
    // (run in 30 s slices so one long evaluate can't stall a loaded machine)
    await p.evaluate(() => {
      const g = __game, C = SM_COMMS, P = g.P;
      const plan = { 5: () => g.startIncident('fire'), 40: () => { g.ledger.damage += 4e6; }, 55: () => g.startIncident('heli'),
        80: () => { P.flying = true; P.pos.set(0, 600, 1500); P.vel.set(0, 0, 0); g.setYawPitch(0, 0); g.keys.add('KeyW'); g.keys.add('ShiftLeft'); },
        86: () => g.keys.clear(), 95: () => g.setMouse(false, true), 97: () => g.setMouse(false, false),
        105: () => { g.ledger.hope = 88; }, 120: () => g.startIncident('robbery'), 150: () => { g.ledger.hope = 12; }, 160: () => g.startIncident('meteor') };
      window.__ct = { t0: C.clock, starts: [], prev: g.currentInc, wasOn: false, shownAny: false, plan, done: {} };
    });
    for (let k = 0; k < 6; k++) {
      await p.evaluate(() => {
        const g = __game, C = SM_COMMS, s0 = window.__ct;
        for (let i = 0; i < 30 * 30; i++) {
          const s = Math.floor(C.clock - s0.t0);
          if (s0.plan[s] && !s0.done[s]) { s0.done[s] = true; s0.plan[s](); }
          g.step(1, 1 / 30);
          if (g.currentInc !== s0.prev) { s0.prev = g.currentInc; if (s0.prev) s0.starts.push({ t: C.clock, type: s0.prev.type }); }
          const on = !!C.current;
          if (on && !s0.wasOn) s0.shownAny = s0.shownAny || C.cardVisible();
          s0.wasOn = on;
        }
      });
    }
    out.play = await p.evaluate(() => {
      const g = __game, C = SM_COMMS, s0 = window.__ct, dt = 1 / 30;
      g.keys.clear(); g.setMouse(false, false);
      // let the radio go quiet: end the running emergency and drop queued calls so a follow-up can't
      // start in the gap (that race made this check flaky), then the card must go away
      if (g.deferIncident) g.deferIncident(1e9);
      if (g.currentInc && g.endIncident) g.endIncident(true, 'test');
      for (let i = 0, quiet = 0; i < 3000 && quiet < 20; i++) { if (C.queue && C.queue.length) C.queue.length = 0; g.step(1, dt); quiet = C.current ? 0 : quiet + 1; }
      const hiddenAfter = !C.cardVisible() && C.cardState() !== 'on';
      const H = C.history.filter(h => h.t0 >= s0.t0 - 1e-6).map(h => ({ who: h.who, trigger: h.trigger, prio: h.prio, t0: h.t0, t1: h.t1, it: h.incidentType, vi: h.vi, cut: h.cut }));
      const lineEv = (g.events || []).filter(e => e.type === 'line').length;
      return { H, starts: s0.starts, shownAny: s0.shownAny, hiddenAfter, span: C.clock - s0.t0, lineEv };
    });
    // 4. no audio context (headless / blocked audio) and voice off: silent calls, subtitles still render
    out.noAudio = await p.evaluate(() => {
      const g = __game, C = SM_COMMS, ctx = g.AU.ctx; C.clear();
      g.AU.ctx = null;
      C.say('lois', 'Lois here. Testing the line with no audio at all.', { interrupt: true }); g.step(40);
      const a = C.cardVisible() && /Lois/.test(C.cardText().name);
      C.say('dispatch', 'All units, radio check on band three.', { interrupt: true }); g.step(40);
      const b = C.cardVisible() && /Dispatch/.test(C.cardText().name);
      g.AU.ctx = ctx; C.voice = false;
      C.say('perry', 'Perry White. Voice off, words on.', { interrupt: true }); g.step(60);
      const c = C.cardVisible() && C.cardText().said.length > 0;
      C.voice = true; C.clear(); g.step(30);
      return { a, b, c, hidden: !C.cardVisible() };
    });
    out.table = await p.evaluate(() => {
      const L = SM_COMMS.lines, few = Object.keys(L).filter(k => L[k].length < 2);
      const who = {}; for (const k in L) for (const l of L[k]) who[l.w] = (who[l.w] || 0) + 1;
      return { total: SM_COMMS.lineCount(), triggers: Object.keys(L).length, few, who };
    });
    return out;
  },
  check: r => {
    const H = r.play.H, rows = [];
    rows.push(['emergency start: Dispatch on the radio within 1 s', r.start.lat >= 0 && r.start.lat <= 1.0, r.start.lat + ' s']);
    rows.push(['exactly one Dispatch line in that second', r.start.inWin === 1, r.start.inWin]);
    rows.push(['callout tagged with the incident type', r.start.tag === 'robbery', r.start.tag]);
    rows.push(['card shows the speaker and subtitle', r.start.shown && /Dispatch/.test(r.start.name) && r.start.said.length > 0, `${r.start.name}: "${r.start.said}"`]);
    rows.push(['medal: Perry or Lois reacts', r.medal.medal === 1 && (r.medal.who === 'perry' || r.medal.who === 'lois'), `${r.medal.trigger} by ${r.medal.who} +${r.medal.after}s: ${r.medal.text}`]);
    let overlap = 0; for (let i = 1; i < H.length; i++) if (H[i].t0 < H[i - 1].t1 - 1e-6) overlap++;
    rows.push(['calls never overlap (3 min)', overlap === 0 && H.length >= 6, `${H.length} calls, ${overlap} overlaps`]);
    let chat = 0, minChat = 999; for (let i = 1; i < H.length; i++) if (H[i].prio === 1) { const d = H[i].t0 - H[i - 1].t0; minChat = Math.min(minChat, d); if (d < 20 - 1e-6) chat++; }
    rows.push(['chatter at most 1 per 20 s (3 min)', chat === 0, `min gap ${minChat === 999 ? '-' : minChat.toFixed(1)} s`]);
    const nd = H.filter(h => h.who !== 'dispatch'); let fast = 0, minNd = 999;
    for (let i = 1; i < nd.length; i++) { const d = nd[i].t0 - nd[i - 1].t0; minNd = Math.min(minNd, d); if (d < 8 - 1e-6) fast++; }
    rows.push(['non-dispatch lines 8 s or more apart', fast === 0, `min ${minNd === 999 ? '-' : minNd.toFixed(1)} s`]);
    const miss = r.play.starts.filter(s => H.filter(h => h.who === 'dispatch' && /^start_/.test(h.trigger) && h.t0 >= s.t - 0.05 && h.t0 <= s.t + 1 && h.it === s.type).length !== 1);
    rows.push(['every emergency start gets its callout within 1 s', r.play.starts.length >= 4 && miss.length === 0, `${r.play.starts.length} starts (${r.play.starts.map(s => s.type).join(',')}), ${miss.length} missed`]);
    let rep = 0; const lastVi = {}; for (const h of H) { if (h.vi >= 0 && lastVi[h.trigger] === h.vi) rep++; lastVi[h.trigger] = h.vi; }
    rows.push(['no variant twice in a row', rep === 0, rep]);
    const kinds = [...new Set(H.map(h => h.who))];
    rows.push(['each call logs a line event', r.play.lineEv >= H.length, `${r.play.lineEv} line events`]);
    rows.push(['several voices heard', kinds.length >= 3, kinds.join(',')]);
    rows.push(['card shows during calls, hides after', r.play.shownAny && r.play.hiddenAfter, `shown ${r.play.shownAny}, hidden ${r.play.hiddenAfter}`]);
    rows.push(['no audio context / voice off: calls still subtitled', r.noAudio.a && r.noAudio.b && r.noAudio.c && r.noAudio.hidden, JSON.stringify(r.noAudio)]);
    rows.push(['line table: 150+ lines, every trigger 2+ variants', r.table.total >= 150 && r.table.few.length === 0, `${r.table.total} lines, ${r.table.triggers} triggers ${JSON.stringify(r.table.who)}${r.table.few.length ? ' short: ' + r.table.few : ''}`]);
    return rows;
  }
});

// screenshots of a Lois call and a police dispatch call: OUT/comms/*.png
SCENARIOS.push({
  name: 'comms-shots', shotsOnly: true,
  page: async (p) => {
    const dir = path.join(OUT, 'comms'); fs.mkdirSync(dir, { recursive: true });
    const shots = [];
    const snap = async (name) => { const f = path.join(dir, name); await p.screenshot({ path: f, timeout: 300000 }); shots.push(f); };
    const lois = await p.evaluate(() => {
      const g = __game, C = SM_COMMS; g.begin(); g.P.flying = true; g.P.pos.set(-60, 140, 260); g.setYawPitch(-0.3, -0.12); g.step(30); C.clear(); C.cfg.hold = 120; // the page keeps running during a slow software-GL screenshot
      C.say('lois', 'Lois here. My source at the fire marshal says the stairwell is gone. Those people can only come down the outside.', { interrupt: true });
      g.step(150); g.render(); return C.cardText();
    });
    await p.waitForTimeout(400);
    await snap('comms-lois.png');
    const disp = await p.evaluate(() => {
      const g = __game, C = SM_COMMS; C.clear(); g.step(5);
      g.startIncident('robbery'); g.step(170); g.render(); return C.cardText();
    });
    await p.waitForTimeout(400);
    await snap('comms-dispatch.png');
    return { lois, disp, shots };
  },
  check: r => [['Lois call on the card', /Lois/.test(r.lois.name) && r.lois.said.length > 10, r.lois.said],
    ['Dispatch call on the card', /Dispatch/.test(r.disp.name) && r.disp.said.length > 10, r.disp.said],
    ['screenshots written', r.shots.length === 2, r.shots.join(', ')]]
});

const RIGS = [
  ['title', null],
  ['aerial', `g.P.flying = true; g.P.pos.set(0, 260, 380); g.setYawPitch(0, -0.18);`],
  ['street', `g.P.flying = false; g.P.pos.set(-150, 1.2, 152); g.setYawPitch(-1.2, 0.06);`],
  ['avenue', `g.P.flying = true; g.P.pos.set(-90, 22, 180); g.setYawPitch(0, -0.02);`],
  ['waterfront', `g.P.flying = true; g.P.pos.set(40, 30, 236); g.setYawPitch(Math.PI, -0.05);`]
];

async function page(browser, q) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p.setDefaultTimeout(LOAD_TIMEOUT);
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 3).join(' <- ')));
  await p.goto(GAME + '?q=' + q, { timeout: LOAD_TIMEOUT });
  await p.waitForFunction(() => window.__game, null, { timeout: LOAD_TIMEOUT });
  return { p, errs };
}

// ---------------------------------------------------------------- runner, with hang protection
// A SwiftShader page can hang with the renderer at 0% CPU (seen: two runs stuck ~27 min, evaluate never
// returning). So every scenario runs under a watchdog, a dead or wedged browser is relaunched, and a global
// wall-clock cap always leaves a (partial) report.json behind.
//   --slow N          multiply every scenario budget (default 1; use 2-3 on a heavily shared machine)
//   --max-minutes N   global cap for the whole run (default 120)
const SLOW = Math.max(0.001, +opt('slow', 1));
const MAX_MS = +opt('max-minutes', 120) * 60000;
const T_START = Date.now();
const BROWSER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const budgetMs = sc => (sc.minutes || 8) * 60000 * SLOW;
class Hung extends Error {}
const watchdog = (promise, ms, what) => {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Hung(`${what} hung (> ${Math.round(ms / 1000)} s)`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
};
const settle = (promise, ms) => watchdog(promise, ms, 'cleanup').catch(() => {}); // close() itself can hang

const report = { when: new Date().toISOString(), quality: QUALITY, scenarios: {}, shots: [], failures: 0, hung: [], relaunches: 0 };
const writeReport = () => { try { fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)); } catch (_) { /* best effort */ } };
const record = (name, rows, result) => {
  report.scenarios[name] = { result, rows };
  for (const [label, ok, detail] of rows) {
    if (!ok) report.failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} ${label}${detail !== '' && detail !== undefined ? '  (' + detail + ')' : ''}`);
  }
  writeReport(); // partial results survive a crash or a kill
};
// last line of defence: even if the event loop is stuck awaiting a wedged browser call, exit with a report
setTimeout(() => { report.aborted = 'global cap reached'; report.failures++; writeReport(); console.log(`\nABORTED: run exceeded ${MAX_MS / 60000} min  ->  ${path.join(OUT, 'report.json')}`); process.exit(1); }, MAX_MS + 120000).unref();

let browser = null;
async function ensureBrowser(force) {
  if (browser && browser.isConnected() && !force) return browser;
  if (browser) { report.relaunches++; console.log('  (relaunching the browser)'); await settle(browser.close(), 20000); }
  browser = await chromium.launch({ args: BROWSER_ARGS });
  return browser;
}

async function runScenario(sc) {
  let p = null, errs = [], result;
  const body = (async () => {
    ({ p, errs } = await page(await ensureBrowser(), sc.quality || SCEN_QUALITY));
    let cdp = null, cpu0 = 0;
    const threadTime = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value;
    if (sc.cpuFrames) try { cdp = await p.context().newCDPSession(p); await cdp.send('Performance.enable'); cpu0 = await threadTime(); } catch (_) { cdp = null; }
    result = sc.page ? await sc.page(p) : await p.evaluate(sc.run);
    if (cdp) try { result.cpuMs = (await threadTime() - cpu0) * 1000 / sc.cpuFrames; } catch (_) { /* wall time only */ }
    return sc.check(result);
  })();
  let rows;
  try { rows = await watchdog(body, budgetMs(sc), 'scenario'); }
  catch (e) {
    rows = [[e instanceof Hung ? 'scenario hung' : 'scenario ran', false, e.message.split('\n')[0]]];
    if (e instanceof Hung) { report.hung.push(sc.name); body.catch(() => {}); await ensureBrowser(true); p = null; } // a wedged page can wedge the browser
    else if (!browser || !browser.isConnected()) await ensureBrowser(true);
  }
  rows.push(['no console errors', errs.length === 0, errs.slice(0, 3).join(' | ')]);
  if (p) await settle(p.close(), 20000);
  return { rows, result };
}

(async () => {
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    if (sc.shotsOnly && !SHOTS && !ONLY.includes(sc.name)) continue; // screenshot scenarios run with --shots
    if (Date.now() - T_START > MAX_MS) { record(sc.name, [['skipped: global time cap reached', false, `${MAX_MS / 60000} min`]]); continue; }
    const { rows, result } = await runScenario(sc);
    record(sc.name, rows, result);
  }
  if (flag('shots')) {
    for (const [name, setup] of RIGS) {
      if (ONLY.length && !ONLY.includes('shot:' + name)) continue;
      if (Date.now() - T_START > MAX_MS) { record('shot:' + name, [['skipped: global time cap reached', false, '']]); continue; }
      let p = null;
      try {
        await watchdog((async () => {
          ({ p } = await page(await ensureBrowser(), QUALITY));
          if (setup) await p.evaluate(`(() => { const g = __game; g.begin(); ${setup} g.step(45); })()`);
          else { await p.waitForFunction(() => window.__game.titleReady, null, { timeout: LOAD_TIMEOUT }); await p.evaluate(() => __game.step(150)); }
          const file = path.join(OUT, `rig-${name}.png`);
          await p.screenshot({ path: file, timeout: 300000 });
          report.shots.push(file); console.log('SHOT  ' + file);
        })(), 8 * 60000 * SLOW, 'screenshot');
      } catch (e) { record('shot:' + name, [[e instanceof Hung ? 'scenario hung' : 'shot taken', false, e.message.split('\n')[0]]]); if (e instanceof Hung) { await ensureBrowser(true); p = null; } }
      if (p) await settle(p.close(), 20000);
    }
  }
  writeReport();
  console.log(`\n${report.failures === 0 ? 'ALL PASS' : report.failures + ' FAILURE(S)'}${report.hung.length ? '  (hung: ' + report.hung.join(', ') + ')' : ''}  ->  ${path.join(OUT, 'report.json')}`);
  if (browser) await settle(browser.close(), 20000);
  process.exit(report.failures ? 1 : 0);
})();
