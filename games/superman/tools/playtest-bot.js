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
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const GAME = 'file://' + path.resolve(__dirname, '..', 'index.html');
fs.mkdirSync(OUT, { recursive: true });

// Each scenario runs in a fresh page. `run` executes in the browser and returns a result object;
// `check` turns it into a list of [label, pass, detail] assertions.
const SCENARIOS = [
  {
    name: 'boot',
    run: `(() => { const g = __game; const unsupported = g.unsupportedAtStart(); g.begin(); g.step(60);
      return { unsupported, people: g.people.length, cars: g.bodies.filter(b => b.kind === 'car').length, buildings: g.buildings.length }; })()`,
    check: r => [['no floor starts unsupported', r.unsupported === 0, r.unsupported],
      ['city populated', r.people > 50 && r.cars > 40 && r.buildings > 30, `${r.people} people, ${r.cars} cars, ${r.buildings} towers`]]
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
      for (let i = 0; i < 900; i++) { const a = performance.now(); g.update(1 / 60); worstFrame = Math.max(worstFrame, performance.now() - a); peakLive = Math.max(peakLive, g.liveDebrisCount); }
      const ms = (performance.now() - t0) / 900;
      for (const o of g.bodies) if (!isFinite(o.pos.x + o.pos.y + o.pos.z)) nan++;
      return { afterPunch, peakLive, live: g.liveDebrisCount, rubble: g.rubble.length, queue: g.fallQueue.length, nan, ms, worstFrame, damage: g.ledger.damage }; })()`,
    check: r => [['punch breaks the wall', r.afterPunch > 0, r.afterPunch + ' pieces'],
      ['tower comes down', r.rubble + r.live > 150, `${r.rubble} rubble, ${r.live} live`],
      ['live debris stays under cap', r.peakLive <= 450, r.peakLive],
      ['collapse finishes (queue drains)', r.queue === 0, r.queue],
      ['no NaN bodies', r.nan === 0, r.nan],
      ['collapse sim cost (ms/frame, CPU)', r.ms < 12, r.ms.toFixed(2) + ' avg, ' + r.worstFrame.toFixed(1) + ' worst']]
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
    name: 'idle-sim-cost',
    run: `(() => { const g = __game; g.begin(); g.step(60); const t0 = performance.now(); g.step(600); return { ms: (performance.now() - t0) / 600 }; })()`,
    check: r => [['idle sim cost (ms/frame, CPU)', r.ms < 6, r.ms.toFixed(2)]]
  }
];

const RIGS = [
  ['aerial', `g.P.flying = true; g.P.pos.set(0, 260, 380); g.setYawPitch(0, -0.18);`],
  ['street', `g.P.flying = false; g.P.pos.set(-150, 1.2, 152); g.setYawPitch(-1.2, 0.06);`],
  ['avenue', `g.P.flying = true; g.P.pos.set(-90, 22, 180); g.setYawPitch(0, -0.02);`],
  ['waterfront', `g.P.flying = true; g.P.pos.set(40, 30, 236); g.setYawPitch(Math.PI, -0.05);`]
];

async function page(browser, q) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await p.goto(GAME + '?q=' + q);
  await p.waitForFunction(() => window.__game, null, { timeout: 120000 });
  return { p, errs };
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = { when: new Date().toISOString(), quality: QUALITY, scenarios: {}, shots: [], failures: 0 };
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    const { p, errs } = await page(browser, 'low');
    let result, rows;
    try { result = await p.evaluate(sc.run); rows = sc.check(result); }
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
      await p.evaluate(`(() => { const g = __game; g.begin(); ${setup} g.step(45); })()`);
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
