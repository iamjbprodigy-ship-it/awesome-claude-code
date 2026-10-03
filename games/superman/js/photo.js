/* Photo mode and the living front page (js/photo.js). Dream-features #16 and #17.
 *
 * PHOTO MODE (O in play or on the pause page; D-pad right in play, X on the pause page with a gamepad)
 *   The sim freezes exactly like the city map (game.js skips update() while __game.freeze.on), the HUD hides and
 *   a free camera takes the lens (__game.camState.hold, so feel.js and updateCamera give it up):
 *     WASD move, Space / C up and down, mouse look (click the view to capture the mouse, or drag),
 *     Q / E roll, Shift fast, mouse wheel or [ ] for FOV. The camera stays within 40 m of Superman.
 *   Panel (arrow keys, or click the arrows): film look, hero pose, frame, FOV, depth of field (a bokeh ShaderPass
 *   that sits in the composer only while photo mode is on), focus, exposure, contrast, saturation, vignette, grain,
 *   hero facing. T / Y / B cycle look / pose / frame, R re-frames the hero, U hides the panel, Enter captures,
 *   O or Esc exits. Pad: sticks fly and look, LB / RB roll, LT / RT down / up, L3 fast, A capture, B exit,
 *   X look, Y pose, Back frame, D-pad picks and adjusts a row, R3 hides the panel.
 *   Film looks: Daily Planet newsprint (B&W halftone), golden hour, comic halftone (posterised, Ben-Day dots, ink).
 *   Poses: as he was, hands on hips, flying fist forward, hero landing kneel, cape billow (the cape cloth is
 *   simulated live in a posed wind).
 *   Frames: none, Jimmy's print, widescreen, Daily Planet front page (masthead + today's headline).
 *   Capture renders the composer and reads the canvas in the same task (no preserveDrawingBuffer), draws the frame
 *   with Canvas 2D and saves metropolis-YYYYMMDD-HHMMSS.png via canvas.toBlob. The shot also becomes the
 *   front-page lead photo.
 *
 * LIVING FRONT PAGE
 *   game.js now emits 'rescue', 'incidentEnd', 'medal' and 'collapse' into __game.events. This file reads them
 *   into a session story, ranks the stories (set pieces, the biggest rescue, a collapse, the damage bill, medals,
 *   help missions) and answers __game.headlineHooks with original template copy. js/demo.js unshifts its Metallo
 *   hook in front of this one, so a Metallo result still leads. The best moment (a set-piece success, a gold or a
 *   big rescue) is auto-captured from the live frame a beat after it happens, newsprint-filtered and shown as the
 *   lead photo, with an "Also in this edition" column. The medals and unlocks lists stay.
 *
 * API: __game.photo = { active, enter(), exit(), toggle(), capture({download}) -> Promise<{size,width,height,type}>,
 *   setLook(id), setPose(id), setFrame(id), set(key, v), frameHero(dist, angleDeg, height), state, LOOKS, POSES,
 *   FRAMES, lead (data URL), story() }.
 * Per frame it allocates nothing; the depth pass for the bokeh re-renders only when the camera or pose changes.
 */
