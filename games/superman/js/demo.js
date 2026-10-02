/*
 * Flagship demo sequencer (design/dream-features.md, step 10).
 *
 * "Play the Demo" on the title screen, or ?demo in the address, runs the 20-minute arc:
 *   90 s of free flight, then the falling helicopter, the tenement fire, the bank robbery, the
 *   runaway bus, Metro Air 207 and the Metallo finale, each starting 25-40 s after the previous
 *   one ends, then the Daily Planet front page with a Metallo headline.
 * Random emergencies are held off for the whole run; street help requests still happen in the gaps.
 * All timing is sim time (the plugin update only runs while the game is unpaused).
 *
 * Debug and test API: window.SM_DEMO (also __game.demo) =
 *   { start(), stop(), active, done, chapter, ORDER, CFG, log, info() }
 */
(function () {
  window.SM_PLUGINS = window.SM_PLUGINS || [];

  const ORDER = [
    { type: 'heli', name: 'Falling Helicopter', who: 'lois', line: 'Clark, a news chopper just lost its tail rotor over midtown. If you know how to reach Superman, now would be good.' },
    { type: 'fire', name: 'Tenement Fire', who: 'jimmy', line: 'Superman! There are people on the top floors of that walk-up. The stairwell is gone!' },
    { type: 'robbery', name: 'Bank Robbery', who: 'dispatch', line: 'All units: armed robbery in progress, shots fired. Hold the perimeter until he arrives.' },
    { type: 'bus', name: 'Runaway Bus', who: 'lois', line: 'A crosstown bus lost its brakes and it is full of standing commuters. Gently, Superman.' },
    { type: 'airliner', name: 'Metro Air 207', who: 'perry', line: 'There is an airliner coming down over the bay with an engine on fire. Hold the front page.' },
    { type: 'metallo', name: 'Metallo', who: 'lois', line: 'Something metal just tore into the plaza and it is glowing green. Superman, it is Kryptonite. Stay back from it.' }
  ];
  const CFG = { firstAt: 90, gapMin: 25, gapMax: 40, paperDelay: 6, retry: 2, maxRetries: 3 };
  const S = { active: false, done: false, t: 0, i: -1, wait: 0, running: null, retries: 0, paperT: 0, log: [], shown: false };
  const G = () => window.__game;
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- HUD: chapter chip and title card
  let chip = null, card = null, cardT = 0;
  function ui() {
    if (chip || !document.body) return;
    const css = document.createElement('style');
    css.textContent = `
      #demo-chip { position: fixed; left: 50%; top: 4px; transform: translateX(-50%); z-index: 6; pointer-events: none;
        font: 700 11px/1 var(--f-ui, sans-serif); letter-spacing: .14em; text-transform: uppercase; color: #ffd76a;
        background: rgba(8, 12, 28, .72); border: 1px solid rgba(255, 215, 106, .35); border-radius: 999px; padding: 5px 12px; }
      #demo-card { position: fixed; left: 0; right: 0; top: 30%; z-index: 6; pointer-events: none; text-align: center;
        color: #fff; text-shadow: 0 2px 18px rgba(0,0,0,.85); opacity: 0; transition: opacity .6s ease; }
      #demo-card.on { opacity: 1; }
      #demo-card small { display: block; font: 700 13px/1.4 var(--f-ui, sans-serif); letter-spacing: .3em; color: #ffd76a; text-transform: uppercase; }
      #demo-card b { display: block; font: 900 clamp(30px, 5vw, 58px)/1.1 var(--f-display, Georgia, serif); letter-spacing: .04em; text-transform: uppercase; }
    `;
    document.head.appendChild(css);
    chip = document.createElement('div'); chip.id = 'demo-chip'; chip.hidden = true; document.body.appendChild(chip);
    card = document.createElement('div'); card.id = 'demo-card'; document.body.appendChild(card);
  }
  function showCard(kicker, title) {
    ui(); if (!card) return;
    card.innerHTML = `<small>${kicker}</small><b>${title}</b>`; card.classList.add('on'); cardT = 3.2;
  }
  function setChip() {
    if (!chip) return;
    chip.hidden = !S.active;
    if (!S.active) return;
    if (S.done) { chip.textContent = 'Demo complete'; return; }
    const n = S.running ? S.i + 1 : S.i + 2;
    chip.textContent = S.running ? `Demo · Chapter ${n}/${ORDER.length} · ${ORDER[S.i].name}`
      : n === 1 ? 'Demo · Free flight' : `Demo · Next: ${ORDER[Math.min(S.i + 1, ORDER.length - 1)].name}`;
  }
  function radio(who, text) { try { if (window.SM_COMMS) window.SM_COMMS.say(who, text, { prio: 2, trigger: 'demo' }); } catch (_) { /* comms optional */ } }

  // ---------------------------------------------------------------- sequencing
  function start() {
    const g = G(); if (!g) return false;
    if (!g.started) g.begin();
    Object.assign(S, { active: true, done: false, t: 0, i: -1, wait: CFG.firstAt, running: null, retries: 0, paperT: 0, log: [], shown: false });
    if (g.currentInc && g.endIncident) g.endIncident(false, 'Demo starting');
    g.deferIncident(1e9);
    ui(); showCard('Superman over Metropolis', 'The Demo');
    radio('perry', 'Kent! Get out there and keep your eyes open. Something tells me today is going to sell papers.');
    setChip();
    return true;
  }
  function stop() { S.active = false; setChip(); const g = G(); if (g) g.deferIncident(0); }

  function launch(ch) {
    const g = G();
    if (ch.type === 'metallo') { if (g.metallo) g.metallo.start(); }
    else g.startIncident(ch.type);
    const inc = g.currentInc;
    return inc && inc.type === ch.type ? inc : null;
  }

  function update(dt) {
    const g = G(); if (!g) return;
    if (cardT > 0) { cardT -= dt; if (cardT <= 0 && card) card.classList.remove('on'); }
    if (!S.active || !g.started) return;
    S.t += dt;
    g.deferIncident(1e9); // endIncident re-arms the random scheduler; keep it off for the whole demo

    if (S.running) {
      if (g.currentInc === S.running.inc) return;
      // chapter over
      const rec = S.running.rec; rec.end = +S.t.toFixed(2);
      rec.result = rec.type === 'metallo' && g.metallo && g.metallo.state.result ? g.metallo.state.result : null;
      S.running = null;
      if (S.i >= ORDER.length - 1) {
        S.done = true; S.paperT = CFG.paperDelay;
        radio('perry', 'Stop the presses. Kent, whatever you saw today, I want it on my desk in an hour.');
      } else S.wait = rand(CFG.gapMin, CFG.gapMax);
      setChip(); return;
    }

    if (S.done) {
      if (S.paperT > 0) {
        S.paperT -= dt;
        if (S.paperT <= 0 && !S.shown) { S.shown = true; showCard('Demo complete', 'Read all about it'); if (g.setPaused) g.setPaused(true); }
      }
      return;
    }

    S.wait -= dt;
    if (S.wait > 0) return;
    if (g.currentInc) { S.wait = CFG.retry; return; } // something else is running: wait for it
    const ch = ORDER[S.i + 1];
    const inc = launch(ch);
    if (!inc) {
      if (++S.retries > CFG.maxRetries) { S.i++; S.retries = 0; S.log.push({ type: ch.type, skipped: true, at: +S.t.toFixed(2) }); }
      S.wait = CFG.retry; return;
    }
    S.i++; S.retries = 0;
    const rec = { type: ch.type, start: +S.t.toFixed(2) };
    S.log.push(rec); S.running = { inc, rec };
    showCard(`Chapter ${S.i + 1} of ${ORDER.length}`, ch.name);
    setTimeout(() => radio(ch.who, ch.line), 900);
    setChip();
  }

  // ---------------------------------------------------------------- front page: the Metallo template set
  function metalloHeadline(L) {
    const g = G(), r = g && g.metallo && g.metallo.state && g.metallo.state.result;
    if (!r) return null;
    if (r.win && r.medal === 'gold') return ['MAN OF STEEL STOPS METALLO', `Kryptonite cyborg felled in ${Math.round(r.time)} s and not one bystander hurt`];
    if (r.win) return ['METALLO DOWN', `Superman tears out the Kryptonite heart · ${r.hurt || 0} hurt in the plaza battle`];
    return ['METALLO ESCAPES', `Kryptonite-hearted cyborg slips away · ${L.saves} saved, city on edge`];
  }

  // ---------------------------------------------------------------- wiring
  const API = { start, stop, ORDER, CFG, get active() { return S.active; }, get done() { return S.done; },
    get chapter() { return S.i; }, get log() { return S.log; }, get state() { return S; },
    info() { return { active: S.active, done: S.done, t: +S.t.toFixed(2), chapter: S.i, running: S.running && S.running.rec.type, log: S.log.slice() }; } };
  window.SM_DEMO = API;

  window.SM_PLUGINS.push(function demo() {
    let wired = false;
    function wire() {
      const g = G(); if (!g || wired) return; wired = true;
      g.demo = API;
      if (g.headlineHooks) g.headlineHooks.unshift(metalloHeadline);
      const btn = document.getElementById('btn-demo');
      if (btn) btn.addEventListener('click', e => { e.stopPropagation(); if (g.titleReady) start(); });
    }
    // ?demo: start the run as soon as the player starts the game
    let pending = /[?&]demo\b/.test(location.search);
    setTimeout(wire, 0);
    return { update(dt) {
      wire();
      const g = G();
      if (pending && g && g.started) { pending = false; start(); }
      update(dt);
    } };
  });
})();
