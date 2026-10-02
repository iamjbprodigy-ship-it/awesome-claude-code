/* Feel pass: hit-stop with a time-scale ramp, trauma-based rotational screen shake, critically damped
 * springs for the camera, and the landing-tier rule. See design/dream-features.md §3 "Feel targets".
 *
 * window.SM_FEEL is a singleton that game.js drives:
 *   FEEL.step(rdt)          -> sim time scale for this frame (0 while frozen, ramps back to 1)
 *   FEEL.hitStop(s, ramp)   -> freeze the sim for s seconds (150 ms ceiling), then ramp 0.25 -> 1 over `ramp` s
 *   FEEL.add(t)             -> add trauma (0..1); shake = trauma^2, decays 1.6/s
 *   FEEL.kick(x, y, z, m)   -> directional camera impulse of about m metres on a 120 ms spring
 *   FEEL.shake(rdt)         -> advance the shake; read FEEL.pitch/yaw/roll (rad) and FEEL.ox/oy/oz (m)
 *   FEEL.spring(s, goal, halfLife, dt)  -> critically damped scalar spring on {x, v}
 *   FEEL.landTier(v, braked)            -> 'soft' | 'hero' | 'crater'
 * Optional settings (a menu comes later): window.SM_SETTINGS.get('shake') scales the shake (0..1, or 0..100 %),
 * get('hitStop') === false turns hit-stop off, get('reducedMotion') halves it. Nothing here allocates per frame.
 */
(function () {
  'use strict';
  const LN2 = Math.LN2, DEG = Math.PI / 180;
  const setting = (k) => { try { const S = window.SM_SETTINGS; return S && typeof S.get === 'function' ? S.get(k) : undefined; } catch (_) { return undefined; } };
  // smooth 1D value noise in [-1, 1]
  function hash(n) { n = (n << 13) ^ n; n = (Math.imul(n, (Math.imul(Math.imul(n, n), 15731) + 789221) | 0) + 1376312589) & 0x7fffffff; return 1 - n / 1073741824; }
  function vnoise(x, seed) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f), a = hash(i + seed * 7919), b = hash(i + 1 + seed * 7919); return a + (b - a) * u; }
  // critically damped spring (Holden's half-life form): s = {x, v}
  function spring(s, goal, half, dt) {
    const y = 2 * LN2 / Math.max(1e-4, half), j0 = s.x - goal, j1 = s.v + j0 * y, e = Math.exp(-y * dt);
    s.x = e * (j0 + j1 * dt) + goal; s.v = e * (s.v - j1 * y * dt);
    return s.x;
  }
  const KICK_HALF = 0.12, KY = 2 * LN2 / KICK_HALF;
  const kx = { x: 0, v: 0 }, ky = { x: 0, v: 0 }, kz = { x: 0, v: 0 };
  const F = {
    // tuning (dream-features §3)
    DECAY: 1.6, MAX_PITCH: 2.5 * DEG, MAX_YAW: 2.5 * DEG, MAX_ROLL: 4 * DEG, MAX_POS: 0.15, CEIL: 0.15,
    trauma: 0, ph: 0, pitch: 0, yaw: 0, roll: 0, ox: 0, oy: 0, oz: 0,
    hitStopT: 0, rampT: 0, rampDur: 0, rampFrom: 1, timeScale: 1,
    lastHitStopMs: 0, frozenMs: 0, peakTrauma: 0,
    spring, vnoise,
    intensity() {
      const v = setting('shake');
      if (typeof v !== 'number' || !isFinite(v)) return 1;
      return Math.max(0, v > 1.5 ? v / 100 : v);
    },
    add(t) { if (!(t > 0)) return; this.trauma = Math.min(1, this.trauma + t); if (this.trauma > this.peakTrauma) this.peakTrauma = this.trauma; },
    // remote events fall off linearly with distance
    addAt(t, dist, range) { this.add(t * Math.max(0, 1 - dist / (range || 150))); },
    kick(x, y, z, m) {
      const I = this.intensity(), v0 = m * KY * Math.E * I, l = Math.hypot(x, y, z) || 1;
      kx.v += x / l * v0; ky.v += y / l * v0; kz.v += z / l * v0;
    },
    hitStop(s, ramp) {
      if (setting('hitStop') === false) { this.lastHitStopMs = 0; return; }
      if (setting('reducedMotion')) s *= 0.5;
      s = Math.min(this.CEIL, Math.max(0, s));
      if (s <= this.hitStopT) return;
      if (this.hitStopT <= 0) this.frozenMs = 0;
      this.hitStopT = s; this.lastHitStopMs = Math.round(s * 1000);
      this.rampDur = Math.max(this.rampT < this.rampDur ? this.rampDur - this.rampT : 0, ramp || 0); this.rampT = 0; this.rampFrom = 0.25;
    },
    // returns the sim time scale for a frame of real length rdt
    step(rdt) {
      if (!(rdt > 0)) return 1;
      let live = rdt;
      if (this.hitStopT > 0) {
        const fr = Math.min(this.hitStopT, rdt);
        this.hitStopT -= fr; this.frozenMs += fr * 1000; live = rdt - fr;
        if (live <= 1e-6) { this.timeScale = 0; return 0; }
      }
      let k = 1;
      if (this.rampT < this.rampDur) {
        this.rampT += live; const u = Math.min(1, this.rampT / this.rampDur);
        k = this.rampFrom + (1 - this.rampFrom) * u * u * (3 - 2 * u);
      }
      this.timeScale = k * live / rdt;
      return this.timeScale;
    },
    shake(rdt) {
      this.trauma = Math.max(0, this.trauma - this.DECAY * rdt);
      const I = this.intensity(), tr = this.trauma, s = tr * tr * I;
      // fast (~20 Hz) jitter on fresh impacts settling into a ~6 Hz rumble as trauma drains
      this.ph = (this.ph + rdt * (6 + 16 * Math.min(1, tr * 1.6))) % 65536;
      const ph = this.ph;
      this.pitch = this.MAX_PITCH * s * vnoise(ph, 1);
      this.yaw = this.MAX_YAW * s * vnoise(ph, 2);
      this.roll = this.MAX_ROLL * s * vnoise(ph * 0.8, 3);
      const pk = tr > 0.7 ? this.MAX_POS * (tr - 0.7) / 0.3 * I : 0;
      spring(kx, 0, KICK_HALF, rdt); spring(ky, 0, KICK_HALF, rdt); spring(kz, 0, KICK_HALF, rdt);
      this.ox = pk * vnoise(ph, 4) + kx.x; this.oy = pk * vnoise(ph, 5) + ky.x; this.oz = pk * vnoise(ph, 6) + kz.x;
    },
    // landing tiers by vertical speed at contact: soft < 15 m/s, hero 15-45, crater > 45 unless braked
    SOFT_MAX: 15, HERO_MAX: 45,
    landTier(v, braked) { return v < this.SOFT_MAX ? 'soft' : (v <= this.HERO_MAX || braked) ? 'hero' : 'crater'; },
    reset() { this.trauma = 0; this.hitStopT = 0; this.rampT = this.rampDur = 0; this.timeScale = 1; kx.x = kx.v = ky.x = ky.v = kz.x = kz.v = 0; }
  };
  window.SM_FEEL = F;
})();
