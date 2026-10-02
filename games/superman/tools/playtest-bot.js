#!/usr/bin/env node
/* Automated playtest bot for Superman Over Metropolis.
 *
 *   node tools/playtest-bot.js [--shots] [--out DIR] [--quality low|shot] [--only name,name]
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
    run: `(() => { const g = __game; g.begin(); g.P.pos.set(0, 400, 0); g.setYawPitch(0, 0.1);
      g.keys.add('KeyW'); g.keys.add('ShiftLeft'); let boomed = false, maxSp = 0;
      for (let i = 0; i < 240; i++) { g.step(1); maxSp = Math.max(maxSp, g.P.vel.length()); boomed = boomed || g.P.boomed; }
      g.keys.clear(); g.P.pos.set(0, 60, 150); g.P.vel.set(0, 0, 0); g.keys.add('ShiftLeft'); g.keys.add('KeyW'); g.setYawPitch(0, 0);
      let lowMax = 0; for (let i = 0; i < 120; i++) { g.step(1); if (g.P.pos.y < 150) lowMax = Math.max(lowMax, g.P.vel.length()); }
      g.keys.clear(); return { maxSp, boomed, lowMax, alt: g.P.pos.y }; })()`,
    check: r => [['boost goes supersonic up high', r.maxSp > 340 && r.boomed, `${r.maxSp.toFixed(0)} m/s`],
      ['boost capped below 150 m', r.lowMax <= 305, `${r.lowMax.toFixed(0)} m/s`]]
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
      g.grabOrRelease(); out.grabbed = !!g.P.hold; g.step(10); g.setYawPitch(-Math.PI / 2, 0.3); g.throwHeld(4); g.step(20);
      out.thrownSpeed = car2.vel.length();
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
