/* Superman Over Metropolis: far skyline plugin.
 * A static, non-destructible city that wraps the destructible 7 x 7 core: the same 60 m street
 * grid continued out to ~3.2 km, a midtown supertall cluster behind the core, a far-shore downtown
 * across the bay, and two landmarks that close avenue views from the core.
 *
 * Draw-call budget (whole plugin): 2 facade meshes (near / far), 1 spire, 1 water tower, 1 tree,
 * 1 warning light, 3 ground planes, ~20 landmark meshes.
 * Instance budget: <= 12,000 instanced boxes/props in total (halved density on low quality).
 * Every building box and tier returns an AABB collider.
 */
(function () {
'use strict';
window.SM_PLUGINS = window.SM_PLUGINS || [];
window.SM_PLUGINS.push(function skyline(ctx) {
  const THREE = ctx.THREE, lin = ctx.lin, clamp = ctx.clamp;
  const LOWQ = !!ctx.isLowQuality;
  const rs = ctx.srand(19380412);
  const R = (a, b) => a + rs() * (b - a);
  const pickS = a => a[Math.floor(rs() * a.length)];

  // ---------------------------------------------------------------- layout constants
  const PITCH = 60, ROAD0 = -210, CORE_CLEAR = 245, RMAX = 3200;
  const NEAR_SEAWALL = 220, FAR_SEAWALL = 1830, FAR_SHORE_MAX = 3260;
  const NEAR_DIST = 700, PROP_DIST = 1500;
  const INSTANCE_CAP = 12000;
  const snap4 = v => Math.max(4, Math.round(v / 4) * 4);
  const lerp = (a, b, t) => a + (b - a) * t;

  // integer hash + value noise (deterministic, independent of the game's RNG stream)
  function hash2(i, j, s) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, z, s) {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const ellipse = (x, z, cx, cz, rx, rz) => clamp(1 - Math.hypot((x - cx) / rx, (z - cz) / rz), 0, 1);

  // ---------------------------------------------------------------- colours
  const styleCols = ctx.STYLE_COLORS.map(list => list.map(h => new THREE.Color(h).convertSRGBToLinear()));
  function styleColor(style) {
    const c = pickS(styleCols[style]).clone(), v = R(0.88, 1.08);
    return c.multiplyScalar(v);
  }

  // ---------------------------------------------------------------- output collections
  const boxes = [];        // facade instances
  const colliders = [];
  const spires = [];       // {x, y, z, r, h}
  const tanks = [];        // water towers {x, y, z, s, rot}
  const parks = [], plazas = [], pads = [];
  const lights = [];       // aircraft warning light positions
  const reserved = [];     // landmark footprints (no ordinary buildings inside)

  function addBox(x0, z0, x1, z1, y0, y1, style, col, lit) {
    boxes.push({ x0, z0, x1, z1, y0, y1, style, col, lit });
    colliders.push({ x0, y0, z0, x1, y1, z1 });
  }
  const hitsReserved = (x0, z0, x1, z1) =>
    reserved.some(r => x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0);

  // ---------------------------------------------------------------- building
  // A building is a stack of 1-3 tier boxes; each tier sits on the previous one (no coplanar overlap).
  function addBuilding(x0, z0, x1, z1, h, style, o) {
    o = o || {};
    if (hitsReserved(x0 - 5, z0 - 5, x1 + 5, z1 + 5)) return null;
    const col = styleColor(style);
    const lit = rs() < 0.25 ? R(0.3, 1) : 0;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, dist = Math.hypot(cx, cz);
    let tx0 = x0, tx1 = x1, tz0 = z0, tz1 = z1, y = 0;
    const breaks = [];
    if (h > 60) {
      const nt = (h > 140 || rs() < 0.4) ? 3 : 2;
      if (nt === 2) breaks.push(snap4(h * R(0.55, 0.75)));
      else breaks.push(snap4(h * R(0.4, 0.55)), snap4(h * R(0.68, 0.84)));
    }
    breaks.push(h);
    for (let t = 0; t < breaks.length; t++) {
      if (t > 0) {
        // each tier 5-10 m narrower per axis: 5 = inset one side, 10 = inset both sides
        for (const ax of [0, 1]) {
          const w = ax === 0 ? tx1 - tx0 : tz1 - tz0;
          if (w < 20) continue;
          const both = w >= 25 && rs() < 0.6, side = rs() < 0.5;
          if (ax === 0) { if (both || side) tx0 += 5; if (both || !side) tx1 -= 5; }
          else { if (both || side) tz0 += 5; if (both || !side) tz1 -= 5; }
        }
      }
      const yt = Math.max(breaks[t], y + 4);
      addBox(tx0, tz0, tx1, tz1, y, yt, style, col, lit);
      y = yt;
    }
    const top = { x0: tx0, z0: tz0, x1: tx1, z1: tz1, y };
    const tw = tx1 - tx0, td = tz1 - tz0;

    // roof dressing (within PROP_DIST only)
    if (dist < PROP_DIST && !o.noRoof) {
      let usedQuad = -1;
      if (h < 60 && tw >= 10 && td >= 10 && rs() < 0.3) {
        // water tower on legs, in one roof quadrant
        usedQuad = Math.floor(rs() * 4);
        const qx = usedQuad & 1 ? tx1 - 4.5 : tx0 + 4.5, qz = usedQuad & 2 ? tz1 - 4.5 : tz0 + 4.5;
        tanks.push({ x: qx, y: top.y, z: qz, s: R(0.8, 1.15), rot: R(0, 6.28) });
      }
      if (tw >= 15 && td >= 15 && rs() < 0.4) {
        // stair / elevator bulkhead: 5 m grid aligned, one storey, windowless
        const bw = rs() < 0.5 ? 5 : 10, bd = 5;
        let q = Math.floor(rs() * 4); if (q === usedQuad) q = 3 - q;
        const bx0 = q & 1 ? tx1 - 5 - bw : tx0 + 5, bz0 = q & 2 ? tz1 - 5 - bd : tz0 + 5;
        if (bx0 >= tx0 && bx0 + bw <= tx1 && bz0 >= tz0 && bz0 + bd <= tz1)
          addBox(bx0, bz0, bx0 + bw, bz0 + bd, top.y, top.y + 4, style + 4, col.clone().multiplyScalar(0.92), 0);
      }
    }
    // supertall crowns: spire / antenna mast, or a mechanical penthouse
    if (h >= 120) {
      const scx = (tx0 + tx1) / 2, scz = (tz0 + tz1) / 2;
      const roll = rs();
      if (roll < 0.45) {
        const sh = R(25, 70);
        spires.push({ x: scx, y: top.y, z: scz, r: R(1.2, 2.2), h: sh });
        lights.push({ x: scx, y: top.y + sh + 1, z: scz, h: top.y + sh });
      } else if (roll < 0.7) {
        const mh = R(18, 40);
        spires.push({ x: scx + 2, y: top.y, z: scz - 1, r: 0.45, h: mh });
        if (rs() < 0.5) spires.push({ x: scx - 3, y: top.y, z: scz + 2, r: 0.35, h: mh * 0.6 });
        lights.push({ x: scx + 2, y: top.y + mh + 0.6, z: scz - 1, h: top.y + mh });
      } else if (tw >= 20 && td >= 20) {
        addBox(tx0 + 5, tz0 + 5, tx1 - 5, tz1 - 5, top.y, top.y + 8, style + 4, col.clone().multiplyScalar(0.9), 0);
      }
    }
    return top;
  }

  function towerStyle(h) {
    const r = rs();
    if (h > 120) return r < 0.5 ? 2 : r < 0.8 ? 1 : 3;
    return r < 0.35 ? 1 : r < 0.7 ? 2 : 3;
  }
  function lowStyle(h) {
    const r = rs();
    if (h <= 24) return r < 0.6 ? 0 : r < 0.88 ? 1 : 3;
    return r < 0.3 ? 0 : r < 0.6 ? 1 : r < 0.8 ? 3 : 2;
  }

  // ---------------------------------------------------------------- landmarks (reserve first)
  const LM_CIVIC = { x0: 45, z0: -440, x1: 135, z1: -388 };        // closes the x = 90 avenue
  const LM_GOTHIC = { x0: -110, z0: -560, x1: -70, z1: -520 };     // closes the x = -90 avenue
  reserved.push(LM_CIVIC, LM_GOTHIC);
  plazas.push({ x0: 35, z0: -450, x1: 145, z1: -378 }, { x0: -120, z0: -575, x1: -60, z1: -505 });

  // ---------------------------------------------------------------- the street grid
  const AVENUE = x => (((x + 90) % 180) + 180) % 180 === 0;        // N-S avenues: x = -90 +- 180k
  const BLVD = z => (((z - ROAD0) % 240) + 240) % 240 === 0;       // E-W boulevards every 4th street
  const IMAX = Math.ceil((RMAX + 260) / PITCH);
  let lotCount = 0;
  for (let j = -IMAX; j <= IMAX + 2; j++) for (let i = -IMAX; i <= IMAX; i++) {
    if (i >= 0 && i <= 6 && j >= 0 && j <= 6) continue;              // destructible core
    const lx = ROAD0 + 10 + i * PITCH, lz = ROAD0 + 10 + j * PITCH;
    let ax0 = lx, ax1 = lx + 40, az0 = lz, az1 = lz + 40;
    const cx = lx + 20, cz = lz + 20;
    const farShore = az0 >= FAR_SEAWALL;
    if (az1 > NEAR_SEAWALL && az0 < FAR_SEAWALL) continue;           // bay + both seawalls
    const r = Math.hypot(cx, cz);
    const inDowntownBox = farShore && cx > -620 && cx < 920 && cz < FAR_SHORE_MAX;
    if (r > RMAX && !inDowntownBox) continue;
    // ring lots touching the core: clip to |x|,|z| >= 245 so the core keeps its margin
    const nearCoreX = ax1 > -CORE_CLEAR && ax0 < CORE_CLEAR, nearCoreZ = az1 > -CORE_CLEAR && az0 < CORE_CLEAR;
    if (nearCoreX && nearCoreZ) {
      if (i < 0) ax1 = Math.min(ax1, -CORE_CLEAR); else if (i > 6) ax0 = Math.max(ax0, CORE_CLEAR);
      if (j < 0) az1 = Math.min(az1, -CORE_CLEAR); else if (j > 6) az0 = Math.max(az0, CORE_CLEAR);
      if (ax1 - ax0 < 10 || az1 - az0 < 10) continue;
    }
    if (hitsReserved(ax0, az0, ax1, az1) && (ax1 - ax0) * (az1 - az0) >= 1600 &&
        reserved.some(q => ax0 >= q.x0 - 10 && ax1 <= q.x1 + 10 && az0 >= q.z0 - 10 && az1 <= q.z1 + 10)) continue;
    lotCount++;

    const lot = { x0: ax0, z0: az0, x1: ax1, z1: az1 };
    // low quality: half density beyond the near ring (dropped lots still get a pad)
    if (LOWQ && r > 500 && hash2(i, j, 91) < 0.5) { pads.push(lot); continue; }

    const n = 0.62 * vnoise(cx / 430, cz / 430, 1) + 0.38 * vnoise(cx / 150, cz / 150, 2);
    // parks: clustered by low-frequency noise plus scattered pocket parks / plazas
    const parkN = vnoise(cx / 520, cz / 520, 7);
    const pr = hash2(i, j, 3);
    if (parkN > 0.85 || pr < 0.035) { parks.push(lot); continue; }
    if (pr < 0.05) { plazas.push(lot); pads.push(lot); }
    else pads.push(lot);

    const edge = clamp((r - 350) / 2700, 0, 1);
    const mid = farShore ? 0 : ellipse(cx, cz, 0, -1300, 440, 440);
    const midRamp = farShore ? 0 : ellipse(cx, cz, 0, -1300, 1000, 1000);
    const down = farShore ? ellipse(cx, cz, 150, 2600, 780, 640) : 0;
    const downRamp = farShore ? ellipse(cx, cz, 150, 2600, 1400, 1100) : 0;
    const onAve = AVENUE(lx - 10) || AVENUE(lx + 50);
    const onBlvd = BLVD(lz - 10) || BLVD(lz + 50);
    const fullLot = ax1 - ax0 === 40 && az1 - az0 === 40;
    if (pr < 0.05) continue; // plaza

    // supertall clusters
    const inMid = cx > -420 && cx < 420 && cz < -880 && cz > -1720;
    const inDown = farShore && cx > -600 && cx < 900 && cz > 2000 && cz < 3200;
    if (fullLot && ((inMid && rs() < 0.22 + 0.6 * mid) || (inDown && rs() < 0.18 + 0.55 * down))) {
      const w = pickS([30, 35, 40]), d = pickS([30, 35, 40]);
      const ox = ax0 + 5 * Math.floor(rs() * ((40 - w) / 5 + 1)), oz = az0 + 5 * Math.floor(rs() * ((40 - d) / 5 + 1));
      const h = inMid
        ? snap4(120 + 180 * clamp(0.65 * mid + 0.45 * rs(), 0, 1))
        : snap4(150 + 170 * clamp(0.6 * down + 0.5 * rs(), 0, 1));
      addBuilding(ox, oz, ox + w, oz + d, h, towerStyle(h));
      continue;
    }

    // ordinary lots: 12-60 m walk-ups and mid-rises, lower toward the edge, taller on avenues
    const maxH = lerp(60, 30, edge);
    let h0 = 12 + (maxH - 12) * Math.pow(n, 1.35);
    if (onAve) h0 *= 1.35; else if (onBlvd) h0 *= 1.15;
    h0 += 46 * Math.pow(Math.max(midRamp, downRamp), 1.5);
    const hCap = 60 + 50 * Math.max(midRamp, downRamp);
    const varH = () => clamp(snap4(h0 * R(0.62, 1.32)), 12, hCap);

    // occasional mid-century slab tower inside the city, mostly on avenues
    if (fullLot && r < 1700 && rs() < (onAve ? 0.06 : 0.018)) {
      const h = snap4(R(68, 112)), w = pickS([30, 35, 40]), d = pickS([25, 30, 35]);
      const ox = ax0 + 5 * Math.floor(rs() * ((40 - w) / 5 + 1)), oz = az0 + 5 * Math.floor(rs() * ((40 - d) / 5 + 1));
      addBuilding(ox, oz, ox + w, oz + d, h, towerStyle(h));
      continue;
    }

    // instance budget: lots thin out to one building each with distance (they read as one mass in the haze)
    const singleP = r > 2300 ? 0.95 : r > 1400 ? 0.8 : onAve ? 0.5 : 0.32;
    const single = rs() < singleP;
    if (single || !fullLot) {
      let w, d, ox, oz;
      if (fullLot) {
        w = pickS([30, 35, 40, 40]); d = pickS([30, 35, 40, 40]);
        ox = ax0 + 5 * Math.floor(rs() * ((40 - w) / 5 + 1)); oz = az0 + 5 * Math.floor(rs() * ((40 - d) / 5 + 1));
      } else { w = ax1 - ax0; d = az1 - az0; ox = ax0; oz = az0; }
      const h = varH();
      addBuilding(ox, oz, ox + w, oz + d, h, onAve && h > 30 ? towerStyle(h) : lowStyle(h));
      continue;
    }
    // 2-4 smaller buildings: street-wall strips, or a broken 2 x 2 block with a courtyard
    if (rs() < 0.72) {
      const parts = pickS([[20, 20], [15, 25], [25, 15], [10, 15, 15], [15, 10, 15], [10, 10, 20], [20, 10, 10], [15, 15, 10], [10, 10, 10, 10]]);
      const alongX = onAve ? false : rs() < 0.5;   // on avenues, the strips face the avenue
      const front = rs() < 0.5;
      let s = alongX ? ax0 : az0;
      for (const p of parts) {
        const dep = pickS([25, 30, 35, 40, 40]), h = varH(), st = lowStyle(h);
        if (alongX) { const z0 = front ? az0 : az1 - dep; addBuilding(s, z0, s + p, z0 + dep, h, st); }
        else { const x0 = front ? ax0 : ax1 - dep; addBuilding(x0, s, x0 + dep, s + p, h, st); }
        s += p;
      }
    } else {
      const skip = rs() < 0.45 ? Math.floor(rs() * 4) : -1;
      for (let q = 0; q < 4; q++) {
        if (q === skip) continue;
        const qx = ax0 + (q & 1) * 20, qz = az0 + (q >> 1) * 20, h = varH();
        addBuilding(qx, qz, qx + 20, qz + 20, h, lowStyle(h));
      }
    }
  }

  // ---------------------------------------------------------------- landmark 1: civic hall with copper dome
  const scene = ctx.scene;
  const stoneMat = new THREE.MeshStandardMaterial({ color: lin(0xd8ccb2), roughness: 0.85 });
  const copperMat = new THREE.MeshStandardMaterial({ color: lin(0x6f9e8a), roughness: 0.5, metalness: 0.3 });
  const goldMat = new THREE.MeshStandardMaterial({ color: lin(0xd9a83a), roughness: 0.3, metalness: 1.0 });
  function mesh(geo, mat, x, y, z, ry) {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true; scene.add(m); return m;
  }
  const finial = (x, y, z, s) => {
    mesh(new THREE.CylinderGeometry(0.25 * s, 0.6 * s, 1.6 * s, 8), goldMat, x, y + 0.8 * s, z);
    mesh(new THREE.SphereGeometry(0.7 * s, 10, 8), goldMat, x, y + 2.1 * s, z);
    mesh(new THREE.ConeGeometry(0.22 * s, 2.2 * s, 8), goldMat, x, y + 3.6 * s, z);
  };
  {
    const civCol = lin(0xddd1b9), lit = 0.5;
    // wings (windowed limestone facade) and the taller central pavilion
    addBox(45, -440, 135, -400, 0, 20, 1, civCol, lit);
    addBox(70, -400, 110, -396, 0, 28, 1, civCol, 0);                     // pavilion front bay
    addBox(70, -440, 110, -400, 20, 28, 1, civCol, lit);                   // pavilion attic
    // portico: stylobate, 8 columns, entablature and pediment facing the core (+z)
    mesh(new THREE.BoxGeometry(44, 1.6, 9), stoneMat, 90, 0.8, -391.5);
    colliders.push({ x0: 68, y0: 0, z0: -396, x1: 112, y1: 24, z1: -387 });
    const colG = new THREE.CylinderGeometry(0.85, 1.0, 15.6, 14);
    for (let k = 0; k < 8; k++) mesh(colG, stoneMat, 71.5 + k * (37 / 7), 1.6 + 7.8, -389.5);
    mesh(new THREE.BoxGeometry(44, 2.4, 9), stoneMat, 90, 18.4, -391.5);
    const pedShape = new THREE.Shape([new THREE.Vector2(-22, 0), new THREE.Vector2(22, 0), new THREE.Vector2(0, 5.2)]);
    const ped = new THREE.ExtrudeGeometry(pedShape, { depth: 9, bevelEnabled: false }); ped.translate(0, 0, -4.5);
    mesh(ped, stoneMat, 90, 19.6, -391.5);
    // drum, dome, lantern
    mesh(new THREE.CylinderGeometry(14.5, 14.5, 1.2, 40), stoneMat, 90, 28.6, -420);
    mesh(new THREE.CylinderGeometry(13, 13, 9, 40), stoneMat, 90, 33.7, -420);
    const ringCols = new THREE.CylinderGeometry(0.45, 0.45, 8, 8);
    for (let k = 0; k < 20; k++) { const a = k / 20 * Math.PI * 2; mesh(ringCols, stoneMat, 90 + Math.cos(a) * 13.6, 33.7, -420 + Math.sin(a) * 13.6); }
    mesh(new THREE.CylinderGeometry(14, 14, 1, 40), stoneMat, 90, 38.7, -420);
    mesh(new THREE.SphereGeometry(13, 40, 18, 0, Math.PI * 2, 0, Math.PI / 2), copperMat, 90, 39.2, -420);
    mesh(new THREE.CylinderGeometry(2.6, 2.6, 5, 16), stoneMat, 90, 54.4, -420);
    mesh(new THREE.SphereGeometry(2.8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), copperMat, 90, 56.9, -420);
    finial(90, 59.5, -420, 1.2);
    colliders.push({ x0: 76, y0: 28, z0: -434, x1: 104, y1: 52, z1: -406 }, { x0: 87, y0: 52, z0: -423, x1: 93, y1: 63, z1: -417 });
    // corner finials on the wings and pavilion
    for (const [fx, fz] of [[45.6, -439.4], [134.4, -439.4], [45.6, -400.6], [134.4, -400.6]]) finial(fx, 20, fz, 0.8);
    for (const [fx, fz] of [[70.6, -396.6], [109.4, -396.6]]) finial(fx, 28, fz, 0.9);
  }

  // ---------------------------------------------------------------- landmark 2: gothic-topped tower
  {
    const gc = lin(0xcbbfa9), lit = 0.6;
    addBox(-110, -560, -70, -520, 0, 24, 1, gc, 0.4);                      // podium
    addBox(-105, -555, -75, -525, 24, 128, 1, gc, lit);                    // shaft
    addBox(-100, -550, -80, -530, 128, 148, 1, gc, lit);                   // first setback
    const gx = -90, gz = -540;
    const crownMat = new THREE.MeshStandardMaterial({ color: lin(0xcfc4ae), roughness: 0.8 });
    mesh(new THREE.BoxGeometry(15, 12, 15), crownMat, gx, 154, gz);
    mesh(new THREE.BoxGeometry(11, 10, 11), crownMat, gx, 165, gz);
    mesh(new THREE.CylinderGeometry(4.6, 4.6, 10, 8), crownMat, gx, 175, gz, Math.PI / 8);
    mesh(new THREE.ConeGeometry(4.6, 38, 8), copperMat, gx, 199, gz, Math.PI / 8);
    finial(gx, 218, gz, 0.9);
    colliders.push({ x0: gx - 7.5, y0: 148, z0: gz - 7.5, x1: gx + 7.5, y1: 180, z1: gz + 7.5 },
      { x0: gx - 3, y0: 180, z0: gz - 3, x1: gx + 3, y1: 220, z1: gz + 3 });
    // stepped pinnacles at the corners of each setback
    const pin = new THREE.ConeGeometry(1.1, 9, 4);
    const pinBase = new THREE.BoxGeometry(2.2, 4, 2.2);
    for (const [hw, y] of [[15, 128], [10, 148], [7.5, 160], [5.5, 170]]) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const px = gx + sx * (hw - 1.1), pz = gz + sz * (hw - 1.1), s = hw / 15 + 0.4;
        const b = mesh(pinBase, crownMat, px, y + 2 * s, pz); b.scale.setScalar(s);
        const c = mesh(pin, crownMat, px, y + 4 * s + 4.5 * s, pz, Math.PI / 4); c.scale.setScalar(s);
      }
    }
    lights.push({ x: gx, y: 222.5, z: gz, h: 222 });
  }

  // ---------------------------------------------------------------- facade instances (near / far)
  // enforce the instance budget: drop the farthest props/boxes first if ever over
  const propCount = () => spires.length + tanks.length;
  if (boxes.length + propCount() > INSTANCE_CAP - 900) {
    boxes.sort((a, b) => Math.hypot(a.x0, a.z0) - Math.hypot(b.x0, b.z0));
    boxes.length = Math.max(0, INSTANCE_CAP - 900 - propCount());
  }
  const isNear = b => Math.hypot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) < NEAR_DIST;
  const nearB = boxes.filter(isNear), farB = boxes.filter(b => !isNear(b));
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const M = new THREE.Matrix4(), P = new THREE.Vector3(), S = new THREE.Vector3(), Qi = new THREE.Quaternion();
  function facadeSet(list, shadows) {
    const m = ctx.instancedFacade(unit, Math.max(1, list.length));
    const ud = m.userData;
    list.forEach((b, k) => {
      P.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      S.set(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
      m.setMatrixAt(k, M.compose(P, Qi, S));
      m.setColorAt(k, b.col);
      ud.aS.setX(k, b.style); ud.aL.setX(k, b.lit); ud.aD.setX(k, rs());
    });
    if (!list.length) m.count = 0;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    ud.aS.needsUpdate = ud.aL.needsUpdate = ud.aD.needsUpdate = true;
    m.castShadow = shadows; m.receiveShadow = true; m.frustumCulled = false;
    scene.add(m);
    return m;
  }
  const nearMesh = facadeSet(nearB, true);
  const farMesh = facadeSet(farB, false);

  // ---------------------------------------------------------------- spires and antenna masts
  if (spires.length) {
    const g = new THREE.CylinderGeometry(0.1, 1, 1, 8); g.translate(0, 0.5, 0);
    const m = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: lin(0xb9b9b4), roughness: 0.35, metalness: 0.85 }), spires.length);
    spires.forEach((s, k) => m.setMatrixAt(k, M.compose(P.set(s.x, s.y, s.z), Qi, S.set(s.r, s.h, s.r))));
    m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false; scene.add(m);
    for (const s of spires) if (s.r > 1) colliders.push({ x0: s.x - s.r * 0.6, y0: s.y, z0: s.z - s.r * 0.6, x1: s.x + s.r * 0.6, y1: s.y + s.h * 0.6, z1: s.z + s.r * 0.6 });
  }

  // ---------------------------------------------------------------- rooftop water towers (one merged geometry)
  function merge(geos) {
    const pos = [], nor = [];
    for (const g0 of geos) {
      const g = g0.index ? g0.toNonIndexed() : g0;
      pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return g;
  }
  if (tanks.length) {
    const parts = [];
    for (const [lx, lz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
      const leg = new THREE.BoxGeometry(0.28, 3.2, 0.28); leg.translate(lx, 1.6, lz); parts.push(leg);
    }
    const deck = new THREE.CylinderGeometry(2.7, 2.7, 0.3, 14); deck.translate(0, 3.2, 0); parts.push(deck);
    const tank = new THREE.CylinderGeometry(2.4, 2.4, 4.8, 14, 1, true); tank.translate(0, 5.75, 0); parts.push(tank);
    const cap = new THREE.ConeGeometry(2.6, 1.8, 14); cap.translate(0, 9.05, 0); parts.push(cap);
    const m = new THREE.InstancedMesh(merge(parts), new THREE.MeshStandardMaterial({ color: lin(0x4b3a2c), roughness: 0.95, side: THREE.DoubleSide }), tanks.length);
    const Y = new THREE.Vector3(0, 1, 0);
    tanks.forEach((t, k) => m.setMatrixAt(k, M.compose(P.set(t.x, t.y, t.z), Qi.setFromAxisAngle(Y, t.rot), S.setScalar(t.s))));
    Qi.identity();
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m);
  }

  // ---------------------------------------------------------------- ground: asphalt, lot pads, parks, plazas
  function quads(list, y, inset) {
    const pos = [], nor = [];
    for (const q of list) {
      const x0 = q.x0 + inset, x1 = q.x1 - inset, z0 = q.z0 + inset, z1 = q.z1 - inset;
      pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
      for (let k = 0; k < 6; k++) nor.push(0, 1, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return g;
  }
  const groundMesh = (g, color, rough) => {
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: lin(color), roughness: rough }));
    m.receiveShadow = true; m.frustumCulled = false; scene.add(m); return m;
  };
  groundMesh(quads([{ x0: -3500, z0: -3500, x1: 3500, z1: 238 }, { x0: -3500, z0: 1802, x1: 3500, z1: 3600 }], 0.008, 0), 0x2f3033, 0.95);
  groundMesh(quads(pads, 0.018, -2), 0x8f8a80, 0.9);
  groundMesh(quads(parks, 0.03, -2), 0x3f6a33, 1.0);
  groundMesh(quads(plazas, 0.03, -2), 0xa79f90, 0.9);

  // park trees (near parks only; crowns read from the air)
  const nearParks = LOWQ ? [] : parks.filter(p => Math.hypot((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2) < 1300);
  const nTree = nearParks.length * 9;
  if (nTree) {
    const g = new THREE.IcosahedronGeometry(3, 0); g.translate(0, 5.5, 0);
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 5); trunk.translate(0, 1.5, 0);
    const tm = new THREE.InstancedMesh(merge([g, trunk]), new THREE.MeshStandardMaterial({ color: lin(0x46702f), roughness: 0.95, flatShading: true }), nTree);
    const tCols = [0x3e6b2f, 0x4f7a34, 0x5e7f2e, 0x355d2a].map(lin);
    let k = 0;
    for (const p of nearParks) for (let t = 0; t < 9; t++) {
      const s = R(0.8, 1.3);
      tm.setMatrixAt(k, M.compose(P.set(R(p.x0 + 4, p.x1 - 4), 0, R(p.z0 + 4, p.z1 - 4)), Qi, S.set(s, s * R(0.9, 1.25), s)));
      tm.setColorAt(k++, tCols[Math.floor(rs() * 4)]);
    }
    tm.castShadow = true; tm.receiveShadow = true; tm.frustumCulled = false; scene.add(tm);
  }

  // ---------------------------------------------------------------- aircraft warning lights (HDR, blinking)
  lights.sort((a, b) => b.h - a.h);
  const warn = lights.slice(0, 18);
  const warnMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.12, 0.05), fog: false });
  if (warn.length) {
    const lm = new THREE.InstancedMesh(new THREE.SphereGeometry(1.3, 8, 6), warnMat, warn.length);
    warn.forEach((l, k) => lm.setMatrixAt(k, M.compose(P.set(l.x, l.y, l.z), Qi, S.setScalar(1))));
    lm.frustumCulled = false; scene.add(lm);
  }

  ctx.skylineStats = {
    lots: lotCount, nearBoxes: nearB.length, farBoxes: farB.length, spires: spires.length,
    waterTowers: tanks.length, trees: nTree, warningLights: warn.length, parks: parks.length,
    colliders: colliders.length,
    instances: nearB.length + farB.length + spires.length + tanks.length + nTree + warn.length
  };
  window.__skylineStats = ctx.skylineStats;
  void nearMesh; void farMesh;

  let t = 0.35;
  return {
    colliders,
    update(dt) {
      // ~40 flashes per minute: a soft-edged pulse that stays visible through bloom
      t += dt;
      const ph = (t % 1.5) / 1.5;
      const k = 0.06 + 0.94 * Math.pow(Math.max(0, Math.sin(ph * Math.PI * 2)), 0.6);
      warnMat.color.setRGB(4 * k, 0.12 * k, 0.05 * k);
    }
  };
});
})();
