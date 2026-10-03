/*
 * Adaptive heroic score (design/dream-features.md, feature 5). Original melody, synthesized live.
 *
 * Nothing here quotes or imitates the 1978 film theme. The hero motif is our own: a pickup lift
 * (A3 D4) into a held fifth, a stepwise fall, then a rising sixth to the long D5. It lives in D major,
 * turns D minor for emergencies and is answered by a separate C-minor/tritone motif for Metallo.
 *
 * Voices (all WebAudio, no files):
 *   brass   : 3 detuned saws through a low-pass with a 60 ms filter-attack envelope
 *   strings : 3 layered saws (chorus detune), slow attack, through a delay-modulated chorus bus
 *   timpani : a sine thump falling to pitch plus a pitched noise burst
 *   choir   : noise through a high-Q band-pass at the note, then a fixed "ah" formant bank
 *   kryp    : a minor-second sine cluster with tremolo (Metallo's Kryptonite pulse)
 *
 * Layers (one active at a time, `SM_AUDIO.layer`):
 *   1 calm      : strings pad and a sparse high line            (on the ground / hovering)
 *   2 flight    : + ostinato, timpani and the brass motif, scaled by speed
 *   3 emergency : D minor, 16th ostinato, stabs; `tension` when an incident timer is under 30 %
 *     metallo   : the dark motif (low brass, tritone) with the Kryptonite pulse
 *   4 triumph   : a short swell of the full motif on a rescue or a gold / silver medal
 * Stingers: takeoff, sonic, rescue, gold, silver, bronze, failure, loss, chapter (demo titles), metallo.
 *
 * Scheduling: the "two clocks" pattern. A 25 ms timer (and every frame) schedules 16th-note steps up to
 * 100 ms ahead on ctx.currentTime, so a slow frame never delays a note. Layer changes are beat- or
 * bar-quantised inside that scheduler. With no running AudioContext (headless, before a gesture, or
 * `SM_AUDIO.debug.virtual = true`) the same state machine runs on a virtual clock advanced by the game's
 * dt and creates no nodes, so tests can check the logic without audio.
 *
 * Mix: music -> duck -> volume -> AU.duckG (so super hearing still muffles it; K mute honoured).
 * Ducks: -8 dB under a comms call (SM_COMMS.speaking), -5 dB while super hearing is on (the city duck
 * adds more), -6 dB for 350 ms under heavy impacts (SM_AUDIO.impact()).
 *
 * API: window.SM_AUDIO = { setMusic(v), setSfx(v), layer, layers, motif, stinger(name), impact(k), debug }
 *      (also __game.audio and __game.music = { layers, voices }).
 */
