// Street dressing plugin for "Superman Over Metropolis".
// Implements the street-level brief (Insomniac Spider-Man reference): raised sidewalks with granite
// curbs, zebra crosswalks, ornate and modern lamp posts, mast-arm traffic signals with live phases,
// sidewalk trees with some autumn colour, and small props (hydrants, mailboxes, trash cans,
// newspaper boxes, benches).
// Contract (see game.js "plugins (skyline, street dressing)"): push a function onto
// window.SM_PLUGINS; it receives ctx and returns { colliders, update(dt, camera) }.
// Linear HDR pipeline: colours go through ctx.lin(); values above 1 are used only for lamp glass
// and signal lamps so that they bloom.
(function () {
  'use strict';
  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function streets(ctx) {
    const THREE = ctx.THREE, lin = ctx.lin, scene = ctx.scene;
    const C = ctx.CONST, LOTS = C.LOTS, PITCH = C.PITCH, HALF = C.HALF;
    const LOWQ = !!ctx.isLowQuality;
    const HOSP = ctx.HOSP;

    // ------------------------------------------------------------------ tuning (all values here)
    const CFG = {
      lot: 40,                 // lot interior size (m)
      roadHalf: 10,            // half road width (m)
      slabH: 0.15,             // sidewalk height
      band: 3,                 // sidewalk band depth from the lot edge
      curbW: 0.25,             // granite curb strip on the road side
      pavingTile: 6,           // paving texture covers 6 m (4 x 1.5 m slabs)
      curbTile: 2,             // curb stones 2 m long
      cross: { from: 11, len: 3, stripeW: 0.6, gap: 0.6, y: 0.03, underY: 0.026 },
      lamp: { along: [10, 30], inset: 0.6, glow: 1.5, glowHex: 0xffc27a },
      signal: { green: 8, amber: 2, red: 10, inset: 0.6, armY: 6.35, lane: 3.5 },
      tree: { inset: 1.2, along: [14, 26], jitter: 1, sideChance: 0.5, autumn: 0.25 },
      props: { slots: [6.8, 17, 20, 23, 33.2], hydrantAt: [5, 35], hydrantChance: 0.6, maxPerSide: 6 },
      padClear: 12             // hospital helipad radius (keep clear)
    };
    const SIG_CYCLE = CFG.signal.green + CFG.signal.amber + CFG.signal.red;
    const SIG_OFFSET = CFG.signal.green + CFG.signal.amber; // crossing direction runs this far behind

    const rnd = ctx.srand ? ctx.srand(5150) : Math.random;
    const RR = (a, b) => a + (b - a) * rnd();
    const pickR = a => a[Math.floor(rnd() * a.length)];
    const rc = k => -HALF + k * PITCH;                    // road centreline k = 0..LOTS
    const CITY_MIN = rc(0) + CFG.roadHalf, CITY_MAX = rc(LOTS) - CFG.roadHalf; // lot extents
    const padDist = (x, z) => Math.hypot(x - HOSP.x, z - HOSP.z);
    const clearOfPad = (x, z, r) => padDist(x, z) > CFG.padClear + r;

    const stats = { instances: 0, drawCalls: 0, mergedMeshes: 0 };
    const UPV = new THREE.Vector3(0, 1, 0);
    const M4 = new THREE.Matrix4(), M4b = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const V = new THREE.Vector3(), S = new THREE.Vector3();
    const WHITE = new THREE.Color(1, 1, 1);
    const grey = f => new THREE.Color(f, f, f);

    // ------------------------------------------------------------------ geometry helpers
    function cyl(rt, rb, h, seg, x, y, z) { const g = new THREE.CylinderGeometry(rt, rb, h, seg || 10); g.translate(x || 0, (y || 0) + h / 2, z || 0); return g; }
    function boxB(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x || 0, (y || 0) + h / 2, z || 0); return g; }
    function boxC(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x || 0, y || 0, z || 0); return g; }
    function rod(r, ax, ay, az, bx, by, bz, seg) {
      const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz), d = b.clone().sub(a), len = d.length();
      const g = new THREE.CylinderGeometry(r, r, len, seg || 8);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(UPV, d.normalize())));
      g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      return g;
    }
    function paint(g, col) {
      if (g.index) g = g.toNonIndexed();
      const n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    }
    // merge non-indexed copies; keeps uv only when every part has it; colour defaults to white
    function merge(list) {
      let n = 0; const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
      for (const g of parts) n += g.attributes.position.count;
      const withUV = parts.every(g => g.attributes.uv), withCol = parts.some(g => g.attributes.color);
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = withUV ? new Float32Array(n * 2) : null, col = withCol ? new Float32Array(n * 3) : null;
      let o = 0;
      for (const g of parts) {
        const c = g.attributes.position.count;
        pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
        if (uv) uv.set(g.attributes.uv.array, o * 2);
        if (col) { if (g.attributes.color) col.set(g.attributes.color.array, o * 3); else col.fill(1, o * 3, (o + c) * 3); }
        o += c;
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      out.computeBoundingSphere();
      return out;
    }
    // box with box-local planar UVs in metres / tile; the long horizontal axis always maps to u
    function uvBox(x0, y0, z0, x1, y1, z1, tile) {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv, alongZ = (z1 - z0) > (x1 - x0);
      for (let i = 0; i < p.count; i++) {
        const px = p.getX(i) - x0, py = p.getY(i) - y0, pz = p.getZ(i) - z0;
        let u, v;
        if (Math.abs(n.getY(i)) > 0.5) { u = alongZ ? pz : px; v = alongZ ? px : pz; }
        else if (Math.abs(n.getX(i)) > 0.5) { u = pz; v = py; }
        else { u = px; v = py; }
        uv.setXY(i, u / tile, v / tile);
      }
      return g;
    }
    // fluted column: alternate radial vertices pulled in
    function fluted(rt, rb, h, y) {
      const seg = 16, g = new THREE.CylinderGeometry(rt, rb, h, seg, 1);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z); if (r < 1e-4) continue;
        const k = Math.round(Math.atan2(x, z) / (Math.PI * 2 / seg));
        if (k % 2 !== 0) { p.setX(i, x * 0.8); p.setZ(i, z * 0.8); }
      }
      g.computeVertexNormals(); g.translate(0, y + h / 2, 0);
      return g;
    }

    // instanced mesh from a list of transforms {x,y,z,ry,sx,sy,sz,c} or {m: Matrix4, c}
    function inst(geo, mat, list, opt) {
      opt = opt || {};
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      const colored = list.some(t => t.c);
      list.forEach((t, i) => {
        if (t.m) im.setMatrixAt(i, t.m);
        else {
          Q.setFromAxisAngle(UPV, t.ry || 0); V.set(t.x, t.y || 0, t.z);
          const s = t.s || 1; S.set(t.sx || s, t.sy || s, t.sz || s);
          M4.compose(V, Q, S); im.setMatrixAt(i, M4);
        }
        if (colored) im.setColorAt(i, t.c || WHITE);
      });
      im.count = list.length;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false;          // r128 culls on base-geometry bounds: never cull the set
      im.castShadow = !!opt.cast; im.receiveShadow = opt.recv !== false;
      im.name = 'streets:' + (opt.name || 'set');
      scene.add(im);
      stats.instances += list.length; stats.drawCalls++;
      return im;
    }
    function staticMesh(geo, mat, name) {
      const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.name = 'streets:' + name;
      m.matrixAutoUpdate = false; m.updateMatrix();
      scene.add(m); stats.drawCalls++; stats.mergedMeshes++;
      return m;
    }

    // ------------------------------------------------------------------ canvas textures
    const maxAniso = ctx.renderer && ctx.renderer.capabilities ? ctx.renderer.capabilities.getMaxAnisotropy() : 1;
    function canvasTex(c) {
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; t.encoding = THREE.sRGBEncoding;
      return t;
    }
    function pavingTexture() {
      const N = 512, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d');
      const slab = N / (CFG.pavingTile / 1.5);
      x.fillStyle = '#bdb6aa'; x.fillRect(0, 0, N, N);
      for (let i = 0; i < N; i += slab) for (let j = 0; j < N; j += slab) {
        x.fillStyle = rnd() < 0.5 ? `rgba(95,85,72,${RR(0.03, 0.1)})` : `rgba(255,250,238,${RR(0.03, 0.09)})`;
        x.fillRect(i, j, slab, slab);
      }
      for (let i = 0; i < 9000; i++) { x.fillStyle = `rgba(${rnd() < 0.5 ? '40,35,30' : '255,255,255'},${RR(0.04, 0.12)})`; x.fillRect(rnd() * N, rnd() * N, RR(1, 2.5), RR(1, 2.5)); }
      for (let i = 0; i < 16; i++) {
        const cx = rnd() * N, cy = rnd() * N, r = RR(12, 60), g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(70,58,46,${RR(0.06, 0.16)})`); g.addColorStop(1, 'rgba(70,58,46,0)');
        x.fillStyle = g; x.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      for (let i = 0; i < 50; i++) { x.fillStyle = `rgba(40,38,36,${RR(0.2, 0.4)})`; x.beginPath(); x.arc(rnd() * N, rnd() * N, RR(1.2, 2.6), 0, 7); x.fill(); }
      x.fillStyle = 'rgba(72,66,58,.6)';
      for (let k = 0; k <= N; k += slab) { x.fillRect(k - 1.5, 0, 3, N); x.fillRect(0, k - 1.5, N, 3); }
      x.fillStyle = 'rgba(255,255,255,.12)';
      for (let k = 0; k < N; k += slab) { x.fillRect(k + 2, 0, 1, N); x.fillRect(0, k + 2, N, 1); }
      return canvasTex(c);
    }
    function granite() {
      const N = 256, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d');
      x.fillStyle = '#6f6b65'; x.fillRect(0, 0, N, N);
      for (let i = 0; i < 7000; i++) { x.fillStyle = `rgba(${rnd() < 0.55 ? '20,20,22' : '220,215,205'},${RR(0.08, 0.3)})`; x.fillRect(rnd() * N, rnd() * N, RR(1, 2), RR(1, 2)); }
      x.fillStyle = 'rgba(25,24,22,.7)'; x.fillRect(0, 0, 3, N);
      return canvasTex(c);
    }
    function stripeTexture() {
      const c = document.createElement('canvas'); c.width = 64; c.height = 256; const x = c.getContext('2d');
      x.fillStyle = '#ecebe5'; x.fillRect(0, 0, 64, 256);
      for (let i = 0; i < 700; i++) { x.fillStyle = `rgba(45,46,49,${RR(0.08, 0.5)})`; x.fillRect(rnd() * 64, rnd() * 256, RR(1, 4), RR(1, 4)); }
      for (let i = 0; i < 5; i++) { x.fillStyle = `rgba(45,46,49,${RR(0.15, 0.35)})`; x.fillRect(rnd() * 50, rnd() * 240, RR(6, 18), RR(10, 40)); }
      const t = canvasTex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
    }

    // ------------------------------------------------------------------ 1. raised sidewalks + curbs
    // one merged static mesh per material (world-placed, per-box UVs): 2 draw calls for all 49 lots
    const H = CFG.slabH, B = CFG.band, CW = CFG.curbW;
    const pave = [], curb = [];
    // interval [a0,a1] minus the hospital pad's shadow on a band [b0,b1] across it (axis 'x' or 'z')
    function cutPad(a0, a1, b0, b1, axis) {
      const pa = axis === 'x' ? HOSP.x : HOSP.z, pb = axis === 'x' ? HOSP.z : HOSP.x, r = CFG.padClear + 0.3;
      const db = pb < b0 ? b0 - pb : pb > b1 ? pb - b1 : 0;
      if (db >= r) return [[a0, a1]];
      const h = Math.sqrt(r * r - db * db), c0 = pa - h, c1 = pa + h, out = [];
      if (c0 > a0) out.push([a0, Math.min(a1, c0)]);
      if (c1 < a1) out.push([Math.max(a0, c1), a1]);
      return out.filter(s => s[1] - s[0] > 0.3);
    }
    for (const L of ctx.lotInfo) {
      const x0 = L.lx, z0 = L.lz, x1 = L.lx + CFG.lot, z1 = L.lz + CFG.lot;
      // N and S run along x; W and E run along z (between the N/S bands)
      const runsX = [[z0, z0 + B], [z1 - B, z1]], runsZ = [[x0, x0 + B], [x1 - B, x1]];
      runsX.forEach(([b0, b1], s) => {
        const north = s === 0;
        for (const [a0, a1] of cutPad(x0, x1, b0, b1, 'x')) {
          curb.push(uvBox(a0, 0, north ? z0 : z1 - CW, a1, H, north ? z0 + CW : z1, CFG.curbTile));
          const p0 = Math.max(a0, x0 + CW), p1 = Math.min(a1, x1 - CW);
          if (p1 > p0) pave.push(uvBox(p0, 0, north ? z0 + CW : z1 - B, p1, H, north ? z0 + B : z1 - CW, CFG.pavingTile));
        }
      });
      runsZ.forEach(([b0, b1], s) => {
        const west = s === 0;
        for (const [a0, a1] of cutPad(z0 + CW, z1 - CW, b0, b1, 'z')) curb.push(uvBox(west ? x0 : x1 - CW, 0, a0, west ? x0 + CW : x1, H, a1, CFG.curbTile));
        for (const [a0, a1] of cutPad(z0 + B, z1 - B, b0, b1, 'z')) pave.push(uvBox(west ? x0 + CW : x1 - B, 0, a0, west ? x0 + B : x1 - CW, H, a1, CFG.pavingTile));
      });
    }
    staticMesh(merge(pave), new THREE.MeshStandardMaterial({ map: pavingTexture(), color: WHITE, roughness: 0.88, metalness: 0 }), 'sidewalk');
    staticMesh(merge(curb), new THREE.MeshStandardMaterial({ map: granite(), color: WHITE, roughness: 0.7, metalness: 0 }), 'curb');

    // ------------------------------------------------------------------ 2. zebra crosswalks
    // On every approach that runs between lots, just outside the junction box. An asphalt underlay
    // hides the older painted crosswalks in the ground texture so the two patterns never overlap.
    const stripes = [], under = [];
    const CR = CFG.cross, pitchS = CR.stripeW + CR.gap;
    function quadXZ(cx, cz, sx, sz, y) { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); g.scale(sx, 1, sz); g.translate(cx, y, cz); return g; }
    let nCross = 0;
    for (let kx = 0; kx <= LOTS; kx++) for (let kz = 0; kz <= LOTS; kz++) {
      const cx = rc(kx), cz = rc(kz);
      for (const sgn of [-1, 1]) {
        // across the x-running road (stripes run along x), band beside the junction at x = cx +- (from..from+len)
        const bx = cx + sgn * (CR.from + CR.len / 2);
        if (bx - CR.len / 2 >= CITY_MIN - 0.01 && bx + CR.len / 2 <= CITY_MAX + 0.01) {
          nCross++;
          under.push(quadXZ(bx, cz, CR.len + 0.4, CFG.roadHalf * 2, CR.underY));
          for (let s = -CFG.roadHalf + 1; s <= CFG.roadHalf - 1 + 1e-6; s += pitchS) stripes.push(quadXZ(bx, cz + s, CR.len, CR.stripeW, CR.y));
        }
        // across the z-running road (stripes run along z)
        const bz = cz + sgn * (CR.from + CR.len / 2);
        if (bz - CR.len / 2 >= CITY_MIN - 0.01 && bz + CR.len / 2 <= CITY_MAX + 0.01 && bz < 236) {
          nCross++;
          under.push(quadXZ(cx, bz, CFG.roadHalf * 2, CR.len + 0.4, CR.underY));
          for (let s = -CFG.roadHalf + 1; s <= CFG.roadHalf - 1 + 1e-6; s += pitchS) {
            const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); g.rotateY(Math.PI / 2); g.scale(CR.stripeW, 1, CR.len); g.translate(cx + s, CR.y, bz);
            stripes.push(g);
          }
        }
      }
    }
    staticMesh(merge(under), new THREE.MeshStandardMaterial({ color: lin(0x2e2f32), roughness: 0.92, metalness: 0 }), 'crosswalk-underlay');
    staticMesh(merge(stripes), new THREE.MeshStandardMaterial({ map: stripeTexture(), color: WHITE, roughness: 0.75, metalness: 0 }), 'crosswalk-stripes');

    // ------------------------------------------------------------------ lot sides (for placement)
    // side: start corner (ox, oz), along dir (tx, tz), outward normal (nx, nz) toward the road.
    // point(a, d): a metres along the side, d metres in from the lot edge (curb face).
    const sides = [];
    for (const L of ctx.lotInfo) {
      const x0 = L.lx, z0 = L.lz, x1 = L.lx + CFG.lot, z1 = L.lz + CFG.lot;
      const defs = [[x0, z0, 1, 0, 0, -1], [x0, z1, 1, 0, 0, 1], [x0, z0, 0, 1, -1, 0], [x1, z0, 0, 1, 1, 0]];
      for (const [ox, oz, tx, tz, nx, nz] of defs) {
        sides.push({ L, ox, oz, tx, tz, nx, nz, yaw: Math.atan2(-nz, nx),
          at(a, d) { return [this.ox + this.tx * a - this.nx * d, this.oz + this.tz * a - this.nz * d]; } });
      }
    }

    // ------------------------------------------------------------------ 3. street lamps
    const glowCol = lin(CFG.lamp.glowHex).multiplyScalar(CFG.lamp.glow);
    const glowMat = new THREE.MeshBasicMaterial({ color: glowCol });
    const iron = lin(0x1b2620), ironHi = lin(0x2a372f), steel = lin(0x7f858a), steelDk = lin(0x5d6267);
    // ornate cast iron (local +x reaches over the road)
    const ornateGeo = merge([
      paint(boxB(0.62, 0.22, 0.62), iron),
      paint(fluted(0.17, 0.25, 1.1, 0.22), iron),
      paint(cyl(0.2, 0.2, 0.1, 16, 0, 1.32), ironHi),
      paint(cyl(0.085, 0.11, 5.3, 12, 0, 1.42), iron),
      paint(cyl(0.13, 0.13, 0.08, 12, 0, 3.6), ironHi),
      paint((() => { const g = new THREE.SphereGeometry(0.11, 10, 6); g.translate(0, 6.82, 0); return g; })(), ironHi),
      paint(rod(0.045, 0, 6.55, 0, 1.95, 6.55, 0), iron),
      paint(rod(0.03, 0, 5.85, 0, 1.0, 6.53, 0), iron),
      paint((() => { const g = new THREE.TorusGeometry(0.2, 0.022, 5, 14); g.translate(0.55, 6.27, 0); return g; })(), iron),
      paint(rod(0.025, 1.9, 6.55, 0, 1.9, 6.38, 0), iron),
      paint((() => { const g = new THREE.ConeGeometry(0.34, 0.3, 6); g.translate(1.9, 6.4, 0); return g; })(), iron),
      paint(cyl(0.18, 0.12, 0.12, 6, 1.9, 5.76), iron)
    ]);
    const ornateGlow = (() => { const g = new THREE.CylinderGeometry(0.24, 0.16, 0.42, 6); g.translate(1.9, 6.06, 0); return g; })();
    // modern cobra head
    const modernGeo = merge([
      paint(boxB(0.45, 0.06, 0.45), steelDk),
      paint(cyl(0.2, 0.24, 0.5, 12), steelDk),
      paint(cyl(0.075, 0.13, 7.1, 12), steel),
      paint(rod(0.05, 0, 6.9, 0, 2.5, 7.25, 0), steel),
      paint((() => { const g = new THREE.SphereGeometry(1, 14, 8); g.scale(0.58, 0.15, 0.25); g.translate(2.78, 7.3, 0); return g; })(), lin(0x9a9fa3))
    ]);
    const modernGlow = (() => { const g = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2); g.scale(0.46, 0.07, 0.19); g.translate(2.8, 7.26, 0); return g; })();
    const lampsO = [], lampsM = [];
    for (const sd of sides) {
      const ornate = !!(sd.L.b && sd.L.b.style === 1);
      for (const a of CFG.lamp.along) {
        const [x, z] = sd.at(a, CFG.lamp.inset);
        if (!clearOfPad(x, z, 0.5) || z > 236) continue;
        (ornate ? lampsO : lampsM).push({ x, y: H, z, ry: sd.yaw });
      }
    }
    const lampMatO = new THREE.MeshStandardMaterial({ color: WHITE, vertexColors: true, roughness: 0.55, metalness: 0.45 });
    const lampMatM = new THREE.MeshStandardMaterial({ color: WHITE, vertexColors: true, roughness: 0.4, metalness: 0.65 });
    inst(ornateGeo, lampMatO, lampsO, { cast: true, name: 'lamp-ornate' });
    inst(ornateGlow, glowMat, lampsO, { cast: false, recv: false, name: 'lamp-ornate-glow' });
    inst(modernGeo, lampMatM, lampsM, { cast: true, name: 'lamp-modern' });
    inst(modernGlow, glowMat, lampsM, { cast: false, recv: false, name: 'lamp-modern-glow' });

    // ------------------------------------------------------------------ 4. mast-arm traffic signals
    // Interior intersections (all four corners are lots). Right-hand traffic as in spawnCar: +x cars
    // drive at z = rc + 3.5, -x at rc - 3.5, +z at x = rc - 3.5, -z at rc + 3.5. Two poles sit on
    // diagonal corners; each pole carries a short arm over one approach and a long arm over the
    // other, so all four approaches get a head over their incoming lane, facing oncoming traffic.
    const SG = CFG.signal, poleI = SG.inset, lane = SG.lane, rH = CFG.roadHalf;
    const sigPoleGeo = merge([
      paint(cyl(0.28, 0.32, 0.5, 12), grey(1)),
      paint(cyl(0.12, 0.16, 6.9, 12, 0, 0.5), grey(1)),
      paint((() => { const g = new THREE.SphereGeometry(0.14, 10, 6); g.translate(0, 7.4, 0); return g; })(), grey(1))
    ]);
    const sigArmGeo = (() => { const g = new THREE.CylinderGeometry(0.075, 0.075, 1, 8); g.rotateZ(-Math.PI / 2); g.translate(0.5, 0, 0); return g; })();
    const yellow = lin(0xd9a014), blackish = lin(0x141414);
    const headGeo = merge([
      paint(boxC(0.42, 1.05, 0.3), yellow),
      paint(boxC(0.62, 1.25, 0.03, 0, 0, -0.17), blackish),
      paint(boxC(0.34, 0.03, 0.22, 0, 0.33 + 0.16, 0.26), yellow.clone().multiplyScalar(0.8)),
      paint(boxC(0.34, 0.03, 0.22, 0, 0.16, 0.26), yellow.clone().multiplyScalar(0.8)),
      paint(boxC(0.34, 0.03, 0.22, 0, -0.33 + 0.16, 0.26), yellow.clone().multiplyScalar(0.8)),
      paint(boxC(0.06, 0.2, 0.06, 0, 0.62, 0), lin(0x2b2d2f))
    ]);
    const discGeo = new THREE.CircleGeometry(0.12, 14);
    const sigPoles = [], sigArms = [], sigHeads = [], discList = [];
    const inter = [];      // {off, heads: [{group, disc, s}]}
    const LAMP_DY = [0.33, 0, -0.33];   // red, amber, green
    for (let kx = 1; kx < LOTS; kx++) for (let kz = 1; kz < LOTS; kz++) {
      const cx = rc(kx), cz = rc(kz), it = { off: RR(0, SIG_CYCLE), heads: [] };
      // [poleX, poleZ, arms: [dirX, dirZ, reach to lane, group, faceX, faceZ]]
      const poles = [
        [cx - rH - poleI, cz + rH + poleI, [[0, -1, rH + poleI - lane, 'x', -1, 0], [1, 0, rH + poleI + lane, 'z', 0, 1]]],
        [cx + rH + poleI, cz - rH - poleI, [[0, 1, rH + poleI - lane, 'x', 1, 0], [-1, 0, rH + poleI + lane, 'z', 0, -1]]]
      ];
      for (const [px, pz, arms] of poles) {
        sigPoles.push({ x: px, y: H, z: pz });
        for (const [dx, dz, reach, group, fx, fz] of arms) {
          sigArms.push({ x: px, y: SG.armY, z: pz, ry: Math.atan2(-dz, dx), sx: reach + 0.5, sy: 1, sz: 1 });
          const hx = px + dx * reach, hz = pz + dz * reach, hy = SG.armY - 0.72, fy = Math.atan2(fx, fz);
          sigHeads.push({ x: hx, y: hy, z: hz, ry: fy });
          Q.setFromAxisAngle(UPV, fy); M4.compose(V.set(hx, hy, hz), Q, S.set(1, 1, 1));
          const disc = discList.length;
          for (const dy of LAMP_DY) { M4b.makeTranslation(0, dy, 0.153); discList.push({ m: M4.clone().multiply(M4b), c: new THREE.Color(0, 0, 0) }); }
          it.heads.push({ group, disc, s: -1 });
        }
      }
      inter.push(it);
    }
    const sigMat = new THREE.MeshStandardMaterial({ color: lin(0x2b2d2f), vertexColors: true, roughness: 0.5, metalness: 0.5 });
    inst(sigPoleGeo, sigMat, sigPoles, { cast: true, name: 'signal-pole' });
    inst(sigArmGeo, new THREE.MeshStandardMaterial({ color: lin(0x2b2d2f), roughness: 0.5, metalness: 0.5 }), sigArms, { cast: true, name: 'signal-arm' });
    inst(headGeo, new THREE.MeshStandardMaterial({ color: WHITE, vertexColors: true, roughness: 0.55, metalness: 0.1 }), sigHeads, { cast: true, name: 'signal-head' });
    const discs = inst(discGeo, new THREE.MeshBasicMaterial({ color: WHITE }), discList, { cast: false, recv: false, name: 'signal-lamps' });
    const LIT = [new THREE.Color(4, 0.2, 0.1), new THREE.Color(4, 2, 0.1), new THREE.Color(0.2, 4, 1)];
    const DARK = [new THREE.Color(0.06, 0.012, 0.01), new THREE.Color(0.06, 0.04, 0.008), new THREE.Color(0.01, 0.06, 0.03)];
    const phase = t => (t < SG.green ? 2 : t < SG.green + SG.amber ? 1 : 0); // 2 green, 1 amber, 0 red
    let simT = 0;
    function updateSignals() {
      let dirty = false;
      for (const it of inter) {
        const t = ((simT + it.off) % SIG_CYCLE + SIG_CYCLE) % SIG_CYCLE;
        const px = phase(t), pz = phase((t + SIG_CYCLE - SIG_OFFSET) % SIG_CYCLE);
        for (const h of it.heads) {
          const s = h.group === 'x' ? px : pz;
          if (s === h.s) continue;
          h.s = s; dirty = true;
          for (let k = 0; k < 3; k++) discs.setColorAt(h.disc + k, (k === 0 && s === 0) || (k === 1 && s === 1) || (k === 2 && s === 2) ? LIT[k] : DARK[k]);
        }
      }
      if (dirty) discs.instanceColor.needsUpdate = true;
    }
    updateSignals();

    // ------------------------------------------------------------------ 5. sidewalk trees
    const TR = CFG.tree;
    let trees = [];
    for (const sd of sides) {
      if (sd.L.type !== 'bld' || rnd() > TR.sideChance) continue;
      for (const a0 of TR.along) {
        const [x, z] = sd.at(a0 + RR(-TR.jitter, TR.jitter), TR.inset);
        if (z > 236 || !clearOfPad(x, z, 3)) continue;
        trees.push({ x, z, yaw: sd.yaw });
      }
    }
    if (LOWQ) trees = trees.filter((_, i) => i % 2 === 0);
    const GREENS = [0x3e6b2c, 0x4b7a31, 0x58843a, 0x355f28, 0x46732e];
    const AUTUMN = [0xd19a2a, 0xcf7a22, 0xb98a2c, 0xc4632a, 0xe0b040];
    const trunks = [], pits = [], crowns = [];
    for (const t of trees) {
      const s = RR(0.85, 1.15), autumn = rnd() < TR.autumn, base = autumn ? pickR(AUTUMN) : pickR(GREENS);
      trunks.push({ x: t.x, y: H, z: t.z, ry: RR(0, 6.28), sx: s, sy: s * RR(0.92, 1.1), sz: s });
      pits.push({ x: t.x, y: H, z: t.z, ry: t.yaw });
      const n = rnd() < 0.5 ? 2 : 3;
      for (let k = 0; k < n; k++) {
        const r = RR(1.05, 1.5) * s, c = lin(autumn && rnd() < 0.3 ? pickR(GREENS) : base).multiplyScalar(RR(0.85, 1.1));
        crowns.push({ x: t.x + RR(-0.55, 0.55), y: H + 3.0 * s + RR(0.7, 1.9), z: t.z + RR(-0.55, 0.55), ry: RR(0, 6.28), sx: r, sy: r * RR(0.8, 1.0), sz: r, c });
      }
    }
    const trunkGeo = merge([cyl(0.09, 0.14, 3.2, 7), rod(0.05, 0, 2.2, 0, 0.5, 3.1, 0.1, 5), rod(0.05, 0, 2.4, 0, -0.4, 3.2, -0.2, 5)]);
    inst(trunkGeo, new THREE.MeshStandardMaterial({ color: lin(0x4a3a2c), roughness: 1 }), trunks, { cast: true, name: 'tree-trunk' });
    inst(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: WHITE, roughness: 0.92, flatShading: true }), crowns, { cast: true, name: 'tree-crown' });
    inst(merge([paint(boxB(1.3, 0.02, 1.3), lin(0x2a241e)), paint(boxB(1.36, 0.03, 0.06, 0, 0, 0.65), lin(0x3a3936)), paint(boxB(1.36, 0.03, 0.06, 0, 0, -0.65), lin(0x3a3936)), paint(boxB(0.06, 0.03, 1.36, 0.65), lin(0x3a3936)), paint(boxB(0.06, 0.03, 1.36, -0.65), lin(0x3a3936))]),
      new THREE.MeshStandardMaterial({ color: WHITE, vertexColors: true, roughness: 1 }), pits, { cast: false, name: 'tree-pit' });

    // ------------------------------------------------------------------ 6. small props
    // Geometry is in prop-local space: +x faces the road, +z runs along the sidewalk.
    const dark = grey(0.12);
    const hydrantGeo = merge([
      paint(cyl(0.17, 0.19, 0.07, 10), grey(0.8)),
      paint(cyl(0.125, 0.135, 0.5, 10, 0, 0.07), grey(1)),
      paint((() => { const g = new THREE.SphereGeometry(0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2); g.translate(0, 0.57, 0); return g; })(), grey(1)),
      paint(cyl(0.035, 0.045, 0.08, 6, 0, 0.68), grey(0.7)),
      paint(rod(0.045, -0.21, 0.42, 0, 0.21, 0.42, 0, 8), grey(0.85)),
      paint(rod(0.06, 0, 0.38, 0, 0.2, 0.38, 0, 8), grey(0.85))
    ]);
    const mailGeo = merge([
      paint(boxB(0.05, 0.18, 0.05, 0.2, 0, 0.2), dark), paint(boxB(0.05, 0.18, 0.05, -0.2, 0, 0.2), dark),
      paint(boxB(0.05, 0.18, 0.05, 0.2, 0, -0.2), dark), paint(boxB(0.05, 0.18, 0.05, -0.2, 0, -0.2), dark),
      paint(boxB(0.48, 0.78, 0.5, 0, 0.18), grey(1)),
      paint((() => { const g = new THREE.CylinderGeometry(0.24, 0.24, 0.5, 12, 1, false, 0, Math.PI); g.rotateX(Math.PI / 2); g.rotateZ(Math.PI / 2); g.translate(0, 0.96, 0); return g; })(), grey(1)),
      paint(boxB(0.02, 0.1, 0.3, 0.25, 0.78), grey(0.45)),
      paint(boxB(0.02, 0.12, 0.34, 0.25, 0.42), grey(1.6))
    ]);
    const trashGeo = merge([
      paint(cyl(0.3, 0.26, 0.82, 12), grey(1)),
      paint(cyl(0.32, 0.32, 0.06, 12, 0, 0.82), grey(0.7)),
      paint(cyl(0.27, 0.27, 0.02, 12, 0, 0.86), grey(0.15))
    ]);
    const newsGeo = merge([
      paint(boxB(0.1, 0.35, 0.3, -0.05), dark),
      paint(boxB(0.42, 0.62, 0.45, 0, 0.35), grey(1)),
      paint(boxB(0.02, 0.24, 0.32, 0.215, 0.6), grey(0.35)),
      paint(boxB(0.46, 0.04, 0.48, 0, 0.97), grey(0.75))
    ]);
    const wood = lin(0x7a5232);
    const benchGeo = merge([
      paint(boxB(0.48, 0.44, 0.06, 0, 0, 0.78), dark), paint(boxB(0.48, 0.44, 0.06, 0, 0, -0.78), dark),
      paint(boxB(0.06, 0.42, 0.06, -0.22, 0.44, 0.78), dark), paint(boxB(0.06, 0.42, 0.06, -0.22, 0.44, -0.78), dark),
      paint(boxB(0.13, 0.04, 1.8, -0.15, 0.42), wood), paint(boxB(0.13, 0.04, 1.8, 0, 0.42), wood), paint(boxB(0.13, 0.04, 1.8, 0.15, 0.42), wood),
      paint(boxB(0.04, 0.11, 1.8, -0.23, 0.56), wood), paint(boxB(0.04, 0.11, 1.8, -0.23, 0.72), wood)
    ]);
    const HYD = [lin(0xb3241c), lin(0xb3241c), lin(0xb3241c), lin(0xd9a520)];
    const TRASH = [lin(0x2f5b3b), lin(0x1d1f21)];
    const NEWS = [0xb32a24, 0x2a5aa8, 0xe0b324, 0xe8e6e0, 0x2f7a46, 0xd8701e].map(h => lin(h));
    let hyd = [], mail = [], trash = [], news = [], bench = [];
    const PR = CFG.props;
    for (const sd of sides) {
      let used = 0;
      const put = (arr, a, d, extra) => {
        const [x, z] = sd.at(a, d);
        if (z > 236 || !clearOfPad(x, z, 1)) return false;
        arr.push(Object.assign({ x, y: H, z, ry: sd.yaw }, extra)); used++; return true;
      };
      if (rnd() < PR.hydrantChance) put(hyd, pickR(PR.hydrantAt), 0.5, { c: pickR(HYD), ry: sd.yaw + RR(-0.4, 0.4) });
      const slots = PR.slots.slice().sort(() => rnd() - 0.5), nSlots = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < nSlots && used < PR.maxPerSide; k++) {
        const a = slots[k], roll = rnd();
        if (a === 20 && roll < 0.35) put(bench, a, 1.9, { c: WHITE });
        else if (roll < 0.62) {
          const n = Math.min(2 + Math.floor(rnd() * 2), PR.maxPerSide - used);
          for (let m = 0; m < n; m++) put(news, a + (m - (n - 1) / 2) * 0.52, 0.65, { c: pickR(NEWS) });
        } else if (roll < 0.8) put(mail, a, 0.75, { c: lin(0x1f4f9a), ry: sd.yaw + Math.PI });
        else put(trash, a, 0.6, { c: pickR(TRASH) });
      }
    }
    if (LOWQ) { const half = a => a.filter((_, i) => i % 2 === 0); hyd = half(hyd); mail = half(mail); trash = half(trash); news = half(news); bench = half(bench); }
    const propMat = (r, m) => new THREE.MeshStandardMaterial({ color: WHITE, vertexColors: true, roughness: r, metalness: m || 0 });
    inst(hydrantGeo, propMat(0.5, 0.2), hyd, { cast: true, name: 'hydrant' });
    inst(mailGeo, propMat(0.45, 0.3), mail, { cast: true, name: 'mailbox' });
    inst(trashGeo, propMat(0.6, 0.3), trash, { cast: true, name: 'trash' });
    inst(newsGeo, propMat(0.5, 0.1), news, { cast: true, name: 'newsbox' });
    inst(benchGeo, propMat(0.8, 0), bench, { cast: true, name: 'bench' });

    stats.counts = {
      lamps: lampsO.length + lampsM.length, signalIntersections: inter.length, signalHeads: sigHeads.length,
      trees: trees.length, crowns: crowns.length, hydrants: hyd.length, mailboxes: mail.length, trash: trash.length,
      newsboxes: news.length, benches: bench.length, crosswalks: nCross
    };
    window.__streets = stats;
    console.info('[streets] instances ' + stats.instances + ', draw calls ' + stats.drawCalls + ' (' + stats.mergedMeshes + ' merged static)', stats.counts);

    return {
      colliders: [],
      update(dt) { simT += dt; updateSignals(); }
    };
  });
})();