(function () {
  'use strict';
  const G = () => window.__game;
  let THREE = null, ctx = null, C = null;

  const LOOKS = [
    { id: 'none', label: 'Natural' },
    { id: 'newsprint', label: 'Daily Planet newsprint' },
    { id: 'golden', label: 'Golden hour' },
    { id: 'comic', label: 'Comic halftone' }
  ];
  const POSES = [
    { id: 'live', label: 'As he was' },
    { id: 'hips', label: 'Hands on hips' },
    { id: 'fly', label: 'Flying, fist forward' },
    { id: 'kneel', label: 'Hero landing' },
    { id: 'cape', label: 'Cape billow' }
  ];
  const FRAMES = [
    { id: 'none', label: 'No frame' },
    { id: 'print', label: "Jimmy's print" },
    { id: 'cinema', label: 'Widescreen' },
    { id: 'planet', label: 'Daily Planet front page' }
  ];
  const RANGE = 40, DEG = Math.PI / 180;
  const pct = v => Math.round(v * 100) + '%';
  const ROWS = [
    { k: 'look', label: 'Film look', list: LOOKS },
    { k: 'pose', label: 'Hero pose', list: POSES },
    { k: 'frame', label: 'Frame', list: FRAMES },
    { k: 'fov', label: 'Field of view', min: 15, max: 100, step: 1, fmt: v => v.toFixed(0) + '°' },
    { k: 'aperture', label: 'Depth of field', min: 0, max: 1, step: 0.05, fmt: v => v <= 0 ? 'Off' : 'f/' + (16 - v * 14.6).toFixed(1) },
    { k: 'focus', label: 'Focus', min: 0, max: 40, step: 0.5, fmt: v => v <= 0 ? 'Auto: Superman' : v.toFixed(1) + ' m' },
    { k: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.1, fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' EV' },
    { k: 'contrast', label: 'Contrast', min: 0.5, max: 1.6, step: 0.05, fmt: pct },
    { k: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.05, fmt: pct },
    { k: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.05, fmt: pct },
    { k: 'grain', label: 'Grain', min: 0, max: 1, step: 0.05, fmt: pct },
    { k: 'turn', label: 'Hero facing', min: -180, max: 180, step: 15, fmt: v => (v > 0 ? '+' : '') + v + '°' }
  ];
  const DEFAULTS = { look: 0, pose: 0, frame: 0, fov: 60, aperture: 0, focus: 0, exposure: 0, contrast: 1, saturation: 1, vignette: 0.3, grain: 0.2, turn: 0 };

  const S = Object.assign({
    active: false, ui: true, row: 0, captures: 0, lastSize: 0,
    cam: null, yaw: 0, pitch: 0, roll: 0,
    saved: null, poseApplied: '', depthSig: 0, passes: null, frameDirty: true
  }, DEFAULTS);
  const keysDown = new Set();
  let lockMove = false;

  // ================================================================== shaders
  const DOF_SHADER = {
    uniforms: {
      tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: null },
      uNear: { value: 0.1 }, uFar: { value: 1000 }, uFocus: { value: 10 }, uAperture: { value: 0 }, uMaxBlur: { value: 1 }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      '#include <packing>',
      'uniform sampler2D tDiffuse, tDepth; uniform vec2 uRes; uniform float uNear, uFar, uFocus, uAperture, uMaxBlur; varying vec2 vUv;',
      'float viewZ(vec2 uv){ float d = unpackRGBAToDepth(texture2D(tDepth, uv)); return max(0.05, -perspectiveDepthToViewZ(d, uNear, uFar)); }',
      'float coc(float z){ return min(uMaxBlur, uMaxBlur * abs(z - uFocus) / z * (z < uFocus ? 1.6 : 1.0)); }',
      'void main(){',
      '  float zc = viewZ(vUv), cc = coc(zc);',
      '  vec3 acc = texture2D(tDiffuse, vUv).rgb; float ws = 1.0;',
      '  for (int i = 0; i < 48; i++) {',
      '    float fi = float(i), r = sqrt((fi + 0.5) / 48.0) * uMaxBlur, a = fi * 2.39996;',
      '    vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;',
      '    float zs = viewZ(uv), cs = coc(zs);',
      '    if (zs > zc) cs = min(cs, cc);',              // a sharp subject in front is not smeared by the background behind it
      '    float w = smoothstep(r - 1.0, r + 0.5, cs);',
      '    acc += texture2D(tDiffuse, uv).rgb * w; ws += w;',
      '  }',
      '  gl_FragColor = vec4(acc / ws, 1.0);',
      '}'
    ].join('\n')
  };
  const LOOK_SHADER = {
    uniforms: {
      tDiffuse: { value: null }, uRes: { value: null }, uLook: { value: 0 }, uExp: { value: 0 }, uCon: { value: 1 },
      uSat: { value: 1 }, uVig: { value: 0.3 }, uGrain: { value: 0.2 }, uTime: { value: 0 }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uLook, uExp, uCon, uSat, uVig, uGrain, uTime; varying vec2 vUv;',
      'float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
      // one screen of rotated halftone cells; v = ink coverage 0..1, returns 1 inside the dot
      'float dots(vec2 px, float cell, float ang, float v){',
      '  float s = sin(ang), c = cos(ang); vec2 q = vec2(c * px.x - s * px.y, s * px.x + c * px.y) / cell;',
      '  float d = length(fract(q) - 0.5), r = sqrt(clamp(v, 0.0, 1.0)) * 0.72;',
      '  return 1.0 - smoothstep(r - 0.07, r + 0.07, d);',
      '}',
      'vec3 adjust(vec3 col){',
      '  col *= exp2(uExp); col = (col - 0.5) * uCon + 0.5;',
      '  float l = lum(col); return mix(vec3(l), col, uSat);',
      '}',
      'void main(){',
      '  vec2 px = vUv * uRes; vec3 col = adjust(texture2D(tDiffuse, vUv).rgb);',
      '  float cell = max(3.0, uRes.y / 190.0);',
      '  if (uLook > 0.5 && uLook < 1.5) {',                                   // Daily Planet newsprint
      '    float g = clamp((lum(col) - 0.5) * 1.35 + 0.53, 0.0, 1.0);',
      '    float ink = dots(px, cell, 0.785, 1.0 - g);',
      '    col = mix(vec3(0.925, 0.905, 0.85), vec3(0.08, 0.08, 0.09), ink * 0.96);',
      '    col *= 0.965 + 0.035 * hash(floor(px / 2.0));',
      '  } else if (uLook > 1.5 && uLook < 2.5) {',                            // golden hour
      '    float l = lum(col);',
      '    col *= vec3(1.13, 1.0, 0.76);',
      '    col = mix(col * vec3(0.86, 0.8, 1.06) + vec3(0.035, 0.0, 0.055), col, smoothstep(0.0, 0.5, l));',
      '    col += vec3(1.0, 0.58, 0.22) * 0.1 * smoothstep(0.55, 1.0, l);',
      '  } else if (uLook > 2.5) {',                                           // comic halftone
      '    vec2 e = 1.5 / uRes;',
      '    float tl = lum(texture2D(tDiffuse, vUv + vec2(-e.x, e.y)).rgb), tr = lum(texture2D(tDiffuse, vUv + e).rgb);',
      '    float bl = lum(texture2D(tDiffuse, vUv - e).rgb), br = lum(texture2D(tDiffuse, vUv + vec2(e.x, -e.y)).rgb);',
      '    float edge = smoothstep(0.1, 0.3, length(vec2(tr + br - tl - bl, tl + tr - bl - br)) / (0.25 + lum(col)));',
      '    vec3 q = floor(clamp(col, 0.0, 1.0) * 4.0 + 0.5) / 4.0;',
      '    float l = lum(col), d = dots(px, cell * 1.4, 0.26, clamp(1.0 - l * 1.5, 0.0, 1.0) * 0.55);',
      '    col = mix(q * 1.12 + 0.03, q * 0.5, d);',
      '    col = mix(col, vec3(0.04, 0.03, 0.06), edge);',
      '  }',
      '  vec2 cc = vUv - 0.5; col *= 1.0 - uVig * dot(cc, cc) * 2.2;',
      '  col += (hash(floor(px) + fract(uTime) * 91.7) - 0.5) * uGrain * 0.22;',
      '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
      '}'
    ].join('\n')
  };

  let dofPass = null, lookPass = null, depthRT = null, depthMat = null, noDepth = null;
  function buildPasses(g) {
    if (dofPass) return;
    dofPass = new THREE.ShaderPass(DOF_SHADER); dofPass.uniforms.uRes.value = new THREE.Vector2(1, 1);
    lookPass = new THREE.ShaderPass(LOOK_SHADER); lookPass.uniforms.uRes.value = new THREE.Vector2(1, 1);
    depthRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat });
    depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dofPass.uniforms.tDepth.value = depthRT.texture;
  }
  const DB = new (window.THREE ? window.THREE.Vector2 : Object)();
  function insertPasses(g) {
    const comp = g.composer, passes = comp.passes;
    const post = window.__post && window.__post.passes && window.__post.passes.hdr;
    let i = post ? passes.indexOf(post) : -1;
    if (i < 0) i = passes.findIndex(p => p === (ctx && ctx.bloom));
    if (i < 0) i = 1;
    comp.insertPass(dofPass, i);
    comp.addPass(lookPass);
    sizePasses(g);
    // things that should not write depth for the bokeh: additive glows, beams, particles, sky
    noDepth = [];
    g.scene.traverse(o => { const m = o.material; if (o.visible && m && !Array.isArray(m) && (m.blending === THREE.AdditiveBlending || m.depthWrite === false || o.isPoints || o.isSprite)) noDepth.push(o); });
  }
  function removePasses(g) {
    const passes = g.composer.passes;
    for (const p of [dofPass, lookPass]) { const i = passes.indexOf(p); if (i >= 0) passes.splice(i, 1); }
    noDepth = null;
  }
  function sizePasses(g) {
    g.renderer.getDrawingBufferSize(DB);
    dofPass.uniforms.uRes.value.set(DB.x, DB.y); lookPass.uniforms.uRes.value.set(DB.x, DB.y);
    const w = Math.max(4, DB.x >> 1), h = Math.max(4, DB.y >> 1);
    if (depthRT.width !== w || depthRT.height !== h) { depthRT.setSize(w, h); S.depthSig = 0; }
  }
  const CC = new (window.THREE ? window.THREE.Color : Object)();
  function renderDepth(g) {
    const r = g.renderer, sc = g.scene, cam = g.camera;
    const vis = noDepth || [];
    for (let i = 0; i < vis.length; i++) vis[i].visible = false;
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    r.getClearColor(CC); const ca = r.getClearAlpha(), prevRT = r.getRenderTarget(), bg = sc.background;
    sc.overrideMaterial = depthMat; sc.background = null;
    r.setClearColor(0xffffff, 1); r.setRenderTarget(depthRT); r.clear(true, true, true);
    r.render(sc, cam);
    sc.overrideMaterial = null; sc.background = bg;
    r.setRenderTarget(prevRT); r.setClearColor(CC, ca); r.shadowMap.autoUpdate = auto;
    for (let i = 0; i < vis.length; i++) vis[i].visible = true;
  }

  // ================================================================== hero poses
  const POSE = {
    hips: { aL: -0.3, aR: -0.3, aLz: -0.55, aRz: 0.55, eLx: -0.1, eRx: -0.1, eLz: 1.45, eRz: -1.45, lL: 0.07, lR: -0.07, kL: -0.04, kR: -0.04, drop: 0, lean: 0, wind: 3 },
    fly: { aL: 0.15, aR: Math.PI * 0.96, aLz: -0.1, aRz: 0.05, eLx: 0.1, eRx: 0, eLz: 0, eRz: 0, lL: 0.05, lR: -0.02, kL: -0.05, kR: -0.35, drop: 0, lean: 0, wind: 38, fly: true },
    kneel: { aL: -0.6, aR: 0.62, aLz: -0.6, aRz: 0.12, eLx: 0.4, eRx: 0, eLz: 0, eRz: 0, lL: -0.05, lR: 1.65, kL: -1.8, kR: -1.75, drop: 0.56, lean: 0.55, wind: 2 },
    cape: { aL: -0.28, aR: -0.28, aLz: -0.5, aRz: 0.5, eLx: -0.1, eRx: -0.1, eLz: 1.4, eRz: -1.4, lL: 0.13, lR: -0.13, kL: -0.05, kR: -0.05, drop: 0, lean: 0, wind: 16, side: 0.55 }
  };
  const JOINTS = [['armL', 'x'], ['armL', 'z'], ['armR', 'x'], ['armR', 'z'], ['elbowL', 'x'], ['elbowL', 'z'], ['elbowR', 'x'], ['elbowR', 'z'], ['legL', 'x'], ['legR', 'x'], ['kneeL', 'x'], ['kneeR', 'x']];
  const JKEY = ['aL', 'aLz', 'aR', 'aRz', 'eLx', 'eLz', 'eRx', 'eRz', 'lL', 'lR', 'kL', 'kR'];
  function saveHero(g) {
    const h = g.hero, c = h.cape, n = c.pts.length;
    const sv = { pos: h.g.position.clone(), quat: h.g.quaternion.clone(), j: new Float32Array(JOINTS.length), cape: new Float32Array(n * 6), pq: g.P.quat.clone(), pv: g.P.vel.clone(), yaw0: 0 };
    JOINTS.forEach(([n2, ax], i) => { sv.j[i] = h[n2].rotation[ax]; });
    for (let i = 0; i < n; i++) { const p = c.pts[i], q = c.prev[i]; sv.cape.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6); }
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(sv.quat);
    sv.yaw0 = Math.hypot(f.x, f.z) > 0.2 ? Math.atan2(-f.x, -f.z) : S.yaw;
    return sv;
  }
  function restoreHero(g, withCape) {
    const h = g.hero, sv = S.saved; if (!sv) return;
    h.g.position.copy(sv.pos); h.g.quaternion.copy(sv.quat);
    JOINTS.forEach(([n2, ax], i) => { h[n2].rotation[ax] = sv.j[i]; });
    if (withCape) {
      const c = h.cape;
      for (let i = 0; i < c.pts.length; i++) { const o = i * 6; c.pts[i].set(sv.cape[o], sv.cape[o + 1], sv.cape[o + 2]); c.prev[i].set(sv.cape[o + 3], sv.cape[o + 4], sv.cape[o + 5]); c.pos[i * 3] = sv.cape[o]; c.pos[i * 3 + 1] = sv.cape[o + 1]; c.pos[i * 3 + 2] = sv.cape[o + 2]; }
      c.geo.attributes.position.needsUpdate = true; c.geo.computeVertexNormals();
    }
  }
  let TQ = null, TQ2 = null, TV = null, TV2 = null, AX = null, UPV = null, EUL = null;
  function applyPose(g) {
    const id = POSES[S.pose].id, h = g.hero, sv = S.saved;
    S.poseApplied = id; S.depthSig = 0;
    if (id === 'live') { restoreHero(g, true); return; }
    const P = POSE[id];
    const face = sv.yaw0 + S.turn * DEG;
    TQ.setFromAxisAngle(UPV, face);
    if (P.fly) TQ.multiply(TQ2.setFromAxisAngle(AX.set(1, 0, 0), -Math.PI / 2));     // head forward, back to the sky
    if (P.lean) TQ.multiply(TQ2.setFromAxisAngle(AX.set(1, 0, 0), -P.lean));
    h.g.quaternion.copy(TQ);
    h.g.position.copy(sv.pos); h.g.position.y -= P.drop;
    for (let i = 0; i < JOINTS.length; i++) h[JOINTS[i][0]].rotation[JOINTS[i][1]] = P[JKEY[i]];
  }
  // the cape keeps moving in a posed wind (cosmetic: the sim itself stays frozen)
  function stepCape(g, dt) {
    const id = S.poseApplied; if (!id || id === 'live' || !g.updateCape) return;
    const P = POSE[id], h = g.hero, face = S.saved.yaw0 + S.turn * DEG;
    const fx = -Math.sin(face), fz = -Math.cos(face);
    // the hero's velocity through still air; the cloth feels the opposite wind
    if (P.fly) TV.set(fx * P.wind, 0, fz * P.wind);
    else TV.set(fx * P.wind - fz * P.wind * (P.side || 0), P.wind * 0.12, fz * P.wind + fx * P.wind * (P.side || 0));
    TQ2.copy(g.P.quat); TV2.copy(g.P.vel);
    g.P.quat.copy(h.g.quaternion); g.P.vel.copy(TV);
    try { g.updateCape(Math.min(dt, 1 / 30), performance.now() / 1000); } finally { g.P.quat.copy(TQ2); g.P.vel.copy(TV2); }
  }

  // ================================================================== enter / exit
  let hudPrev = '';
  function enter() {
    const g = G(); if (S.active || !g || !g.started || !g.hero || !g.freeze) return false;
    if (g.bench && g.bench.active) return false;
    if (g.MAP && g.MAP.open) g.setMapOpen(false);
    if (g.paused) g.setPaused(false);
    g.freeze.on = true; S.active = true;
    if (g.setMouse) g.setMouse(false, false); g.P.charging = false;
    keysDown.clear();
    g.camState.hold = true;
    buildPasses(g);
    const cam = g.camera;
    S.saved = saveHero(g);
    S.saved.fov = cam.fov; S.saved.camPos = cam.position.clone(); S.saved.camQuat = cam.quaternion.clone();
    S.saved.speed = window.__post && window.__post.enable ? window.__post.enable.speed : null;
    if (S.saved.speed !== null) window.__post.enable.speed = false; // no flight blur on a frozen frame
    S.cam = cam.position.clone();
    cam.getWorldDirection(TV); S.yaw = Math.atan2(-TV.x, -TV.z); S.pitch = Math.asin(Math.max(-1, Math.min(1, TV.y))); S.roll = 0;
    S.fov = Math.round(Math.max(15, Math.min(100, cam.fov)));
    S.poseApplied = ''; if (S.pose) applyPose(g);
    insertPasses(g); S.depthSig = 0;
    const hud = document.getElementById('hud'); if (hud) { hudPrev = hud.style.display; hud.style.display = 'none'; }
    document.body.classList.add('photo-on');
    buildUI(); UI.root.hidden = false; S.frameDirty = true; renderUI();
    if (g.emit) g.emit('photo', { on: true });
    return true;
  }
  function exit() {
    const g = G(); if (!S.active || !g) return false;
    removePasses(g);
    if (S.saved && S.saved.speed !== null && window.__post) window.__post.enable.speed = S.saved.speed;
    restoreHero(g, true); S.poseApplied = '';
    const cam = g.camera;
    if (S.saved) { cam.position.copy(S.saved.camPos); cam.quaternion.copy(S.saved.camQuat); cam.fov = S.saved.fov; cam.updateProjectionMatrix(); }
    g.camState.hold = false; g.camState.init = false;
    const hud = document.getElementById('hud'); if (hud) hud.style.display = hudPrev;
    document.body.classList.remove('photo-on');
    if (UI.root) UI.root.hidden = true;
    keysDown.clear();
    S.active = false; g.freeze.on = false;
    if (document.pointerLockElement) { lockMove = false; document.exitPointerLock(); }
    try { const r = g.renderer.domElement.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* needs a gesture */ }
    if (g.emit) g.emit('photo', { on: false });
    return true;
  }

  // ================================================================== free camera
  function frameHero(dist, angDeg, hgt) {
    const g = G(); if (!g || !S.active) return;
    const hp = g.hero.g.position, face = S.saved ? S.saved.yaw0 + S.turn * DEG : 0;
    const a = face + (angDeg === undefined ? 35 : angDeg) * DEG, d = dist || 4.2, y = hgt === undefined ? 0.35 : hgt;
    S.cam.set(hp.x - Math.sin(a) * d, hp.y + y, hp.z - Math.cos(a) * d);
    TV.set(hp.x - S.cam.x, hp.y + 0.2 - S.cam.y, hp.z - S.cam.z).normalize();
    S.yaw = Math.atan2(-TV.x, -TV.z); S.pitch = Math.asin(TV.y); S.roll = 0;
  }
  const pad = { on: false, prev: new Uint8Array(20), lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, b: new Uint8Array(20) };
  function updateCamera(g, dt) {
    const k = keysDown, has = c => k.has(c);
    const fast = has('ShiftLeft') || has('ShiftRight') || pad.b[10];
    const sp = fast ? 24 : 6;
    let mf = (has('KeyW') ? 1 : 0) - (has('KeyS') ? 1 : 0) - pad.ly;
    let mr = (has('KeyD') ? 1 : 0) - (has('KeyA') ? 1 : 0) + pad.lx;
    let mu = (has('Space') ? 1 : 0) - (has('KeyC') ? 1 : 0) + pad.rt - pad.lt;
    const roll = (has('KeyQ') ? 1 : 0) - (has('KeyE') ? 1 : 0) + (pad.b[4] ? 1 : 0) - (pad.b[5] ? 1 : 0);
    if (pad.on) { S.yaw -= pad.rx * dt * 1.8; S.pitch -= pad.ry * dt * 1.4 * (g.camState.invY ? -1 : 1); }
    if (has('BracketLeft')) setVal('fov', S.fov - 30 * dt, true);
    if (has('BracketRight')) setVal('fov', S.fov + 30 * dt, true);
    S.pitch = Math.max(-1.5, Math.min(1.5, S.pitch));
    S.roll = Math.max(-45 * DEG, Math.min(45 * DEG, S.roll + roll * 40 * DEG * dt));
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw), cp = Math.cos(S.pitch), spi = Math.sin(S.pitch);
    S.cam.x += ((-sy * cp) * mf + cy * mr) * sp * dt;
    S.cam.y += (spi * mf + mu) * sp * dt;
    S.cam.z += ((-cy * cp) * mf - sy * mr) * sp * dt;
    clampCam(g);
    const cam = g.camera;
    cam.position.copy(S.cam);
    cam.quaternion.setFromEuler(EUL.set(S.pitch, S.yaw, S.roll, 'YXZ'));
    if (cam.fov !== S.fov) { cam.fov = S.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
  function clampCam(g) {
    const hp = g.hero.g.position;
    TV.copy(S.cam).sub(hp); const L = TV.length();
    if (L > RANGE) S.cam.copy(hp).addScaledVector(TV, RANGE / L);
    const bay = C && S.cam.z > C.WATER_Z && S.cam.z < C.FAR_SHORE;
    const floor = bay ? C.WATER_Y + 0.4 : (g.groundY ? g.groundY(S.cam.x, S.cam.z) : 0) + 0.3;
    if (S.cam.y < floor) S.cam.y = floor;
  }

  // ================================================================== per-frame (runs before game.js's frame: registered first)
  let lastT = performance.now(), padSeen = false;
  function pollPad(g) {
    pad.on = false;
    if (!navigator.getGamepads || (!padSeen && !S.active)) return null;
    const list = navigator.getGamepads(); let gp = null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].connected) { gp = list[i]; break; }
    if (!gp) return null;
    pad.on = true;
    const dz = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
    pad.lx = dz(gp.axes[0] || 0); pad.ly = dz(gp.axes[1] || 0); pad.rx = dz(gp.axes[2] || 0); pad.ry = dz(gp.axes[3] || 0);
    pad.lt = gp.buttons[6] ? gp.buttons[6].value : 0; pad.rt = gp.buttons[7] ? gp.buttons[7].value : 0;
    let edges = 0;
    const n = Math.min(20, gp.buttons.length);
    for (let i = 0; i < n; i++) { const b = gp.buttons[i] && gp.buttons[i].pressed ? 1 : 0; if (b && !pad.prev[i]) edges |= 1 << i; pad.prev[i] = b; pad.b[i] = b; }
    return edges;
  }
  addEventListener('gamepadconnected', () => { padSeen = true; });
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)); lastT = now;
    const g = G(); if (!g || !THREE) return;
    const edges = pollPad(g);
    const settingsOpen = window.SM_SETTINGS && window.SM_SETTINGS.isOpen;
    if (edges && !settingsOpen && g.started) {
      const E = i => (edges >> i) & 1;
      if (!S.active) {
        if ((g.paused && E(2)) || (!g.paused && !(g.MAP && g.MAP.open) && E(15))) enter();
      } else {
        if (E(1) || E(9)) exit();
        else if (E(0)) capture({ download: true });
        else {
          if (E(2)) cycle('look', 1);
          if (E(3)) cycle('pose', 1);
          if (E(8)) cycle('frame', 1);
          if (E(11)) toggleUI();
          if (E(12)) moveRow(-1);
          if (E(13)) moveRow(1);
          if (E(14)) adjustRow(-1);
          if (E(15)) adjustRow(1);
        }
      }
    }
    if (S.active) {
      if (!pad.on) { pad.lx = pad.ly = pad.rx = pad.ry = pad.lt = pad.rt = 0; pad.b.fill(0); }
      updateCamera(g, dt);
      stepCape(g, dt);
      const lu = lookPass.uniforms;
      lu.uLook.value = S.look; lu.uExp.value = S.exposure; lu.uCon.value = S.contrast; lu.uSat.value = S.saturation;
      lu.uVig.value = S.vignette; lu.uGrain.value = S.grain; lu.uTime.value = (now / 1000) % 100;
      dofPass.enabled = S.aperture > 0;
      if (dofPass.enabled) {
        sizePasses(g);
        const cam = g.camera, hp = g.hero.g.position;
        const autoF = Math.max(0.5, Math.hypot(hp.x - cam.position.x, hp.y + 0.25 - cam.position.y, hp.z - cam.position.z));
        const du = dofPass.uniforms;
        du.uNear.value = cam.near; du.uFar.value = cam.far; du.uFocus.value = S.focus > 0 ? S.focus : autoF;
        du.uMaxBlur.value = Math.max(1, S.aperture * DB.y * 0.022);
        // re-render the depth only when the view or the pose changed
        const e = cam.matrixWorld.elements;
        const sig = e[12] * 1.31 + e[13] * 7.7 + e[14] * 3.3 + e[0] * 11 + e[1] * 13 + e[2] * 17 + e[8] * 19 + e[9] * 23 + e[10] * 29 + cam.fov * 31 + DB.x + S.pose * 101 + S.turn * 0.37 + 1;
        if (sig !== S.depthSig) { S.depthSig = sig; renderDepth(g); }
      }
      if (S.frameDirty) drawPreviewFrame();
      if (UI.dist) { const hp = g.hero.g.position, d = Math.round(Math.hypot(S.cam.x - hp.x, S.cam.y - hp.y, S.cam.z - hp.z)); if (UI.distV !== d) { UI.distV = d; UI.dist.textContent = d + ' / ' + RANGE + ' m'; } }
    }
    if (pendingShot && now >= pendingShot.due && g.started && !S.active) takeAutoShot(g);
  }
  requestAnimationFrame(tick);

  // ================================================================== input (capture phase, after settings.js remapping)
  const ADJ_REPEAT = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, BracketLeft: 1, BracketRight: 1 };
  addEventListener('keydown', e => {
    const g = G(); if (!g || !g.started) return;
    if (window.SM_SETTINGS && window.SM_SETTINGS.isOpen) return;
    if (!S.active) {
      if (e.code === 'KeyO' && !e.repeat && !(g.MAP && g.MAP.open) && !(g.bench && g.bench.active)) { e.preventDefault(); e.stopImmediatePropagation(); enter(); }
      return;
    }
    if (!/^F\d+$/.test(e.code)) e.preventDefault();
    e.stopImmediatePropagation(); // the frozen game must not see keys: no punches, map, pause or F8 in photo mode
    keysDown.add(e.code);
    if (e.repeat && !ADJ_REPEAT[e.code]) return;
    switch (e.code) {
      case 'KeyO': case 'Escape': exit(); break;
      case 'Enter': case 'NumpadEnter': capture({ download: true }); break;
      case 'KeyT': cycle('look', e.shiftKey ? -1 : 1); break;
      case 'KeyY': cycle('pose', e.shiftKey ? -1 : 1); break;
      case 'KeyB': cycle('frame', e.shiftKey ? -1 : 1); break;
      case 'KeyU': toggleUI(); break;
      case 'KeyR': frameHero(); break;
      case 'ArrowUp': moveRow(-1); break;
      case 'ArrowDown': moveRow(1); break;
      case 'ArrowLeft': adjustRow(-1); break;
      case 'ArrowRight': adjustRow(1); break;
      default: break;
    }
  }, true);
  addEventListener('keyup', e => { keysDown.delete(e.code); }, true); // keyups pass through so the game's own key set clears
  addEventListener('blur', () => keysDown.clear());
  addEventListener('mousedown', e => {
    if (!S.active) return;
    const g = G(), cv = g && g.renderer.domElement;
    if (e.target !== cv && !(e.target && e.target.id === 'ph-frame')) return; // the panel's own buttons
    e.preventDefault(); e.stopImmediatePropagation();
    if (document.pointerLockElement !== cv) { try { const r = cv.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* drag still looks */ } }
  }, true);
  addEventListener('mousemove', e => {
    if (!S.active) return;
    const g = G(), cv = g && g.renderer.domElement;
    const locked = document.pointerLockElement === cv;
    e.stopImmediatePropagation();
    if (!locked && !((e.buttons & 1) && (e.target === cv || (e.target && e.target.id === 'ph-frame')))) return;
    const ms = 0.0021 * (g.camState.sens || 1) * Math.min(1, S.fov / 60);
    S.yaw -= e.movementX * ms; S.pitch -= e.movementY * ms * (g.camState.invY ? -1 : 1);
  }, true);
  addEventListener('wheel', e => {
    if (!S.active || (UI.panel && UI.panel.contains(e.target))) return;
    setVal('fov', S.fov + Math.sign(e.deltaY) * 3, true);
  }, { passive: true });

  // ================================================================== panel
  const UI = { root: null, panel: null, rows: [], frame: null, dist: null, distV: -1 };
  function buildUI() {
    if (UI.root) return;
    const root = document.createElement('div'); root.id = 'photo'; root.hidden = true;
    root.innerHTML = '<canvas id="ph-frame"></canvas><div id="ph-flash"></div>' +
      '<div class="ph-panel" role="dialog" aria-label="Photo mode">' +
      '<div class="ph-h"><span class="ph-rec"></span>Photo mode<small class="ph-dist"></small></div>' +
      '<div class="ph-sub">The city holds its breath</div>' +
      '<div class="ph-rows"></div>' +
      '<div class="ph-btns"><button type="button" class="ph-shoot">Capture <kbd>Enter</kbd></button><button type="button" class="ph-exit">Exit <kbd>O</kbd></button></div>' +
      '<div class="ph-keys"><span><kbd>WASD</kbd> move</span><span><kbd>Space</kbd>/<kbd>C</kbd> up, down</span><span><kbd>Mouse</kbd> look</span><span><kbd>Q</kbd>/<kbd>E</kbd> roll</span>' +
      '<span><kbd>Shift</kbd> fast</span><span><kbd>Wheel</kbd> zoom</span><span><kbd>T</kbd> look</span><span><kbd>Y</kbd> pose</span><span><kbd>B</kbd> frame</span><span><kbd>R</kbd> re-frame</span><span><kbd>U</kbd> hide</span></div>' +
      '<div class="ph-pad">Pad: <kbd>A</kbd> capture <kbd>B</kbd> exit <kbd>X</kbd> look <kbd>Y</kbd> pose <kbd>LB</kbd>/<kbd>RB</kbd> roll <kbd>D-pad</kbd> adjust</div>' +
      '</div><div class="ph-saved" aria-live="polite"></div>';
    document.body.appendChild(root);
    UI.root = root; UI.panel = root.querySelector('.ph-panel'); UI.frame = root.querySelector('#ph-frame');
    UI.dist = root.querySelector('.ph-dist'); UI.saved = root.querySelector('.ph-saved'); UI.flash = root.querySelector('#ph-flash');
    const box = root.querySelector('.ph-rows');
    ROWS.forEach((r, i) => {
      const el = document.createElement('div'); el.className = 'ph-row'; el.dataset.i = i;
      el.innerHTML = `<span class="ph-l">${r.label}</span><button type="button" class="ph-a" data-d="-1" aria-label="Less">‹</button><b class="ph-v"></b><button type="button" class="ph-a" data-d="1" aria-label="More">›</button>`;
      box.appendChild(el); UI.rows.push({ el, v: el.querySelector('.ph-v'), last: '' });
    });
    UI.panel.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) { const row = e.target.closest('.ph-row'); if (row) { S.row = +row.dataset.i; renderUI(); } return; }
      if (b.classList.contains('ph-shoot')) capture({ download: true });
      else if (b.classList.contains('ph-exit')) exit();
      else if (b.classList.contains('ph-a')) { S.row = +b.closest('.ph-row').dataset.i; adjustRow(+b.dataset.d); }
    });
    UI.panel.addEventListener('mousedown', e => e.stopPropagation());
    addEventListener('resize', () => { S.frameDirty = true; });
  }
  function renderUI() {
    if (!UI.root) return;
    ROWS.forEach((r, i) => {
      const u = UI.rows[i], v = S[r.k];
      const t = r.list ? r.list[v].label : r.fmt(v);
      if (u.last !== t) { u.v.textContent = t; u.last = t; }
      u.el.classList.toggle('on', i === S.row);
    });
    UI.panel.classList.toggle('ph-hidden', !S.ui);
  }
  function setVal(k, v, quiet) {
    const r = ROWS.find(x => x.k === k); if (!r) return;
    if (r.list) v = ((Math.round(v) % r.list.length) + r.list.length) % r.list.length;
    else v = Math.max(r.min, Math.min(r.max, Math.round(v / r.step) * r.step));
    if (!r.list && r.step < 1) v = +v.toFixed(3);
    S[k] = v;
    const g = G();
    if (S.active && g && (k === 'pose' || k === 'turn')) applyPose(g);
    if (k === 'frame') S.frameDirty = true;
    if (!quiet || k === 'fov') renderUI();
  }
  function cycle(k, d) { setVal(k, S[k] + d); }
  function moveRow(d) { S.row = (S.row + d + ROWS.length) % ROWS.length; renderUI(); }
  function adjustRow(d) { const r = ROWS[S.row]; setVal(r.k, S[r.k] + (r.list ? d : d * r.step)); }
  function toggleUI() { S.ui = !S.ui; renderUI(); }

  // ================================================================== frames (preview canvas and capture use the same drawing)
  function today(long) {
    const d = new Date();
    return long ? d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  }
  const DISPLAY = "'Big Shoulders Display', Impact, 'Arial Narrow Bold', 'Arial Narrow', sans-serif";
  function fitText(x, text, maxW, size, weight, family) {
    let s = size; x.font = `${weight} ${s}px ${family}`;
    while (s > 8 && x.measureText(text).width > maxW) { s *= 0.92; x.font = `${weight} ${s}px ${family}`; }
    return s;
  }
  function drawFrame(x, w, h, id) {
    x.save();
    if (id === 'cinema') {
      const bh = Math.max(0, (h - w / 2.39) / 2);
      x.fillStyle = '#000'; x.fillRect(0, 0, w, bh); x.fillRect(0, h - bh, w, bh);
    } else if (id === 'print') {
      const m = Math.round(h * 0.04), bot = Math.round(h * 0.12);
      x.fillStyle = '#f7f4ec';
      x.fillRect(0, 0, w, m); x.fillRect(0, 0, m, h); x.fillRect(w - m, 0, m, h); x.fillRect(0, h - bot, w, bot);
      x.strokeStyle = 'rgba(0,0,0,0.25)'; x.lineWidth = Math.max(1, h / 720); x.strokeRect(m, m, w - 2 * m, h - m - bot);
      x.fillStyle = '#4a4a52'; x.textBaseline = 'middle';
      fitText(x, 'x', w, Math.round(bot * 0.32), 'italic 400', "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive");
      x.fillText('Metropolis, ' + today(false) + '  —  J.O.', m * 1.3, h - bot / 2);
    } else if (id === 'planet') {
      const m = Math.round(h * 0.035), top = Math.round(h * 0.19), bot = Math.round(h * 0.17);
      x.fillStyle = '#efe9dc';
      x.fillRect(0, 0, w, top); x.fillRect(0, 0, m, h); x.fillRect(w - m, 0, m, h); x.fillRect(0, h - bot, w, bot);
      x.fillStyle = '#17171a'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
      const ms = fitText(x, 'Daily Planet', w - 2 * m, Math.round(top * 0.5), '700', "Georgia, 'Times New Roman', serif");
      x.fillText('Daily Planet', w / 2, m * 0.6 + ms * 0.86);
      const ry = Math.round(m * 0.6 + ms * 1.02), lw = Math.max(1, h / 540);
      x.fillRect(m, ry, w - 2 * m, lw * 2); x.fillRect(m, ry + lw * 4, w - 2 * m, lw);
      x.font = `600 ${Math.round(top * 0.11)}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
      x.fillStyle = '#4c4840';
      x.fillText(('Metropolis · Final edition · ' + today(true)).toUpperCase(), w / 2, Math.min(top - lw * 3, ry + lw * 6 + top * 0.13));
      x.strokeStyle = '#17171a'; x.lineWidth = lw * 1.5; x.strokeRect(m, top, w - 2 * m, h - top - bot);
      const g = G(); let hl = 'SUPERMAN OVER METROPOLIS';
      try { if (g && g.headline) hl = String(g.headline()[0]).toUpperCase(); } catch (_) { /* keep the default */ }
      x.fillStyle = '#111'; x.textAlign = 'left';
      const hs = fitText(x, hl, w - 2 * m, Math.round(bot * 0.48), '900', DISPLAY);
      x.fillText(hl, m, h - bot + m * 0.35 + hs * 0.9);
      x.font = `italic ${Math.round(bot * 0.15)}px Georgia, serif`; x.fillStyle = '#4c4840';
      x.fillText('Photo: Jimmy Olsen / Daily Planet', m, h - bot * 0.14);
      x.textAlign = 'right'; x.font = `700 ${Math.round(bot * 0.13)}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
      x.fillText('25¢', w - m, h - bot * 0.14);
    }
    x.restore();
  }
  function drawPreviewFrame() {
    S.frameDirty = false;
    const cv = UI.frame; if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const x = cv.getContext('2d'); x.clearRect(0, 0, w, h);
    drawFrame(x, w, h, FRAMES[S.frame].id);
  }

  // ================================================================== capture
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  // render, then read the WebGL canvas in the same task: the drawing buffer is still intact
  function grab(g, w, h) {
    const cv = g.renderer.domElement;
    g.render();
    const c = document.createElement('canvas'); c.width = w || cv.width; c.height = h || cv.height;
    c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
    return c;
  }
  function capture(opts) {
    opts = opts || {};
    const g = G(); if (!g) return Promise.resolve(null);
    const c = grab(g);
    const lead = scaled(c, 640);                       // the front-page copy, unframed
    drawFrame(c.getContext('2d'), c.width, c.height, S.active ? FRAMES[S.frame].id : 'none');
    flash();
    S.captures++;
    const name = 'metropolis-' + stamp() + '.png';
    return new Promise(res => {
      c.toBlob(b => {
        if (!b) { res(null); return; }
        S.lastSize = b.size;
        if (opts.download !== false) {
          const url = URL.createObjectURL(b), a = document.createElement('a');
          a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 20000);
        }
        if (UI.saved) { UI.saved.textContent = 'Saved ' + name; UI.saved.classList.remove('on'); void UI.saved.offsetWidth; UI.saved.classList.add('on'); }
        setTimeout(() => { LEAD.photo = { url: newsprint(lead), label: 'Superman over Metropolis', by: 'Jimmy Olsen', t: g.simT }; refreshLead(); }, 0);
        if (g.emit) g.emit('photo', { capture: true, size: b.size, w: c.width, h: c.height, look: LOOKS[S.look].id, pose: POSES[S.pose].id, frame: FRAMES[S.frame].id });
        res({ size: b.size, width: c.width, height: c.height, type: b.type, name, blob: b });
      }, 'image/png');
    });
  }
  function flash() {
    if (!UI.flash || document.body.classList.contains('sm-nf')) return;
    UI.flash.classList.remove('on'); void UI.flash.offsetWidth; UI.flash.classList.add('on');
  }
  function scaled(src, W) {
    const s = Math.min(1, W / src.width), c = document.createElement('canvas');
    c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  // a 45-degree halftone on newsprint, as the press would run it
  function newsprint(src) {
    const w = src.width, h = src.height, sx = src.getContext('2d');
    let px; try { px = sx.getImageData(0, 0, w, h).data; } catch (_) { return src.toDataURL('image/jpeg', 0.85); }
    const L = new Float32Array(w * h);
    for (let i = 0, j = 0; i < L.length; i++, j += 4) {
      const l = (px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114) / 255;
      L[i] = Math.max(0, Math.min(1, (l - 0.5) * 1.4 + 0.54));
    }
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const x = out.getContext('2d');
    x.fillStyle = '#ebe5d6'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#161618'; x.beginPath();
    const cell = Math.max(3, Math.round(w / 150)), c = Math.SQRT1_2, ext = Math.ceil((w + h) / cell) + 2;
    for (let a = -ext; a <= ext; a++) for (let b = 0; b <= ext * 1.5; b++) {
      const cx = (a * c + b * c) * cell, cy = (-a * c + b * c) * cell;
      if (cx < -cell || cy < -cell || cx > w + cell || cy > h + cell) continue;
      const ix = Math.max(0, Math.min(w - 1, cx | 0)), iy = Math.max(0, Math.min(h - 1, cy | 0));
      const r = Math.sqrt(1 - L[iy * w + ix]) * cell * 0.7;
      if (r < 0.25) continue;
      x.moveTo(cx + r, cy); x.arc(cx, cy, r, 0, 6.2832);
    }
    x.fill();
    return out.toDataURL('image/jpeg', 0.85);
  }

  // ================================================================== the session story (from __game.events)
  const LOG = { rescues: [], incidents: [], collapses: [], missions: [], seed: (Math.random() * 1e6) | 0 };
  let evIdx = 0, evLast = null, misSeen = 0;
  const KIND_LABEL = { heli: 'the falling news chopper', fire: 'the tenement fire', robbery: 'the bank robbery', meteor: 'the meteor strike', bus: 'the runaway bus', airliner: 'Metro Air 207', metallo: 'the Metallo fight' };
  function scan() {
    const g = G(); if (!g || !g.events) return;
    const E = g.events;
    if (evLast && E[evIdx - 1] !== evLast) { const i = E.lastIndexOf(evLast); evIdx = i >= 0 ? i + 1 : 0; }
    if (evIdx > E.length) evIdx = E.length;
    while (evIdx < E.length) {
      const e = E[evIdx++]; evLast = e;
      if (e.type === 'rescue') {
        LOG.rescues.push(e);
        const sc = 30 + 3 * Math.min(10, e.n || 1);
        wantShot(sc, e.why || 'A rescue', e.t);
      } else if (e.type === 'incidentEnd') {
        LOG.incidents.push(e);
        if (e.success) {
          const base = e.kind === 'metallo' ? 100 : e.kind === 'airliner' ? 95 : e.kind === 'bus' ? 88 : 50;
          wantShot(base + (e.medal === 'gold' ? 10 : e.medal === 'silver' ? 5 : 1) + Math.min(10, e.saved || 0), 'Superman at ' + (KIND_LABEL[e.kind] || 'the scene'), e.t);
        }
      } else if (e.type === 'collapse') LOG.collapses.push(e);
    }
    const ms = g.missions && g.missions.stats;
    if (ms && ms.success > misSeen) {
      misSeen = ms.success;
      const m = g.missions.current && g.missions.current();
      LOG.missions.push((m && m.lines && m.lines.label) || 'a call for help');
    }
  }
  // auto best moment: a beat after it happens, snapshot the live frame (only a better moment replaces it)
  const LEAD = { auto: null, photo: null, best: 0 };
  let pendingShot = null;
  function wantShot(score, label, t) {
    if (score <= LEAD.best || (pendingShot && score <= pendingShot.score)) return;
    pendingShot = { score, label, t, due: performance.now() + 220 };
  }
  function takeAutoShot(g) {
    const ps = pendingShot; pendingShot = null;
    if (ps.score <= LEAD.best) return;
    LEAD.best = ps.score;
    let small;
    try { const cv = g.renderer.domElement, s = Math.min(1, 640 / cv.width); small = grab(g, Math.round(cv.width * s), Math.round(cv.height * s)); } catch (e) { console.warn('photo: auto shot', e); return; }
    setTimeout(() => { LEAD.auto = { url: newsprint(small), label: ps.label, by: 'Daily Planet staff', t: ps.t, score: ps.score }; refreshLead(); if (g.emit) g.emit('photo', { auto: true, score: ps.score }); }, 0);
  }
  function leadPhoto() { return LEAD.photo || LEAD.auto; }
  function refreshLead() {
    const img = document.querySelector('#paper .fp-lead img'), lp = leadPhoto();
    if (lp && img && img.getAttribute('src') !== lp.url) { img.src = lp.url; const cap = document.querySelector('#paper .fp-lead figcaption'); if (cap) cap.textContent = caption(lp); }
    else if (lp && !img) { const pz = document.getElementById('paused'); if (pz && !pz.hidden) insertLead(document.getElementById('paper')); }
  }
  function caption(lp) { return `${lp.label}. Photo: ${lp.by}.`; }

  // ---------------------------------------------------------------- headline templates (original copy)
  const pick = (arr, salt) => arr[(LOG.seed + (salt || 0)) % arr.length];
  const up = s => String(s || '').toUpperCase();
  function stories(L) {
    scan();
    const g = G(), money = g && g.money ? g.money : (v => '$' + Math.round(v));
    const out = [];
    const add = (score, h1, h2, kind) => out.push({ score, h1, h2, kind });
    for (const e of LOG.incidents) {
      const gold = e.medal === 'gold' ? 4 : 0, hurt = e.injuries || 0, lost = e.lost || 0, where = e.where || 'Metropolis';
      if (e.kind === 'airliner') {
        if (e.success) add(95 + gold, pick(['SUPERMAN SETS FLIGHT 207 DOWN ON THE BAY', 'BURNING JET EASED ONTO THE WATER', `ALL ${e.saved || 140} ABOARD METRO AIR 207 WALK AWAY`], 1),
          `A stricken Metro Air 207 airliner glides onto the bay ${hurt ? `— ${hurt} treated for injuries` : 'without a single injury'}; passengers applaud from the wings`, 'airliner');
        else add(80, 'AIRLINER LOST OVER THE BAY', 'Metro Air 207 goes down despite a desperate rescue attempt; a stunned city asks how', 'airliner');
      } else if (e.kind === 'bus') {
        if (e.success) add(85 + gold, pick(['RUNAWAY BUS STOPPED COLD', 'BRAKES FAIL. SUPERMAN DOESN’T.', 'BUS HALTED FEET FROM THE CROSSWALK'], 2),
          `${e.saved ? e.saved + ' riders ride' : 'Its riders ride'} out a brakeless plunge down Centennial St${hurt ? `; ${hurt} bruised` : ', not a scratch among them'}`, 'bus');
        else add(72, 'RUNAWAY BUS HITS WATERFRONT CROSSWALK', `${lost || 'Several'} lost as a brakeless bus beats Superman to the corner`, 'bus');
      } else if (e.kind === 'metallo') {
        add(e.success ? 99 : 90, e.success ? 'METALLO BROUGHT DOWN' : 'METALLO WALKS AWAY', e.success ? 'Kryptonite cyborg felled in the plaza; the heart is sealed in lead' : 'The Kryptonite-hearted cyborg escapes the plaza; police on alert', 'metallo');
      } else if (e.success) {
        const sc = Math.min(75, 40 + 3 * (e.saved || 0) + (e.medal === 'gold' ? 10 : e.medal === 'silver' ? 5 : 0));
        const T = {
          heli: [['NEWS CHOPPER CAUGHT IN MID-AIR', 'SUPERMAN SNATCHES FALLING CHOPPER'], `A crippled news helicopter set down whole over ${where}${hurt ? `; ${hurt} hurt` : '; the crew climbs out shaken but unhurt'}`],
          fire: [['TRAPPED TENANTS PULLED FROM THE BLAZE', `SUPERMAN BEATS THE FLAMES AT ${up(where)}`], `${e.saved || 'Residents'} carried out of a burning tower at ${where}; firefighters call it a miracle`],
          robbery: [['BANK RAID FOILED', 'ROBBERS MEET THE MAN OF STEEL'], `An armed crew at ${where} is rounded up before the getaway${hurt ? `; ${hurt} hurt in the crossfire` : ', and nobody is hurt'}`],
          meteor: [[`SKY ROCK SHATTERED OVER ${up(where)}`, 'METEOR STOPPED SHORT OF DOWNTOWN'], `A falling meteor is broken up before it reaches ${where}`]
        }[e.kind];
        if (T) add(sc, pick(T[0], 3), T[1], e.kind);
      } else {
        add(35 + 5 * lost, `TOO LATE AT ${up(where)}`, `${lost ? lost + ' lost' : 'Heartbreak'} as Superman arrives after the worst has happened`, e.kind);
      }
    }
    const bigC = LOG.collapses.reduce((a, c) => (!a || c.fell > a.fell ? c : a), null);
    if (bigC && bigC.fell > 30) add(bigC.fell > 120 ? 78 : 52, bigC.fell > 120 ? `${up(bigC.name)} COMES DOWN` : `FLOORS GIVE WAY AT ${up(bigC.name)}`,
      `Dust rolls through the streets as ${bigC.name} ${bigC.fell > 120 ? 'falls' : 'partly collapses'}; the repair bill tops ${money(L.damage)}`, 'collapse');
    if (L.damage > 25e6) add(70, 'WRECKING BALL IN A CAPE?', `Property damage climbs to ${money(L.damage)}; City Hall wants a word with Superman`, 'damage');
    else if (L.damage > 8e6) add(44, 'HELP, AT A PRICE', `${money(L.damage)} in damage left behind as Superman works the city`, 'damage');
    const golds = L.medals ? L.medals.gold : 0;
    if (golds >= 3) add(56 + golds, `${golds} GOLDS AND COUNTING`, `Every alarm answered cleanly: ${L.saves} saved and Hope at ${Math.round(L.hope)}`, 'medals');
    const nm = LOG.missions.length;
    if (nm) add(Math.min(66, 32 + 6 * nm), nm > 1 ? 'HERO OF THE NEIGHBOURHOOD' : 'SUPERMAN STOPS FOR A STRANGER',
      nm > 1 ? `From ${LOG.missions[0]} to ${LOG.missions[nm - 1]}, he answered ${nm} calls from the street` : `A call from the street (${LOG.missions[0]}) answered in person`, 'missions');
    const bigR = LOG.rescues.reduce((a, r) => (!a || r.n > a.n ? r : a), null);
    if (bigR && !/^Help request/.test(bigR.why || '') && !bigR.inc) add(Math.min(60, 30 + 3 * bigR.n), bigR.n > 1 ? `SUPERMAN SAVES ${bigR.n}` : 'ONE LIFE, ONE SECOND TO SPARE',
      `${bigR.why ? bigR.why.replace(/^Saved\b/, 'Rescued') : 'A rescue'} — and ${L.saves} saved across the day`, 'rescue');
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  function storyHeadline(L) { const s = stories(L); return s.length ? [s[0].h1, s[0].h2] : null; }

  // ---------------------------------------------------------------- front page additions
  function insertLead(paper) {
    if (!paper || paper.querySelector('.fp-lead')) return;
    const lp = leadPhoto(); if (!lp) return;
    const fig = document.createElement('figure'); fig.className = 'fp-lead';
    const img = document.createElement('img'); img.alt = 'Lead photo'; img.src = lp.url;
    const cap = document.createElement('figcaption'); cap.textContent = caption(lp);
    fig.appendChild(img); fig.appendChild(cap);
    const deck = paper.querySelector('.deck');
    if (deck && deck.nextSibling) paper.insertBefore(fig, deck.nextSibling); else paper.appendChild(fig);
  }
  function frontHook(paper, L) {
    if (!paper) return;
    insertLead(paper);
    const g = G();
    // "also in this edition": the stories that did not lead
    let lead = ''; try { lead = g.headline()[0]; } catch (_) { /* none */ }
    const more = stories(L).filter(s => s.h1 !== lead).slice(0, 3);
    if (more.length) {
      const box = document.createElement('div'); box.className = 'fp-more';
      box.innerHTML = '<h3>Also in this edition</h3><ul></ul>';
      const ul = box.querySelector('ul');
      for (const s of more) { const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = s.h1; const sp = document.createElement('span'); sp.textContent = s.h2; li.appendChild(b); li.appendChild(sp); ul.appendChild(li); }
      const un = paper.querySelector('.unlocks');
      paper.insertBefore(box, un || null);
    }
    pauseButton();
  }
  function pauseButton() {
    if (document.getElementById('pause-photo')) return;
    const pz = document.getElementById('paused'); if (!pz) return;
    let bar = pz.querySelector('.sms-pausebar');
    const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'pause-photo'; btn.textContent = 'Photo mode';
    const hint = document.createElement('span'); hint.className = 'ph-hint'; hint.innerHTML = '<kbd>O</kbd> or <kbd>X</kbd>';
    if (!bar) { bar = document.createElement('div'); bar.className = 'sms-pausebar ph-pausebar'; pz.appendChild(bar); bar.addEventListener('click', e => e.stopPropagation()); }
    bar.insertBefore(hint, bar.firstChild); bar.insertBefore(btn, bar.firstChild);
    btn.addEventListener('click', e => { e.stopPropagation(); enter(); });
  }

  // ================================================================== wiring
  const API = {
    get active() { return S.active; }, enter, exit, toggle() { return S.active ? exit() : enter(); }, capture,
    setLook(id) { const i = typeof id === 'number' ? id : LOOKS.findIndex(l => l.id === id); if (i >= 0) setVal('look', i); },
    setPose(id) { const i = typeof id === 'number' ? id : POSES.findIndex(l => l.id === id); if (i >= 0) setVal('pose', i); },
    setFrame(id) { const i = typeof id === 'number' ? id : FRAMES.findIndex(l => l.id === id); if (i >= 0) setVal('frame', i); },
    set(k, v) { setVal(k, v); }, frameHero, state: S, LOOKS, POSES, FRAMES, ROWS,
    get look() { return LOOKS[S.look].id; }, get pose() { return POSES[S.pose].id; }, get frame() { return FRAMES[S.frame].id; },
    get lead() { const lp = leadPhoto(); return lp ? lp.url : null; }, get leadInfo() { const lp = leadPhoto(); return lp ? { label: lp.label, by: lp.by, t: lp.t, score: lp.score || 0 } : null; },
    get passes() { return { dof: dofPass, look: lookPass }; }, story() { const g = G(); return g ? stories(g.ledger) : []; }, log: LOG
  };
  window.SM_PHOTO = API;
  (window.SM_PLUGINS = window.SM_PLUGINS || []).push(function photo(c) {
    ctx = c; THREE = c.THREE; C = c.CONST;
    TQ = new THREE.Quaternion(); TQ2 = new THREE.Quaternion(); TV = new THREE.Vector3(); TV2 = new THREE.Vector3();
    AX = new THREE.Vector3(); UPV = new THREE.Vector3(0, 1, 0); EUL = new THREE.Euler();
    let wired = false;
    const wire = () => {
      const g = G(); if (!g || wired) return; wired = true;
      g.photo = API;
      if (g.headlineHooks) g.headlineHooks.push(storyHeadline);   // pushed: js/demo.js unshifts Metallo in front
      if (g.frontPageHooks) g.frontPageHooks.push(frontHook);
    };
    setTimeout(wire, 0);
    return { update() { wire(); scan(); } };
  });
})();