(function () {
  'use strict';
  const G = () => window.__game;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  const BPM = 108, STEP = 60 / BPM / 4, LOOKAHEAD = 0.1, TICK_MS = 25, MAX_VOICES = 24;
  const DB = { comms: -8, hear: -5, impact: -6 };

  // ------------------------------------------------------------------ state
  const ST = {
    step: 0, nextT: 0, vclock: 0, real: false,
    layer: 'calm', target: 'calm', pending: null, phrase0: 0,
    triumphUntil: -1, quietUntil: -1, phrase0Tri: 0,
    speed: 0, flightK: 0, flyHold: 0, tension: false, krypK: 0,
    stQueue: [], ends: new Float64Array(64), endsI: 0,
    duckDb: 0, impactUntil: 0, music: 0.8, sfx: 1,
    // trackers for edge detection
    seen: null, saves: -1, lost: -1, medals: -1, medalG: 0, medalS: 0, medalB: 0, inc: null, boomed: false,
    chapter: -1, metActive: false, lastStinger: {}
  };
  const DBG = {
    virtual: false, log: [], stingers: [], notes: 0, dropped: 0, minLead: Infinity, maxVoices: 0,
    transitions: [], inst: {}, duckDb: 0, motif: 'hero', built: false,
    get clock() { return clockNow(); }, get step() { return ST.step; }, get target() { return ST.target; },
    get pending() { return ST.pending; }, get flightK() { return +ST.flightK.toFixed(3); }, get tension() { return ST.tension; },
    get real() { return ST.real; }, get voices() { return voices(clockNow()); },
    reset() { this.log.length = 0; this.stingers.length = 0; this.transitions.length = 0; this.notes = 0; this.inst = {}; this.dropped = 0; this.minLead = Infinity; this.maxVoices = 0; }
  };

  // ------------------------------------------------------------------ audio graph (lazy)
  const A = { ctx: null, out: null, vol: null, duck: null, in: null, brass: null, strings: null, timp: null, choir: null, kryp: null };
  function au() { const g = G(); return g && g.AU; }
  function build() {
    const AU = au(); if (!AU || !AU.ctx || !AU.duckG) return false;
    if (A.ctx === AU.ctx) return true;
    const c = AU.ctx; A.ctx = c;
    A.vol = c.createGain(); A.vol.gain.value = AU.muted ? 0 : ST.music;
    A.duck = c.createGain(); A.duck.gain.value = 1;
    A.out = c.createGain(); A.out.gain.value = 0.5;     // headroom under the SFX
    A.in = c.createGain();
    A.out.connect(A.duck); A.duck.connect(A.vol); A.vol.connect(AU.duckG);
    // a small hall: generated impulse, 2.4 s
    const len = Math.floor(c.sampleRate * 2.4), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    const conv = c.createConvolver(); conv.buffer = ir;
    const wet = c.createGain(); wet.gain.value = 0.32;
    A.in.connect(A.out); A.in.connect(conv); conv.connect(wet); wet.connect(A.out);
    const bus = v => { const b = c.createGain(); b.gain.value = v; b.connect(A.in); return b; };
    A.brass = bus(0.55); A.timp = bus(0.9); A.kryp = bus(0.35);
    // strings: dry + two LFO-modulated delay taps (chorus)
    A.strings = c.createGain(); A.strings.gain.value = 0.5;
    const sOut = bus(1); A.strings.connect(sOut);
    for (let k = 0; k < 2; k++) {
      const dl = c.createDelay(0.05); dl.delayTime.value = 0.012 + k * 0.007;
      const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.31 + k * 0.17; lg.gain.value = 0.0035;
      lfo.connect(lg); lg.connect(dl.delayTime); lfo.start();
      const tg = c.createGain(); tg.gain.value = 0.55; A.strings.connect(dl); dl.connect(tg); tg.connect(sOut);
    }
    // choir: an "ah" formant bank after the pitched noise
    A.choir = c.createGain(); A.choir.gain.value = 1;
    const cOut = bus(1.6);
    for (const [f, q, gn] of [[760, 6, 1], [1150, 7, 0.55], [2650, 9, 0.25]]) {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const g = c.createGain(); g.gain.value = gn; A.choir.connect(bp); bp.connect(g); g.connect(cOut);
    }
    DBG.built = true;
    return true;
  }

  // ------------------------------------------------------------------ voices
  function voices(now) { let n = 0; for (let i = 0; i < 64; i++) if (ST.ends[i] > now) n++; return n; }
  // reserve a voice slot; returns false (and drops the note) at the cap
  function claim(t, dur, now) {
    const n = voices(now);
    if (n >= MAX_VOICES) { DBG.dropped++; return false; }
    ST.ends[ST.endsI] = t + dur; ST.endsI = (ST.endsI + 1) & 63;
    if (n + 1 > DBG.maxVoices) DBG.maxVoices = n + 1;
    return true;
  }
  const env = (p, t, a, peak, hold, rel) => {
    p.setValueAtTime(0.0001, t); p.exponentialRampToValueAtTime(peak, t + a);
    p.setValueAtTime(peak, t + Math.max(a, hold)); p.exponentialRampToValueAtTime(0.0001, t + Math.max(a, hold) + rel);
  };
  const SYN = {
    brass(c, t, f, d, v) {
      const lp = c.createBiquadFilter(), g = c.createGain(); lp.type = 'lowpass'; lp.Q.value = 2;
      lp.frequency.setValueAtTime(f * 1.2, t); lp.frequency.exponentialRampToValueAtTime(f * (3 + 7 * v) + 400, t + 0.06);
      lp.frequency.exponentialRampToValueAtTime(f * (1.6 + 3 * v) + 250, t + 0.06 + Math.max(0.15, d * 0.8));
      env(g.gain, t, 0.035, 0.22 * v, d, 0.18);
      for (const cents of [-9, 0, 8]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = cents + (Math.random() - 0.5) * 3; o.connect(lp); o.start(t); o.stop(t + d + 0.25); }
      lp.connect(g); g.connect(A.brass); return d + 0.2;
    },
    strings(c, t, f, d, v, stac) {
      const lp = c.createBiquadFilter(), g = c.createGain(); lp.type = 'lowpass'; lp.frequency.value = 2400 + 1400 * v; lp.Q.value = 0.6;
      const a = stac ? 0.012 : 0.3, rel = stac ? 0.09 : 0.45;
      env(g.gain, t, a, (stac ? 0.13 : 0.1) * v, stac ? Math.min(d, 0.07) : d, rel);
      for (const cents of [-13, 4, 15]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = cents; o.connect(lp); o.start(t); o.stop(t + Math.max(d, a) + rel + 0.05); }
      lp.connect(g); g.connect(A.strings); return Math.max(d, a) + rel;
    },
    timp(c, t, f, d, v) {
      const o = c.createOscillator(), g = c.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.1);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9 * v, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4 + 0.9 * v);
      o.connect(g); g.connect(A.timp); o.start(t); o.stop(t + 1.4);
      const AU = au(), n = c.createBufferSource(); n.buffer = AU.noise;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2.5; bp.Q.value = 3;
      const ng = c.createGain(); ng.gain.setValueAtTime(0.5 * v, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      n.connect(bp); bp.connect(ng); ng.connect(A.timp); n.start(t, Math.random()); n.stop(t + 0.12);
      return 1.3;
    },
    choir(c, t, f, d, v) {
      const AU = au(), n = c.createBufferSource(); n.buffer = AU.noise; n.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 28;
      const g = c.createGain(); env(g.gain, t, 0.45, 0.9 * v, d, 0.6);
      const s = c.createOscillator(); s.type = 'triangle'; s.frequency.value = f; const sg = c.createGain(); sg.gain.value = 0.025;
      n.connect(bp); bp.connect(g); s.connect(sg); sg.connect(g); g.connect(A.choir);
      n.start(t, Math.random()); n.stop(t + d + 0.7); s.start(t); s.stop(t + d + 0.7); return d + 0.6;
    },
    kryp(c, t, f, d, v) {
      const g = c.createGain(); env(g.gain, t, 0.01, 0.16 * v, d * 0.4, d * 0.6);
      const trem = c.createOscillator(), tg = c.createGain(); trem.frequency.value = 9; tg.gain.value = 0.06 * v; trem.connect(tg); tg.connect(g.gain);
      for (const r of [1, 1.0595, 1.4142]) { const o = c.createOscillator(); o.type = r > 1.3 ? 'triangle' : 'sine'; o.frequency.value = f * r; o.connect(g); o.start(t); o.stop(t + d + 0.05); }
      trem.start(t); trem.stop(t + d + 0.05); g.connect(A.kryp); return d;
    },
    cymbal(c, t, f, d, v) {
      const AU = au(), n = c.createBufferSource(); n.buffer = AU.noise;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4500;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 * v, t + Math.max(0.005, d * 0.6)); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.4);
      n.connect(hp); hp.connect(g); g.connect(A.in); n.start(t, Math.random()); n.stop(t + d + 1.5); return d + 1.4;
    }
  };

  // one note: inst, absolute time, midi, length in steps, velocity 0..1
  function play(inst, t, midi, steps, v, opt) {
    if (v <= 0.01) return;
    const now = clockNow(), lead = t - now;
    if (lead < DBG.minLead) DBG.minLead = lead;
    const dur = steps * STEP;
    if (!claim(t, dur + (inst === 'timp' ? 1.2 : inst === 'cymbal' ? 1.4 : 0.4), now)) return;
    DBG.notes++; DBG.inst[inst] = (DBG.inst[inst] || 0) + 1;
    if (!ST.real) return;
    const AU = au(); if (!AU || AU.muted || !A.ctx) return;
    try { SYN[inst](A.ctx, Math.max(t, A.ctx.currentTime), mtof(midi), dur, clamp(v, 0, 1), opt); } catch (e) { /* a node failed to build: skip this note */ }
  }

  // ------------------------------------------------------------------ the music (all original)
  // 16 steps per bar. Note tuples: [step, midi, lengthInSteps]
  const HERO = [ // phrase A, 4 bars, D major: the lift, the fall, the rising sixth home
    [0, 57, 2], [2, 62, 2], [4, 69, 6], [10, 67, 2], [12, 66, 2], [14, 67, 2],
    [16, 71, 4], [20, 74, 8], [28, 73, 2], [30, 71, 2],
    [32, 69, 4], [36, 66, 2], [38, 69, 2], [40, 76, 8],
    [48, 74, 12]];
  const HERO_B = [ // answering phrase: a high descent over the bVII
    [0, 78, 6], [6, 76, 2], [8, 74, 4], [12, 72, 4],
    [16, 74, 2], [18, 71, 2], [20, 67, 8], [28, 69, 4],
    [32, 71, 4], [36, 74, 4], [40, 79, 6], [46, 78, 2],
    [48, 74, 16]];
  const CALM_LINE = [[0, 81, 8], [8, 78, 8], [20, 79, 12], [32, 76, 8], [40, 74, 8], [52, 73, 12]];
  const EMERG = [ // the motif head in D minor, broken off and sequenced up
    [0, 57, 2], [2, 62, 2], [4, 69, 4], [8, 70, 2], [10, 69, 2], [12, 67, 4],
    [16, 58, 2], [18, 62, 2], [20, 70, 4], [24, 72, 2], [26, 70, 2], [28, 69, 4],
    [32, 60, 2], [34, 64, 2], [36, 72, 4], [40, 74, 2], [42, 72, 2], [44, 70, 4],
    [48, 69, 8], [56, 73, 8]];
  const METALLO = [ // low brass, C minor with a tritone, Neapolitan Db, ends on the tritone
    [0, 36, 4], [4, 42, 4], [8, 41, 2], [10, 39, 2], [12, 37, 4],
    [16, 36, 8], [28, 35, 4],
    [32, 36, 4], [36, 42, 4], [40, 44, 2], [42, 43, 2], [44, 42, 4],
    [48, 37, 6], [54, 36, 2], [56, 42, 8]];
  // chord per bar: [bass, voicing...]
  const CH = {
    calm: [[38, 62, 66, 69], [35, 62, 66, 71], [31, 62, 67, 71], [33, 61, 64, 69]],         // D Bm G A
    heroA: [[38, 62, 66, 69], [31, 62, 67, 71], [33, 61, 64, 69], [38, 62, 66, 69]],        // D G A D
    heroB: [[36, 64, 67, 72], [31, 62, 67, 71], [33, 61, 64, 69], [38, 62, 66, 69]],        // C G A D (bVII)
    emerg: [[38, 62, 65, 69], [34, 62, 65, 70], [36, 64, 67, 72], [33, 61, 64, 69]],        // Dm Bb C A
    metallo: [[36, 60, 63, 67], [37, 61, 65, 68], [36, 60, 63, 67], [30, 61, 66, 70]]       // Cm Db Cm Gb
  };

  // play one step of the current arrangement at time t
  function arrange(s, t) {
    const L = ST.triumphUntil > s ? 'triumph' : ST.layer;
    const pos = (s - (L === 'triumph' ? ST.phrase0Tri : ST.phrase0)) & 127, bar = (pos >> 4) & 3, st = pos & 15, phraseB = pos >= 64;
    const k = ST.flightK, quiet = ST.quietUntil > s;
    const mel = (list, inst, v, tr) => { for (const n of list) if (n[0] === (pos & 63)) play(inst, t, n[1] + (tr || 0), n[2], v); };
    if (L === 'calm') {
      const ch = CH.calm[bar];
      if (st === 0) { for (let i = 1; i < 4; i++) play('strings', t, ch[i], 16, 0.55); play('strings', t, ch[0] + 12, 16, 0.5); }
      if (st === 0 && (bar & 1) === 0) play('choir', t, ch[3] + 12, 30, 0.35);
      if (!quiet && !phraseB) mel(CALM_LINE, 'strings', 0.4);
    } else if (L === 'flight') {
      const ch = (phraseB ? CH.heroB : CH.heroA)[bar];
      if (st === 0) { for (let i = 1; i < 4; i++) play('strings', t, ch[i], 16, 0.4 + 0.25 * k); play('timp', t, ch[0], 4, 0.35 + 0.4 * k); }
      // ostinato: root-fifth-octave 8ths, 16ths when fast
      const sub = k > 0.7 ? 1 : 2;
      if (st % sub === 0) { const pat = [0, 7, 12, 7]; play('strings', t, ch[0] + 12 + pat[(st / sub) & 3], sub, 0.25 + 0.45 * k, true); }
      if (st === 8 && k > 0.5) play('timp', t, ch[0], 2, 0.3 * k);
      if (!quiet && k > 0.15) mel(phraseB ? HERO_B : HERO, 'brass', 0.35 + 0.55 * k);
      if (!quiet && k > 0.6 && st === 0) play('brass', t, ch[0] + 12, 14, 0.4 * k);
    } else if (L === 'emergency') {
      const ch = CH.emerg[bar];
      if (st === 0) { for (let i = 1; i < 4; i++) play('strings', t, ch[i], 16, 0.5); }
      play('strings', t, ch[0] + 12 + ((st & 2) ? 12 : 0), 1, 0.5, true);  // driving 16ths
      if (st === 0 || st === 8 || (st === 14 && bar === 3)) play('timp', t, ch[0], 2, st === 0 ? 0.8 : 0.55);
      if (st === 6 || st === 14) for (let i = 1; i < 4; i++) play('brass', t, ch[i] - 12, 1, 0.55);
      if (!quiet) mel(EMERG, 'brass', 0.7);
      if (ST.tension && (st & 1) === 1) play('strings', t, ch[3] + 24, 1, 0.3, true);
      if (ST.tension && st === 12) play('cymbal', t, 0, 4, 0.5);
    } else if (L === 'metallo') {
      const ch = CH.metallo[bar];
      if (st === 0) { play('strings', t, ch[1] - 12, 16, 0.5); play('strings', t, ch[2] - 12, 16, 0.45); play('choir', t, ch[3], 16, 0.3); }
      if (st === 0 || st === 3 || st === 10) play('timp', t, ch[0] + 12, 2, st === 0 ? 0.85 : 0.5);
      if (!quiet) mel(METALLO, 'brass', 0.85);
      if (!quiet) mel(METALLO, 'brass', 0.4, 12);
      // the Kryptonite pulse: a dissonant cluster on every 8th, louder as it weakens you
      if ((st & 1) === 0) play('kryp', t, 76, 1.6, 0.35 + 0.65 * ST.krypK);
    } else { // triumph: the full motif, fortissimo, choir and timpani
      const ch = CH.heroA[bar];
      if (st === 0) { for (let i = 1; i < 4; i++) play('strings', t, ch[i], 16, 0.8); play('choir', t, ch[2] + 12, 16, 0.55); play('timp', t, ch[0], 4, 0.9); play('brass', t, ch[0] + 12, 14, 0.6); }
      if (bar === 0 && st >= 8 && (st & 1) === 0) play('timp', t, 38, 1, 0.3 + st * 0.03);
      if (!quiet) mel(HERO, 'brass', 1);
    }
  }

  // ------------------------------------------------------------------ stingers
  // [stepOffset, inst, midi, lengthSteps, vel]
  const chord = (o, inst, notes, len, v) => notes.map(m => [o, inst, m, len, v]);
  const STING = {
    takeoff: [[0, 'brass', 57, 1, 0.8], [1, 'brass', 62, 1, 0.85], [2, 'brass', 69, 6, 0.95], [0, 'timp', 38, 4, 0.8], [2, 'cymbal', 0, 2, 0.4]],
    sonic: [[0, 'timp', 38, 4, 1], [0, 'cymbal', 0, 1, 0.9], ...chord(0, 'brass', [50, 57, 62, 66], 10, 0.9), ...chord(0, 'strings', [74, 78, 81], 12, 0.7)],
    rescue: [[0, 'strings', 62, 1, 0.7], [1, 'strings', 66, 1, 0.7], [2, 'strings', 69, 1, 0.75], [3, 'strings', 74, 8, 0.8],
      ...chord(3, 'brass', [62, 69, 74], 8, 0.8), [3, 'choir', 78, 12, 0.5], [3, 'timp', 38, 4, 0.7]],
    gold: [[0, 'brass', 57, 2, 1], [2, 'brass', 62, 2, 1], [4, 'brass', 69, 6, 1], [10, 'brass', 71, 2, 1], [12, 'brass', 74, 12, 1],
      ...chord(12, 'brass', [50, 57, 62, 66], 12, 0.8), ...chord(12, 'choir', [74, 78, 81], 16, 0.6), ...chord(0, 'strings', [62, 66, 69], 24, 0.6),
      [0, 'timp', 38, 2, 0.6], [4, 'timp', 38, 2, 0.7], [8, 'timp', 38, 1, 0.5], [9, 'timp', 38, 1, 0.55], [10, 'timp', 38, 1, 0.6], [11, 'timp', 38, 1, 0.7], [12, 'timp', 38, 4, 1], [12, 'cymbal', 0, 2, 0.8]],
    silver: [...chord(0, 'brass', [55, 59, 62, 67], 4, 0.85), ...chord(4, 'brass', [57, 62, 66, 69], 10, 0.9), [0, 'timp', 43, 2, 0.6], [4, 'timp', 38, 4, 0.8], [4, 'choir', 74, 12, 0.4]],
    bronze: [...chord(0, 'brass', [50, 57, 62, 66], 6, 0.6), [0, 'timp', 38, 3, 0.5]],
    failure: [...chord(0, 'strings', [55, 58, 62, 67], 20, 0.55), [0, 'strings', 43, 20, 0.45]],     // minor iv (G minor), strings alone
    hit: [[0, 'timp', 33, 3, 1], [0, 'cymbal', 0, 1, 0.6], ...chord(0, 'brass', [45, 52, 57], 4, 0.7)],
    loss: [...chord(0, 'strings', [55, 58, 62], 14, 0.45)],
    metallo: [...chord(0, 'brass', [24, 30, 36, 42], 10, 1), [0, 'timp', 36, 6, 1], [0, 'kryp', 76, 8, 1], [4, 'kryp', 77, 8, 0.8]]
  };
  const CH_ROOTS = [62, 65, 60, 67, 57, 0]; // demo chapter title roots (D, F, C, G, A, Metallo)
  function chapterSting(i) {
    if (i === CH_ROOTS.length - 1) return STING.metallo;
    const r = CH_ROOTS[((i % 5) + 5) % 5];
    return [[0, 'timp', r - 24, 2, 0.6], [2, 'timp', r - 24, 2, 0.75], [4, 'timp', r - 24, 6, 1], [4, 'cymbal', 0, 2, 0.6],
      ...chord(4, 'brass', [r - 12, r - 5, r, r + 4], 12, 0.9), ...chord(4, 'choir', [r + 12, r + 16], 14, 0.45)];
  }
  // queue a stinger at the next 8th (beat-quantised feel without waiting a whole beat)
  function stinger(name, arg) {
    const sim = G() ? +(G().simT || 0).toFixed(2) : 0;
    const notes = name === 'chapter' ? chapterSting(arg | 0) : STING[name];
    if (!notes) return false;
    const now = clockNow(), last = ST.lastStinger[name] || -99;
    if (now - last < (name === 'rescue' ? 3 : 0.8) && name !== 'chapter') return false;
    ST.lastStinger[name] = now;
    const at = ST.step + 2 - (ST.step & 1);
    let len = 0; for (const n of notes) len = Math.max(len, n[0] + n[3]);
    ST.stQueue.push({ name, at, notes });
    ST.quietUntil = Math.max(ST.quietUntil, at + len);
    const e = { name, arg: arg === undefined ? null : arg, t: sim, clock: +now.toFixed(3), atStep: at };
    DBG.stingers.push(e); if (DBG.stingers.length > 200) DBG.stingers.shift();
    const g = G(); if (g && g.emit) g.emit('music', { stinger: name });
    return true;
  }
  function triumph(bars) {
    const s = ST.step + 4 - (ST.step & 3); // next beat
    if (ST.triumphUntil < s) { ST.triumphUntil = s + bars * 16; ST.phrase0Tri = s; }
    else ST.triumphUntil = Math.max(ST.triumphUntil, s + bars * 16);
    DBG.transitions.push({ from: ST.layer, to: 'triumph', step: s, t: G() ? +G().simT.toFixed(2) : 0 });
  }

  // ------------------------------------------------------------------ scheduler (two clocks)
  function clockNow() { return ST.real && A.ctx ? A.ctx.currentTime : ST.vclock; }
  function realOK() {
    if (DBG.virtual) return false;
    const AU = au(); if (!AU || !AU.ctx || AU.ctx.state !== 'running') return false;
    return build();
  }
  function doStep(s, t) {
    // beat/bar-quantised layer change
    if (ST.pending && ST.pending !== ST.layer) {
      const urgent = ST.pending === 'emergency' || ST.pending === 'metallo';
      if ((s & (urgent ? 3 : 15)) === 0) {
        DBG.transitions.push({ from: ST.layer, to: ST.pending, step: s, t: G() ? +G().simT.toFixed(2) : 0 });
        if (DBG.transitions.length > 200) DBG.transitions.shift();
        ST.layer = ST.pending; ST.pending = null; ST.phrase0 = s;
        DBG.motif = ST.layer === 'metallo' ? 'metallo' : ST.layer === 'emergency' ? 'hero-minor' : 'hero';
        if (ST.layer === 'metallo' && G()) stinger('metallo');
      }
    } else if (ST.pending === ST.layer) ST.pending = null;
    for (let i = ST.stQueue.length - 1; i >= 0; i--) {
      const q = ST.stQueue[i]; if (q.at > s) continue;
      for (const n of q.notes) play(n[1], t + n[0] * STEP, n[2], n[3], n[4]);
      ST.stQueue.splice(i, 1);
    }
    arrange(s, t);
  }
  function pump() {
    const real = realOK();
    if (real !== ST.real) { ST.real = real; ST.ends.fill(0); ST.nextT = (real ? A.ctx.currentTime : ST.vclock) + 0.05; }
    const now = clockNow();
    if (ST.nextT < now) ST.nextT = now + 0.01;   // fell behind (tab hidden, long stall): never schedule in the past
    let guard = 0;
    while (ST.nextT < now + LOOKAHEAD && guard++ < 16) { doStep(ST.step, ST.nextT); ST.step++; ST.nextT += STEP; }
  }

  // ------------------------------------------------------------------ game state -> target layer, stingers, ducking
  function pickTarget(g) {
    const P = g.P, M = g.metallo && g.metallo.state;
    if (M && M.active && !M.down && !M.leaving) return 'metallo';
    const inc = g.currentInc, ms = window.SM_MISSIONS;
    if (inc || (ms && ms.state === 'active')) return 'emergency';
    return ST.flyHold > 0 ? 'flight' : 'calm';
  }
  function scanEvents(g) {
    const ev = g.events; if (!ev || !ev.length) return;
    const last = ev[ev.length - 1]; if (last === ST.seen) return;
    let i = ev.length - 1; while (i > 0 && ev[i - 1] !== ST.seen && ev.length - i < 64) i--;
    if (ST.seen === null) { ST.seen = last; return; }   // first look: don't replay history
    for (; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'takeoff') stinger('takeoff');
      else if (e.type === 'impact') { API.impact(1); stinger('hit'); }
      else if (e.type === 'land' && (e.tier === 'crater' || e.tier === 'super')) API.impact(1);
    }
    ST.seen = last;
  }
  function watch(g) {
    const L = g.ledger, P = g.P;
    // rescues
    if (ST.saves < 0) ST.saves = L.saves;
    if (L.saves > ST.saves) { if (stinger('rescue')) triumph(2); }
    ST.saves = L.saves;
    // medals and failures
    const md = L.medals;
    if (ST.medals < 0) { ST.medalG = md.gold; ST.medalS = md.silver; ST.medalB = md.bronze; ST.medals = 0; }
    if (md.gold > ST.medalG) { stinger('gold'); triumph(4); }
    else if (md.silver > ST.medalS) { stinger('silver'); triumph(2); }
    else if (md.bronze > ST.medalB) stinger('bronze');
    const medalNow = md.gold + md.silver + md.bronze, medalWas = ST.medalG + ST.medalS + ST.medalB;
    ST.medalG = md.gold; ST.medalS = md.silver; ST.medalB = md.bronze;
    const inc = g.currentInc;
    if (ST.inc && !inc && medalNow === medalWas) stinger('failure');
    ST.inc = inc;
    if (ST.lost < 0) ST.lost = L.lost;
    if (L.lost > ST.lost && !ST.lastStingerRecent('failure')) stinger('loss');
    ST.lost = L.lost;
    // sonic boom (P.boomed flips on at Mach 1)
    if (P.boomed && !ST.boomed) stinger('sonic');
    ST.boomed = !!P.boomed;
    // demo chapters
    const D = g.demo || window.SM_DEMO;
    if (D && D.active) { const c = D.chapter; if (c !== ST.chapter && c >= 0) stinger('chapter', c); ST.chapter = c; }
    else ST.chapter = -1;
  }
  ST.lastStingerRecent = name => clockNow() - (ST.lastStinger[name] || -99) < 1;

  let lastDuck = 1, lastVol = -1;
  function update(dt) {
    const g = G(); if (!g || !g.P) return;
    if (!ST.real) ST.vclock += dt;
    const P = g.P, sp = P.vel.length();
    ST.speed = sp;
    ST.flightK += (clamp((sp - 10) / 240, 0, 1) - ST.flightK) * (1 - Math.exp(-2 * dt));
    if (P.flying && sp > 8) ST.flyHold = 3; else ST.flyHold = Math.max(0, ST.flyHold - dt);
    const inc = g.currentInc;
    ST.tension = !!(inc && inc.limit && inc.age / inc.limit > 0.7);
    const M = g.metallo && g.metallo.state;
    ST.krypK = clamp(P.kryp || 0, 0, 1);
    if (g.started) { scanEvents(g); watch(g); }
    const tgt = g.started ? pickTarget(g) : 'calm';
    ST.target = tgt;
    if (tgt !== ST.layer) ST.pending = tgt; else ST.pending = null;
    if (M && M.active !== ST.metActive) ST.metActive = !!M.active;
    // ducking
    const C = window.SM_COMMS, speaking = !!(C && C.speaking), hear = !!g.hearOn;
    const now = clockNow();
    let db = (speaking ? DB.comms : 0) + (hear ? DB.hear : 0) + (now < ST.impactUntil ? DB.impact : 0);
    ST.duckDb = db; DBG.duckDb = db;
    pump();
    if (ST.real && A.ctx) {
      const AU = g.AU, t = A.ctx.currentTime, lin = Math.pow(10, db / 20);
      if (Math.abs(lin - lastDuck) > 0.005) { A.duck.gain.setTargetAtTime(lin, t, lin < lastDuck ? 0.004 : 0.12); lastDuck = lin; }
      const vol = AU.muted ? 0 : ST.music;
      if (vol !== lastVol) { A.vol.gain.setTargetAtTime(vol, t, 0.05); lastVol = vol; }
      // SFX volume rides the world bus (K mute in game.js writes 0 / 0.75; we keep the scale on top)
      if (AU.master) { const sv = AU.muted ? 0 : 0.75 * ST.sfx; if (Math.abs(AU.master.gain.value - sv) > 1e-3) AU.master.gain.value = sv; }
    }
    hookSettings();
  }

  // the 25 ms timer keeps the music going between frames (and while paused)
  setInterval(() => { if (ST.real) { try { pump(); } catch (e) { /* keep the timer alive */ } } }, TICK_MS);
  // resume on any gesture (the game resumes on keydown; clicks and pads count too)
  const resume = () => { const AU = au(); if (AU && AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);

  // settings menu (built elsewhere): SM_SETTINGS.on('music', v), SM_SETTINGS.on('sfx', v)
  let hooked = false;
  const norm = v => { v = +v; if (!isFinite(v)) return 1; return clamp(v > 1 ? v / 100 : v, 0, 1); };
  function hookSettings() {
    const S = window.SM_SETTINGS; if (hooked || !S || typeof S.on !== 'function') return;
    hooked = true;
    try {
      S.on('music', v => API.setMusic(v)); S.on('sfx', v => API.setSfx(v));
      if (typeof S.get === 'function') { const m = S.get('music'), s = S.get('sfx'); if (m !== undefined && m !== null) API.setMusic(m); if (s !== undefined && s !== null) API.setSfx(s); }
    } catch (e) { /* a different settings API: leave the defaults */ }
  }

  // ------------------------------------------------------------------ API
  const API = {
    setMusic(v) { ST.music = norm(v); lastVol = -1; return ST.music; },
    setSfx(v) { ST.sfx = norm(v); return ST.sfx; },
    get music() { return ST.music; }, get sfx() { return ST.sfx; },
    get layer() { return ST.triumphUntil > ST.step ? 'triumph' : ST.layer; },
    get baseLayer() { return ST.layer; },
    get motif() { return DBG.motif; },
    // dream-features 6.x names: pad always, ostinato over 75 m/s, motif in an emergency or boost, tension under 30 % time
    get layers() {
      const out = ['pad'], L = this.layer;
      if (L !== 'calm' && (ST.speed > 75 || L === 'emergency' || L === 'metallo')) out.push('ostinato');
      if (L === 'emergency' || L === 'metallo' || L === 'triumph' || (L === 'flight' && ST.flightK > 0.15)) out.push('motif');
      if (ST.tension) out.push('tension');
      return out;
    },
    get voices() { return voices(clockNow()); },
    stinger, triumph,
    impact(k) { ST.impactUntil = clockNow() + 0.35 * clamp(k || 1, 0.5, 2); },
    debug: DBG
  };
  window.SM_AUDIO = API;

  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function score() {
    // __game is assigned after plugins load: attach on the first frame
    let wired = false;
    return {
      update(dt) {
        const g = G();
        if (!wired && g) { wired = true; g.audio = API; g.music = { get layers() { return API.layers; }, get voices() { return API.voices; }, get layer() { return API.layer; } }; }
        try { update(Math.min(dt, 0.1)); } catch (e) { if (!DBG.err) { DBG.err = String(e && e.stack || e); console.warn('score', e); } }
      }
    };
  });
})();
