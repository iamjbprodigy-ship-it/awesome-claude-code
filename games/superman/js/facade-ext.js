/* Facade extension: interior mapping, procedural weathering/AO and glass micro-variation.
 *
 * Owner: technical-artist. Consumed by makeFacadeMat() in js/game.js through window.SM_FACADE_EXT
 * (must load before game.js). Same material is used by destructible blocks (per-face vUv) and the
 * skyline instances (#define WORLD_UV), so every term here works from vWP / vWN / fu only.
 *
 * Techniques
 *  1. Interior mapping (van Dongen 2008): one ray-box per glass pixel against a fake room
 *     5 m wide x 4 m tall x ROOM_DEPTH deep behind each 5 m x 4 m floor cell, in the facade's
 *     tangent frame (T = horizontal along the wall, B = up, depth = -vWN). Randomised per cell
 *     (wall/floor tint, furniture block, lit ceiling, dark rooms), per window (blinds/curtains).
 *     Composited as emission weighted by (1 - Fresnel), so the PBR env reflection dominates at
 *     grazing angles and the room shows head-on. Beyond INT_FADE it collapses to the original
 *     flat lit-window glow (LOD), so the far skyline pays only for the Fresnel term.
 *  2. Weathering + procedural AO: per-floor colour drift, window-reveal AO, cell-base AO, and
 *     (brick / ribbon only, see art bible 6 "Texture philosophy") sill rain streaks, ground grime.
 *  3. Glass micro-variation: per-pane roughness jitter, per-pane tilt + pillow bulge on the
 *     shading normal so reflections and sun glints break up pane to pane.
 *
 * Budgets: window emission is clamped to WIN_MAX (art bible: <= 0.6 in daylight, bloom at 1.0).
 */
