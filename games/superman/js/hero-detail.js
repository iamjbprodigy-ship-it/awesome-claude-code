/* Superman Over Metropolis: sculpted hero body (three.js r128, no external assets).
 *
 *   window.SM_HERO = { build(THREE, g, opts), capeMaterial(THREE, opts), CAPE: { CW, CH } }
 *
 * The body is built from superellipse cross-section sweeps displaced by Gaussian muscle and
 * feature fields, welded for smooth normals, baked with a cavity AO vertex attribute and merged
 * into nine meshes (torso with head, upper arms, forearms with fists, thighs, shins with boots)
 * that share ONE material. Suit, trunks, belt, boots, skin, hair and eyes are picked per pixel
 * from a per-vertex part id plus the object-space position, with procedural weave, seams and an
 * embossed chest shield as a three-tap bump. game.js keeps the old primitive model as a fallback.
 *
 * Frames: the hero's front is -Z, his right is +X, the origin is at hip level. Limb pieces are
 * built for the right side in their pivot frames and mirrored for the left.
 */
(function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // monotone cubic (PCHIP) through [x, y] keys: smooth profiles with no overshoot
  function pchip(keys) {
    const n = keys.length, xs = keys.map(k => k[0]), ys = keys.map(k => k[1]);
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else { const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i], w1 = 2 * h1 + h0, w2 = h1 + 2 * h0; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
    }
    const asc = xs[n - 1] > xs[0];
    return x => {
      if (asc ? x <= xs[0] : x >= xs[0]) return ys[0];
      if (asc ? x >= xs[n - 1] : x <= xs[n - 1]) return ys[n - 1];
      let i = 0; while (i < n - 2 && (asc ? x > xs[i + 1] : x < xs[i + 1])) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }
  // a profile table: rows [s, a, b, c, ...] -> f(s) = [a, b, c, ...]
  function profile(rows) {
    const cols = rows[0].length - 1, fs = [];
    for (let c = 0; c < cols; c++) fs.push(pchip(rows.map(r => [r[0], r[c + 1]])));
    return s => fs.map(f => f(s));
  }

  // ---------------------------------------------------------------- pieces
  // piece = { pos: [], uv: [], idx: [], part, side, mask: [] }
  // Sweep a superellipse ring along an axis. o.ring(s) -> { c: [x,y,z], up, un, wp, wn, e }
  // (extents along +U, -U, +W, -W). s runs from o.s0 to o.s1; rounded domes close both ends.
  function sweep(o) {
    const n = o.n, m = o.m, U = o.U || [1, 0, 0], W = o.W || [0, 0, -1];
    const s0 = o.s0, s1 = o.s1, len = Math.abs(s1 - s0), c0 = o.cap0 || 0, c1 = o.cap1 || 0;
    const ringAt = s => {
      const r = o.ring(s), u = Math.abs(s - s0), v = Math.abs(s1 - s);
      let k = 1;
      if (c0 && u < c0) { const q = 1 - u / c0; k = Math.sqrt(Math.max(0, 1 - q * q)); }
      if (c1 && v < c1) { const q = 1 - v / c1; k = Math.min(k, Math.sqrt(Math.max(0, 1 - q * q))); }
      r.k = k; return r;
    };
    // place rings evenly by arc length so domes and sharp slopes get enough rings
    const S = 600, cum = [0];
    let prev = ringAt(s0);
    for (let i = 1; i <= S; i++) {
      const s = s0 + (s1 - s0) * i / S, r = ringAt(s);
      const dc = Math.hypot(r.c[0] - prev.c[0], r.c[1] - prev.c[1], r.c[2] - prev.c[2]);
      const de = Math.max(Math.abs(r.up * r.k - prev.up * prev.k), Math.abs(r.wp * r.k - prev.wp * prev.k), Math.abs(r.wn * r.k - prev.wn * prev.k), Math.abs(r.un * r.k - prev.un * prev.k));
      cum.push(cum[i - 1] + Math.hypot(dc, de) + len / S * 0.15); prev = r;
    }
    const total = cum[S], ss = [];
    for (let i = 0, j = 0; i < n; i++) {
      const target = total * i / (n - 1);
      while (j < S - 1 && cum[j + 1] < target) j++;
      const f = clamp((target - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]), 0, 1);
      ss.push(s0 + (s1 - s0) * (j + f) / S);
    }
    const pos = [], uv = [], idx = [];
    for (let i = 0; i < n; i++) {
      const r = ringAt(ss[i]), e = 2 / (r.e || 2);
      for (let j = 0; j <= m; j++) {
        const th = j / m * Math.PI * 2, cx = Math.cos(th), sx = Math.sin(th);
        const X = Math.sign(cx) * Math.pow(Math.abs(cx), e) * (cx > 0 ? r.up : r.un) * r.k;
        const Z = Math.sign(sx) * Math.pow(Math.abs(sx), e) * (sx > 0 ? r.wp : r.wn) * r.k;
        pos.push(r.c[0] + U[0] * X + W[0] * Z, r.c[1] + U[1] * X + W[1] * Z, r.c[2] + U[2] * X + W[2] * Z);
        uv.push(j / m, i / (n - 1));
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < m; j++) {
      const a = i * (m + 1) + j, b = a + 1, c = a + m + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const p = { pos, uv, idx, part: o.part || 0, side: 1, mask: new Array(pos.length / 3).fill(0) };
    orient(p); normals(p); return p;
  }
  // flip the winding if the closed mesh has negative signed volume (normals pointing in)
  function orient(p) {
    const P = p.pos, I = p.idx; let v = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    if (v < 0) for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
  }
  // smooth normals welded by position: seams and collapsed poles share one averaged normal
  function normals(p) {
    const P = p.pos, I = p.idx, nv = P.length / 3, key = new Int32Array(nv), map = new Map(), acc = [];
    for (let i = 0; i < nv; i++) {
      const k = Math.round(P[i * 3] * 2e4) + ',' + Math.round(P[i * 3 + 1] * 2e4) + ',' + Math.round(P[i * 3 + 2] * 2e4);
      let id = map.get(k); if (id === undefined) { id = acc.length / 3; map.set(k, id); acc.push(0, 0, 0); }
      key[i] = id;
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area weighted
      for (const q of [I[t], I[t + 1], I[t + 2]]) { const k = key[q] * 3; acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz; }
    }
    const N = new Array(P.length);
    for (let i = 0; i < nv; i++) {
      const k = key[i] * 3, l = Math.hypot(acc[k], acc[k + 1], acc[k + 2]) || 1;
      N[i * 3] = acc[k] / l; N[i * 3 + 1] = acc[k + 1] / l; N[i * 3 + 2] = acc[k + 2] / l;
    }
    p.nrm = N; return N;
  }
  // Gaussian field: { c: [x,y,z], r: [rx,ry,rz] or [rx-,rx+,ry-,ry+,rz-,rz+], a: amplitude (m), p: sharpness }
  function field(f, x, y, z) {
    const r = f.r, s = r.length === 6;
    const dx = x - f.c[0], dy = y - f.c[1], dz = z - f.c[2];
    const qx = dx / (s ? (dx < 0 ? r[0] : r[1]) : r[0]), qy = dy / (s ? (dy < 0 ? r[2] : r[3]) : r[1]), qz = dz / (s ? (dz < 0 ? r[4] : r[5]) : r[2]);
    const q = qx * qx + qy * qy + qz * qz;
    if (q > 30) return 0;
    return f.a * Math.exp(-(f.p ? Math.pow(q, f.p) : q));
  }
  const sym = f => [f, Object.assign({}, f, { c: [-f.c[0], f.c[1], f.c[2]], r: f.r.length === 6 ? [f.r[1], f.r[0], f.r[2], f.r[3], f.r[4], f.r[5]] : f.r })];
  // displace along the welded normal by a field sum (+ optional extra fn(x,y,z,i))
  function displace(p, fields, extra) {
    const N = normals(p), P = p.pos;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      let d = 0; for (const f of fields) d += field(f, x, y, z);
      if (extra) d += extra(x, y, z, i / 3);
      P[i] += N[i] * d; P[i + 1] += N[i + 1] * d; P[i + 2] += N[i + 2] * d;
    }
    normals(p);
  }
  function mirrorX(p) {
    const q = { pos: p.pos.slice(), uv: p.uv.slice(), idx: p.idx.slice(), part: p.part, side: -1, mask: p.mask.slice() };
    for (let i = 0; i < q.pos.length; i += 3) q.pos[i] = -q.pos[i];
    for (let t = 0; t < q.idx.length; t += 3) { const x = q.idx[t + 1]; q.idx[t + 1] = q.idx[t + 2]; q.idx[t + 2] = x; }
    normals(q); return q;
  }
  // capsule-like tube along a curve with a radius profile (both ends close to a point)
  function tube(THREE, pts, rad, segs, rs, part) {
    const curve = new THREE.CatmullRomCurve3(pts.map(v => new THREE.Vector3(v[0], v[1], v[2])));
    const fr = curve.computeFrenetFrames(segs, false), pos = [], uv = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, P = curve.getPointAt(t), N = fr.normals[i], B = fr.binormals[i], r = rad(t);
      for (let j = 0; j <= rs; j++) {
        const a = j / rs * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        pos.push(P.x + r * (c * N.x + s * B.x), P.y + r * (c * N.y + s * B.y), P.z + r * (c * N.z + s * B.z)); uv.push(j / rs, t);
      }
    }
    for (let i = 0; i < segs; i++) for (let j = 0; j < rs; j++) { const a = i * (rs + 1) + j, b = a + 1, c = a + rs + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const p = { pos, uv, idx, part, side: 1, mask: new Array(pos.length / 3).fill(1) };
    orient(p); normals(p); return p;
  }

  // ---------------------------------------------------------------- anatomy (metres)
  function torsoPiece() {
    // y: half-width x, front depth, back depth, centre z, exponent  -- the heroic V-taper
    const T = profile([
      [-0.335, 0.10, 0.075, 0.085, 0.0, 2.2],
      [-0.29, 0.152, 0.094, 0.11, 0.0, 2.3],
      [-0.21, 0.166, 0.1, 0.118, 0.0, 2.4],
      [-0.12, 0.158, 0.1, 0.104, 0.0, 2.45],
      [-0.03, 0.146, 0.099, 0.092, 0.0, 2.45],
      [0.07, 0.156, 0.104, 0.096, 0.0, 2.45],
      [0.17, 0.184, 0.114, 0.106, 0.0, 2.5],
      [0.27, 0.214, 0.125, 0.112, 0.0, 2.6],
      [0.35, 0.232, 0.124, 0.114, 0.0, 2.7],
      [0.415, 0.24, 0.106, 0.11, 0.0, 2.9],
      [0.46, 0.22, 0.088, 0.096, 0.0, 2.9],
      [0.495, 0.168, 0.072, 0.082, 0.004, 2.6],
      [0.525, 0.1, 0.062, 0.07, 0.006, 2.3],
      [0.555, 0.066, 0.057, 0.062, 0.006, 2.1],
      [0.62, 0.057, 0.052, 0.058, 0.004, 2.0],
      [0.69, 0.054, 0.05, 0.056, 0.004, 2.0]
    ]);
    const p = sweep({ n: 72, m: 56, s0: -0.335, s1: 0.69, cap0: 0.035, cap1: 0.03, part: 0, ring: y => {
      const [x, f, b, cz, e] = T(y); return { c: [0, y, cz], up: x, un: x, wp: f, wn: b, e };
    } });
    const F = [
      // pectorals with a crisp lower shelf, split by the sternum
      ...sym({ c: [0.088, 0.312, -0.13], r: [0.072, 0.075, 0.034, 0.07, 0.06, 0.06], a: 0.024, p: 1.5 }),
      { c: [0, 0.3, -0.14], r: [0.011, 0.09, 0.06], a: -0.007 },
      // six-pack, linea alba, obliques, serratus
      ...[0.172, 0.104, 0.038].flatMap((y, i) => sym({ c: [0.034, y, -0.11], r: [0.024, 0.027 - i * 0.002, 0.05], a: 0.0075, p: 1.7 })),
      { c: [0, 0.07, -0.11], r: [0.006, 0.16, 0.05], a: -0.003 },
      ...sym({ c: [0.125, 0.0, -0.075], r: [0.035, 0.08, 0.06], a: 0.007 }),
      ...[0.215, 0.18, 0.145].flatMap(y => sym({ c: [0.165, y, -0.055], r: [0.025, 0.011, 0.03], a: 0.0032 })),
      // lats flare, traps, scapulae, spine, glutes, collarbones, neck straps
      ...sym({ c: [0.172, 0.27, 0.055], r: [0.06, 0.06, 0.12, 0.1, 0.08, 0.08], a: 0.022 }),
      ...sym({ c: [0.085, 0.5, 0.035], r: [0.07, 0.045, 0.06], a: 0.016 }),
      { c: [0, 0.39, 0.12], r: [0.09, 0.11, 0.06], a: 0.008 },
      ...sym({ c: [0.092, 0.33, 0.12], r: [0.05, 0.06, 0.05], a: 0.008 }),
      { c: [0, 0.2, 0.12], r: [0.011, 0.32, 0.05], a: -0.006 },
      ...sym({ c: [0.072, -0.225, 0.11], r: [0.07, 0.075, 0.07], a: 0.02 }),
      ...sym({ c: [0.075, 0.5, -0.07], r: [0.06, 0.011, 0.04], a: 0.004 }),
      ...sym({ c: [0.03, 0.585, -0.035], r: [0.012, 0.05, 0.02], a: 0.0045 }),
      { c: [0, 0.59, -0.058], r: [0.009, 0.01, 0.02], a: 0.0028 }
    ];
    displace(p, F); return p;
  }

  function hairLine() {
    // hairline height by angle around the head (0 = forehead, PI = nape)
    return pchip([[0, 0.8], [0.55, 0.797], [0.95, 0.785], [1.15, 0.772], [1.22, 0.735], [1.33, 0.735], [1.41, 0.776], [1.85, 0.776], [2.1, 0.712], [2.6, 0.676], [Math.PI, 0.668]]);
  }
  function headPiece() {
    const H = profile([
      // y, half-width, front z, back z, exponent
      [0.618, 0.02, -0.088, -0.07, 2.6],
      [0.628, 0.026, -0.091, -0.052, 2.6],
      [0.645, 0.046, -0.094, -0.006, 2.5],
      [0.665, 0.058, -0.097, 0.038, 2.4],
      [0.69, 0.064, -0.099, 0.068, 2.3],
      [0.715, 0.068, -0.1, 0.084, 2.3],
      [0.74, 0.072, -0.099, 0.094, 2.25],
      [0.77, 0.074, -0.1, 0.1, 2.2],
      [0.8, 0.073, -0.094, 0.1, 2.2],
      [0.825, 0.068, -0.082, 0.092, 2.2],
      [0.845, 0.056, -0.064, 0.076, 2.2],
      [0.86, 0.034, -0.036, 0.048, 2.2],
      [0.866, 0.012, -0.012, 0.02, 2.2]
    ]);
    const p = sweep({ n: 92, m: 80, s0: 0.618, s1: 0.866, cap0: 0.008, cap1: 0.012, part: 1, ring: y => {
      const [x, f, b, e] = H(y); return { c: [0, y, (f + b) / 2], up: x, un: x, wp: (b - f) / 2, wn: (b - f) / 2, e };
    } });
    const F = [
      ...sym({ c: [0.03, 0.762, -0.1], r: [0.024, 0.008, 0.025], a: 0.0055 }),           // brow ridge
      { c: [0, 0.757, -0.1], r: [0.012, 0.008, 0.025], a: 0.004 },                         // glabella
      ...sym({ c: [0.032, 0.744, -0.098], r: [0.017, 0.011, 0.03], a: -0.012, p: 1.3 }),  // eye sockets
      { c: [0, 0.737, -0.1], r: [0.0085, 0.016, 0.03], a: 0.007 },                         // nose bridge
      { c: [0, 0.716, -0.1], r: [0.0095, 0.013, 0.03], a: 0.014 },                         // dorsum
      { c: [0, 0.703, -0.1], r: [0.011, 0.009, 0.03], a: 0.02, p: 1.2 },                   // tip
      ...sym({ c: [0.0135, 0.7, -0.095], r: [0.0075, 0.0065, 0.02], a: 0.008 }),          // alae
      { c: [0, 0.693, -0.1], r: [0.012, 0.004, 0.03], a: -0.004 },                         // under the nose
      { c: [0, 0.684, -0.1], r: [0.004, 0.006, 0.03], a: 0.0015 },                         // philtrum
      { c: [0, 0.6755, -0.1], r: [0.021, 0.0045, 0.03], a: 0.0055, p: 1.3 },               // upper lip
      { c: [0, 0.6635, -0.1], r: [0.019, 0.0045, 0.03], a: 0.005, p: 1.3 },                // lower lip
      { c: [0, 0.6695, -0.1], r: [0.023, 0.0013, 0.03], a: -0.003 },                       // mouth line
      ...sym({ c: [0.023, 0.669, -0.09], r: [0.004, 0.004, 0.02], a: -0.002 }),           // corners
      { c: [0, 0.655, -0.1], r: [0.016, 0.004, 0.03], a: -0.0025 },                        // under-lip groove
      ...sym({ c: [0.011, 0.638, -0.095], r: [0.013, 0.012, 0.03], a: 0.007 }),           // square chin
      { c: [0, 0.638, -0.1], r: [0.0028, 0.008, 0.03], a: -0.0025 },                       // cleft
      ...sym({ c: [0.05, 0.722, -0.085], r: [0.02, 0.011, 0.03], a: 0.006 }),             // cheekbones
      ...sym({ c: [0.052, 0.69, -0.085], r: [0.016, 0.014, 0.03], a: -0.003 }),           // cheek hollows
      ...sym({ c: [0.024, 0.688, -0.1], r: [0.004, 0.012, 0.03], a: -0.0018 }),           // nasolabial folds
      ...sym({ c: [0.058, 0.652, 0.0], r: [0.014, 0.012, 0.03], a: 0.005 }),              // jaw angles
      ...sym({ c: [0.07, 0.76, -0.05], r: [0.012, 0.018, 0.02], a: -0.003 })              // temples
    ];
    // hair: a mask from the hairline, raised into volume with a side part and a front lift
    const hl = hairLine(), P = p.pos;
    for (let i = 0; i < P.length / 3; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      p.mask[i] = sstep(-0.004, 0.004, y - hl(Math.abs(Math.atan2(x, -z))));
    }
    const lift = [
      { c: [0.012, 0.826, -0.07], r: [0.05, 0.022, 0.035], a: 0.007 },
      { c: [-0.036, 0.84, 0.0], r: [0.0035, 0.035, 0.09], a: -0.0045 }
    ];
    displace(p, F, (x, y, z, i) => {
      const m = p.mask[i]; if (!m) return 0;
      let d = 0.0085; for (const f of lift) d += field(f, x, y, z);
      return d * m;
    });
    return p;
  }
  function earPiece() {
    const p = sweep({ n: 18, m: 20, s0: 0.766, s1: 0.708, cap0: 0.012, cap1: 0.014, part: 1, ring: y => {
      const t = (0.766 - y) / 0.058;
      return { c: [0.071, y, 0.012 + t * 0.008], up: 0.009, un: 0.008, wp: 0.011 - t * 0.003, wn: 0.017 - t * 0.004, e: 2.2 };
    } });
    displace(p, [{ c: [0.082, 0.742, 0.012], r: [0.006, 0.014, 0.009], a: -0.0035 }]);
    return p;
  }
  const EYE = { x: 0.032, y: 0.744, z: -0.0772, r: 0.0125 };
  function eyePiece() {
    const r = EYE.r;
    return Object.assign(sweep({ n: 16, m: 24, s0: EYE.y + r, s1: EYE.y - r, cap0: r, cap1: r, part: 3, ring: y => ({ c: [EYE.x, y, EYE.z], up: r, un: r, wp: r, wn: r, e: 2 }) }), {});
  }
  function curlPiece(THREE) {
    // the forelock: a lock leaving the hairline and curling into a small "S" on the forehead
    const pts = [[0.0, 0.818, -0.08], [0.006, 0.803, -0.1], [0.013, 0.79, -0.106], [0.02, 0.779, -0.107], [0.021, 0.771, -0.107], [0.015, 0.767, -0.108], [0.01, 0.772, -0.108], [0.013, 0.778, -0.107]];
    return tube(THREE, pts, t => 0.0048 * Math.pow(Math.sin(Math.PI * t), 0.6), 40, 8, 2);
  }

  // right upper arm, pivot frame (shoulder joint at the origin)
  function upperArmPiece() {
    const A = profile([
      [0.09, 0.06, 0.05, 0.065, 0.065, 2.2],
      [0.05, 0.078, 0.058, 0.076, 0.076, 2.2],
      [0.0, 0.088, 0.06, 0.08, 0.08, 2.2],
      [-0.06, 0.076, 0.058, 0.07, 0.068, 2.2],
      [-0.13, 0.06, 0.055, 0.064, 0.062, 2.2],
      [-0.2, 0.054, 0.05, 0.06, 0.058, 2.2],
      [-0.26, 0.05, 0.047, 0.052, 0.052, 2.2],
      [-0.315, 0.046, 0.044, 0.046, 0.046, 2.2]
    ]);
    const p = sweep({ n: 36, m: 28, s0: 0.09, s1: -0.315, cap0: 0.06, cap1: 0.045, part: 4, ring: y => {
      const [o, i, f, b, e] = A(y); return { c: [0, y, 0], up: o, un: i, wp: f, wn: b, e };
    } });
    displace(p, [
      { c: [0.04, 0.0, -0.05], r: [0.03, 0.05, 0.028], a: 0.008 },  // front delt
      { c: [0.075, -0.005, 0], r: [0.025, 0.05, 0.03], a: 0.008 },   // side delt
      { c: [0.04, 0.0, 0.05], r: [0.03, 0.05, 0.028], a: 0.007 },    // rear delt
      { c: [0.0, -0.155, -0.055], r: [0.032, 0.06, 0.03], a: 0.015 }, // biceps
      { c: [0.018, -0.11, 0.055], r: [0.022, 0.07, 0.03], a: 0.011 }, // triceps (lateral head)
      { c: [-0.014, -0.13, 0.05], r: [0.02, 0.06, 0.03], a: 0.009 },  // triceps (long head)
      { c: [0.055, -0.08, 0], r: [0.01, 0.025, 0.04], a: -0.003 }     // deltoid insertion
    ]);
    return p;
  }
  // right forearm + fist, joint frame (elbow at the origin)
  function forearmPieces(THREE) {
    const A = profile([
      [0.035, 0.044, 0.042, 0.044, 0.046, 2.2],
      [0.0, 0.05, 0.046, 0.048, 0.052, 2.2],
      [-0.05, 0.056, 0.05, 0.052, 0.048, 2.25],
      [-0.12, 0.048, 0.043, 0.042, 0.04, 2.25],
      [-0.2, 0.038, 0.034, 0.03, 0.03, 2.3],
      [-0.25, 0.034, 0.03, 0.026, 0.026, 2.3]
    ]);
    const fa = sweep({ n: 32, m: 24, s0: 0.035, s1: -0.25, cap0: 0.04, cap1: 0.02, part: 5, ring: y => {
      const [o, i, f, b, e] = A(y); return { c: [0, y, 0], up: o, un: i, wp: f, wn: b, e };
    } });
    displace(fa, [
      { c: [0.026, -0.06, -0.03], r: [0.025, 0.05, 0.025], a: 0.007 }, // brachioradialis
      { c: [-0.02, -0.07, -0.02], r: [0.025, 0.06, 0.025], a: 0.006 }, // flexors
      { c: [0.0, 0.0, 0.05], r: [0.02, 0.025, 0.02], a: 0.005 }        // olecranon
    ]);
    // fist hanging at the side: back of the hand outward (+x), curled fingers inward, knuckles low
    const B = profile([
      [-0.232, 0.026, 0.026, 0.026, 0.024, 2.2],
      [-0.26, 0.026, 0.03, 0.04, 0.036, 2.6],
      [-0.29, 0.025, 0.036, 0.046, 0.042, 3.0],
      [-0.322, 0.024, 0.036, 0.045, 0.041, 3.1],
      [-0.345, 0.02, 0.03, 0.04, 0.036, 3.0]
    ]);
    const fist = sweep({ n: 24, m: 24, s0: -0.232, s1: -0.345, cap0: 0.012, cap1: 0.018, part: 6, ring: y => {
      const [o, i, f, b, e] = B(y); return { c: [0, y, -0.002], up: o, un: i, wp: f, wn: b, e };
    } });
    displace(fist, [
      ...[-0.03, -0.01, 0.01, 0.028].map(z => ({ c: [0.012, -0.333, z], r: [0.012, 0.009, 0.008], a: 0.0045 })),
      ...[-0.02, 0.0, 0.02].map(z => ({ c: [-0.032, -0.305, z], r: [0.012, 0.026, 0.0026], a: -0.0032 })),
      ...[-0.02, 0.0, 0.02].map(z => ({ c: [0.022, -0.325, z], r: [0.008, 0.006, 0.0025], a: -0.0018 })),
      { c: [0.026, -0.27, 0], r: [0.006, 0.03, 0.04], a: 0.002 }
    ]);
    const thumb = tube(THREE, [[-0.012, -0.258, -0.036], [-0.02, -0.28, -0.046], [-0.03, -0.302, -0.046], [-0.036, -0.316, -0.036]], t => 0.0115 * Math.pow(Math.sin(Math.PI * t), 0.5), 14, 12, 6);
    return [fa, fist, thumb];
  }
  // right thigh, pivot frame (hip joint at the origin)
  function thighPiece() {
    const A = profile([
      [0.085, 0.08, 0.06, 0.084, 0.092, 2.3],
      [0.03, 0.094, 0.074, 0.09, 0.098, 2.3],
      [-0.05, 0.098, 0.077, 0.092, 0.094, 2.3],
      [-0.14, 0.09, 0.073, 0.088, 0.084, 2.3],
      [-0.23, 0.078, 0.065, 0.08, 0.074, 2.3],
      [-0.32, 0.065, 0.056, 0.066, 0.062, 2.25],
      [-0.39, 0.058, 0.05, 0.058, 0.056, 2.2],
      [-0.415, 0.054, 0.048, 0.052, 0.052, 2.2]
    ]);
    const p = sweep({ n: 42, m: 32, s0: 0.085, s1: -0.415, cap0: 0.05, cap1: 0.04, part: 7, ring: y => {
      const [o, i, f, b, e] = A(y); return { c: [0, y, 0], up: o, un: i, wp: f, wn: b, e };
    } });
    displace(p, [
      { c: [0.055, -0.18, -0.025], r: [0.035, 0.11, 0.045], a: 0.011 },  // vastus lateralis
      { c: [0.0, -0.15, -0.085], r: [0.03, 0.13, 0.03], a: 0.008 },      // rectus femoris
      { c: [-0.035, -0.315, -0.05], r: [0.03, 0.04, 0.03], a: 0.012 },   // vastus medialis teardrop
      { c: [0.0, -0.18, 0.08], r: [0.05, 0.12, 0.03], a: 0.008 },        // hamstrings
      { c: [-0.06, -0.08, -0.02], r: [0.025, 0.08, 0.04], a: 0.005 },    // adductors
      { c: [0.072, -0.12, 0.0], r: [0.008, 0.1, 0.05], a: -0.0025 }      // IT band groove
    ]);
    return p;
  }
  const bootTop = (x, z) => -0.03 - 0.05 * Math.max(0, 1 - Math.abs(x) / 0.04) * sstep(0, -0.03, z);
  // right shin + boot, joint frame (knee at the origin)
  function shinPieces() {
    const A = profile([
      [0.04, 0.05, 0.048, 0.054, 0.048, 2.2],
      [0.0, 0.056, 0.052, 0.058, 0.052, 2.2],
      [-0.06, 0.055, 0.05, 0.05, 0.062, 2.2],
      [-0.12, 0.054, 0.05, 0.046, 0.068, 2.2],
      [-0.2, 0.047, 0.044, 0.042, 0.05, 2.25],
      [-0.27, 0.041, 0.039, 0.041, 0.042, 2.3],
      [-0.31, 0.043, 0.041, 0.046, 0.046, 2.4]
    ]);
    const shin = sweep({ n: 38, m: 28, s0: 0.04, s1: -0.31, cap0: 0.045, cap1: 0.03, part: 8, ring: y => {
      const [o, i, f, b, e] = A(y); return { c: [0, y, 0], up: o, un: i, wp: f, wn: b, e };
    } });
    const F = [
      { c: [0, -0.005, -0.06], r: [0.024, 0.024, 0.02], a: 0.008 },        // patella
      { c: [0.022, -0.115, 0.06], r: [0.025, 0.06, 0.03], a: 0.01 },       // gastrocnemius heads
      { c: [-0.022, -0.12, 0.06], r: [0.025, 0.065, 0.03], a: 0.011 },
      { c: [0.016, -0.12, -0.045], r: [0.012, 0.09, 0.02], a: 0.004 }      // tibialis
    ];
    // boots are a touch thicker than the suit, with the V-notched top as a real lip
    const P = shin.pos;
    for (let i = 0; i < P.length / 3; i++) shin.mask[i] = sstep(0.004, -0.004, P[i * 3 + 1] - bootTop(P[i * 3], P[i * 3 + 2]));
    displace(shin, F, (x, y, z, i) => 0.0032 * shin.mask[i]);
    // foot: swept heel to toe, flat sole, squared toe box
    const Fp = profile([
      [0.062, 0.03, -0.3, -0.36, 2.4],
      [0.04, 0.035, -0.29, -0.363, 2.5],
      [0.0, 0.041, -0.276, -0.366, 2.7],
      [-0.05, 0.045, -0.298, -0.366, 2.9],
      [-0.11, 0.048, -0.322, -0.366, 3.1],
      [-0.17, 0.043, -0.336, -0.366, 3.1],
      [-0.205, 0.034, -0.345, -0.364, 3.0]
    ]);
    const foot = sweep({ n: 30, m: 24, s0: 0.062, s1: -0.205, cap0: 0.03, cap1: 0.03, part: 8, U: [1, 0, 0], W: [0, 1, 0], ring: z => {
      const [w, top, sole, e] = Fp(z); return { c: [0, (top + sole) / 2, z], up: w, un: w, wp: (top - sole) / 2, wn: (top - sole) / 2, e };
    } });
    foot.mask.fill(1);
    return [shin, foot];
  }

  // ---------------------------------------------------------------- cavity AO bake
  // For each vertex, the share of nearby surface (all pieces, rest pose) that sits above its
  // tangent plane: creases, armpits, under the chin and the eye sockets come out darker.
  function bakeAO(items) {
    const R = 0.045, cell = R, grid = new Map(), occ = [];
    const keyOf = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
    const seen = new Set();
    for (const it of items) for (let i = 0; i < it.wp.length; i += 3) {
      const x = it.wp[i], y = it.wp[i + 1], z = it.wp[i + 2], v = Math.round(x / 0.006) + ',' + Math.round(y / 0.006) + ',' + Math.round(z / 0.006);
      if (seen.has(v)) continue; seen.add(v);
      const k = keyOf(x, y, z); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(x, y, z);
    }
    for (const it of items) {
      const P = it.wp, N = it.wn, ao = it.piece.ao = new Array(P.length / 3);
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2], nx = N[i], ny = N[i + 1], nz = N[i + 2];
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
        let o = 0, tot = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
          const arr = grid.get((cx + a) + ',' + (cy + b) + ',' + (cz + c)); if (!arr) continue;
          for (let j = 0; j < arr.length; j += 3) {
            const dx = arr[j] - x, dy = arr[j + 1] - y, dz = arr[j + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > R * R || d2 < 1e-8) continue;
            const d = Math.sqrt(d2), w = 1 - d / R, cs = (dx * nx + dy * ny + dz * nz) / d;
            tot += w; if (cs > 0.12) o += w * (cs - 0.12);
          }
        }
        ao[i / 3] = 1 - clamp(2.2 * o / (tot + 1e-3), 0, 0.72);
      }
    }
  }

  // ---------------------------------------------------------------- merge
  function merge(THREE, pieces) {
    let nv = 0, ni = 0; for (const p of pieces) { nv += p.pos.length / 3; ni += p.idx.length; }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), info = new Float32Array(nv * 4);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let v = 0, t = 0;
    for (const p of pieces) {
      const n = p.pos.length / 3;
      pos.set(p.pos, v * 3); nrm.set(p.nrm, v * 3); uv.set(p.uv, v * 2);
      for (let i = 0; i < n; i++) { const o = (v + i) * 4; info[o] = p.part; info[o + 1] = p.side; info[o + 2] = p.ao ? p.ao[i] : 1; info[o + 3] = p.mask[i]; }
      for (let i = 0; i < p.idx.length; i++) idx[t + i] = p.idx[i] + v;
      v += n; t += p.idx.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  // ---------------------------------------------------------------- textures
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
  function shieldPath(x, s, ox, oy) {
    x.beginPath(); x.moveTo(ox + 16 * s, oy + 8 * s); x.lineTo(ox + 112 * s, oy + 8 * s); x.lineTo(ox + 124 * s, oy + 36 * s);
    x.lineTo(ox + 64 * s, oy + 104 * s); x.lineTo(ox + 4 * s, oy + 36 * s); x.closePath();
  }
  function drawS(x, s, ox, oy) {
    x.font = `italic 900 ${66 * s}px Georgia, 'Times New Roman', serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('S', ox + 64 * s, oy + 52 * s);
  }
  // chest shield: R = red (border + S), G = yellow fill, B = emboss height
  function shieldTexture(THREE, aniso) {
    const W = 256, H = 224, s = 2;
    const layer = draw => { const [c, x] = canvas(W, H); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.fillStyle = '#fff'; x.strokeStyle = '#fff'; draw(x); return c; };
    const all = layer(x => { shieldPath(x, s, 0, 0); x.fill(); });
    const yel = layer(x => { shieldPath(x, s, 0, 0); x.fill(); x.strokeStyle = '#000'; x.lineWidth = 9 * s; x.lineJoin = 'miter'; shieldPath(x, s, 0, 0); x.stroke(); x.fillStyle = '#000'; drawS(x, s, 0, 0); });
    const blur = (src, px) => { const [c, x] = canvas(W, H); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); if ('filter' in x) x.filter = `blur(${px}px)`; x.drawImage(src, 0, 0); return c; };
    const ga = all.getContext('2d').getImageData(0, 0, W, H).data, gy = yel.getContext('2d').getImageData(0, 0, W, H).data;
    // raised red: blur of (all - yellow)
    const red = layer(() => {}); { const x = red.getContext('2d'), im = x.getImageData(0, 0, W, H); for (let i = 0; i < im.data.length; i += 4) { const r = Math.max(0, ga[i] - gy[i]); im.data[i] = im.data[i + 1] = im.data[i + 2] = r; } x.putImageData(im, 0, 0); }
    const hA = blur(all, 2.5).getContext('2d').getImageData(0, 0, W, H).data, hR = blur(red, 1.5).getContext('2d').getImageData(0, 0, W, H).data;
    const [c, x] = canvas(W, H), im = x.createImageData(W, H);
    for (let i = 0; i < im.data.length; i += 4) {
      im.data[i] = Math.max(0, ga[i] - gy[i]); im.data[i + 1] = gy[i]; im.data[i + 2] = Math.min(255, hA[i] * 0.6 + hR[i] * 0.4); im.data[i + 3] = 255;
    }
    x.putImageData(im, 0, 0);
    const t = new THREE.CanvasTexture(c); t.anisotropy = aniso || 1; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }
  // cape back: R = yellow S-shield outline + S
  function capeTexture(THREE, aniso) {
    const [c, x] = canvas(256, 224); x.fillStyle = '#000'; x.fillRect(0, 0, 256, 224);
    x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = 12; x.lineJoin = 'miter'; shieldPath(x, 1.8, 13, 12); x.stroke(); drawS(x, 1.8, 13, 12);
    const t = new THREE.CanvasTexture(c); t.anisotropy = aniso || 1; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  // ---------------------------------------------------------------- shaders
  const col = (THREE, h) => { const c = new THREE.Color(h).convertSRGBToLinear(); return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`; };
  const NOISE = `
float smHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float smNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(smHash(i), smHash(i + vec3(1, 0, 0)), f.x), mix(smHash(i + vec3(0, 1, 0)), smHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(smHash(i + vec3(0, 0, 1)), smHash(i + vec3(1, 0, 1)), f.x), mix(smHash(i + vec3(0, 1, 1)), smHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float smSq(float x) { return x * x; }
float smR(float a, float b, float x) { return 1.0 - smoothstep(b, a, x); }
vec3 smPerturb(vec3 surfPos, vec3 n, vec2 dH) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * n - grad);
}`;
  function bodyShader(THREE) {
    const C = h => col(THREE, h);
    return `
uniform sampler2D smShield;
varying vec3 vObj;
varying vec4 vInfo;
${NOISE}
struct SmSurf { vec3 col; float rough; float metal; float h; float skin; float sheen; };
// fine knit: crossed ribs in object space, faded out before they alias
float smWeave(vec3 p, float aa) {
  vec3 q = p * 3900.0;
  float w = sin(q.x + q.y * 0.7 + q.z * 0.2) * sin(q.y - q.z * 0.8 + q.x * 0.3);
  return w * (1.0 - smoothstep(0.15, 0.45, aa * 620.0));
}
SmSurf smSurface(vec3 p, float part, float side, float mask, float aa) {
  SmSurf s;
  vec3 SUIT = ${C(0x2246b4)}, RED = ${C(0xb5121b)}, YEL = ${C(0xf6c414)}, GOLD = ${C(0xe8a90c)}, BOOT = ${C(0xa30e17)};
  vec3 SKIN = ${C(0xdfa283)}, LIP = ${C(0xb4685c)}, HAIR = ${C(0x0c0d11)};
  float e = max(aa * 0.75, 0.0004);
  float fab = 1.0;      // fabric weave amount
  s.col = SUIT; s.rough = 0.5; s.metal = 0.0; s.h = 0.0; s.skin = 0.0; s.sheen = 1.0;
  if (part < 0.5) {
    // torso: crew collar, shield, belt with buckle, trunks
    float collarY = 0.53 + 0.032 * smoothstep(-0.05, 0.06, p.z);
    float neck = smoothstep(collarY - e, collarY + e, p.y);
    float bc = -0.113;
    float belt = smR(0.023 + e, 0.023 - e, abs(p.y - bc));
    float trunks = 1.0 - smoothstep(bc - 0.023 - e, bc - 0.023 + e, p.y);
    float fr = smR(-0.02, -0.06, p.z);
    vec2 bq = abs(vec2(p.x, p.y - bc));
    float buckle = fr * smR(e, -e, max(bq.x - 0.036, bq.y - 0.028));
    float bin = fr * smR(e, -e, max(bq.x - 0.026, bq.y - 0.018));
    vec2 su = vec2(0.5 - p.x / 0.25, (p.y - 0.204) / 0.218);
    vec4 sh = texture2D(smShield, su) * smR(-0.04, -0.075, p.z);
    s.col = mix(SUIT, RED, sh.r); s.col = mix(s.col, YEL, sh.g);
    s.h += sh.b * 0.0028; fab *= 1.0 - 0.6 * max(sh.r, sh.g); s.rough = mix(s.rough, 0.36, max(sh.r, sh.g));
    s.col = mix(s.col, RED, trunks);
    float gold = max(belt, buckle);
    s.col = mix(s.col, GOLD, gold); s.metal = gold * 0.6; s.rough = mix(s.rough, 0.3, gold); fab *= 1.0 - gold;
    s.h += belt * 0.0022 + buckle * 0.0012 + bin * 0.0018 - (buckle - bin) * 0.0006;
    // seams: sides, under the arms down to the belt
    float seam = exp(-smSq((p.z - 0.012) / 0.0016)) * step(0.11, abs(p.x)) * (1.0 - gold);
    s.h -= seam * 0.0007 + trunks * 0.0004 * exp(-smSq((p.y - bc + 0.026) / 0.002));
    s.h += 0.0012 * exp(-smSq((p.y - collarY + 0.004) / 0.003)) * (1.0 - neck);
    s.col = mix(s.col, SKIN, neck); s.skin = neck; fab *= 1.0 - neck; s.rough = mix(s.rough, 0.55, neck); s.sheen *= 1.0 - neck * 0.7;
  } else if (part < 1.5) {
    // head: skin, hair from the baked mask, brows, lash line, lips, beard shadow
    float hair = smoothstep(0.3, 0.7, mask);
    vec3 sk = SKIN;
    float fz = smR(-0.06, -0.085, p.z);
    vec2 lq = vec2(p.x / 0.021, (p.y - 0.6695) / 0.0088);
    float lips = smR(1.0, 0.65, length(lq)) * fz;
    sk = mix(sk, LIP, lips * 0.55);
    float beard = smR(0.7, 0.672, p.y) * (1.0 - lips) * smR(-0.02, -0.06, p.z + 0.02 * abs(p.x) / 0.06);
    sk *= mix(vec3(1.0), vec3(0.8, 0.82, 0.88), beard * 0.42);
    float ax = abs(p.x);
    vec2 bw = vec2((ax - 0.031) / 0.02, (p.y - 0.7625 + 0.006 * smoothstep(0.0, 1.0, (ax - 0.02) / 0.03)) / 0.0042);
    float brow = smR(1.0, 0.55, length(bw)) * fz;
    vec2 lw = vec2((ax - 0.032) / 0.0145, (p.y - 0.7445) / 0.0085);
    float lash = smR(0.25, 0.0, abs(length(lw) - 1.0)) * step(0.0, lw.y + 0.3) * fz;
    sk = mix(sk, sk * 0.35, lash * 0.75);
    s.col = mix(sk, HAIR, max(hair, brow * 0.9));
    s.skin = 1.0 - max(hair, brow); s.rough = mix(0.5, 0.36, hair) - lips * 0.12; fab = 0.0;
    s.sheen = hair * 0.8;
    float th = atan(p.x, -p.z);
    s.h += hair * 0.00035 * sin(th * 150.0 + p.y * 260.0 + sin(p.y * 400.0 + th * 9.0) * 2.0) * (1.0 - smoothstep(0.2, 0.5, aa * 160.0));
    s.h += (1.0 - hair) * 0.00007 * (smNoise(p * 1400.0) - 0.5) * (1.0 - smoothstep(0.1, 0.4, aa * 1400.0 / 6.0));
  } else if (part < 2.5) {
    s.col = HAIR; s.rough = 0.36; s.sheen = 0.8; fab = 0.0;
  } else if (part < 3.5) {
    // eye: sclera, blue iris with a dark limbal ring, pupil, upper-lid shadow
    vec3 d = normalize(p - vec3(side * ${EYE.x.toFixed(4)}, ${EYE.y.toFixed(4)}, ${EYE.z.toFixed(4)}));
    float c = -d.z;
    float iris = smoothstep(0.855, 0.875, c), pupil = smoothstep(0.958, 0.968, c), limb = smR(0.035, 0.0, abs(c - 0.868));
    s.col = mix(${C(0xd8d2c8)}, ${C(0x3c6fb4)}, iris); s.col = mix(s.col, ${C(0x040405)}, max(pupil, limb * 0.6));
    s.col *= mix(1.0, 0.35, smoothstep(0.15, 0.6, d.y));
    s.rough = 0.08; s.sheen = 0.0; fab = 0.0;
  } else if (part < 4.5) {
    // upper arm: seam down the outside
    s.h -= 0.0007 * exp(-smSq(p.z / 0.0016)) * step(0.0, p.x * side);
  } else if (part < 5.5) {
    // forearm: seam + rolled cuff at the wrist
    s.h -= 0.0007 * exp(-smSq(p.z / 0.0016)) * step(0.0, p.x * side);
    s.h += 0.0009 * smR(-0.226, -0.236, p.y);
  } else if (part < 6.5) {
    s.col = SKIN * mix(1.0, 0.92, smR(-0.315, -0.34, p.y)); s.rough = 0.52; s.skin = 1.0; s.sheen = 0.2; fab = 0.0;
    s.h += 0.00008 * (smNoise(p * 1200.0) - 0.5) * (1.0 - smoothstep(0.1, 0.4, aa * 200.0));
  } else if (part < 7.5) {
    // thigh: suit with the trunks' leg cut, high on the outside
    float a = atan(p.x * side, -p.z);
    float hem = -0.098 + 0.078 * pow(0.5 + 0.5 * sin(a), 1.6);
    float tr = smoothstep(hem - e, hem + e, p.y);
    s.col = mix(SUIT, RED, tr);
    s.h += tr * 0.0006 + 0.0012 * exp(-smSq((p.y - hem - 0.003) / 0.0025));
    s.h -= 0.0007 * exp(-smSq(p.z / 0.0016)) * step(0.0, p.x * side) * (1.0 - tr);
  } else {
    // shin + foot: boot with the V-notched top, glossier leather, dark sole
    float top = -0.03 - 0.05 * max(0.0, 1.0 - abs(p.x) / 0.04) * smR(0.0, -0.03, p.z);
    float boot = smR(top + e, top - e, p.y);
    float sole = smR(-0.3515 + e, -0.3515 - e, p.y);
    s.col = mix(SUIT, BOOT, boot); s.col = mix(s.col, ${C(0x2a0a0b)}, sole);
    s.rough = mix(0.5, 0.27, boot) + sole * 0.35; s.sheen = mix(1.0, 1.4, boot); fab *= 1.0 - boot;
    s.h += 0.0011 * exp(-smSq((p.y - top + 0.002) / 0.0022)) * boot - 0.0006 * exp(-smSq((p.y + 0.3515) / 0.0012));
    s.h += boot * (1.0 - sole) * 0.00025 * (smNoise(p * vec3(160.0, 60.0, 160.0)) - 0.5) * (1.0 - smoothstep(0.2, 0.5, aa * 60.0));
  }
  // suit fabric: fine weave, knit noise and soft wrinkles
  if (fab > 0.0) {
    s.h += fab * (0.00011 * smWeave(p, aa) + 0.00045 * (smNoise(p * 38.0) - 0.5) * (1.0 - smoothstep(0.3, 0.6, aa * 38.0)));
    s.rough += fab * 0.08 * (smNoise(p * 90.0) - 0.5);
  }
  return s;
}`;
  }

  function bodyMaterial(THREE, opts) {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, emissive: new THREE.Color(0, 0, 0) });
    const shield = shieldTexture(THREE, opts.aniso);
    m.onBeforeCompile = sh => {
      sh.uniforms.smShield = { value: shield };
      sh.vertexShader = 'attribute vec4 aInfo;\nvarying vec3 vObj;\nvarying vec4 vInfo;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vObj = position; vInfo = aInfo;');
      sh.fragmentShader = bodyShader(THREE) + '\n' + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
  float smPart = floor(vInfo.x + 0.5);
  float smAA = length(fwidth(vObj));
  vec3 smDx = dFdx(vObj), smDy = dFdy(vObj);
  SmSurf smS = smSurface(vObj, smPart, vInfo.y, vInfo.w, smAA);
  float smHx = smSurface(vObj + smDx, smPart, vInfo.y, vInfo.w, smAA).h;
  float smHy = smSurface(vObj + smDy, smPart, vInfo.y, vInfo.w, smAA).h;
  diffuseColor.rgb = smS.col;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(smS.rough, 0.04, 1.0);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = smS.metal;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  normal = smPerturb(-vViewPosition, normal, vec2(smHx - smS.h, smHy - smS.h));')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  {
    float ao = vInfo.z;
    reflectedLight.indirectDiffuse *= ao;
    reflectedLight.indirectSpecular *= mix(1.0, ao * ao, 0.85);
    reflectedLight.directDiffuse *= mix(1.0, ao, 0.3);
    float nv = saturate(dot(geometry.normal, geometry.viewDir));
    float rim = pow(1.0 - nv, 4.0);
    vec3 sheenCol = mix(diffuseColor.rgb, vec3(1.0), 0.3);
    reflectedLight.indirectSpecular += smS.sheen * 0.55 * rim * sheenCol * (irradiance + iblIrradiance) * RECIPROCAL_PI * ao;
    #if NUM_DIR_LIGHTS > 0
      vec3 L = directionalLights[0].direction;
      float ndl = dot(geometry.normal, L);
      // skin: light wraps past the terminator with a warm subsurface tint
      float wrap = max(0.0, (ndl + 0.5) / 1.5) - max(0.0, ndl);
      reflectedLight.directDiffuse += smS.skin * diffuseColor.rgb * directionalLights[0].color * wrap * vec3(1.0, 0.42, 0.3) * 0.8;
      // grazing sheen picks up the sun from behind
      reflectedLight.directSpecular += smS.sheen * 0.3 * rim * sheenCol * directionalLights[0].color * saturate(dot(-geometry.viewDir, L) * 0.6 + 0.4) * saturate(ndl + 0.35);
    #endif
  }`);
    };
    m.customProgramCacheKey = () => 'sm-hero-body-v1';
    return m;
  }

  function capeMaterial(THREE, opts) {
    opts = opts || {};
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0xa80f16).convertSRGBToLinear(), roughness: 0.62, side: THREE.DoubleSide });
    const S = capeTexture(THREE, opts.aniso);
    m.onBeforeCompile = sh => {
      sh.uniforms.smCapeS = { value: S };
      sh.vertexShader = 'varying vec2 vCapeUv;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vCapeUv = uv;');
      sh.fragmentShader = 'uniform sampler2D smCapeS;\nvarying vec2 vCapeUv;\n' + NOISE + '\n' + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
  float cOut = gl_FrontFacing ? 1.0 : 0.0;   // the outer side is the front face
  vec2 cuv = vCapeUv;
  float hem = 1.0 - smoothstep(0.012, 0.05, cuv.y);
  float sideHem = 1.0 - smoothstep(0.008, 0.03, min(cuv.x, 1.0 - cuv.x));
  vec4 cS = texture2D(smCapeS, vec2((cuv.x - 0.5) / 0.34 + 0.5, (cuv.y - 0.64) / 0.135 + 0.5));
  float cY = cS.r * cOut * step(abs(cuv.x - 0.5), 0.17) * step(abs(cuv.y - 0.64), 0.0675);
  vec3 cCol = diffuseColor.rgb * mix(1.0, 0.62, max(hem, sideHem * 0.7)) * mix(0.66, 1.0, cOut);
  vec2 cFw = fwidth(cuv * vec2(600.0, 1300.0));
  float cWeave = sin(cuv.x * 3770.0) * sin(cuv.y * 8170.0) * (1.0 - smoothstep(0.15, 0.45, max(cFw.x, cFw.y) / 6.28));
  cCol *= 1.0 + 0.06 * cWeave + 0.08 * (smNoise(vec3(cuv * vec2(40.0, 90.0), 0.0)) - 0.5);
  diffuseColor.rgb = mix(cCol, ${col(THREE, 0xf2b705)}, cY);`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(mix(0.72, 0.6, cOut), 0.48, cY);')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  #if NUM_DIR_LIGHTS > 0
  {
    // light through the cloth when the sun is on the other side
    float tr = saturate(-dot(geometry.normal, directionalLights[0].direction));
    float vb = saturate(dot(-geometry.viewDir, directionalLights[0].direction)) * 0.6 + 0.4;
    reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color * tr * vb * vec3(0.32, 0.12, 0.1);
    float nv = saturate(dot(geometry.normal, geometry.viewDir));
    reflectedLight.indirectSpecular += pow(1.0 - nv, 5.0) * 0.4 * diffuseColor.rgb * (irradiance + iblIrradiance) * RECIPROCAL_PI;
  }
  #endif`);
    };
    m.customProgramCacheKey = () => 'sm-hero-cape-v1';
    return m;
  }

  // ---------------------------------------------------------------- build
  function build(THREE, g, opts) {
    opts = opts || {};
    const t0 = performance.now();
    const head = headPiece(), curl = curlPiece(THREE), torso = torsoPiece();
    const ear = earPiece(), eye = eyePiece();
    const torsoParts = [torso, head, ear, mirrorX(ear), eye, mirrorX(eye), curl];
    const ua = upperArmPiece(), fa = forearmPieces(THREE), th = thighPiece(), sh = shinPieces();
    const ARM = 0.3, ARMY = 0.42, ELB = -0.29, HIP = 0.098, HIPY = -0.22, KNEE = -0.38;
    const side = (list, s) => s > 0 ? list : list.map(mirrorX);
    const limbs = {
      uaR: side([ua], 1), uaL: side([ua], -1), faR: side(fa, 1), faL: side(fa, -1),
      thR: side([th], 1), thL: side([th], -1), shR: side(sh, 1), shL: side(sh, -1)
    };
    // AO bake in the rest pose with every piece in the body frame
    const items = [];
    const put = (pieces, ox, oy) => { for (const p of pieces) { const wp = p.pos.slice(); for (let i = 0; i < wp.length; i += 3) { wp[i] += ox; wp[i + 1] += oy; } items.push({ piece: p, wp, wn: p.nrm }); } };
    put(torsoParts, 0, 0);
    put(limbs.uaR, ARM, ARMY); put(limbs.uaL, -ARM, ARMY); put(limbs.faR, ARM, ARMY + ELB); put(limbs.faL, -ARM, ARMY + ELB);
    put(limbs.thR, HIP, HIPY); put(limbs.thL, -HIP, HIPY); put(limbs.shR, HIP, HIPY + KNEE); put(limbs.shL, -HIP, HIPY + KNEE);
    bakeAO(items);

    const mat = bodyMaterial(THREE, opts);
    const meshes = [];
    const mk = (pieces, parent) => { const m = new THREE.Mesh(merge(THREE, pieces), mat); m.castShadow = true; parent.add(m); meshes.push(m); return m; };
    mk(torsoParts, g);
    const limb = (s, isArm) => {
      const piv = new THREE.Group(), joint = new THREE.Group();
      piv.position.set(s * (isArm ? ARM : HIP), isArm ? ARMY : HIPY, 0); g.add(piv);
      joint.position.set(0, isArm ? ELB : KNEE, 0); piv.add(joint);
      const k = s > 0 ? 'R' : 'L';
      mk(isArm ? limbs['ua' + k] : limbs['th' + k], piv);
      mk(isArm ? limbs['fa' + k] : limbs['sh' + k], joint);
      piv.userData.joint = joint;
      return piv;
    };
    const armL = limb(-1, true), armR = limb(1, true), legL = limb(-1, false), legR = limb(1, false);
    let verts = 0, tris = 0; for (const m of meshes) { verts += m.geometry.attributes.position.count; tris += m.geometry.index.count / 3; }
    window.SM_HERO.stats = { ms: Math.round(performance.now() - t0), meshes: meshes.length, verts, tris };
    return { suit: mat, armL, armR, legL, legR, meshes };
  }

  window.SM_HERO = { build, capeMaterial, CAPE: { CW: 8, CH: 12 } };
})();
