/* Settings menu and accessibility suite (js/settings.js).
 *
 * A full-screen options screen in the title / HUD style, reachable from "Settings" on the title menu, from
 * the pause front page, and with Y on a gamepad. Five tabs:
 *   Controls       remap every keyboard action (two slots each), invert Y, mouse sensitivity
 *   Camera         FOV offset, camera distance, screen shake 0-100 %, hit-stop, reduced motion, speed effects
 *   Display        quality preset, supersampling (?ss=), ambient occlusion (?ao=) (these three reload), FPS meter, HUD scale
 *   Audio          master, effects, radio and music volume
 *   Accessibility  subtitle / bubble size and backing, colour-blind-safe map palette, hold-to-toggle for heat,
 *                  freeze and the charge punch, QTE assist, reduced flashing
 *
 * Remapping is a capture-phase translation layer on window, registered before every other module's key
 * listener (this file loads straight after the three.js vendor scripts): a physical KeyboardEvent.code is
 * translated to the code the game expects and re-dispatched as a synthetic event, so game.js, missions.js,
 * setpieces.js and metallo.js keep reading plain codes ('KeyE', 'Space', 'F8', ...). Keys moved away from an
 * action stop triggering it. Unmanaged keys (Esc, Enter, ...) pass through untouched.
 *
 * API: window.SM_SETTINGS = { get(k), set(k, v), on(k, fn) -> off, vol(bus), open(tab), close(), isOpen,
 *   bind(action, slot, code), keyLabel(action), reset(tab), padOwned(), DEFAULTS, ACTIONS }.
 *   get('shake') is 0..1, get('hitStop') / get('reducedMotion') / get('qteAssist') are booleans.
 *   Audio: after the first sound, __game.AU gains .out (master), .sfxBus and .musicBus. A music module should
 *   connect to AU.musicBus (already scaled by master and music) or read vol('music') and on('music', fn).
 * Persistence: localStorage 'sm-settings' (JSON, wrapped in try/catch); defaults apply at boot.
 * No per-frame allocations: the frame loop only compares cached values.
 */
