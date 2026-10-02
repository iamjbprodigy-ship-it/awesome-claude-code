#!/usr/bin/env node
/* Automated playtest bot for Superman Over Metropolis.
 *
 *   node tools/playtest-bot.js [--shots] [--out DIR] [--quality low|shot] [--only name,name]
 *   (--only missions,dialogue,mission-shots for the street-level missions; mission-shots writes DIR/missions/*.png)
 *   (--only power-levels,ground-run,hearing for the power set; powers-shots writes DIR/powers/*.png)
 *   (--only comms for the radio calls; comms-shots writes DIR/comms/*.png)
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
const SHOTS = flag('shots');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const GAME = 'file://' + path.resolve(opt('file', path.join(__dirname, '..', 'index.html')));
fs.mkdirSync(OUT, { recursive: true });

// Each scenario runs in a fresh page. `run` executes in the browser and returns a result object;
// `check` turns it into a list of [label, pass, detail] assertions.
const SCENARIOS = [
  {
    name: 'title-start',
    // real user path: wait for the title to say it's ready, then click Start / press Enter
    page: async (p) => {
      await p.waitForFunction(() => window.__game && window.__game.titleReady, null, { timeout: 120000 });
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
      await p.waitForFunction(() => window.__game && window.__game.titleReady, null, { timeout: 120000 });
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
    name: 'punch-and-collapse',
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
      ['collapse sim cost (ms/frame, CPU)', r.ms < 12, r.ms.toFixed(2) + ' avg, ' + r.worstFrame.toFixed(1) + ' worst']]
  },
  {
    name: 'superpowers',
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
    name: 'emergencies',
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
    name: 'render-budget', quality: 'high',
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
    name: 'idle-sim-cost',
    run: `(() => { const g = __game; g.begin(); g.step(60); const t0 = performance.now(); g.step(600); return { ms: (performance.now() - t0) / 600 }; })()`,
    check: r => [['idle sim cost (ms/frame, CPU)', r.ms < 6, r.ms.toFixed(2)]]
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
    name: 'missions',
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
    out.play = await p.evaluate(() => {
      const g = __game, C = SM_COMMS, P = g.P, dt = 1 / 30;
      const t0 = C.clock, starts = [];
      let prev = g.currentInc, wasOn = false, shownAny = false, hiddenAfter = true;
      const plan = { 5: () => g.startIncident('fire'), 40: () => { g.ledger.damage += 4e6; }, 55: () => g.startIncident('heli'),
        80: () => { P.flying = true; P.pos.set(0, 600, 1500); P.vel.set(0, 0, 0); g.setYawPitch(0, 0); g.keys.add('KeyW'); g.keys.add('ShiftLeft'); },
        86: () => g.keys.clear(), 95: () => g.setMouse(false, true), 97: () => g.setMouse(false, false),
        105: () => { g.ledger.hope = 88; }, 120: () => g.startIncident('robbery'), 150: () => { g.ledger.hope = 12; }, 160: () => g.startIncident('meteor') };
      const done = {};
      for (let i = 0; i < 180 * 30; i++) {
        const s = Math.floor(C.clock - t0);
        if (plan[s] && !done[s]) { done[s] = true; plan[s](); }
        g.step(1, dt);
        if (g.currentInc !== prev) { prev = g.currentInc; if (prev) starts.push({ t: C.clock, type: prev.type }); }
        const on = !!C.current;
        if (on && !wasOn) shownAny = shownAny || C.cardVisible();
        wasOn = on;
      }
      g.keys.clear(); g.setMouse(false, false);
      // let the last call finish: the card must go away
      for (let i = 0; i < 900 && C.current; i++) g.step(1, dt);
      g.step(20, dt);
      hiddenAfter = !C.cardVisible() && C.cardState() !== 'on';
      const H = C.history.filter(h => h.t0 >= t0 - 1e-6).map(h => ({ who: h.who, trigger: h.trigger, prio: h.prio, t0: h.t0, t1: h.t1, it: h.incidentType, vi: h.vi, cut: h.cut }));
      return { H, starts, shownAny, hiddenAfter, span: C.clock - t0 };
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
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 3).join(' <- ')));
  await p.goto(GAME + '?q=' + q);
  await p.waitForFunction(() => window.__game, null, { timeout: 120000 });
  return { p, errs };
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = { when: new Date().toISOString(), quality: QUALITY, scenarios: {}, shots: [], failures: 0 };
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    if (sc.shotsOnly && !SHOTS && !ONLY.includes(sc.name)) continue; // screenshot scenarios run with --shots
    const { p, errs } = await page(browser, sc.quality || 'low');
    let result, rows;
    try { result = sc.page ? await sc.page(p) : await p.evaluate(sc.run); rows = sc.check(result); }
    catch (e) { rows = [['scenario ran', false, e.message.split('\n')[0]]]; }
    rows.push(['no console errors', errs.length === 0, errs.slice(0, 3).join(' | ')]);
    report.scenarios[sc.name] = { result, rows };
    for (const [label, ok, detail] of rows) {
      if (!ok) report.failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${sc.name.padEnd(20)} ${label}${detail !== '' && detail !== undefined ? '  (' + detail + ')' : ''}`);
    }
    await p.close();
  }
  if (flag('shots')) {
    for (const [name, setup] of RIGS) {
      if (ONLY.length && !ONLY.includes('shot:' + name)) continue;
      const { p } = await page(browser, QUALITY);
      if (setup) await p.evaluate(`(() => { const g = __game; g.begin(); ${setup} g.step(45); })()`);
      else { await p.waitForFunction(() => window.__game.titleReady, null, { timeout: 120000 }); await p.evaluate(() => __game.step(150)); }
      const file = path.join(OUT, `rig-${name}.png`);
      await p.screenshot({ path: file, timeout: 300000 });
      report.shots.push(file); console.log('SHOT  ' + file);
      await p.close();
    }
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.failures === 0 ? 'ALL PASS' : report.failures + ' FAILURE(S)'}  ->  ${path.join(OUT, 'report.json')}`);
  await browser.close();
  process.exit(report.failures ? 1 : 0);
})();