(function () {
  'use strict';
  // ---- tunables (art-director / performance-analyst knobs) --------------------------------------
  const CFG = {
    INT_FADE0: 450.0,   // m: interior mapping starts fading to the flat LOD
    INT_FADE1: 600.0,   // m: interior mapping fully off
    ROOM_DEPTH: 4.0,    // m
    STORE_DEPTH: 8.0,   // m
    DAYLIGHT: 0.13,     // radiance of window-side interior surfaces per unit albedo
    WIN_MAX: 0.6,       // art bible cap for window light in daylight
    GRIME: 1.0,         // global weathering strength (0 disables streaks / grime band / edge dirt)
    AO: 1.0,            // procedural AO strength
    GLASS_ROUGH: 0.07,  // max per-pane roughness added on top of 0.04
    GLASS_TILT: 0.03    // per-pane random normal tilt (radians, approx)
  };
  const f = v => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  const defs = Object.keys(CFG).map(k => `#define X_${k} ${f(CFG[k])}`).join('\n');

  const pars = `
${defs}
// hash without sine (Hoskins): stable on desktop GPUs, no transcendental cost
float x_h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float x_h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 x_h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float x_vn(vec2 p) {
  vec2 i = floor(p), u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(x_h12(i), x_h12(i + vec2(1.0, 0.0)), u.x), mix(x_h12(i + vec2(0.0, 1.0)), x_h12(i + 1.0), u.x), u.y);
}
// Interior mapping: p = entry point in room space (m), d = view ray in room space, R = room size.
// rnd = per-room randoms, kind.x = office, kind.y = store, lit = ceiling light on.
vec3 x_room(vec3 p, vec3 d, vec3 R, vec4 rnd, vec2 kind, float lit, float detail) {
  vec3 dd = vec3(d.x >= 0.0 ? max(d.x, 1e-4) : min(d.x, -1e-4), d.y >= 0.0 ? max(d.y, 1e-4) : min(d.y, -1e-4), d.z);
  vec3 tb = (step(0.0, dd) * R - p) / dd;
  float t = min(min(tb.x, tb.y), tb.z);
  vec3 h = clamp(p + dd * t, vec3(0.0), R);
  float mZ = step(tb.z, min(tb.x, tb.y));          // back wall
  float mY = (1.0 - mZ) * step(tb.y, tb.x);        // floor or ceiling
  float mX = 1.0 - mZ - mY;                        // side wall
  float cei = mY * step(0.0, dd.y), flo = mY - cei;
  float dz = h.z / R.z;
  // albedos (held under the 0.55 saturation cap)
  vec3 wall = mix(mix(vec3(0.72, 0.69, 0.63), vec3(0.66, 0.56, 0.45), rnd.x),
                  mix(vec3(0.55, 0.60, 0.56), vec3(0.56, 0.60, 0.67), rnd.x), step(0.62, rnd.y));
  wall = mix(wall, vec3(0.70, 0.70, 0.68), kind.x * 0.7);
  vec3 flr = mix(vec3(0.40, 0.27, 0.17), vec3(0.30, 0.30, 0.32), step(0.55, rnd.z));
  flr = mix(flr, vec3(0.26, 0.28, 0.31), kind.x);
  vec3 alb = wall * (mZ + mX * 0.82) + flr * flo + vec3(0.80, 0.79, 0.76) * cei;
  // furniture silhouette against the back wall (sofa / desk / cabinet)
  float fw = 0.7 + 1.1 * rnd.z;
  float furn = mZ * step(h.y, 0.8 + 0.9 * rnd.w * (1.0 - kind.y)) * step(abs(h.x - R.x * (0.25 + 0.5 * rnd.y)), fw);
  alb *= 1.0 - 0.5 * furn;
  // shop shelving on back and side walls
  if (kind.y > 0.5) {
    float sy = h.y * 2.2, walls = mZ + mX;
    float band = step(0.3, h.y) * step(h.y, 2.4) * walls;
    float shelf = step(0.82, fract(sy));
    vec3 prod = 0.44 + 0.1 * cos(6.2831 * (x_h12(floor(vec2((h.x + h.z) * 1.6, sy))) + vec3(0.0, 0.33, 0.67)));
    prod = mix(vec3(0.46, 0.44, 0.41), prod, detail);
    alb = mix(alb, mix(prod, vec3(0.52, 0.5, 0.46), shelf), band * 0.6);
  }
  // room-corner AO: distance to the nearest edge of the hit face
  vec3 q = min(h, R - h) + vec3(mX, mY, mZ) * 9.0;
  float ao = 0.55 + 0.45 * smoothstep(0.0, 0.7, min(q.x, min(q.y, q.z)));
  // window daylight falls off with depth; floor near the window catches the most, ceiling the least
  float day = X_DAYLIGHT * (1.0 + 0.5 * kind.y) * mix(1.0, 0.25, dz) * (1.0 + 0.9 * flo * (1.0 - dz)) * (1.0 - 0.55 * cei);
  // ceiling light (lamp for homes, uniform panels for offices / shops)
  vec3 lp = vec3(R.x * 0.5, R.y - 0.1, R.z * 0.5);
  vec3 lv = lp - h;
  float lamp = lit * mix(0.9 / (1.0 + dot(lv, lv) * 0.35), 0.32, max(kind.x, kind.y));
  vec3 L = alb * ao * (vec3(day) + vec3(1.0, 0.78, 0.55) * lamp);
  // visible fixtures on the ceiling
  float disc = 1.0 - smoothstep(0.18, 0.45, length(h.xz - lp.xz));
  float panel = step(0.62, fract(h.x / 1.25 + 0.19)) * step(0.55, fract(h.z / 1.5 + 0.3));
  L += cei * lit * vec3(1.0, 0.86, 0.68) * 0.55 * mix(disc, panel, max(kind.x, kind.y));
  return L;
}
`;

  const fragment = `
// ---------------- facade-ext (x_) ----------------
float x_on = (1.0 - isRoof) * (1.0 - fSolid);
vec3 x_N = normalize(vWN);
#ifdef WORLD_UV
vec3 x_T = an.x > an.z ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
#else
vec3 x_T = cross(vec3(0.0, 1.0, 0.0), x_N);
x_T = dot(x_T, x_T) > 0.01 ? normalize(x_T) : vec3(1.0, 0.0, 0.0);
#endif
x_on *= step(abs(x_N.y), 0.7);
vec3 x_V = vWP - cameraPosition;
float x_dist = length(x_V);
x_V /= max(x_dist, 1e-3);
float x_cosV = clamp(-dot(x_V, x_N), 0.0, 1.0);
float x_fres = 0.06 + 0.94 * pow(1.0 - x_cosV, 5.0);
float x_near = x_on * (1.0 - smoothstep(X_INT_FADE0, X_INT_FADE1, x_dist));
float x_store = fStore * (1.0 - fSolid);
// window-local coordinates and the pane rectangle per style (matches FACADE_GLSL)
float x_wx = fract(fu.x * nwin);
vec4 x_win = st < 0.5 ? vec4(0.25, 0.75, 0.24, 0.84) : st < 1.5 ? vec4(0.22, 0.78, 0.2, 0.8)
           : st < 2.5 ? vec4(0.045, 0.955, 0.07, 0.95) : vec4(0.0, 0.965, 0.34, 0.82);
float x_cw = 5.0 / nwin;
if (x_store > 0.5) { x_wx = fu.x; x_win = vec4(0.05, 0.95, 0.04, 0.66); x_cw = 5.0; }
vec2 x_pp = clamp(vec2((x_wx - x_win.x) / (x_win.y - x_win.x), (fu.y - x_win.z) / (x_win.w - x_win.z)), 0.0, 1.0);
vec2 x_ps = vec2((x_win.y - x_win.x) * x_cw, (x_win.w - x_win.z) * 4.0);   // pane size, m
float x_flush = step(1.5, st) * (1.0 - x_store);                             // curtain / ribbon glazing
// ---- procedural AO: window reveal (glass) + cell base
float x_ex = min(x_pp.x, 1.0 - x_pp.x) * x_ps.x;
float x_rev = smoothstep(0.0, 0.14, x_ex) * smoothstep(0.0, 0.08, x_pp.y * x_ps.y) * smoothstep(0.0, 0.3, (1.0 - x_pp.y) * x_ps.y);
float x_revAO = 1.0 - X_AO * mix(0.4, 0.15, x_flush) * (1.0 - x_rev);
float x_cao = 1.0 - X_AO * 0.08 * (1.0 - smoothstep(0.0, 0.1, fu.y));
// ---- weathering (opaque parts). Grime only on brick (and lightly on ribbon): bible 6 keeps civic stone clean
float x_gw = X_GRIME * (st < 0.5 ? 1.0 : (st > 2.5 ? 0.55 : 0.0)) * (1.0 - fSolid);
float x_hc = dot(vWP, x_T);
float x_sy = st < 0.5 ? 0.18 : 0.34;
float x_sx = st < 0.5 ? smoothstep(0.17, 0.23, x_wx) * smoothstep(0.83, 0.77, x_wx) : 1.0;
float x_below = max(x_sy - fu.y, 0.0) * 4.0 * step(fu.y, x_sy) * (1.0 - x_store);
if (fTop > 0.5) x_below = fu.y < 0.84 ? min(x_below > 0.0 ? x_below : 9.0, (0.84 - fu.y) * 4.0) : 0.0;
float x_sfade = step(1e-4, x_below) * exp(-x_below * 1.4);
float x_sn = x_vn(vec2(x_hc * 6.0, fu.y * 1.3 + seedW * 13.0));
float x_streak = (0.04 + 0.1 * smoothstep(0.45, 0.85, x_sn)) * x_sfade * x_sx;
float x_band = (1.0 - smoothstep(0.2, 1.8, vWP.y)) * (0.05 + 0.04 * x_vn(vec2(x_hc * 1.7, 3.1)));
float x_edge = 0.05 * (1.0 - smoothstep(0.0, 0.07, fu.y));
float x_dirt = max(1.0 - x_gw * (x_streak + x_band + x_edge), 0.86);
// sill shadow (punched windows): thin AO line right under the stone sill
float x_sill = (1.0 - x_flush) * (1.0 - x_store) * x_sx * step(st, 1.5) * step(fu.y, x_sy) * (1.0 - smoothstep(0.0, 0.03, x_sy - fu.y));
x_cao *= 1.0 - X_AO * 0.12 * x_sill;
// per-floor colour drift (+-2.5%, slight warm/cool) keyed to floor and lot so a whole floor shifts together
float x_fl = floor(vWP.y / 4.0);
vec2 x_lot = floor(vWP.xz / 60.0);
float x_dr = x_h12(vec2(x_fl * 7.13 + x_lot.x * 3.7, x_lot.y * 5.3 + x_fl * 0.37)) - 0.5;
vec3 x_drift = vec3(1.0 + 0.05 * x_dr + 0.015 * x_dr, 1.0 + 0.05 * x_dr, 1.0 + 0.05 * x_dr - 0.015 * x_dr);
vec3 x_opq = mix(vec3(1.0), x_drift * x_dirt * max(x_cao, 0.82), x_on);
diffuseColor.rgb *= mix(x_opq, vec3(mix(1.0, x_revAO, x_on)), fGlass);
// ---- glass micro-variation: per-pane id, roughness jitter, tilt + pillow bulge on the normal
float x_pid = x_h12(vec2(seedW * 733.0 + wi, x_fl + 0.5));
float x_gm = fGlass * x_on;
vec2 x_bu = 2.0 * x_pp - 1.0;
vec2 x_tilt = x_gm * ((x_h22(vec2(x_pid * 91.0, seedW * 17.0)) - 0.5) * 2.0 * X_GLASS_TILT
            - 0.012 * vec2(x_bu.x * (1.0 - x_bu.y * x_bu.y), x_bu.y * (1.0 - x_bu.x * x_bu.x)));
// ---- interior: far LOD reproduces the original flat glow, near replaces it with the room
vec3 x_roomE = vec3(1.0, 0.62, 0.3) * X_WIN_MAX * (litW + x_store * 0.55) + vec3(0.045, 0.042, 0.038) * (1.0 - x_flush * 0.3);
if (x_near > 0.001 && fGlass > 0.001) {
  vec4 x_rnd = vec4(x_h22(vec2(seedW * 937.1, 3.7)), x_h22(vec2(seedW * 311.7, 8.1)));
  float x_lit = max(vLit * step(0.55, x_h11(seedW * 577.3)), x_store);
  float x_D = mix(X_ROOM_DEPTH, X_STORE_DEPTH, x_store);
  vec3 x_d = vec3(dot(x_V, x_T), x_V.y, max(-dot(x_V, x_N), 0.02));
  vec3 x_p = vec3(clamp(fu.x, 0.002, 0.998) * 5.0, clamp(fu.y, 0.002, 0.998) * 4.0, 0.0);
  vec3 x_r = x_room(x_p, x_d, vec3(5.0, 4.0, x_D), x_rnd, vec2(x_flush, x_store), x_lit, 1.0 - smoothstep(15.0, 45.0, x_dist));
  x_r *= 1.0 - 0.72 * step(x_rnd.w, 0.14) * (1.0 - x_lit);                // a few dark rooms
  // blinds (top-down, slatted) or curtains (side drapes) per window, sitting right behind the glass
  float x_bh = x_h12(vec2(seedW * 413.0, wi + 0.5));
  float x_bc = x_h11(x_bh * 91.7);
  float x_blind = step(x_bh, 0.22) * step(1.0 - (0.15 + 0.75 * x_bc), x_pp.y);
  float x_curt = step(0.22, x_bh) * step(x_bh, 0.36) * (1.0 - x_flush);
  float x_cwd = 0.12 + 0.25 * x_bc;
  x_curt *= max(step(x_pp.x, x_cwd), step(1.0 - x_cwd, x_pp.x));
  float x_slat = mix(1.0, 0.82 + 0.18 * step(0.35, fract(fu.y * 4.0 * 22.0)), smoothstep(80.0, 25.0, x_dist));
  float x_fold = 0.82 + 0.18 * sin(x_pp.x * 55.0 + x_bc * 6.0);
  vec3 x_cc = mix(vec3(0.62, 0.55, 0.45), vec3(0.45, 0.50, 0.55), x_rnd.y);
  vec3 x_cover = x_blind * vec3(0.6, 0.58, 0.53) * x_slat + x_curt * (1.0 - x_blind) * x_cc * x_fold;
  float x_cm = clamp(x_blind + x_curt, 0.0, 1.0) * (1.0 - x_store);
  x_r = mix(x_r, x_cover * (X_DAYLIGHT * 1.1 + x_lit * vec3(0.42, 0.33, 0.22)), x_cm);
  x_roomE = mix(x_roomE, x_r, x_near);
}
x_roomE = min(x_roomE, vec3(X_WIN_MAX));
x_roomE *= fGlass * x_on * (1.0 - x_fres) * x_revAO
         * (1.0 - 1.6 * clamp(vHeat * 0.55, 0.0, 0.55)) * (1.0 - 0.7 * clamp(vFrost, 0.0, 1.0));
fLit = 0.0;   // replaced by x_roomE (same far-field values, capped at X_WIN_MAX)
`;

  const roughness = `
roughnessFactor += x_gm * (x_pid * X_GLASS_ROUGH + 0.012 * x_vn(vec2(x_hc * 2.0, vWP.y * 0.5)));
`;

  const emissive = `
totalEmissiveRadiance += x_roomE;
if (x_gm > 0.001) {
  vec3 x_tv = (viewMatrix * vec4(x_T, 0.0)).xyz;
  vec3 x_bv = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  normal = normalize(normal + x_tilt.x * x_tv + x_tilt.y * x_bv);
}
`;

  window.SM_FACADE_EXT = { pars, fragment, roughness, emissive, config: CFG };
})();