(function () {
  'use strict';
  const STORE = 'sm-settings';

  // ================================================================== actions (game code + default keys)
  // [id, label, the code game.js reads, default physical keys (slot 0, slot 1), group]
  const ACTIONS = [
    ['forward', 'Forward', 'KeyW', ['KeyW', null], 'Movement'],
    ['back', 'Back', 'KeyS', ['KeyS', null], 'Movement'],
    ['left', 'Left', 'KeyA', ['KeyA', null], 'Movement'],
    ['right', 'Right', 'KeyD', ['KeyD', null], 'Movement'],
    ['up', 'Climb / leap', 'Space', ['Space', null], 'Movement'],
    ['down', 'Descend', 'KeyC', ['KeyC', null], 'Movement'],
    ['boost', 'Super speed', 'ShiftLeft', ['ShiftLeft', 'ShiftRight'], 'Movement'],
    ['fly', 'Fly / walk', 'KeyF', ['KeyF', null], 'Movement'],
    ['lookUp', 'Look up', 'ArrowUp', ['ArrowUp', null], 'Movement'],
    ['lookDown', 'Look down', 'ArrowDown', ['ArrowDown', null], 'Movement'],
    ['lookLeft', 'Look left', 'ArrowLeft', ['ArrowLeft', null], 'Movement'],
    ['lookRight', 'Look right', 'ArrowRight', ['ArrowRight', null], 'Movement'],
    ['grab', 'Grab / interact', 'KeyE', ['KeyE', null], 'Powers'],
    ['heat', 'Heat vision', 'KeyR', ['KeyR', null], 'Powers'],
    ['freeze', 'Freeze breath', 'KeyQ', ['KeyQ', null], 'Powers'],
    ['xray', 'X-ray vision', 'KeyX', ['KeyX', null], 'Powers'],
    ['hear', 'Super hearing', 'KeyH', ['KeyH', null], 'Powers'],
    ['clap', 'Thunder clap', 'KeyG', ['KeyG', null], 'Powers'],
    ['slow', 'Slow time', 'KeyV', ['KeyV', null], 'Powers'],
    ['pow1', 'Power level 1', 'Digit1', ['Digit1', 'Numpad1'], 'Powers'],
    ['pow2', 'Power level 2', 'Digit2', ['Digit2', 'Numpad2'], 'Powers'],
    ['pow3', 'Power level 3', 'Digit3', ['Digit3', 'Numpad3'], 'Powers'],
    ['map', 'City map', 'KeyM', ['KeyM', 'Tab'], 'Interface'],
    ['pause', 'Pause', 'KeyP', ['KeyP', null], 'Interface'],
    ['paper', 'Daily Planet', 'KeyN', ['KeyN', null], 'Interface'],
    ['mute', 'Mute', 'KeyK', ['KeyK', null], 'Interface'],
    ['fps', 'Frame-rate meter', 'Backquote', ['Backquote', 'F3'], 'Interface'],
    ['metallo', 'Metallo finale', 'F8', ['F8', null], 'Interface'],
    ['wave', 'Wave to the crowd', 'KeyT', ['KeyT', null], 'Interface']   // js/citymood.js
  ].map(a => ({ id: a[0], label: a[1], code: a[2], def: a[3], group: a[4] }));
  const ACT = {}; for (const a of ACTIONS) ACT[a.id] = a;
  const ACT_DESC = {
    boost: 'Hold to go supersonic in flight, or sprint on foot.', up: 'Climb in flight. On the ground, Space leaps.',
    grab: 'Grab or set down cars, rubble and people; talk to someone waving you down; brace the runaway bus. Mission and set-piece prompts follow this key.',
    heat: 'Hold for heat vision (right mouse button also works). Accessibility can make it a toggle.',
    freeze: 'Hold for freeze breath. Accessibility can make it a toggle.',
    hear: 'Tap to toggle super hearing, or hold to listen.', map: 'Open the city map. Click to set a waypoint.',
    fps: 'Show or hide the frame-rate meter.', metallo: 'Start, or retry, the Metallo finale.',
    wave: 'Wave to the people below. Nearby citizens cheer back (+1 Hope, at most +3 a minute).',
    pow1: 'Every power at level 1: about Mach 1.', pow2: 'Every power at level 2: about Mach 3.', pow3: 'Every power at full strength: Mach 10+.'
  };

  const defBinds = () => { const b = {}; for (const a of ACTIONS) b[a.id] = a.def.slice(); return b; };
  const DEFAULTS = {
    binds: defBinds(), invertY: false, mouseSens: 1,
    fovOffset: 0, camDist: 1, shake: 1, hitStop: true, reducedMotion: false, speedFx: 1,
    ss: 'auto', ao: 'auto', fps: false, hudScale: 1,
    master: 1, sfx: 1, radio: 1, music: 0.8,
    subScale: 1, subBg: 0.84, colorblind: false, toggleHeat: false, toggleFreeze: false, toggleCharge: false,
    qteAssist: false, reducedFlash: false
  };

  // ================================================================== state + persistence
  const S = {};
  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) { raw = null; }
    for (const k in DEFAULTS) {
      const d = DEFAULTS[k], v = raw && raw[k];
      if (k === 'binds') {
        S.binds = defBinds();
        if (v && typeof v === 'object') for (const a of ACTIONS) {
          const s = v[a.id];
          if (Array.isArray(s) && s.length === 2 && s.every(c => c === null || (typeof c === 'string' && c.length < 32))) S.binds[a.id] = s.slice();
        }
      } else S[k] = (v !== undefined && v !== null && typeof v === typeof d) ? v : d;
    }
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (_) { /* storage blocked: settings last this session */ } }
  load();

  const subs = {};
  function emit(k) {
    const list = subs[k]; if (!list) return;
    for (let i = 0; i < list.length; i++) { try { list[i](S[k], k); } catch (e) { console.warn('[settings]', k, e); } }
  }
  function commit(k) { save(); apply(k); emit(k); emit('*'); }

  // ================================================================== key routing tables
  let REV = {}, MANAGED = {};
  function rebuildRoutes() {
    const rev = {}, man = {};
    for (const a of ACTIONS) {
      man[a.code] = 1; for (const c of a.def) if (c) man[c] = 1;
      for (const c of S.binds[a.id]) if (c) rev[c] = a.code;
    }
    REV = rev; MANAGED = man;
  }
  rebuildRoutes();
  // the game code a physical key should become: a code, null (swallow: the key was moved away), undefined (not ours)
  function route(code) { const r = REV[code]; return r !== undefined ? r : MANAGED[code] ? null : undefined; }

  const KEYNAMES = {
    Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    MetaLeft: 'L Meta', MetaRight: 'R Meta', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp', CapsLock: 'Caps', Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
    NumpadEnter: 'Num Ent', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .'
  };
  function keyName(code) {
    if (!code) return '—';
    if (KEYNAMES[code]) return KEYNAMES[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(\d)$/.exec(code); if (m) return 'Num ' + m[1];
    return code;
  }
  function keyChar(code) {
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1].toLowerCase();
    m = /^(?:Digit|Numpad)(\d)$/.exec(code); if (m) return m[1];
    return code === 'Space' ? ' ' : code === 'Backquote' ? '`' : /^Shift/.test(code) ? 'Shift' : code;
  }

  // ================================================================== boot: reload-only display options travel in the URL
  (function urlInject() {
    const q = location.search, add = [];
    if (S.ss !== 'auto' && !/[?&]ss=/.test(q)) add.push('ss=' + S.ss);
    if (S.ao !== 'auto' && !/[?&]ao=/.test(q)) add.push('ao=' + S.ao);
    if (!add.length) return;
    const url = location.pathname + (q ? q + '&' : '?') + add.join('&') + location.hash;
    try { history.replaceState(history.state, '', url); } catch (_) { /* file:// may refuse: the stored value applies on the next Apply */ }
  })();

  // ================================================================== applying settings
  const G = () => window.__game;
  const root = document.documentElement;
  const CB_PIN = { call: '#b9a3ff', inc: '#f0e442', kryp: '#1fd6a6', hurt: '#f2661c', trap: '#56b4e9', hosp: '#ffffff', way: '#2f7dff', help: '#e58fc6', sp: '#e69f00' };
  const CB_BEAM = {}; // HDR beacon colours derived from CB_PIN once THREE is around
  const ORIG_PIN = {}, ORIG_BEAM = {};
  let postBase = -1;
  function setVar(n, v) { root.style.setProperty(n, v); }
  function cssVars() {
    setVar('--sm-hud', String(S.hudScale));
    setVar('--sm-sub', String(S.subScale));
    setVar('--sm-sub-a', String(S.subBg));
    setVar('--sm-bark-a', Math.round(Math.min(1, Math.max(0.7, S.subBg + 0.11)) * 100) + '%');
    const b = document.body; if (!b) return;
    b.classList.toggle('sm-cb', !!S.colorblind);
    b.classList.toggle('sm-rm', !!S.reducedMotion);
    b.classList.toggle('sm-nf', !!S.reducedFlash);
  }
  function applyPalette(g) {
    if (!g || !g.PIN_COL || !g.BEACON_COL) return;
    const P = g.PIN_COL, B = g.BEACON_COL;
    for (const k in CB_PIN) {
      if (!(k in P)) continue;
      if (S.colorblind) {
        if (P[k] !== CB_PIN[k]) { ORIG_PIN[k] = P[k]; if (B[k] && B[k].clone) ORIG_BEAM[k] = B[k].clone(); } // first time, or a module re-set it
        P[k] = CB_PIN[k];
        if (B[k] && B[k].setStyle) { if (!CB_BEAM[k]) CB_BEAM[k] = B[k].clone().setStyle(CB_PIN[k]).multiplyScalar(2.7); B[k].copy(CB_BEAM[k]); }
      } else if (k in ORIG_PIN) {
        P[k] = ORIG_PIN[k]; if (B[k] && ORIG_BEAM[k]) B[k].copy(ORIG_BEAM[k]);
        delete ORIG_PIN[k]; delete ORIG_BEAM[k];
      }
    }
  }
  function applyAudio(g) {
    const AU = g && g.AU; if (!AU || !AU.out) return;
    AU.out.gain.value = S.master; AU.sfxBus.gain.value = S.sfx; AU.musicBus.gain.value = S.music;
  }
  function applyPost() {
    const PT = window.__post; if (!PT || !PT.tuning) return;
    if (postBase < 0) postBase = PT.tuning.blurMax;
    PT.tuning.blurMax = postBase * S.speedFx; PT.enable.speed = S.speedFx > 0.001;
  }
  function apply(k) {
    const g = G();
    if (k === 'binds') { rebuildRoutes(); updateChips(); return; }
    if (k === 'hudScale' || k === 'subScale' || k === 'subBg' || k === 'colorblind' || k === 'reducedMotion' || k === 'reducedFlash') cssVars();
    if (k === 'toggleHeat' || k === 'toggleFreeze' || k === 'toggleCharge') releaseLatches();
    if (!g) return;
    const C = g.camState;
    if (C) { C.invY = !!S.invertY; C.sens = S.mouseSens; C.fovOff = S.fovOffset; C.distK = S.camDist; C.speedFx = S.speedFx; }
    if (k === 'speedFx' || k === '*') applyPost();
    if (g.FX) g.FX.flashK = S.reducedFlash ? 0.2 : 1;
    if (k === 'fps' || k === '*') { const f = document.getElementById('fps'); if (f && f.hidden === !!S.fps) f.hidden = !S.fps; }
    if (k === 'colorblind' || k === '*') applyPalette(g);
    applyAudio(g);
  }
  function applyAll() { cssVars(); apply('*'); updateChips(); }

  // ================================================================== audio buses (after the game's first sound)
  let wiredCtx = null;
  function wireAudio(g) {
    const AU = g.AU; if (!AU || !AU.ctx || AU.ctx === wiredCtx || !AU.comp || !AU.duckG || !AU.hearBus) return;
    wiredCtx = AU.ctx;
    try {
      const c = AU.ctx;
      AU.out = c.createGain(); AU.out.connect(c.destination);
      AU.comp.disconnect(); AU.comp.connect(AU.out);
      AU.sfxBus = c.createGain(); AU.sfxBus.connect(AU.comp);
      AU.duckG.disconnect(); AU.duckG.connect(AU.sfxBus);
      AU.hearBus.disconnect(); AU.hearBus.connect(AU.sfxBus);
      AU.musicBus = c.createGain(); AU.musicBus.connect(AU.out);
      applyAudio(g); emit('music');
    } catch (e) { console.warn('[settings] audio wiring', e); }
  }

  // ================================================================== HUD power chips follow the bindings
  const CHIP_ACT = { boost: 'boost', grab: 'grab', freeze: 'freeze', xray: 'xray', hear: 'hear', clap: 'clap', slow: 'slow', fly: 'fly' };
  function updateChips() {
    const box = document.getElementById('powers'); if (!box) return;
    for (const p in CHIP_ACT) {
      const kbd = box.querySelector('.chip[data-p="' + p + '"] kbd'); if (!kbd) continue;
      const b = S.binds[CHIP_ACT[p]], t = keyName(b[0] || b[1]).replace(/^L /, '');
      if (kbd.textContent !== t) kbd.textContent = t;
    }
  }

  // ================================================================== hold-to-toggle latches
  const latch = { KeyR: false, KeyQ: false }, mlatch = { heat: false, charge: false };
  const toggleOf = code => (code === 'KeyR' && S.toggleHeat) || (code === 'KeyQ' && S.toggleFreeze);
  function fireKey(type, code, src) {
    const ev = new KeyboardEvent(type, { code, key: keyChar(code), bubbles: true, cancelable: true, repeat: !!(src && src.repeat),
      shiftKey: !!(src && src.shiftKey), ctrlKey: !!(src && src.ctrlKey), altKey: !!(src && src.altKey), metaKey: !!(src && src.metaKey) });
    ev.__sm = true;
    const t = (src && src.target && src.target.dispatchEvent) ? src.target : window;
    t.dispatchEvent(ev);
    return ev;
  }
  function fireMouse(type, button) { const ev = new MouseEvent(type, { button, bubbles: true, cancelable: true }); ev.__sm = true; window.dispatchEvent(ev); }
  function releaseLatches() {
    for (const c in latch) if (latch[c] && !toggleOf(c)) { latch[c] = false; fireKey('keyup', c, null); }
    if (mlatch.heat && !S.toggleHeat) { mlatch.heat = false; fireMouse('mouseup', 2); }
    if (mlatch.charge && !S.toggleCharge) { mlatch.charge = false; fireMouse('mouseup', 0); }
  }

  // ================================================================== keyboard: capture-phase translation layer
  const heldMap = {};        // physical code -> the code it went down as (so a remap mid-hold still releases cleanly)
  function onKeyEvent(e) {
    if (e.__sm) return;                              // our own re-dispatch
    if (UI.open) { uiKey(e); return; }
    const g = G();
    if (!g || !g.started) { titleKey(e); return; }
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const down = e.type === 'keydown', phys = e.code;
    let to;
    if (down) { to = route(phys); if (!e.repeat) heldMap[phys] = to; }
    else if (phys in heldMap) { to = heldMap[phys]; delete heldMap[phys]; }
    else to = route(phys);
    if (to === undefined) return;
    if (to && toggleOf(to)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (down && !e.repeat) { const on = !latch[to]; latch[to] = on; fireKey(on ? 'keydown' : 'keyup', to, e); }
      return;
    }
    if (to === phys) return;                         // identity: the game reads the original event
    e.preventDefault(); e.stopImmediatePropagation();
    if (to) fireKey(e.type, to, e);
  }
  addEventListener('keydown', onKeyEvent, true);
  addEventListener('keyup', onKeyEvent, true);

  // mouse: hold-to-toggle for heat (right button) and the charge punch (left button)
  function onMouseEvent(e) {
    if (e.__sm || UI.open) return;
    const g = G(); if (!g || !g.started || g.paused || (g.MAP && g.MAP.open)) return;
    const which = e.button === 2 && S.toggleHeat ? 'heat' : e.button === 0 && S.toggleCharge ? 'charge' : null;
    if (!which) return;
    if (e.type === 'mousedown') {
      if (mlatch[which]) { e.preventDefault(); e.stopImmediatePropagation(); mlatch[which] = false; fireMouse('mouseup', e.button); }
      else if (e.target === document.getElementById('c')) mlatch[which] = true;
    } else if (mlatch[which]) e.stopImmediatePropagation();
  }
  addEventListener('mousedown', onMouseEvent, true);
  addEventListener('mouseup', onMouseEvent, true);
  addEventListener('blur', () => { mlatch.heat = mlatch.charge = false; latch.KeyR = latch.KeyQ = false; for (const k in heldMap) delete heldMap[k]; });

  // title menu: arrow keys walk the buttons; Enter on a menu button other than Start activates that button
  // (game.js would otherwise read Enter as "start")
  function menuButtons() { const m = document.getElementById('menu'); return m && !m.hidden ? Array.from(m.querySelectorAll('button')).filter(b => !b.hidden) : []; }
  function moveMenu(d) {
    const bs = menuButtons(); if (!bs.length) return;
    const i = bs.indexOf(document.activeElement);
    bs[i < 0 ? 0 : (i + d + bs.length) % bs.length].focus({ preventScroll: true });
  }
  function titleKey(e) {
    if (e.type !== 'keydown') return;
    const bs = menuButtons(); if (!bs.length) return;
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); moveMenu(e.code === 'ArrowDown' ? 1 : -1); return; }
    const a = document.activeElement;
    if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && a && a.id !== 'go' && bs.includes(a)) e.stopImmediatePropagation();
  }

  // ================================================================== the menu (rows per tab)
  const pct = v => Math.round(v * 100) + '%';
  const TABS = [
    { id: 'controls', label: 'Controls', rows: () => {
      const r = [{ t: 'head', label: 'Look' },
        { t: 'toggle', k: 'invertY', label: 'Invert Y axis', desc: 'Mouse forward looks down, as in a flight sim. Also applies to the right stick.' },
        { t: 'slider', k: 'mouseSens', label: 'Mouse sensitivity', min: 0.25, max: 3, step: 0.05, fmt: v => v.toFixed(2) + '×', desc: 'How far the camera turns per inch of mouse travel.' }];
      let grp = '';
      for (const a of ACTIONS) {
        if (a.group !== grp) { grp = a.group; r.push({ t: 'head', label: grp }); }
        r.push({ t: 'bind', a: a.id, label: a.label, desc: ACT_DESC[a.id] || '' });
      }
      r.push({ t: 'button', label: 'Reset controls to default', act: () => resetTab('controls'), desc: 'Every key back to its default, plus invert Y and sensitivity.' });
      return r;
    } },
    { id: 'camera', label: 'Camera', rows: () => [
      { t: 'slider', k: 'fovOffset', label: 'Field of view', min: -10, max: 20, step: 1, fmt: v => (v > 0 ? '+' : '') + v + '°', desc: 'Added to the dynamic field of view, which still widens with speed. Wider shows more city; narrower frames him larger.' },
      { t: 'slider', k: 'camDist', label: 'Camera distance', min: 0.7, max: 1.6, step: 0.05, fmt: v => v.toFixed(2) + '×', desc: 'How far the chase camera sits behind him, in every mode.' },
      { t: 'slider', k: 'shake', label: 'Screen shake', min: 0, max: 1, step: 0.05, fmt: pct, desc: 'Impacts, booms and landings shake the camera. 0% removes it entirely.' },
      { t: 'toggle', k: 'hitStop', label: 'Hit-stop', desc: 'The world freezes for a few frames when a punch lands. Off keeps the action continuous.' },
      { t: 'toggle', k: 'reducedMotion', label: 'Reduced motion', desc: 'Halves hit-stop and stills interface animations such as sliding cards and bubbles.' },
      { t: 'slider', k: 'speedFx', label: 'Speed effects', min: 0, max: 1, step: 0.05, fmt: pct, desc: 'Motion blur and speed lines at high speed. 0% turns both off.' },
      { t: 'button', label: 'Reset camera to default', act: () => resetTab('camera') }
    ] },
    { id: 'display', label: 'Display', rows: () => [
      { t: 'choice', k: 'quality', label: 'Quality preset', reload: true, opts: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
        get: () => pendingQ || curQuality(), set: v => { pendingQ = v; }, desc: 'Draw distance, shadows, reflections and destruction budgets. Applies on reload.' },
      { t: 'choice', k: 'ss', label: 'Supersampling', reload: true, opts: [['auto', 'Auto'], ['1', 'Off (1×)'], ['1.25', '1.25×'], ['1.5', '1.5×'], ['2', '2×']], desc: 'Renders above native resolution for cleaner edges (Ultra only). Auto picks 1.5× on strong GPUs. Applies on reload.' },
      { t: 'choice', k: 'ao', label: 'Ambient occlusion', reload: true, opts: [['auto', 'Auto'], ['0', 'Off'], ['1', 'On']], desc: 'Contact shadow where walls meet the street. Auto turns it on at Ultra. Applies on reload.' },
      { t: 'toggle', k: 'fps', label: 'FPS meter', desc: 'Frame rate, frame time and draw calls at the top of the screen (also ` or F3 in game).' },
      { t: 'slider', k: 'hudScale', label: 'HUD scale', min: 0.75, max: 1.5, step: 0.05, fmt: pct, desc: 'Size of the speed, city, solar and power panels and the minimap.' },
      { t: 'button', label: 'Apply and reload', act: () => applyReload(), reloadBtn: true, desc: 'Restarts the game with the new quality, supersampling and occlusion settings. Your city progress is not kept.' },
      { t: 'button', label: 'Reset display to default', act: () => resetTab('display') }
    ] },
    { id: 'audio', label: 'Audio', rows: () => [
      { t: 'slider', k: 'master', label: 'Master volume', min: 0, max: 1, step: 0.05, fmt: pct, desc: 'Everything: effects, radio and music. K still mutes in game.' },
      { t: 'slider', k: 'sfx', label: 'Effects', min: 0, max: 1, step: 0.05, fmt: pct, desc: 'The city, his powers, impacts and super hearing.' },
      { t: 'slider', k: 'radio', label: 'Radio', min: 0, max: 1, step: 0.05, fmt: pct, desc: 'Calls from Lois, Jimmy, Perry and police dispatch.' },
      { t: 'slider', k: 'music', label: 'Music', min: 0, max: 1, step: 0.05, fmt: pct, desc: 'The score.' },
      { t: 'button', label: 'Reset audio to default', act: () => resetTab('audio') }
    ] },
    { id: 'access', label: 'Accessibility', rows: () => [
      { t: 'head', label: 'Subtitles' },
      { t: 'slider', k: 'subScale', label: 'Subtitle size', min: 0.8, max: 1.8, step: 0.1, fmt: pct, desc: 'Radio subtitles, mission cards and the speech bubbles over people in the street.', preview: 'sub' },
      { t: 'slider', k: 'subBg', label: 'Subtitle background', min: 0.4, max: 1, step: 0.05, fmt: pct, desc: 'Opacity of the panel behind subtitles. Speech bubbles never drop below 70% so their text stays readable.', preview: 'sub' },
      { t: 'head', label: 'Vision' },
      { t: 'toggle', k: 'colorblind', label: 'Colour-blind palette', desc: 'Map pins, minimap arrows and light beams use the Okabe–Ito palette, safe for protanopia, deuteranopia and tritanopia.', preview: 'palette' },
      { t: 'toggle', k: 'reducedFlash', label: 'Reduced flashing', desc: 'Damps camera and muzzle flashes, the hit flash at the screen edge and explosion lights, and stops strobing HUD lights.' },
      { t: 'head', label: 'Input' },
      { t: 'toggle', k: 'toggleHeat', label: 'Heat vision: toggle', desc: 'Press once to start heat vision and again to stop, instead of holding (key and right mouse button).' },
      { t: 'toggle', k: 'toggleFreeze', label: 'Freeze breath: toggle', desc: 'Press once to start freeze breath and again to stop, instead of holding.' },
      { t: 'toggle', k: 'toggleCharge', label: 'Charge punch: toggle', desc: 'Click to start charging a punch and click again to release it, instead of holding the button.' },
      { t: 'toggle', k: 'qteAssist', label: 'QTE assist', desc: 'Timing prompts close 60% slower, so their windows last longer, and a burning airliner wing holds 60% longer.' },
      { t: 'button', label: 'Reset accessibility to default', act: () => resetTab('access') }
    ] }
  ];
  const TAB_KEYS = {
    controls: ['binds', 'invertY', 'mouseSens'], camera: ['fovOffset', 'camDist', 'shake', 'hitStop', 'reducedMotion', 'speedFx'],
    display: ['ss', 'ao', 'fps', 'hudScale'], audio: ['master', 'sfx', 'radio', 'music'],
    access: ['subScale', 'subBg', 'colorblind', 'toggleHeat', 'toggleFreeze', 'toggleCharge', 'qteAssist', 'reducedFlash']
  };

  let pendingQ = null;
  function curQuality() { const g = G(); const q = g && g.quality; return q === 'shot' || !q ? 'high' : q; }
  function reloadDirty() {
    const q = location.search;
    const urlSS = (q.match(/[?&]ss=([\d.]+)/) || [])[1] || 'auto', urlAO = (q.match(/[?&]ao=(\d)/) || [])[1] || 'auto';
    return (pendingQ && pendingQ !== curQuality()) || S.ss !== urlSS || S.ao !== urlAO;
  }
  function applyReload() {
    const q = pendingQ || curQuality();
    try { localStorage.setItem('sm-quality', q); } catch (_) { /* the URL carries it */ }
    const parts = location.search.replace(/^\?/, '').split('&').filter(p => p && !/^(q|ss|ao|bench)(=|$)/.test(p));
    parts.push('q=' + q); if (S.ss !== 'auto') parts.push('ss=' + S.ss); if (S.ao !== 'auto') parts.push('ao=' + S.ao);
    location.href = location.href.split(/[?#]/)[0] + '?' + parts.join('&');
  }
  function resetTab(id) {
    for (const k of TAB_KEYS[id]) S[k] = k === 'binds' ? defBinds() : DEFAULTS[k];
    if (id === 'display') pendingQ = null;
    save(); for (const k of TAB_KEYS[id]) { apply(k); emit(k); } emit('*');
    refresh(); note('Defaults restored');
  }

  // ================================================================== DOM
  const UI = { open: false, el: null, tab: 0, rows: [], rowEls: [], fi: 0, slot: 0, capture: null, from: null, prevFocus: null };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function build() {
    if (UI.el) return;
    const el = document.createElement('div');
    el.id = 'sm-settings'; el.className = 'sms'; el.hidden = true;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Settings');
    el.innerHTML =
      '<div class="sms-top">' +
        '<div class="sms-brand"><svg viewBox="0 0 128 112" aria-hidden="true"><path d="M18 6 L110 6 L124 34 L64 106 L4 34 Z" fill="#c8211b"/><path d="M24 14 L104 14 L114 34 L64 94 L14 34 Z" fill="#f2c12e"/><text x="64" y="66" text-anchor="middle" font-family="Georgia, serif" font-weight="900" font-size="58" fill="#c8211b">S</text></svg>' +
          '<div><p class="sms-kick">Superman &middot; Over Metropolis</p><h2>Settings</h2></div></div>' +
        '<nav class="sms-tabs" role="tablist"><span class="sms-cap" aria-hidden="true">Q<i>LB</i></span>' +
          TABS.map((t, i) => '<button type="button" role="tab" class="sms-tab" data-tab="' + i + '">' + t.label + '</button>').join('') +
        '<span class="sms-cap" aria-hidden="true">E<i>RB</i></span></nav>' +
      '</div>' +
      '<div class="sms-main"><div class="sms-list" role="listbox"></div>' +
        '<aside class="sms-info" aria-live="polite"><p class="sms-kick sms-info-tab"></p><h3 class="sms-info-h"></h3><p class="sms-info-d"></p><div class="sms-info-x"></div><p class="sms-note"></p></aside></div>' +
      '<div class="sms-foot">' +
        '<span><kbd>↑↓</kbd>Select</span><span><kbd>←→</kbd>Adjust</span><span><kbd>Enter</kbd><kbd>A</kbd>Change</span>' +
        '<span><kbd>Bksp</kbd><kbd>X</kbd>Default</span><span><kbd>Del</kbd>Clear key</span>' +
        '<button type="button" class="sms-back"><kbd>Esc</kbd><kbd>B</kbd>Back</button></div>' +
      '<div class="sms-capture" hidden><div class="sms-capcard"><p class="sms-kick">Rebind</p><h3></h3><p class="sms-capt">Press a key</p><p class="sms-capd">Esc cancels. A key already in use swaps places.</p></div></div>';
    document.body.appendChild(el);
    UI.el = el; UI.list = el.querySelector('.sms-list'); UI.tabs = Array.from(el.querySelectorAll('.sms-tab'));
    UI.infoTab = el.querySelector('.sms-info-tab'); UI.infoH = el.querySelector('.sms-info-h'); UI.infoD = el.querySelector('.sms-info-d');
    UI.infoX = el.querySelector('.sms-info-x'); UI.note = el.querySelector('.sms-note');
    UI.cap = el.querySelector('.sms-capture'); UI.capH = UI.cap.querySelector('h3');
    // pointer: tabs, rows, arrows, slider drag, key cells
    el.addEventListener('click', e => e.stopPropagation());
    el.addEventListener('mousedown', e => e.stopPropagation());
    el.querySelector('.sms-back').addEventListener('click', () => back());
    UI.tabs.forEach((b, i) => b.addEventListener('click', () => setTab(i)));
    UI.list.addEventListener('mousemove', e => { const r = e.target.closest('.sms-row'); if (r && !UI.drag) { const i = +r.dataset.i; if (i !== UI.fi && UI.rows[i].t !== 'head') focusRow(i, false); } });
    UI.list.addEventListener('click', e => {
      const r = e.target.closest('.sms-row'); if (!r) return; const i = +r.dataset.i, row = UI.rows[i]; if (row.t === 'head') return;
      focusRow(i, false);
      const arr = e.target.closest('.sms-arr'), key = e.target.closest('.sms-key');
      if (arr) adjust(+arr.dataset.d);
      else if (key) { UI.slot = +key.dataset.s; renderRow(i); activate(); }
      else if (row.t !== 'slider') activate();
    });
    UI.list.addEventListener('pointerdown', e => {
      const sl = e.target.closest('.sms-slider'); if (!sl) return;
      const i = +sl.closest('.sms-row').dataset.i; focusRow(i, false); UI.drag = sl;
      const move = ev => { const b = sl.getBoundingClientRect(), row = UI.rows[i]; const u = Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width)); setVal(row, row.min + u * (row.max - row.min)); };
      move(e);
      const up = () => { UI.drag = null; removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    UI.capture = null;
  }
  function rowHTML(row, i) {
    if (row.t === 'head') return '<div class="sms-row sms-head" data-i="' + i + '"><span>' + esc(row.label) + '</span></div>';
    let ctl = '';
    if (row.t === 'slider') ctl = '<div class="sms-slider"><i></i><u></u></div><b class="sms-val"></b>';
    else if (row.t === 'toggle' || row.t === 'choice') ctl = '<span class="sms-arr" data-d="-1">‹</span><b class="sms-val"></b><span class="sms-arr" data-d="1">›</span>';
    else if (row.t === 'bind') ctl = '<kbd class="sms-key" data-s="0"></kbd><kbd class="sms-key" data-s="1"></kbd>';
    else if (row.t === 'button') ctl = '<span class="sms-go">›</span>';
    return '<div class="sms-row sms-' + row.t + (row.reload ? ' sms-reload' : '') + '" role="option" data-i="' + i + '"><span class="sms-lbl">' + esc(row.label) +
      (row.reload ? '<em>reload</em>' : '') + '</span><span class="sms-ctl">' + ctl + '</span></div>';
  }
  const valOf = row => (row.get ? row.get() : S[row.k]);
  function renderRow(i) {
    const row = UI.rows[i], el = UI.rowEls[i]; if (!el || row.t === 'head') return;
    if (row.t === 'slider') {
      const v = valOf(row), u = (v - row.min) / (row.max - row.min);
      el.querySelector('.sms-slider i').style.width = (u * 100).toFixed(1) + '%';
      el.querySelector('.sms-slider u').style.left = (u * 100).toFixed(1) + '%';
      el.querySelector('.sms-val').textContent = row.fmt(v);
    } else if (row.t === 'toggle') {
      const v = !!valOf(row); el.querySelector('.sms-val').textContent = v ? 'On' : 'Off'; el.classList.toggle('on', v);
    } else if (row.t === 'choice') {
      const v = String(valOf(row)), o = row.opts.find(p => p[0] === v); el.querySelector('.sms-val').textContent = o ? o[1] : v;
    } else if (row.t === 'bind') {
      const b = S.binds[row.a], ks = el.querySelectorAll('.sms-key');
      for (let s = 0; s < 2; s++) {
        ks[s].textContent = keyName(b[s]); ks[s].classList.toggle('empty', !b[s]);
        ks[s].classList.toggle('sel', i === UI.fi && s === UI.slot);
        ks[s].classList.toggle('changed', b[s] !== ACT[row.a].def[s]);
      }
    } else if (row.reloadBtn) el.classList.toggle('dim', !reloadDirty());
  }
  function setTab(i) {
    UI.tab = (i + TABS.length) % TABS.length;
    UI.tabs.forEach((b, j) => { b.classList.toggle('on', j === UI.tab); b.setAttribute('aria-selected', j === UI.tab ? 'true' : 'false'); });
    UI.rows = TABS[UI.tab].rows();
    UI.list.innerHTML = UI.rows.map(rowHTML).join('');
    UI.rowEls = Array.from(UI.list.children);
    UI.slot = 0; UI.list.scrollTop = 0;
    UI.infoTab.textContent = TABS[UI.tab].label;
    for (let k = 0; k < UI.rows.length; k++) renderRow(k);
    focusRow(nextRow(-1, 1), true);
    note('');
  }
  function refresh() { for (let k = 0; k < UI.rows.length; k++) renderRow(k); info(); }
  function nextRow(i, d) { let j = i; for (let n = 0; n < UI.rows.length; n++) { j += d; if (j < 0 || j >= UI.rows.length) return i < 0 ? 0 : i; if (UI.rows[j].t !== 'head') return j; } return i; }
  function focusRow(i, scroll) {
    const prev = UI.fi; UI.fi = i;
    if (UI.rowEls[prev]) { UI.rowEls[prev].classList.remove('focus'); UI.rowEls[prev].removeAttribute('aria-selected'); renderRow(prev); }
    const el = UI.rowEls[i]; if (!el) return;
    el.classList.add('focus'); el.setAttribute('aria-selected', 'true'); renderRow(i);
    if (scroll !== false) {
      const L = UI.list, top = el.offsetTop - L.offsetTop, h = el.offsetHeight;
      if (top < L.scrollTop + 8) L.scrollTop = Math.max(0, top - 40); else if (top + h > L.scrollTop + L.clientHeight - 8) L.scrollTop = top + h - L.clientHeight + 40;
    }
    info();
  }
  function info() {
    const row = UI.rows[UI.fi]; if (!row) return;
    UI.infoH.textContent = row.label;
    let d = row.desc || '';
    if (row.t === 'bind') {
      const a = ACT[row.a];
      d = (d ? d + ' ' : '') + 'Default: ' + a.def.filter(Boolean).map(keyName).join(' / ') + '.';
    }
    UI.infoD.textContent = d;
    let x = '';
    if (row.preview === 'palette') {
      const pins = [['inc', 'Emergency'], ['kryp', 'Kryptonite'], ['hurt', 'Injured'], ['trap', 'Trapped'], ['hosp', 'Hospital'], ['way', 'Waypoint']];
      const g = G(), live = g && g.PIN_COL;
      x = '<ul class="sms-swatch">' + pins.map(p => '<li><i style="background:' + (S.colorblind ? CB_PIN[p[0]] : ((live && (ORIG_PIN[p[0]] || live[p[0]])) || '#888')) + '"></i>' + p[1] + '</li>').join('') + '</ul>';
    } else if (row.preview === 'sub') {
      x = '<div class="sms-subprev"><div class="bark on plead">Help! Up here!</div><div class="sms-subcard"><b>LOIS LANE</b><span>The stairwell is gone. They can only come down the outside.</span></div></div>';
    } else if (row.t === 'bind') {
      x = '<p class="sms-hint">Enter or click a key cell to change it. ← → pick the main or alternate slot.</p>';
    } else if (row.reload) x = '<p class="sms-hint">Saved now; takes effect after <b>Apply and reload</b>.</p>';
    UI.infoX.innerHTML = x;
  }
  function note(t) { if (UI.note) UI.note.textContent = t; }

  // ================================================================== editing
  function setVal(row, v) {
    if (row.t === 'slider') { v = Math.round(v / row.step) * row.step; v = Math.min(row.max, Math.max(row.min, +v.toFixed(4))); }
    if (row.set) row.set(v); else API.set(row.k, v);
    renderRow(UI.fi); if (row.preview) info();
    const rb = UI.rows.findIndex(r => r.reloadBtn); if (rb >= 0) renderRow(rb);
  }
  function adjust(d) {
    const row = UI.rows[UI.fi]; if (!row) return;
    if (row.t === 'slider') setVal(row, valOf(row) + d * row.step);
    else if (row.t === 'toggle') setVal(row, !valOf(row));
    else if (row.t === 'choice') { const i = row.opts.findIndex(o => o[0] === String(valOf(row))); setVal(row, row.opts[(i + d + row.opts.length) % row.opts.length][0]); }
    else if (row.t === 'bind') { UI.slot = d < 0 ? 0 : 1; renderRow(UI.fi); }
  }
  function activate() {
    const row = UI.rows[UI.fi]; if (!row) return;
    if (row.t === 'toggle' || row.t === 'choice') adjust(1);
    else if (row.t === 'button') { if (!row.reloadBtn || reloadDirty()) row.act(); else note('Nothing to apply yet'); }
    else if (row.t === 'bind') { UI.capture = { a: row.a, s: UI.slot }; UI.capH.textContent = ACT[row.a].label + (UI.slot ? ' (alternate)' : ''); UI.cap.hidden = false; }
  }
  function resetRow() {
    const row = UI.rows[UI.fi]; if (!row) return;
    if (row.t === 'bind') { const d = ACT[row.a].def[UI.slot]; bind(row.a, UI.slot, d); }
    else if (row.k === 'quality') pendingQ = null;
    else if (row.k) API.set(row.k, DEFAULTS[row.k]);
    refresh();
  }
  function bind(action, slot, code) {
    const B = S.binds; if (!B[action]) return false;
    const prev = B[action][slot]; let moved = null;
    if (code) for (const a of ACTIONS) for (let s = 0; s < 2; s++) {
      if (B[a.id][s] === code && !(a.id === action && s === slot)) { B[a.id][s] = prev; moved = a; }
    }
    B[action][slot] = code || null;
    commit('binds');
    if (UI.open) { refresh(); note(moved && moved.id !== action ? keyName(code) + ' was on ' + moved.label + (prev ? ', which now uses ' + keyName(prev) : ', which is now unbound') : ''); }
    return true;
  }

  // ================================================================== open / close / input while open
  const padNow = () => performance.now();
  function open(tab) {
    build();
    const g = G();
    UI.from = g && g.started ? 'pause' : 'title';
    UI.prevFocus = document.activeElement;
    UI.open = true; UI.el.hidden = false;
    if (document.pointerLockElement) try { document.exitPointerLock(); } catch (_) { /* ignore */ }
    let ti = UI.tab; if (typeof tab === 'string') { const k = TABS.findIndex(t => t.id === tab); if (k >= 0) ti = k; } else if (typeof tab === 'number') ti = tab;
    setTab(ti);
    UI.el.classList.remove('in'); void UI.el.offsetWidth; UI.el.classList.add('in');
  }
  function close() {
    if (!UI.open) return;
    UI.open = false; UI.capture = null; if (UI.cap) UI.cap.hidden = true; UI.el.hidden = true;
    const t = UI.from === 'pause' ? document.getElementById('pause-settings') : document.getElementById('btn-settings');
    const f = (t && t.offsetParent) ? t : UI.prevFocus;
    if (f && f.focus) try { f.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
  }
  function back() { if (UI.capture) { UI.capture = null; UI.cap.hidden = true; return; } close(); }
  const PASS = { F5: 1, F11: 1, F12: 1 };
  function uiKey(e) {
    e.stopImmediatePropagation();
    if (!PASS[e.code]) e.preventDefault();
    if (e.type !== 'keydown') return;
    const c = e.code;
    if (UI.capture) {
      if (e.repeat) return;
      if (c === 'Escape') { back(); return; }
      if (PASS[c] || !c) return;
      const cap = UI.capture; UI.capture = null; UI.cap.hidden = true; bind(cap.a, cap.s, c); return;
    }
    if (c === 'Escape') { back(); return; }
    if (c === 'ArrowUp' || c === 'KeyW') focusRow(nextRow(UI.fi, -1));
    else if (c === 'ArrowDown' || c === 'KeyS') focusRow(nextRow(UI.fi, 1));
    else if (c === 'ArrowLeft' || c === 'KeyA') adjust(-1);
    else if (c === 'ArrowRight' || c === 'KeyD') adjust(1);
    else if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') activate();
    else if (c === 'KeyE' || c === 'PageDown' || (c === 'Tab' && !e.shiftKey)) setTab(UI.tab + 1);
    else if (c === 'KeyQ' || c === 'PageUp' || (c === 'Tab' && e.shiftKey)) setTab(UI.tab - 1);
    else if (c === 'Home') focusRow(nextRow(-1, 1));
    else if (c === 'End') focusRow(nextRow(UI.rows.length, -1));
    else if (c === 'Backspace') resetRow();
    else if (c === 'Delete') { const row = UI.rows[UI.fi]; if (row && row.t === 'bind') bind(row.a, UI.slot, null); }
  }

  // entry points: the title menu button and a button on the pause front page
  function hookButtons() {
    const b = document.getElementById('btn-settings');
    if (b && !b.__sm) { b.__sm = true; b.addEventListener('click', e => { e.stopPropagation(); open(); }); }
    const pz = document.getElementById('paused');
    if (pz && !document.getElementById('pause-settings')) {
      const bar = document.createElement('div'); bar.className = 'sms-pausebar';
      bar.innerHTML = '<button type="button" id="pause-settings">Settings</button><span><kbd>Enter</kbd> or <kbd>Y</kbd></span>';
      pz.appendChild(bar);
      bar.addEventListener('click', e => e.stopPropagation());
      bar.querySelector('button').addEventListener('click', e => { e.stopPropagation(); open(); });
      // focus it whenever the front page opens, so Enter (or Space) goes straight to settings
      new MutationObserver(() => { if (!pz.hidden && !UI.open) { const pb = document.getElementById('pause-settings'); if (pb) try { pb.focus({ preventScroll: true }); } catch (_) { /* ignore */ } } })
        .observe(pz, { attributes: true, attributeFilter: ['hidden'] });
    }
  }
  hookButtons();

  // ================================================================== gamepad (menus only; game.js reads the pad in play)
  let padSeen = false;
  addEventListener('gamepadconnected', () => { padSeen = true; });
  const pprev = new Uint8Array(20);
  const rep = { y: 0, x: 0, ty: 0, tx: 0 };
  function padOwned() { const g = G(); return UI.open || !!(g && !g.started && g.titleReady); }
  function repeatDir(axis, d, now) {
    if (d === 0) { rep[axis] = 0; return 0; }
    const tk = axis === 'y' ? 'ty' : 'tx';
    if (rep[axis] !== d) { rep[axis] = d; rep[tk] = now + 380; return d; }
    if (now >= rep[tk]) { rep[tk] = now + (axis === 'x' ? 70 : 110); return d; }
    return 0;
  }
  let padProbe = 0;
  function pollPad(now) {
    if (!navigator.getGamepads) return;
    if (!padSeen) { if (now < padProbe) return; padProbe = now + 1000; } // a pad plugged in before load: probe once a second
    const list = navigator.getGamepads(); let gp = null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].connected) { gp = list[i]; break; }
    if (!gp) return;
    padSeen = true;
    const n = Math.min(20, gp.buttons.length);
    let edges = 0; // bit mask of fresh presses for the buttons we read
    for (let i = 0; i < n; i++) { const p = gp.buttons[i] && gp.buttons[i].pressed ? 1 : 0; if (p && !pprev[i]) edges |= 1 << i; pprev[i] = p; }
    const ly = gp.axes[1] || 0, lx = gp.axes[0] || 0;
    const dy = (pprev[12] || ly < -0.55) ? -1 : (pprev[13] || ly > 0.55) ? 1 : 0;
    const dx = (pprev[14] || lx < -0.55) ? -1 : (pprev[15] || lx > 0.55) ? 1 : 0;
    const E = i => (edges >> i) & 1;
    const g = G();
    if (UI.open) {
      if (UI.capture) { if (E(1)) back(); return; }
      const my = repeatDir('y', dy, now), mx = repeatDir('x', dx, now);
      if (my) focusRow(nextRow(UI.fi, my));
      if (mx) adjust(mx);
      if (E(0)) activate();
      if (E(1) || E(9)) back();
      if (E(4)) setTab(UI.tab - 1);
      if (E(5)) setTab(UI.tab + 1);
      if (E(2)) resetRow();
      return;
    }
    if (!g) return;
    if (!g.started && g.titleReady) {
      const cp = document.getElementById('controls-panel');
      if (cp && !cp.hidden) { if (E(1) || E(0)) cp.hidden = true; return; }
      const my = repeatDir('y', dy, now); if (my) moveMenu(my);
      if (E(3)) { open(); return; }
      if (E(0)) { const a = document.activeElement, bs = menuButtons(); (bs.includes(a) ? a : document.getElementById('go')).click(); }
      else if (E(9)) { const go = document.getElementById('go'); if (go) go.click(); }
      return;
    }
    if (g.started && g.paused && E(3)) open();
  }

  // ================================================================== frame loop (cheap: compares only)
  let ready = false;
  function tick() {
    requestAnimationFrame(tick);
    const g = G();
    if (g && !ready) { ready = true; hookButtons(); applyAll(); }
    if (!g) return;
    wireAudio(g);
    if (S.colorblind && g.PIN_COL && (g.PIN_COL.inc !== CB_PIN.inc || (g.PIN_COL.sp && g.PIN_COL.sp !== CB_PIN.sp) || (g.PIN_COL.help && g.PIN_COL.help !== CB_PIN.help))) applyPalette(g);
    if (latch.KeyR && !g.keys.has('KeyR')) latch.KeyR = false;
    if (latch.KeyQ && !g.keys.has('KeyQ')) latch.KeyQ = false;
    pollPad(padNow());
  }
  if (document.body) cssVars(); else addEventListener('DOMContentLoaded', cssVars);
  requestAnimationFrame(tick);

  // ================================================================== API
  const API = {
    get(k) { return k === 'quality' ? (pendingQ || curQuality()) : S[k]; },
    set(k, v) {
      if (k === 'quality') { pendingQ = v; return; }
      if (!(k in DEFAULTS)) return;
      if (k === 'shake' && typeof v === 'number' && v > 1.5) v = v / 100;
      if (k === 'binds') { const b = defBinds(); for (const a of ACTIONS) if (v && Array.isArray(v[a.id])) b[a.id] = v[a.id].slice(0, 2); S.binds = b; commit('binds'); if (UI.open) refresh(); return; }
      if (typeof v !== typeof DEFAULTS[k]) return;
      if (S[k] === v) return;
      S[k] = v; commit(k);
      if (UI.open) refresh();
    },
    on(k, fn) { (subs[k] || (subs[k] = [])).push(fn); return () => { const l = subs[k], i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; },
    vol(bus) { const m = S.master; return bus === 'master' ? m : m * (S[bus] === undefined ? 1 : S[bus]); },
    bind, route, keyLabel: id => { const b = S.binds[id]; return b ? keyName(b[0] || b[1]) : ''; }, keyName,
    open, close, get isOpen() { return UI.open; }, padOwned,
    reset(tab) { if (tab && TAB_KEYS[tab]) resetTab(tab); else { for (const t in TAB_KEYS) resetTab(t); } },
    applyReload, get reloadPending() { return !!reloadDirty(); },
    DEFAULTS, ACTIONS, TABS: TABS.map(t => t.id), get tab() { return TABS[UI.tab].id; },
    _latch: latch, _mlatch: mlatch
  };
  window.SM_SETTINGS = API;
})();
