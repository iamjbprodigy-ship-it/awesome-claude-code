/* Street-level life for "Superman Over Metropolis": NPC dialogue barks and small help missions
 * with quick-time interactions.
 *
 * Design brief (coordinator task, "what a lifelong Superman fan dreams of at street level"):
 *   1. NPC dialogue: subtitle barks above heads, triggered by landing, low flight, rescues, damage,
 *      heat vision, sonic booms and the city's Hope; victims plead, robbers taunt and surrender;
 *      a procedural formant "voice blip" per line; rate-limited so it never spams.
 *   2. Help missions: a pedestrian flags you down (minimap pin + beacon), E to talk, then a task
 *      with a QTE (hold, mash, timing ring, takedown, carry, catch). One at a time, every 45-90 s,
 *      never while a major emergency is running. Each has opening/success/fail lines, a Hope
 *      reward or penalty, a ledger count, a toast and a timeout.
 *   3. Polish: kids run up and wave, phone-camera flashes, crowds gather and applaud after a
 *      rescue, a grateful person shouts from a window later.
 *
 * Contract: pushes a plugin onto window.SM_PLUGINS (update runs inside the sim, so it pauses with
 * the game). Everything else (people, ledger, toast, Hope, SFX, incidents) is read lazily from
 * window.__game at runtime. Debug / test hooks live on window.SM_MISSIONS (= __game.missions).
 * Performance: reuses the instanced pedestrians (custom poses are written straight into the
 * instance matrices), one hidden prop mesh, a pooled DOM layer; no per-frame allocations.
 */
(function () {
  'use strict';

  // ================================================================== tuning (all values here)
  const CFG = {
    spawn: {
      first: [45, 90],      // s of calm before the first help request
      every: [45, 90],      // s between requests (counted only while no emergency is running)
      minIncGap: 18,        // don't open a request if the next emergency is due sooner than this
      incDefer: 8,          // while a task is in progress the next emergency waits at least this long
      retry: 5,             // s before retrying a spawn that could not be placed
      near: [40, 170]       // distance band from Superman for the request
    },
    talkDist: 4.5,          // m: press E this close to the person waving
    flagTimeout: 90,        // s: an unanswered request quietly lapses
    flagBarkEvery: 6,       // s between "over here!" calls
    resultHold: 5,          // s the mission NPCs linger after the outcome
    types: {
      pinned: { w: 1, limit: 60, hold: 1.6, decay: 0.6, range: 3.6, reward: 4, penalty: 3, saves: true },
      beam:   { w: 1, limit: 60, tap: 0.1, holdRate: 0.35, decay: 0.3, tapWindow: 0.35, range: 3.6, reward: 5, penalty: 3, saves: true },
      ledge:  { w: 1, limit: 70, grip: 40, ring: 1.3, win: [0.16, 0.34], miss: 6, range: 4, reward: 6, penalty: 4, saves: true, h: [16, 90] },
      bay:    { w: 1, limit: 60, reward: 6, penalty: 4, saves: true, out: 16 },
      crime:  { w: 1, limit: 80, ring: 0.9, win: [0.04, 0.26], range: 3.2, grace: 2, head: 14, reward: 4, penalty: 3 },
      kid:    { w: 1, limit: 150, radius: 6, dist: [140, 300], reward: 4, penalty: 2 },
      worker: { w: 1, limit: 120, radius: 6, minHosp: 80, reward: 5, penalty: 3 },
      cat:    { w: 1, limit: 90, radius: 6, grab: 2.8, reward: 3, penalty: 1 },
      washer: { w: 1, limit: 60, snap: 3.5, slowRadius: 35, catchR: 2.6, h: [16, 32], reward: 6, penalty: 4, saves: true }
    },
    bark: {
      minGap: 1.5,          // s between any two ordinary barks
      prioGap: 0.4,         // s between priority barks (mission dialogue, victims, thanks)
      maxVisible: 3,        // bubbles on screen at once
      perPerson: 9,         // s before the same person speaks again
      dur: 2.8,             // s a bubble stays up
      maxDist: 70,          // m from the camera for ordinary barks
      recent: 18,           // lines remembered to avoid repeats
      scanHz: 5,            // ambient reaction scans per second
      catGap: { landHigh: 2.5, landMid: 2.5, landLow: 2.5, kid: 2, photo: 3, flyHigh: 6, flyLow: 6, damage: 4, heat: 5, boom: 4, plead: 5, hurt: 7, taunt: 6, passHigh: 9, passLow: 9 },
      voice: 0.05           // voice blip loudness
    },
    mood: { low: 35, high: 65 },        // Hope thresholds for city mood
    land: { radius: 25, photos: 3, minAir: 0.6, minH: 4 },
    flyover: { h: [3, 30], speed: 18, radius: 30, every: 6 },
    pass: { radius: 12, every: 8, maxSpeed: 10 },
    kids: { count: 12, hs: 0.62, ws: 0.8, runRadius: 50, minHope: 30, max: 3 },
    crowd: { max: 6, radius: 55, ring: [3.5, 6], applause: 1 },
    window: { delay: [45, 110], near: 80, maxAlt: 60, maxWait: 300, pending: 2 },
    colors: { pin: '#ff7ad9', beacon: [2.6, 0.7, 2.0] }
  };

  // ================================================================== lines (all original)
  const LINES = {
    landHigh: ["It's him! It's really him!", 'Superman! Over here!', 'Can I get a picture? Please?', 'Welcome back, big guy!', 'Best day ever!',
      'Mom, look! He landed right there!', 'We love you, Superman!', 'Thanks for everything you do!', 'Metropolis is lucky to have you!',
      "Oh wow, he's even taller in person.", 'Somebody get my camera!', 'Three cheers for our hero!', 'Look at that cape!',
      "He's smiling at me. He's smiling at me!", 'Hero of the city, right here on our block!'],
    landMid: ['Is that... Superman?', "Huh. He's real.", 'Morning, Superman.', "Don't see that every day.", 'Look who dropped in.',
      'Hey! Nice landing!', "My sister's never going to believe this.", 'Everything okay? Is something happening?',
      'Whoa, easy on the sidewalk.', 'Should we... wave?', 'He just landed next to the coffee cart!', 'Superman! Hi! Um... hi.'],
    landLow: ["Uh oh. What's he doing here?", 'Everybody stay calm.', 'Keep your distance, folks.', 'Last time he showed up, half the block came down.',
      "Who's paying for all the damage, huh?", "Please don't break anything.", "I don't trust anybody who can do that.", 'Get the kids inside.',
      'Is this another emergency? Again?', "My insurance doesn't cover flying aliens.", 'Some hero. Look at this city.',
      "Let's go. I don't want to be here when it starts.", 'Easy... nobody make any sudden moves.', 'Not again...'],
    kid: ['Superman! Superman! Can you fly me?', "I'm gonna be just like you!", 'Look! I have a cape too!', 'Is it true you can see through walls?',
      'High five! Please?', 'How fast can you go? Faster than a jet?', "My dad says you're the best!", 'Can you lift a bus? Can you?',
      'I drew you in art class!', 'Wave at me! Wave at me!', 'Whoa! Your cape is so red!', "When I grow up I'm gonna save people too!"],
    photo: ['Hold still! Got it!', 'Say cheese!', 'One more! Just one more!', 'This is going straight online.', 'Flash is on, flash is on!', 'Selfie! Quick, get in!'],
    flyHigh: ['Look! Up there!', 'There he goes!', 'Did you see that?!', "Wooo! Go get 'em!", "That's our hero!", 'Fly, Superman, fly!',
      "He's heading downtown!", 'Whoa, that was close!', 'I felt the wind from here!', 'Never gets old.'],
    flyLow: ["Slow down! You'll knock someone over!", 'Hey! This is a sidewalk!', 'Show-off.', 'My hat! He blew my hat off!',
      'Somebody should regulate that.', 'Could you not, please?'],
    thanks: ['You saved my life!', 'Thank you, Superman!', 'I thought that was it for me...', "I don't know how to thank you.",
      'You came! You actually came!', "I'll never forget this.", 'Bless you. Bless you!', 'My hands are still shaking. Thank you.',
      'I owe you everything.', "I knew you'd come.", "You're a miracle!", 'Thank you so much!', "I can't believe I'm okay.",
      'Wait till I tell my kids about this!'],
    applause: ['Bravo!', 'Way to go, Superman!', 'Did everyone see that?!', "Let's hear it for him!", 'Incredible!', "That's how it's done!",
      'Encore! Encore!', 'Now THAT is a hero.'],
    damage: ['Hey, my car!', 'Watch it!', 'That was my building!', "Who's gonna pay for that?", 'Are you kidding me?!',
      'Hey! I just had that washed!', 'Careful, pal!', 'My shop! My windows!', "That's coming out of somebody's taxes.", 'Whoa, whoa, whoa!',
      'Look at this mess!', 'There goes the neighborhood.', 'Hey, we live here!', 'Easy with the strength, big guy!'],
    heat: ['His eyes! Look at his eyes!', 'Is that laser vision?!', "Whoa, it's getting hot!", "Something's burning!",
      "Get back, he's using the heat thing!", "Don't look directly at it!", 'Melted right through!', 'That smells like toast.'],
    boom: ['What was that?!', 'My ears!', 'Was that thunder?', "Sonic boom! He's going fast!", 'Every car alarm on the block just went off.',
      'My windows are rattling!', 'The whole street shook!', 'Ow! Warn a guy next time!'],
    plead: ['Help! Somebody help!', 'Please! Over here!', "I can't hold on much longer!", 'Is anyone there?!', 'Help me! Please!',
      'Somebody call for help!', 'Please hurry!', "I can't breathe under here!", "Please, I've got kids!", 'Hello?! Can anyone hear me?!',
      'Hurry! Please!', "Don't leave me here!"],
    hurt: ['Ow... my leg...', 'I need a doctor...', 'Somebody... please...', "I can't get up...", 'It hurts...', "Help... I'm hurt..."],
    taunt: ["You can't stop all of us!", 'Back off, cape!', 'Try and catch me, flyboy!', 'Keep moving! Go, go!', "Ha! You'll never catch me!",
      "This town's ours!", 'Stay back or else!', 'Come on then!'],
    surrender: ['Okay, okay! I give up!', "Don't hurt me! I'm done!", 'Alright! Hands up, see?', 'I surrender! I surrender!', 'Fine! Take me in!',
      'Ow! Okay! You win!', "I should've stayed home today.", 'Please, just call the cops.'],
    window: ['Hey, Superman! Remember me? Thanks again!', 'Superman! I told everyone at work about you!', "That's him! That's the one who saved me!",
      "Hey! You're the best! Thanks for today!", 'Superman! Come by for dinner sometime!', 'Thank you! From all of us up here!'],
    flag: ['Superman! Over here!', 'Please, Superman, we need help!', 'Hey! Superman! Down here!', "Superman! Please, it's an emergency!",
      'Over here! Hurry!', 'Superman! Please come quick!', 'Help! This way!', 'Superman! Thank goodness!'],
    passHigh: ['Morning, Superman!', 'Keep up the good work!', 'Nice day for flying, huh?', "Hey, it's him!", "Go get 'em, Superman!",
      "You're the best!", "City's safer with you around.", 'Thanks for keeping us safe!'],
    passLow: ['Hmph.', 'Yeah, yeah. Hero.', 'Fix the street while you\'re at it.', "Shouldn't you be somewhere?", 'Who invited him?',
      'Coming through. Some of us walk.', "Can't a person get coffee in peace?", 'Big deal.'],
    cat: ['Mrrow!', 'Mew!', 'Hsss...', 'Mrrp?', 'Meow!'],
    slip: ["I'm slipping!", "My fingers! I can't feel my fingers!", 'Hurry!', "It's giving way!", 'Please, please, please...', 'Up here! Up here!'],
    caught: ['You caught me!', "Wh... I'm flying?", "Don't drop me, don't drop me!", 'I thought I was done for!', 'Wow. Wow!'],
    waveOff: ['Never mind me, go! They need you more!', "Go! There's an emergency!", "It can wait, go help them!"],
    creak: ['The cable! Did you hear that?', "It's starting to give!", 'Stay close, please!']
  };
  // per-mission dialogue: opening (two lines, a variant is picked), success, fail
  const DIALOGUE = {
    pinned: { who: 'Panicked friend', label: 'Pinned under a car', task: 'Hold E to lift the car',
      open: [["Superman! My friend - the car rolled right onto him!", 'He\'s pinned. Please, lift it off him!'],
        ['Please help! A car slid off the jack onto my buddy!', 'He can barely breathe under there!']],
      success: ["He's free! Oh, thank you, thank you!", 'You lifted it like it was nothing!'],
      fail: ['The paramedics got him out... he\'s badly hurt.', 'We waited too long. They\'re taking him to the hospital.'] },
    beam: { who: 'Site foreman', label: 'Pinned under a beam', task: 'Tap SPACE to lift the beam',
      open: [['A girder came down off the scaffold!', "Our guy's pinned under it. It weighs a ton!"],
        ['The crane dropped a steel beam!', "My partner's under it - please, lift it!"]],
      success: ['You lifted a steel beam like a fence post!', "He's okay! Everybody, he's okay!"],
      fail: ['The rescue crew had to cut him out. He\'s hurt bad.', "Too late... they're rushing him to the ER."] },
    ledge: { who: 'Witness', label: 'Dangling from a ledge', task: 'Fly up and press E inside the ring',
      open: [["Up there! Someone's hanging off the roof!", "She can't hold on much longer!"],
        ['A man slipped off the roof edge!', "He's hanging by his fingertips! Hurry!"]],
      success: ['You got them! Oh, thank goodness!', 'Pulled right back up. Unbelievable!'],
      fail: ["The fire crew's airbag caught them... barely.", 'They fell. The airbag saved them, but they\'re hurt.'] },
    bay: { who: "Driver's sister", label: 'Car in the bay', task: 'Dive, grab the car (E) and carry it ashore',
      open: [["A car went off the pier! My brother's inside!", "It's sinking! Please!"],
        ['That car skidded right into the bay!', "The driver's still in there!"]],
      success: ["He's out! He's breathing!", 'You carried the whole car out of the water!'],
      fail: ["The divers got him out. He's on his way to the hospital.", 'The harbor patrol pulled him out... barely.'] },
    crime: { who: 'Mugging victim', label: 'Purse snatcher', task: 'Catch the thief, then press E as the ring closes',
      open: [['He grabbed my purse and ran!', 'Everything I have is in there!'],
        ['Thief! He snatched my bag!', 'He went that way! Please!']],
      success: ['My purse! Thank you, Superman!', "Everything's still here. You're amazing!"],
      fail: ["He's gone... and so is my rent money.", 'He got away. Thanks for trying.'] },
    kid: { who: 'Lost kid', label: 'Lost kid', task: 'Carry the kid (E) to their parent',
      open: [["I can't find my mom...", "She was right here and then she wasn't..."],
        ['I got lost on the way to the park...', "My dad's gonna be so worried..."]],
      success: ['My baby! Oh, thank you!', 'There you are! Thank you, Superman!'],
      fail: ['The police found them... after a very long cry.', 'An officer is bringing the kid home. Too slow, this time.'] },
    worker: { who: 'Coworker', label: 'Injured worker', task: 'Carry him (E) to the hospital pad',
      open: [['My buddy fell off the ladder! His leg is broken!', 'The ambulance is stuck in traffic!'],
        ['One of our crew is hurt bad!', 'Can you get him to the hospital? Fast?']],
      success: ['The doctors have him. You\'re a lifesaver.', 'Straight to the ER! Thanks, Superman!'],
      fail: ['The ambulance finally got him... he\'s in rough shape.', "Took too long. He'll pull through, but it's bad."] },
    cat: { who: 'Cat owner', label: 'Cat up a tree', task: 'Fly up, press E to take the cat, E again by the owner',
      open: [["My cat's stuck up in that tree!", "She's been crying for an hour!"],
        ["Whiskers climbed the tree and won't come down!", 'Could you... maybe... float up there?']],
      success: ["Whiskers! You're safe! Thank you, Superman!", "Oh, she's purring! She likes you!"],
      fail: ['The fire department finally got her down.', "She jumped... and ran off. I'll find her."] },
    washer: { who: "Window washer's partner", label: 'Scaffold cable', task: 'Stay close and catch him if he falls',
      open: [["The scaffold cable's fraying! My partner's up there!", 'If it snaps...'],
        ["Hey! The rigging up there's giving out!", "Please, stay close! It's gonna go!"]],
      success: ['You caught him! Out of thin air!', "He's okay! You actually caught him!"],
      fail: ['The awning broke his fall... he\'s hurt.', 'He hit the awning. Alive, but hurt.'] }
  };
  const TYPES = Object.keys(CFG.types);
  const TONE = { landHigh: 'cheer', landMid: '', landLow: 'fear', kid: 'kid', photo: 'cheer', flyHigh: 'cheer', flyLow: 'fear', thanks: 'thanks',
    applause: 'cheer', damage: 'fear', heat: 'fear', boom: 'fear', plead: 'plead', hurt: 'plead', taunt: 'thug', surrender: 'thug',
    window: 'thanks', flag: 'plead', passHigh: 'cheer', passLow: 'fear', cat: 'cat', slip: 'plead', caught: 'thanks', waveOff: '', creak: 'plead', say: '' };

  // ================================================================== mission state machine
  // Every mission walks idle -> flag -> talk -> active -> success | fail -> idle; a request nobody
  // answers (or one waved off for an emergency) goes flag -> expired -> idle.
  const TRANSITIONS = {
    idle: ['flag'], flag: ['talk', 'expired'], talk: ['active'], active: ['success', 'fail'],
    success: ['idle'], fail: ['idle'], expired: ['idle']
  };

  // ================================================================== module state
  let THREE = null, C = null, ctx = null, ready = false;
  let V3, UP, ZAX, XAX;
  let M = null;                  // the one mission in flight
  let spawnT = 0, clock = 0, scanT = 0, lastType = '';
  const held = { KeyE: false, Space: false };
  const later = [];              // [{at, fn}] game-clock callbacks (pause with the game)
  const runners = [];            // people jogging somewhere: {p, x, z, then}
  const shouts = [];             // pending window shouts: {at, until}
  const kids = [];
  const stats = { spawned: 0, success: 0, fail: 0, expired: 0, byType: {} };
  // reaction trackers
  const ev = { air: false, airT: 0, lastSaves: 0, lastDamage: 0, heatT: 0, heatOn: false, boomed: false, flyT: 0, passT: 0, cuffed: new Set(), seen: false };
  let trees = null;              // [{x, z, top}] tree positions (sidewalk trees from streets.js)
  let prop = null;               // the single prop mesh (beam, scaffold plank or cat)
  // scratch (no per-frame allocations)
  let T1, T2, TQ, TQ2, TM, TL, TR, TS, TP;

  // ================================================================== small helpers
  const R = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const G = () => window.__game;
  const hd2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
  function mood() { const h = G().ledger.hope; return h < CFG.mood.low ? 'low' : h >= CFG.mood.high ? 'high' : 'mid'; }
  function at(sec, fn) { later.push({ at: clock + sec, fn }); }
  function canStand(p) { return p && p.mode !== 'gone' && p.mode !== 'safe'; }

  // ================================================================== DOM: bubbles, card, QTE prompt, marker, HUD row
  const UI = {};
  function buildDOM() {
    const hud = document.getElementById('hud'); if (!hud || UI.barks) return;
    UI.barks = document.createElement('div'); UI.barks.id = 'barks'; hud.appendChild(UI.barks);
    UI.pool = [];
    for (let i = 0; i < CFG.bark.maxVisible + 1; i++) {
      const el = document.createElement('div'); el.className = 'bark'; UI.barks.appendChild(el);
      UI.pool.push({ el, on: false, p: null, anchor: null, until: 0, t0: 0, prio: false, x: -1, y: -1, cls: '' });
    }
    UI.card = document.createElement('div'); UI.card.id = 'msn-card'; UI.card.hidden = true;
    UI.card.innerHTML = '<div class="who"></div><p class="l1"></p><p class="l2"></p>';
    hud.appendChild(UI.card);
    UI.qte = document.createElement('div'); UI.qte.id = 'msn-qte'; UI.qte.hidden = true;
    UI.qte.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="q-track" cx="50" cy="50" r="40"/>' +
      '<circle class="q-win" cx="50" cy="50" r="10"/><circle class="q-arc" cx="50" cy="50" r="40"/>' +
      '<circle class="q-ring" cx="50" cy="50" r="40"/><text class="q-key" x="50" y="51">E</text></svg><div class="cap"></div><div class="sub"></div>';
    hud.appendChild(UI.qte);
    UI.qArc = UI.qte.querySelector('.q-arc'); UI.qWin = UI.qte.querySelector('.q-win'); UI.qRing = UI.qte.querySelector('.q-ring');
    UI.qKey = UI.qte.querySelector('.q-key'); UI.qCap = UI.qte.querySelector('.cap'); UI.qSub = UI.qte.querySelector('.sub');
    const mk = document.getElementById('markers');
    UI.mk = document.createElement('div'); UI.mk.className = 'mk help'; UI.mk.innerHTML = '<span></span><b></b>'; UI.mk.style.display = 'none';
    if (mk) mk.appendChild(UI.mk);
    const rows = document.querySelector('#tr .rows');
    if (rows) {
      const s = document.createElement('span'); s.textContent = 'Help requests';
      UI.row = document.createElement('b'); UI.row.id = 'st-help'; UI.row.textContent = '0';
      rows.appendChild(s); rows.appendChild(UI.row);
    }
    const legend = document.querySelector('.map-legend ul');
    if (legend) { const li = document.createElement('li'); li.innerHTML = '<i class="lg help"></i>Help request'; legend.appendChild(li); }
    UI.cardT = 0; UI.rowTxt = '';
  }
  function showCard(who, l1, l2, sec) {
    if (!UI.card) return;
    UI.card.querySelector('.who').textContent = who || '';
    UI.card.querySelector('.l1').textContent = l1 || '';
    UI.card.querySelector('.l2').textContent = l2 || '';
    UI.card.hidden = false; UI.card.classList.remove('out'); UI.cardT = sec || 4.5;
  }

  // ================================================================== voice blips (WebAudio formant chirps)
  const FORMANTS = [[730, 1090], [270, 2290], [530, 1840], [300, 870], [660, 1720], [490, 1350]];
  function voice(text, who, loud) {
    const g = G(), AU = g && g.AU;
    if (!AU || !AU.ctx || AU.muted || !AU.master || AU.ctx.state === 'closed') return;
    try {
      const c = AU.ctx, t0 = c.currentTime + 0.02, kid = who && who.kid;
      const n = clamp(Math.round(text.length / 7), 2, 8), step = kid ? 0.095 : 0.11;
      const base = kid ? R(300, 380) : who ? 105 + ((who.id * 37) % 130) : 170;
      const cam = g.camera.position, d = who ? Math.sqrt((who.pos.x - cam.x) ** 2 + (who.pos.z - cam.z) ** 2) : 20;
      const vol = CFG.bark.voice * (loud || 1) / (1 + d / 25);
      const o = c.createOscillator(); o.type = 'sawtooth';
      const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 5;
      const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 7;
      const gn = c.createGain(); gn.gain.setValueAtTime(0, t0);
      o.connect(f1); o.connect(f2); f1.connect(gn); f2.connect(gn); gn.connect(AU.master);
      const k = kid ? 1.25 : 1;
      for (let i = 0; i < n; i++) {
        const t = t0 + i * step, fm = pick(FORMANTS), f = base * (1 + R(-0.1, 0.16)) * (i === n - 1 && text.endsWith('?') ? 1.25 : 1);
        o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * R(0.9, 1.05), t + step * 0.8);
        f1.frequency.setValueAtTime(fm[0] * k, t); f2.frequency.setValueAtTime(fm[1] * k, t);
        gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(vol, t + 0.015); gn.gain.linearRampToValueAtTime(0, t + step * 0.85);
      }
      o.start(t0); o.stop(t0 + n * step + 0.05);
    } catch (_) { /* audio is optional */ }
  }
  function applause(n) {
    const g = G(), AU = g && g.AU; if (!AU || !AU.ctx || AU.muted || !AU.noise) return;
    try {
      const c = AU.ctx, t0 = c.currentTime + 0.05;
      for (let i = 0; i < 16 * n; i++) {
        const t = t0 + R(0, 2.2), s = c.createBufferSource(); s.buffer = AU.noise;
        const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = R(1400, 2600); f.Q.value = 1.2;
        const gg = c.createGain(); gg.gain.setValueAtTime(0.0001, t); gg.gain.linearRampToValueAtTime(R(0.05, 0.1), t + 0.004); gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        s.connect(f); f.connect(gg); gg.connect(AU.master); s.start(t, R(0, 1.5)); s.stop(t + 0.1);
      }
    } catch (_) { /* optional */ }
  }

  // ================================================================== barks
  const recent = [];
  const lastCat = {};
  const barkLog = [];            // [{t, cat, prio}] for tests
  let lastAny = -99, lastPrio = -99;
  function chooseLine(cat) {
    const list = LINES[cat]; if (!list || !list.length) return '';
    for (let k = 0; k < 6; k++) { const l = pick(list); if (!recent.includes(l)) return l; }
    return pick(list);
  }
  // who: a person (or null with opts.anchor); returns true if the bubble was shown
  function bark(who, cat, opts) {
    opts = opts || {};
    const g = G(); if (!g || !g.started || !UI.pool) return false;
    const prio = !!opts.prio, B = CFG.bark;
    if (prio ? clock - lastPrio < B.prioGap : clock - lastAny < B.minGap) return false;
    if (!prio && clock - (lastCat[cat] || -99) < (B.catGap[cat] || 4)) return false;
    if (who && !prio && clock - (who.barkT || -99) < B.perPerson) return false;
    const pos = who ? who.pos : opts.anchor; if (!pos) return false;
    const cam = g.camera.position;
    if (!prio && (pos.x - cam.x) ** 2 + (pos.y - cam.y) ** 2 + (pos.z - cam.z) ** 2 > B.maxDist * B.maxDist) return false;
    // a free bubble, or (for priority lines) the oldest ordinary one
    let slot = null, oldest = null;
    let vis = 0; for (const b of UI.pool) if (b.on) vis++;
    for (const b of UI.pool) {
      if (!b.on) { if (!slot) slot = b; continue; }
      if (!b.prio && (!oldest || b.t0 < oldest.t0)) oldest = b;
    }
    if (vis >= B.maxVisible) { if (!prio || !oldest) return false; hideBubble(oldest); slot = oldest; }
    if (!slot) return false;
    const text = opts.text || chooseLine(cat); if (!text) return false;
    recent.push(text); if (recent.length > B.recent) recent.shift();
    slot.on = true; slot.p = who; slot.anchor = who ? null : pos; slot.prio = prio; slot.t0 = clock; slot.until = clock + (opts.dur || B.dur + text.length * 0.02);
    slot.lift = opts.lift || 0;
    const cls = 'bark on ' + (opts.tone !== undefined ? opts.tone : TONE[cat] || '') + (who && who.kid ? ' small' : '');
    slot.el.className = cls; slot.el.textContent = text; slot.x = slot.y = -1;
    lastAny = clock; if (prio) lastPrio = clock; lastCat[cat] = clock; if (who) who.barkT = clock;
    barkLog.push({ t: clock, cat, prio, text }); if (barkLog.length > 200) barkLog.shift();
    if (cat !== 'cat') voice(text, who, prio ? 1.3 : 1);
    if (cat === 'photo' && who) flash(who);
    return true;
  }
  function hideBubble(b) { b.on = false; b.p = null; b.anchor = null; b.el.className = 'bark'; }
  function updateBubbles(g, camera) {
    const w = innerWidth, h = innerHeight;
    for (const b of UI.pool) {
      if (!b.on) continue;
      if (clock > b.until || (b.p && (b.p.mode === 'gone' || b.p.mode === 'safe'))) { hideBubble(b); continue; }
      const p = b.p;
      if (p) T1.set(p.pos.x, p.pos.y + (p.mode === 'msn' && p.msnPose === 'lying' ? 0.7 : 1.05 * (p.hs || 1) - (p.kid ? 0.25 : 0)) + b.lift, p.pos.z);
      else T1.copy(b.anchor);
      T1.project(camera);
      if (T1.z > 1 || T1.x < -1.2 || T1.x > 1.2 || T1.y < -1.2 || T1.y > 1.2) { if (b.el.style.visibility !== 'hidden') b.el.style.visibility = 'hidden'; continue; }
      if (b.el.style.visibility) b.el.style.visibility = '';
      const x = clamp((T1.x * 0.5 + 0.5) * w, 80, w - 80) | 0, y = clamp((-T1.y * 0.5 + 0.5) * h, 40, h - 40) | 0;
      if (x !== b.x || y !== b.y) { b.x = x; b.y = y; b.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`; }
    }
  }
  function flash(p) {
    const fx = G().FX; if (!fx) return;
    fx.flash(p.pos.x + Math.cos(p.face) * 0.3, p.pos.y + 0.45 * (p.hs || 1), p.pos.z + Math.sin(p.face) * 0.3);
  }

  // nearest people matching a filter (horizontal distance), written into `out` (reused)
  const near = [];
  function gather(center, radius, filter, max) {
    near.length = 0; const r2 = radius * radius;
    for (const p of G().people) {
      if (!filter(p)) continue;
      const d2 = hd2(p.pos, center); if (d2 > r2) continue;
      p._d2 = d2; near.push(p);
    }
    near.sort((a, b) => a._d2 - b._d2);
    if (near.length > max) near.length = max;
    return near;
  }
  const isPed = p => (p.mode === 'free' || p.mode === 'cheer') && !p.thug && !p.msnRole;
  function barkNearest(center, radius, cat, opts) {
    const list = gather(center, radius, isPed, 4);
    for (const p of list) if (bark(p, cat, opts)) return p;
    return null;
  }

  // ================================================================== city reactions
  function onLand(g) {
    const P = g.P, md = mood(), L = CFG.land;
    const list = gather(P.pos, L.radius, isPed, 8).slice();
    if (!list.length) return;
    const cat = md === 'high' ? 'landHigh' : md === 'low' ? 'landLow' : 'landMid';
    for (const p of list) if (bark(p, cat, { prio: !ev.seen })) break;
    ev.seen = true;
    if (md === 'low') {
      // skeptical crowd: a few people back away
      let n = 0; for (const p of list) { if (p.kid || n >= 3 || p.mode !== 'free') continue; p.fleeT = 2.5; p.dir.set(p.pos.x - P.pos.x, 0, p.pos.z - P.pos.z).normalize(); n++; }
      return;
    }
    // phones come out: a few stop, face him and snap photos (cheer mode flashes its camera)
    let ph = 0;
    for (const p of list) {
      if (ph >= L.photos || p.kid || p.mode !== 'free') continue;
      p.mode = 'cheer'; p.cheerT = R(3, 5); p.photoT = R(0, 0.6); ph++;
      if (ph === 1) at(0.6, () => bark(p, 'photo'));
      flash(p);
    }
    // kids run up and wave
    if (G().ledger.hope >= CFG.kids.minHope) {
      let k = 0;
      for (const kd of kids) {
        if (k >= CFG.kids.max || kd.mode !== 'free' || kd.msnRole) continue;
        if (hd2(kd.pos, P.pos) > CFG.kids.runRadius * CFG.kids.runRadius) continue;
        const a = R(0, 6.28), r = R(1.8, 2.8);
        runTo(kd, P.pos.x + Math.cos(a) * r, P.pos.z + Math.sin(a) * r, 'kid'); k++;
      }
    }
  }
  function runTo(p, x, z, then) {
    for (const r of runners) if (r.p === p) { r.x = x; r.z = z; r.then = then; return; }
    if (runners.length >= 12) return;
    runners.push({ p, x, z, then, t: 0 });
  }
  function updateRunners(dt) {
    for (let i = runners.length - 1; i >= 0; i--) {
      const r = runners[i], p = r.p; r.t += dt;
      if (p.mode !== 'free' || r.t > 20) { runners.splice(i, 1); continue; }
      const dx = r.x - p.pos.x, dz = r.z - p.pos.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < 0.8) {
        runners.splice(i, 1);
        p.mode = 'cheer'; p.cheerT = R(4, 7); p.photoT = p.kid ? 99 : R(0.3, 1.5);
        if (r.then === 'kid') bark(p, 'kid');
        else if (r.then === 'crowd') { if (!ev.applauded) { ev.applauded = true; applause(CFG.crowd.applause); bark(p, 'applause', { prio: true }); } }
        continue;
      }
      p.dir.set(dx / d, 0, dz / d); p.fleeT = 0.3;
    }
  }
  function onRescue(g, pos) {
    const thank = gather(pos, 12, p => (p.mode === 'free' || p.mode === 'cheer' || p.mode === 'phys') && !p.thug, 1)[0];
    if (thank) bark(thank, 'thanks', { prio: true });
    // a crowd gathers in a loose ring and applauds
    ev.applauded = false;
    const list = gather(pos, CFG.crowd.radius, p => p.mode === 'free' && !p.thug && !p.msnRole && p !== thank, CFG.crowd.max);
    let i = 0;
    for (const p of list) {
      const a = (i++ / Math.max(1, list.length)) * 6.28 + R(-0.3, 0.3), r = R(CFG.crowd.ring[0], CFG.crowd.ring[1]);
      runTo(p, pos.x + Math.cos(a) * r, pos.z + Math.sin(a) * r, 'crowd');
    }
    // and somebody remembers it later
    if (shouts.length < CFG.window.pending) shouts.push({ at: clock + R(CFG.window.delay[0], CFG.window.delay[1]), until: clock + CFG.window.maxWait });
  }
  function updateShouts(g) {
    if (!shouts.length) return;
    const s = shouts[0], P = g.P;
    if (clock < s.at) return;
    if (clock > s.until) { shouts.shift(); return; }
    if (P.pos.y > CFG.window.maxAlt) return;
    let best = null, bd = CFG.window.near * CFG.window.near;
    for (const b of g.buildings) {
      const cx = clamp(P.pos.x, b.x0, b.x1), cz = clamp(P.pos.z, b.z0, b.z1), d2 = (cx - P.pos.x) ** 2 + (cz - P.pos.z) ** 2;
      if (d2 < bd && d2 > 25 && b.h > 10) { bd = d2; best = b; }
    }
    if (!best) return;
    // a window on the face toward him, a few storeys up
    const x = clamp(P.pos.x, best.x0 + 2, best.x1 - 2), z = clamp(P.pos.z, best.z0 + 2, best.z1 - 2);
    const ox = P.pos.x < best.x0 ? -0.4 : P.pos.x > best.x1 ? 0.4 : 0, oz = P.pos.z < best.z0 ? -0.4 : P.pos.z > best.z1 ? 0.4 : 0;
    const y = clamp(P.pos.y + R(4, 10), 6, best.h - 3);
    const fx = ox < 0 ? best.x0 + ox : ox > 0 ? best.x1 + ox : x, fz = oz < 0 ? best.z0 + oz : oz > 0 ? best.z1 + oz : z;
    if (g.blockAt(fx - ox * 3, y, fz - oz * 3) < 0) return;
    const anchor = new V3(fx, y, fz);
    if (bark(null, 'window', { anchor, prio: true, tone: 'window', dur: 4 })) shouts.shift();
  }

  // per-frame event detection (cheap) and a 5 Hz ambient scan
  function detectEvents(g, dt) {
    const P = g.P, L = g.ledger, gy = g.groundY(P.pos.x, P.pos.z), h = P.pos.y - Math.max(gy, 0);
    // landing
    if (h > CFG.land.minH) { ev.air = true; ev.airT += dt; }
    else if (ev.air && h < 1.3 && (P.grounded || !P.flying)) { const long = ev.airT > CFG.land.minAir; ev.air = false; ev.airT = 0; if (long) onLand(g); }
    // rescues (ledger saves) and property damage
    if (L.saves > ev.lastSaves) { ev.lastSaves = L.saves; onRescue(g, P.pos); }
    if (L.damage - ev.lastDamage > 20000) {
      ev.lastDamage = L.damage;
      let car = false; for (const c of g.cars) if (!c.dead && c.wreck && hd2(c.pos, P.pos) < 400) { car = true; break; }
      barkNearest(P.pos, 45, 'damage', car ? { text: pick(['Hey, my car!', 'My car! My beautiful car!', 'That was my car!', 'Hey, my car!']) } : null);
    } else if (L.damage < ev.lastDamage) ev.lastDamage = L.damage;
    // heat vision and sonic booms
    const heat = !!g.heatOn;
    if (heat) { ev.heatT -= dt; if (!ev.heatOn || ev.heatT <= 0) { ev.heatT = 5; barkNearest(P.pos, 45, 'heat'); } }
    ev.heatOn = heat;
    if (P.boomed && !ev.boomed) at(0.5, () => barkNearest(P.pos, 140, 'boom', { prio: false }));
    ev.boomed = P.boomed;
  }
  function scan(g) {
    const P = g.P, sp = P.vel.length(), gy = Math.max(0, g.groundY(P.pos.x, P.pos.z)), h = P.pos.y - gy, md = mood();
    const step = 1 / CFG.bark.scanHz;
    // low flight over a crowd
    ev.flyT -= step;
    if (P.flying && h > CFG.flyover.h[0] && h < CFG.flyover.h[1] && sp > CFG.flyover.speed && ev.flyT <= 0) {
      if (barkNearest(P.pos, CFG.flyover.radius, md === 'low' ? 'flyLow' : 'flyHigh')) ev.flyT = CFG.flyover.every;
    }
    // walking past people: the city's mood in a sentence
    ev.passT -= step;
    if (!P.flying && h < 1.5 && sp < CFG.pass.maxSpeed && ev.passT <= 0) {
      ev.passT = CFG.pass.every * R(0.7, 1.3);
      if (md !== 'mid' || Math.random() < 0.5) barkNearest(P.pos, CFG.pass.radius, md === 'low' ? 'passLow' : 'passHigh');
    }
    // victims and robbers in the major emergencies
    for (const p of g.people) {
      if (p.mode === 'gone' || p.msnRole) continue;
      if (p.thug) {
        if (p.cuffed && !ev.cuffed.has(p)) { ev.cuffed.add(p); if (hd2(p.pos, P.pos) < 3600) bark(p, 'surrender', { prio: true }); }
        else if (!p.cuffed && p.mode === 'thug' && hd2(p.pos, P.pos) < 2500 && Math.random() < 0.08) bark(p, 'taunt');
        continue;
      }
      if (p.mode === 'trapped' && (p.pos.x - P.pos.x) ** 2 + (p.pos.y - P.pos.y) ** 2 + (p.pos.z - P.pos.z) ** 2 < 2025 && Math.random() < 0.1) bark(p, 'plead');
      else if (p.mode === 'down' && hd2(p.pos, P.pos) < 900 && Math.random() < 0.06) bark(p, 'hurt');
    }
    if (ev.cuffed.size > 40) ev.cuffed.clear();
    // keep the kids kid-sized (a reused slot may have become something else)
    for (let i = kids.length - 1; i >= 0; i--) { const k = kids[i]; if (k.thug || k.mode === 'gone' || !k.kid) { k.kid = false; k.hs = 1; k.ws = 1; kids.splice(i, 1); } }
    // grateful people shout from windows
    updateShouts(g);
  }

  // ================================================================== posing (writes straight into the instanced people)
  // matches game.js placePart(): local +X forward, arms/legs swing about Z
  function part(mesh, slot, base, px, py, pz, ang) {
    TL.makeTranslation(px, py, pz); if (ang) TL.multiply(TR.makeRotationZ(ang));
    TM.multiplyMatrices(base, TL); mesh.setMatrixAt(slot, TM);
  }
  const BASE = { m: null };
  function posePerson(g, p, kind, t) {
    const PPL = g.PPL; if (!PPL) return;
    let legA = 0, aL = 0.08, aR = 0.08, upright = true;
    TQ.setFromAxisAngle(UP, -p.face); TP.copy(p.pos);
    switch (kind) {
      case 'wave': aR = Math.PI * 0.85 + Math.sin(t * 9) * 0.35; aL = 0.15 + Math.sin(t * 9 + 1) * 0.1; TP.y += Math.abs(Math.sin(t * 4.5)) * 0.05; break;
      case 'plead': aL = Math.PI * 0.9 + Math.sin(t * 6) * 0.3; aR = Math.PI * 0.9 - Math.sin(t * 6) * 0.3; break;
      case 'hang': aL = Math.PI * 0.98 + Math.sin(t * 3) * 0.03; aR = Math.PI * 0.98 - Math.sin(t * 3.4) * 0.03; legA = Math.sin(t * 2.3) * 0.3; upright = false; break;
      case 'fall': aL = 2.4 + Math.sin(t * 13) * 0.8; aR = 2.4 + Math.cos(t * 12) * 0.8; legA = Math.sin(t * 11) * 0.6; upright = false; break;
      case 'lying': TQ.multiply(TQ2.setFromAxisAngle(ZAX, Math.PI / 2)); aL = 2.6 + Math.sin(t * 3) * 0.35; aR = 0.3; legA = Math.sin(t * 2) * 0.1; upright = false; break;
      case 'cower': aL = aR = 2.3 + Math.sin(t * 8) * 0.1; TP.y -= 0.12; break;
      case 'grip': aL = aR = 0.9; break;   // holding the scaffold rail
      default: break;
    }
    if (upright && p.kid) TP.y -= 0.9 * (1 - (p.hs || 1));
    TM.compose(TP, TQ, TS.set(p.ws || 1, p.hs || 1, p.ws || 1));
    const base = BASE.m || (BASE.m = new THREE.Matrix4()); base.copy(TM);
    const s = p.slot;
    part(PPL.torso, s, base, 0, 0, 0, 0); part(PPL.hips, s, base, 0, 0, 0, 0);
    part(PPL.head, s, base, 0, 0, 0, 0); part(PPL.hair, s, base, 0, 0, 0, 0);
    part(PPL.legL, s, base, 0, -0.06, -0.095, legA); part(PPL.legR, s, base, 0, -0.06, 0.095, -legA);
    part(PPL.armL, s, base, 0, 0.5, -0.235, aL); part(PPL.armR, s, base, 0, 0.5, 0.235, aR);
  }
  const UPRIGHT = { free: 1, cheer: 1, msn: 1, thug: 1, trapped: 1 };
  function applyPoses(g) {
    const PPL = g.PPL; if (!PPL) return;
    let dirty = false;
    if (M) for (const p of M.npcs) {
      if (!p.msnPose || (p.mode !== 'msn' && p.mode !== 'trapped')) continue;
      posePerson(g, p, p.msnPose, clock + p.slot); dirty = true;
    }
    // kids: lower the whole figure so the scaled-down body stands on the pavement
    for (const k of kids) {
      if (!UPRIGHT[k.mode] || (k.msnPose && (k.mode === 'msn' || k.mode === 'trapped'))) continue;
      const off = 0.9 * (1 - k.hs), i = k.slot * 16 + 13;
      for (const name in PPL) PPL[name].instanceMatrix.array[i] -= off;
      dirty = true;
    }
    if (dirty) for (const name in PPL) PPL[name].instanceMatrix.needsUpdate = true;
  }

  // ================================================================== world helpers for placing missions
  function lotsNear(g, P, min, max, filter) {
    const out = [];
    for (const L of ctx.lotInfo) {
      if (filter && !filter(L)) continue;
      const d = Math.hypot(L.lx + 20 - P.x, L.lz + 20 - P.z);
      if (d >= min && d <= max) out.push(L);
    }
    if (!out.length) for (const L of ctx.lotInfo) if (!filter || filter(L)) out.push(L);
    return out;
  }
  function center(g) { const P = g.P.pos; return Math.abs(P.x) > 400 || P.z < -400 || P.z > 400 ? T2.set(0, 0, 0) : T2.set(P.x, 0, P.z); }
  function sidewalk(L, out) {
    const r = R(1.6, 38.4), side = Math.floor(R(0, 4));
    if (side === 0) out.set(L.lx + r, 0, L.lz + 1.6); else if (side === 1) out.set(L.lx + r, 0, L.lz + 38.4);
    else if (side === 2) out.set(L.lx + 1.6, 0, L.lz + r); else out.set(L.lx + 38.4, 0, L.lz + r);
    return out;
  }
  function freeSpot(g, x, z) { return g.blockAt(x, 1, z) < 0 && z < C.WATER_Z - 3; }
  function topInset(b) { let ins = 0; for (const t of b.tiers) if (b.ny - 1 >= t.y) ins = t.ins; return ins; }
  function tierTop(b) { return b.tiers.length > 1 ? b.tiers[1].y * C.STORY : b.h; }
  // a face of building b (inset by `ins` cells): the one facing Superman
  function faceToward(b, ins, P) {
    const x0 = b.x0 + ins * C.CELL, x1 = b.x1 - ins * C.CELL, z0 = b.z0 + ins * C.CELL, z1 = b.z1 - ins * C.CELL;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, dx = P.x - cx, dz = P.z - cz;
    if (Math.abs(dx) > Math.abs(dz)) return dx < 0 ? { nx: -1, nz: 0, x: x0, z: (z0 + z1) / 2, half: (z1 - z0) / 2 } : { nx: 1, nz: 0, x: x1, z: (z0 + z1) / 2, half: (z1 - z0) / 2 };
    return dz < 0 ? { nx: 0, nz: -1, x: (x0 + x1) / 2, z: z0, half: (x1 - x0) / 2 } : { nx: 0, nz: 1, x: (x0 + x1) / 2, z: z1, half: (x1 - x0) / 2 };
  }
  function findTrees(g) {
    trees = [];
    const tm = g.scene.getObjectByName('streets:tree-trunk');
    if (tm && tm.isInstancedMesh) {
      const a = tm.instanceMatrix.array;
      for (let i = 0; i < tm.count; i++) { const o = i * 16; trees.push({ x: a[o + 12], z: a[o + 14], top: a[o + 13] + 3.0 * Math.hypot(a[o + 4], a[o + 5], a[o + 6]) + 0.6 }); }
    }
  }
  function npc(g, mode, x, z, opts) {
    const y = g.groundY(x, z) + 0.9;
    const p = g.placePerson(mode, T1.set(x, y, z), { thug: !!(opts && opts.thug) });
    if (!p) return null;
    p.hs = (opts && opts.hs) || 1; p.ws = (opts && opts.ws) || 1; p.kid = !!(opts && opts.kid);
    p.msnRole = (opts && opts.role) || 'npc'; p.msnPose = (opts && opts.pose) || 'stand';
    p.fleeT = 0; p.cheerT = 0; p.injured = false; p.vel.set(0, 0, 0); p.sleeping = false;
    if (p.kid && !kids.includes(p)) kids.push(p);
    M.npcs.push(p);
    return p;
  }
  function freeNpc(g, p, mode) {
    if (!p) return;
    p.msnRole = null; p.msnPose = null;
    if (p.mode === 'held' || p.mode === 'gone' || p.mode === 'safe' || p.mode === 'phys') return;
    if (mode === 'gone') { p.mode = 'gone'; return; }
    if (p.mode === 'thug') return;     // cuffed robber: leave him kneeling for the police
    p.mode = mode || 'free'; p.pos.y = g.groundY(p.pos.x, p.pos.z) + 0.9; p.quat.identity();
    if (p.mode === 'cheer') { p.cheerT = R(4, 7); p.photoT = 99; }
  }
  function faceTo(p, x, z) { p.face = Math.atan2(z - p.pos.z, x - p.pos.x); }
  function showProp(kind, x, y, z, yaw) {
    const m = prop; if (!m) return;
    m.visible = true; m.position.set(x, y, z); m.rotation.set(0, yaw || 0, 0);
    if (kind === 'beam') { m.scale.set(0.42, 0.5, 6.4); m.material.color.setRGB(0.09, 0.1, 0.11); m.material.roughness = 0.55; m.material.metalness = 0.6; }
    else if (kind === 'plank') { m.scale.set(1.0, 0.14, 4.0); m.material.color.setRGB(0.32, 0.34, 0.36); m.material.roughness = 0.7; m.material.metalness = 0.3; }
    else if (kind === 'cat') { m.scale.set(0.24, 0.26, 0.5); m.material.color.setRGB(0.7, 0.3, 0.07); m.material.roughness = 0.9; m.material.metalness = 0; }
  }
  function hideProp() { if (prop) prop.visible = false; }

  // ================================================================== mission definitions
  // setup(g, m) places everything and returns true; start(m) runs after the talk; update(g, m, dt, du)
  // drives the task and calls win()/lose(); key(g, m, code) returns true to consume a key.
  const DEF = {
    pinned: {
      setup(g, m) { return setupPinned(g, m, 'car'); },
      start(g, m) { m.phase = 'lift'; },
      key(g, m, code) { if (code === 'KeyE' && near3(g.P.pos, m.victim.pos, m.cfg.range)) { m.lifting = true; return true; } return false; },
      update(g, m, dt, du) {
        const inR = near3(g.P.pos, m.victim.pos, m.cfg.range);
        if (m.car && (m.car.dead || hd2(m.car.pos, m.victim.pos) > 9 && !m.car.sleeping)) { m.prog = 1; }
        if (inR && held.KeyE) m.prog = Math.min(1, m.prog + du / m.cfg.hold); else m.prog = Math.max(0, m.prog - du * m.cfg.decay);
        if (m.car && !m.car.dead && m.car.sleeping) m.car.pos.y = m.carY + m.prog * 0.9;
        m.qte = inR ? { kind: 'hold', key: 'E', p: m.prog, cap: 'Hold E', sub: 'Lift the car' } : null;
        m.hint = inR ? null : 'Get to them';
        if (Math.random() < 0.15 * dt) bark(m.victim, 'plead', { prio: true });
        if (m.prog >= 1) {
          if (m.car && !m.car.dead) { const c = m.car; c.sleeping = false; c.parked = false; c.vel.set(m.side.x * 5, 6, m.side.z * 5); c.angVel.set(R(-1, 1), 0, R(-1, 1)); }
          freeVictim(g, m); win(g, m);
        }
      }
    },
    beam: {
      setup(g, m) { return setupPinned(g, m, 'beam'); },
      start(g, m) { m.phase = 'lift'; m.lastTap = -9; },
      key(g, m, code) {
        if (code === 'Space' && near3(g.P.pos, m.victim.pos, m.cfg.range)) { m.prog = Math.min(1, m.prog + m.cfg.tap); m.lastTap = clock; m.tapFx = 0.15; return true; }
        return false;
      },
      update(g, m, dt, du) {
        const inR = near3(g.P.pos, m.victim.pos, m.cfg.range);
        if (inR && held.Space) m.prog = Math.min(1, m.prog + du * m.cfg.holdRate);
        else if (clock - m.lastTap > m.cfg.tapWindow) m.prog = Math.max(0, m.prog - du * m.cfg.decay);
        if (prop) prop.position.y = m.propY + m.prog * 1.1;
        m.qte = inR ? { kind: 'mash', key: 'SPACE', p: m.prog, cap: 'Tap SPACE', sub: 'Lift the beam' } : null;
        m.hint = inR ? null : 'Get to them';
        if (Math.random() < 0.15 * dt) bark(m.victim, 'plead', { prio: true });
        if (m.prog >= 1) { m.beamUp = 0.01; freeVictim(g, m); win(g, m); }
      }
    },
    ledge: {
      setup(g, m) {
        const P = g.P.pos, c = center(g), list = [];
        for (const b of g.buildings) { if (b.h < m.cfg.h[0] || b.h > m.cfg.h[1]) continue; const d = Math.hypot((b.x0 + b.x1) / 2 - c.x, (b.z0 + b.z1) / 2 - c.z); if (d < 260) list.push(b); }
        if (!list.length) return false;
        for (let tries = 0; tries < 8; tries++) {
          const b = pick(list), ins = topInset(b), f = faceToward(b, ins, P);
          const along = R(-f.half + 2, f.half - 2);
          const hx = f.x + f.nx * 0.35 + (f.nz ? along : 0), hz = f.z + f.nz * 0.35 + (f.nx ? along : 0);
          if (g.blockAt(hx - f.nx * 1.5, b.h - 1, hz - f.nz * 1.5) < 0) continue;
          const fb = faceToward(b, 0, P);   // the street face below
          const gx = fb.x + fb.nx * 5 + (fb.nz ? along : 0), gz = fb.z + fb.nz * 5 + (fb.nx ? along : 0);
          if (!freeSpot(g, gx, gz)) continue;
          m.b = b; m.f = f; m.roof = b.h;
          m.giver = npc(g, 'msn', gx, gz, { pose: 'wave', role: 'giver' });
          m.victim = npc(g, 'trapped', hx, hz, { pose: 'hang', role: 'victim' });
          if (!m.giver || !m.victim) return false;
          m.victim.pos.set(hx, b.h - 1.15, hz); m.victim.face = Math.atan2(-f.nz, -f.nx);
          m.target = m.victim.pos;
          return true;
        }
        return false;
      },
      start(g, m) { m.phase = 'hang'; m.grip = m.cfg.grip; m.ringT = 0; },
      key(g, m, code) {
        if (code !== 'KeyE' || m.phase !== 'hang' || !near3(g.P.pos, m.victim.pos, m.cfg.range)) return false;
        const r = ringAt(m), w = m.cfg.win;
        if (r >= w[0] && r <= w[1]) {
          // pulled up onto the roof
          const v = m.victim; v.pos.set(v.pos.x - m.f.nx * 2.2, m.roof + 0.9, v.pos.z - m.f.nz * 2.2);
          v.mode = 'msn'; v.msnPose = 'stand'; faceTo(v, g.P.pos.x, g.P.pos.z);
          m.qteResult = 'ok'; win(g, m);
        } else { m.grip -= m.cfg.miss; m.qteResult = 'miss'; m.qteFx = 0.35; bark(m.victim, 'slip', { prio: true }); }
        return true;
      },
      update(g, m, dt, du) {
        if (m.phase === 'hang') {
          m.grip -= dt;
          const inR = near3(g.P.pos, m.victim.pos, m.cfg.range);
          if (inR) m.ringT += du; else m.ringT = 0;
          m.qte = inR ? { kind: 'timing', key: 'E', p: clamp(m.grip / m.cfg.grip, 0, 1), ring: ringAt(m), win: m.cfg.win, cap: 'Press E in the ring', sub: 'Grip ' + Math.max(0, Math.ceil(m.grip)) + 's' } : null;
          m.hint = inR ? null : 'Fly up to the ledge';
          if (Math.random() < 0.2 * dt) bark(m.victim, m.grip < 12 ? 'slip' : 'plead', { prio: true });
          if (m.grip <= 0) { startFall(g, m, m.victim); bark(m.victim, 'slip', { prio: true, text: 'Aaaah!' }); }
        } else if (m.phase === 'fall') updateFall(g, m, dt);
      }
    },
    bay: {
      setup(g, m) {
        let car = null, bd = Infinity;
        const P = g.P.pos;
        const x = clamp(P.x, -170, 170) + R(-30, 30);
        for (const c of g.cars) { if (c.dead || c.exploded || c.held || !c.parked) continue; const d = (c.pos.x - x) ** 2 + (c.pos.z - C.WATER_Z) ** 2; if (d < bd) { bd = d; car = c; } }
        if (!car) for (const c of g.cars) if (!c.dead && !c.held && !c.exploded) { car = c; break; }
        if (!car) return false;
        const gz = C.WATER_Z - 6;
        m.giver = npc(g, 'msn', x + R(-3, 3), gz, { pose: 'wave', role: 'giver' });
        if (!m.giver) return false;
        m.car = car; m.carX = x; m.target = car.pos;
        // the car only goes in once you've heard what happened
        return true;
      },
      start(g, m) {
        const c = m.car; c.drive = null; c.parked = false; c.sleeping = false; c.alarm = 0;
        c.pos.set(m.carX, C.WATER_Y + 0.4, C.WATER_Z + m.cfg.out); c.vel.set(0, -1.5, 0); c.angVel.set(0.1, 0, 0.05);
        c.quat.setFromAxisAngle(UP, R(0, 6.28)); c.flood = 0.2; c.wet = false;
        m.phase = 'sinking'; m.grabbed = false;
      },
      update(g, m, dt) {
        const c = m.car, P = g.P;
        if (c.dead) { lose(g, m); return; }
        if (c.held) m.grabbed = true;
        const onLand = c.pos.z < C.WATER_Z - 0.5 && !c.held && c.pos.y < 3 && (c.onGround || c.sleeping || Math.abs(c.vel.y) < 0.5);
        if (m.grabbed && onLand) {
          const d = npc(g, 'msn', c.pos.x + 2.4, Math.min(c.pos.z, C.WATER_Z - 2), { pose: 'stand', role: 'driver' });
          if (d) { faceTo(d, P.pos.x, P.pos.z); m.thanker = d; }
          win(g, m); return;
        }
        const nearCar = c.pos.distanceTo(P.pos) < 9;
        m.qte = null;
        m.hint = c.held ? 'Carry it ashore' : nearCar ? 'Press E to grab the car' : 'Dive to the car';
        if (!c.held && Math.random() < 0.5 * dt && g.FX) g.FX.water(c.pos.x + R(-1, 1), C.WATER_Y + 0.1, c.pos.z + R(-1, 1), 0, R(0.5, 1.5), 0);
        if (Math.random() < 0.12 * dt) bark(m.giver, 'plead', { prio: true, text: pick(['Hurry! He\'s still in there!', 'The car is going under!', 'Please! Get him out!']) });
      }
    },
    crime: {
      setup(g, m) {
        const c = center(g), lots = lotsNear(g, c, CFG.spawn.near[0], CFG.spawn.near[1], L => L.type !== 'hospital');
        for (let tries = 0; tries < 8; tries++) {
          const L = pick(lots), s = sidewalk(L, T1); if (!freeSpot(g, s.x, s.z)) continue;
          m.giver = npc(g, 'msn', s.x, s.z, { pose: 'wave', role: 'giver' });
          m.target = m.giver && m.giver.pos; return !!m.giver;
        }
        return false;
      },
      start(g, m) {
        const v = m.giver, P = g.P.pos;
        // the thief bolts from just behind her
        let rx = v.pos.x, rz = v.pos.z;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = v.pos.x + dx * m.cfg.head, z = v.pos.z + dz * m.cfg.head; if (freeSpot(g, x, z) && (x - P.x) ** 2 + (z - P.z) ** 2 > 100) { rx = x; rz = z; break; } }
        const r = npc(g, 'free', rx, rz, { thug: true, role: 'robber', pose: null });
        if (!r) { lose(g, m); return; }
        r.msnPose = null; r.fleeT = 2; r.turnT = 0; m.robber = r; m.phase = 'chase'; m.grace = 0;
        v.msnPose = 'stand'; m.target = r.pos;
        bark(r, 'taunt', { prio: true });
      },
      key(g, m, code) {
        if (code !== 'KeyE') return false;
        if (m.phase === 'qte') {
          const r = ringAt(m), w = m.cfg.win;
          if (r >= w[0] && r <= w[1]) takedown(g, m); else escape(g, m);
          return true;
        }
        if (m.phase === 'return' && near3(g.P.pos, m.giver.pos, CFG.talkDist)) {
          m.giver.msnPose = 'wave'; m.qteResult = 'ok'; win(g, m); return true;
        }
        return false;
      },
      update(g, m, dt, du) {
        const r = m.robber, P = g.P;
        if (!r || r.mode === 'gone') { lose(g, m); return; }
        if (m.phase === 'chase' || m.phase === 'qte') {
          if (r.cuffed) { takedown(g, m); return; }     // punched, clapped or grabbed: same result
        }
        if (m.phase === 'chase') {
          m.grace -= du;
          if (r.mode === 'free') steerRobber(g, r, du);
          const d = r.pos.distanceTo(P.pos);
          m.qte = null; m.hint = d < 30 ? 'Catch him' : 'Chase the thief';
          if (d < m.cfg.range && m.grace <= 0 && r.mode === 'free') { m.phase = 'qte'; m.ringT = 0; r.mode = 'msn'; r.msnPose = 'cower'; faceTo(r, P.pos.x, P.pos.z); }
          if (Math.random() < 0.1 * dt) bark(r, 'taunt');
        } else if (m.phase === 'qte') {
          m.ringT += du;
          const ring = ringAt(m);
          m.qte = { kind: 'timing', key: 'E', p: 1, ring, win: m.cfg.win, cap: 'Takedown', sub: 'Press E as the ring closes' };
          if (ring <= 0) escape(g, m);
        } else if (m.phase === 'return') {
          const d = Math.sqrt(hd2(m.giver.pos, P.pos));
          m.qte = d < CFG.talkDist ? { kind: 'hint', key: 'E', p: 1, cap: 'Return the purse', sub: '' } : null;
          m.hint = d < CFG.talkDist ? null : 'Return the purse';
          faceTo(m.giver, P.pos.x, P.pos.z);
        }
      }
    },
    kid: {
      setup(g, m) {
        const c = center(g), lots = lotsNear(g, c, CFG.spawn.near[0], CFG.spawn.near[1], L => L.type !== 'hospital');
        for (let tries = 0; tries < 8; tries++) {
          const L = pick(lots), s = sidewalk(L, T1); if (!freeSpot(g, s.x, s.z)) continue;
          const plots = lotsNear(g, s, m.cfg.dist[0], m.cfg.dist[1], LL => LL.type !== 'hospital');
          const PL = pick(plots), ps = sidewalk(PL, new V3()); if (!freeSpot(g, ps.x, ps.z)) continue;
          m.giver = npc(g, 'msn', s.x, s.z, { pose: 'wave', role: 'giver', kid: true, hs: CFG.kids.hs, ws: CFG.kids.ws });
          m.parent = npc(g, 'msn', ps.x, ps.z, { pose: 'stand', role: 'parent' });
          if (!m.giver || !m.parent) return false;
          m.target = m.giver.pos; return true;
        }
        return false;
      },
      start(g, m) { startEscort(g, m, m.giver, m.parent.pos, 'parent'); m.parent.msnPose = 'wave'; },
      update(g, m, dt) { updateEscort(g, m, dt); }
    },
    worker: {
      setup(g, m) {
        const c = center(g), H = ctx.HOSP;
        const lots = lotsNear(g, c, CFG.spawn.near[0], CFG.spawn.near[1], L => L.type === 'bld' && Math.hypot(L.lx + 20 - H.x, L.lz + 20 - H.z) > m.cfg.minHosp);
        for (let tries = 0; tries < 8; tries++) {
          const L = pick(lots), s = sidewalk(L, T1); if (!freeSpot(g, s.x, s.z)) continue;
          const vx = s.x + (Math.abs(s.x - L.lx - 20) > 15 ? 0 : 2.2), vz = s.z + (Math.abs(s.x - L.lx - 20) > 15 ? 2.2 : 0);
          if (!freeSpot(g, vx, vz)) continue;
          m.giver = npc(g, 'msn', s.x, s.z, { pose: 'wave', role: 'giver' });
          m.victim = npc(g, 'msn', vx, vz, { pose: 'lying', role: 'victim' });
          if (!m.giver || !m.victim) return false;
          m.victim.pos.y = g.groundY(vx, vz) + 0.25;
          m.target = m.giver.pos; return true;
        }
        return false;
      },
      start(g, m) { startEscort(g, m, m.victim, ctx.HOSP, 'hospital'); m.giver.msnPose = 'stand'; },
      update(g, m, dt) { updateEscort(g, m, dt); }
    },
    cat: {
      setup(g, m) {
        if (!trees) findTrees(g);
        const c = center(g);
        let t = null;
        if (trees.length) {
          const cand = trees.filter(tr => { const d = Math.hypot(tr.x - c.x, tr.z - c.z); return d > 30 && d < 220; });
          t = cand.length ? pick(cand) : pick(trees);
        } else { const L = pick(lotsNear(g, c, 40, 200, L => L.type !== 'hospital')), s = sidewalk(L, T1); t = { x: s.x, z: s.z, top: 4 }; }
        let gx = t.x, gz = t.z;
        for (const [dx, dz] of [[2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6]]) if (freeSpot(g, t.x + dx, t.z + dz)) { gx = t.x + dx; gz = t.z + dz; break; }
        m.giver = npc(g, 'msn', gx, gz, { pose: 'wave', role: 'giver' });
        if (!m.giver) return false;
        m.cat = new V3(t.x, t.top, t.z); m.target = m.giver.pos;
        showProp('cat', t.x, t.top, t.z, R(0, 6.28));
        return true;
      },
      start(g, m) { m.phase = 'tree'; m.target = m.cat; faceTo(m.giver, m.cat.x, m.cat.z); m.giver.msnPose = 'plead'; },
      key(g, m, code) {
        if (code !== 'KeyE') return false;
        const P = g.P.pos;
        if (m.phase === 'tree' && P.distanceTo(m.cat) < m.cfg.grab) { m.phase = 'carry'; m.target = m.giver.pos; bark(null, 'cat', { anchor: m.cat, prio: true, text: 'Mrrp?' }); return true; }
        if (m.phase === 'carry') {
          if (hd2(P, m.giver.pos) < m.cfg.radius * m.cfg.radius && P.y - g.groundY(P.x, P.z) < 4) {
            m.cat.set(m.giver.pos.x + 0.6, g.groundY(P.x, P.z) + 0.15, m.giver.pos.z);
            if (prop) prop.position.copy(m.cat);
            win(g, m);
          } else G().toast('Take the cat back to its owner (pink pin).', '');
          return true;
        }
        return false;
      },
      update(g, m, dt) {
        const P = g.P;
        if (m.phase === 'tree') {
          const d = P.pos.distanceTo(m.cat);
          m.qte = d < m.cfg.grab ? { kind: 'hint', key: 'E', p: 1, cap: 'Take the cat', sub: '' } : null;
          m.hint = d < m.cfg.grab ? null : 'Fly up to the cat';
          if (Math.random() < 0.25 * dt) bark(null, 'cat', { anchor: m.cat, prio: d < 40 });
          if (prop) prop.position.copy(m.cat);
        } else if (m.phase === 'carry') {
          // the cat rides in his arms
          m.cat.copy(P.pos); m.cat.y += 0.15; m.cat.add(T1.set(0, 0, -0.45).applyQuaternion(P.quat));
          if (prop) { prop.position.copy(m.cat); prop.quaternion.copy(P.quat); }
          const d = Math.sqrt(hd2(P.pos, m.giver.pos));
          m.qte = d < m.cfg.radius ? { kind: 'hint', key: 'E', p: 1, cap: 'Hand the cat over', sub: '' } : null;
          m.hint = d < m.cfg.radius ? null : 'Bring the cat to its owner';
        }
      }
    },
    washer: {
      setup(g, m) {
        const P = g.P.pos, c = center(g), list = [];
        for (const b of g.buildings) { if (tierTop(b) < m.cfg.h[0] + 4) continue; const d = Math.hypot((b.x0 + b.x1) / 2 - c.x, (b.z0 + b.z1) / 2 - c.z); if (d < 260) list.push(b); }
        if (!list.length) return false;
        for (let tries = 0; tries < 8; tries++) {
          const b = pick(list), f = faceToward(b, 0, P);
          const y = Math.floor(clamp(R(m.cfg.h[0], m.cfg.h[1]), m.cfg.h[0], tierTop(b) - 4) / C.STORY) * C.STORY;
          const along = R(-f.half + 3, f.half - 3);
          const sx = f.x + f.nx * 0.9 + (f.nz ? along : 0), sz = f.z + f.nz * 0.9 + (f.nx ? along : 0);
          if (g.blockAt(sx - f.nx * 1.5, y + 1, sz - f.nz * 1.5) < 0) continue;
          const gx = f.x + f.nx * 6 + (f.nz ? along : 0), gz = f.z + f.nz * 6 + (f.nx ? along : 0);
          if (!freeSpot(g, gx, gz)) continue;
          m.giver = npc(g, 'msn', gx, gz, { pose: 'wave', role: 'giver' });
          m.victim = npc(g, 'trapped', sx, sz, { pose: 'grip', role: 'victim' });
          if (!m.giver || !m.victim) return false;
          m.victim.pos.set(sx, y + 0.07 + 0.9, sz); m.victim.face = Math.atan2(-f.nz, -f.nx);
          m.f = f; m.plankY = y;
          showProp('plank', sx, y, sz, f.nx ? 0 : Math.PI / 2);
          m.target = m.giver.pos; return true;
        }
        return false;
      },
      start(g, m) { m.phase = 'creak'; m.snapT = m.cfg.snap; m.target = m.victim.pos; },
      update(g, m, dt) {
        if (m.phase === 'creak') {
          m.snapT -= dt; m.hint = 'Stay close: the cable is going';
          if (m.snapT < m.cfg.snap - 0.8 && !m.creaked) { m.creaked = true; bark(m.giver, 'creak', { prio: true }); }
          if (m.snapT <= 0) {
            if (prop) prop.rotation.set(m.f.nx ? 0.7 : 0, prop.rotation.y, m.f.nx ? 0 : 0.7);
            bark(m.giver, 'say', { prio: true, text: 'The cable! It snapped!' });
            const sfx = G().SFX; if (sfx) sfx.alert();
            startFall(g, m, m.victim);
          }
        } else if (m.phase === 'fall') updateFall(g, m, dt);
      }
    }
  };
  function near3(a, b, r) { return a.distanceToSquared(b) < r * r; }
  function ringAt(m) {
    const per = m.type === 'crime' ? m.cfg.ring : m.cfg.ring;
    if (m.type === 'crime') return clamp(1 - m.ringT / per, 0, 1);
    return 1 - (m.ringT % per) / per;      // the ledge ring repeats
  }
  // ---- pinned (car or beam)
  function setupPinned(g, m, kind) {
    const c = center(g), lots = lotsNear(g, c, CFG.spawn.near[0], CFG.spawn.near[1], L => L.type !== 'hospital');
    for (let tries = 0; tries < 10; tries++) {
      const L = pick(lots), s = sidewalk(L, T1); if (!freeSpot(g, s.x, s.z)) continue;
      // victim a few metres out toward the street
      const out = new V3(s.x - (L.lx + 20), 0, s.z - (L.lz + 20)); if (Math.abs(out.x) > Math.abs(out.z)) out.set(Math.sign(out.x), 0, 0); else out.set(0, 0, Math.sign(out.z));
      const vx = s.x + out.x * 4.5, vz = s.z + out.z * 4.5;
      if (!freeSpot(g, vx, vz)) continue;
      let car = null;
      if (kind === 'car') {
        let bd = Infinity;
        for (const cc of g.cars) { if (cc.dead || cc.exploded || cc.held || !cc.parked) continue; const d = (cc.pos.x - vx) ** 2 + (cc.pos.z - vz) ** 2; if (d < bd) { bd = d; car = cc; } }
        if (!car) { kind = 'beam'; m.type = 'beam'; m.def = DEF.beam; m.cfg = CFG.types.beam; m.lines = DIALOGUE.beam; }
      }
      m.giver = npc(g, 'msn', s.x, s.z, { pose: 'wave', role: 'giver' });
      m.victim = npc(g, 'trapped', vx, vz, { pose: 'lying', role: 'victim' });
      if (!m.giver || !m.victim) return false;
      m.victim.pos.y = g.groundY(vx, vz) + 0.25; m.victim.face = Math.atan2(out.z, out.x) + Math.PI / 2;
      m.side = new V3(-out.z, 0, out.x);
      const yaw = Math.atan2(out.x, out.z);
      if (kind === 'car') {
        car.drive = null; car.parked = true; car.sleeping = true; car.vel.set(0, 0, 0); car.angVel.set(0, 0, 0);
        m.carY = 1.2; car.pos.set(vx, m.carY, vz);
        car.quat.setFromAxisAngle(UP, yaw).multiply(TQ.setFromAxisAngle(XAX, 0.2)); m.car = car;
      } else { m.propY = 0.55; showProp('beam', vx, m.propY, vz, yaw + Math.PI / 2 + 0.25); }
      m.prog = 0; m.target = m.giver.pos;
      return true;
    }
    return false;
  }
  function freeVictim(g, m) {
    const v = m.victim; v.mode = 'msn'; v.msnPose = 'stand'; v.pos.y = g.groundY(v.pos.x, v.pos.z) + 0.9; faceTo(v, g.P.pos.x, g.P.pos.z);
    m.thanker = v;
  }
  // ---- falls (ledge and washer): kinematic, with a slow-motion assist when he's close
  function startFall(g, m, p) { m.phase = 'fall'; m.fallV = 0; p.msnPose = 'fall'; p.mode = 'trapped'; }
  function updateFall(g, m, dt) {
    const p = m.victim, P = g.P;
    m.fallV -= 9.81 * dt; p.pos.y += m.fallV * dt;
    const d = p.pos.distanceTo(P.pos);
    m.qte = null; m.hint = 'Catch them!';
    if (d < CFG.types.washer.slowRadius && !m.slowOn) { m.slowOn = true; m.slowPrev = P.slow; P.slow = true; }
    if (d < CFG.types.washer.catchR) {
      // caught: straight into his arms (same hold the E key uses)
      if (P.hold) g.grabOrRelease();
      p.mode = 'held'; p.held = true; p.sleeping = false; p.vel.set(0, 0, 0); p.prevDanger = false; p.msnPose = null;
      P.holdRel.setFromAxisAngle(XAX, -Math.PI / 2); P.hold = p;
      bark(p, 'caught', { prio: true }); m.qteResult = 'ok';
      win(g, m); return;
    }
    const gy = g.groundY(p.pos.x, p.pos.z);
    if (p.pos.y <= gy + 0.3) { p.pos.y = gy + 0.25; p.msnPose = 'lying'; p.mode = 'msn'; lose(g, m); }
  }
  function endSlow(g, m) { if (m && m.slowOn) { g.P.slow = !!m.slowPrev; m.slowOn = false; } }
  // ---- robber
  function steerRobber(g, r, dt) {
    r.fleeT = 2; r.turnT = (r.turnT || 0) - dt; if (r.turnT > 0) return;
    r.turnT = 1.2;
    const P = g.P.pos; let bx = r.dir.x, bz = r.dir.z, bs = -1e9;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = r.pos.x + dx * 4, az = r.pos.z + dz * 4;
      if (g.blockAt(ax, 1, az) >= 0 || az > C.WATER_Z - 5 || Math.abs(ax) > 250 || az < -250) continue;
      const s = dx * (r.pos.x - P.x) + dz * (r.pos.z - P.z) + R(0, 8);
      if (s > bs) { bs = s; bx = dx; bz = dz; }
    }
    r.dir.set(bx, 0, bz);
  }
  function takedown(g, m) {
    const r = m.robber;
    r.mode = 'thug'; r.cuffed = true; r.msnPose = null; r.pos.y = g.groundY(r.pos.x, r.pos.z) + 0.9; r.vel.set(0, 0, 0);
    ev.cuffed.add(r); bark(r, 'surrender', { prio: true });
    m.qteResult = 'ok'; m.phase = 'return'; m.target = m.giver.pos;
    const t = G().toast; if (t) t('Purse recovered. Take it back to her.', 'good');
    const sfx = G().SFX; if (sfx) sfx.punch(r.pos, 0.5);
  }
  function escape(g, m) {
    const r = m.robber; m.qteResult = 'miss'; m.qteFx = 0.35;
    r.mode = 'free'; r.msnPose = null; r.fleeT = 2; r.turnT = 0; m.phase = 'chase'; m.grace = m.cfg.grace;
    bark(r, 'taunt', { prio: true, text: pick(['Too slow!', 'Ha! Missed me!', 'Nice try, cape!']) });
  }
  // ---- escorts (kid, worker): reuse the game's carry (E) and check where they're set down
  function startEscort(g, m, who, dest, kind) {
    m.phase = 'pickup'; m.who = who; m.dest = dest; m.destKind = kind; m.target = who.pos; m.wasHeld = false;
  }
  function updateEscort(g, m, dt) {
    const p = m.who, P = g.P, rad = m.cfg.radius;
    if (p.mode === 'gone' || p.mode === 'safe' || p.mode === 'down' || p.injured) { lose(g, m); return; }
    if (p.mode === 'held') { m.wasHeld = true; m.phase = 'carry'; m.target = m.dest; }
    else if (m.wasHeld) {
      m.wasHeld = false;
      const gy = g.groundY(p.pos.x, p.pos.z);
      if (hd2(p.pos, m.dest) < rad * rad && p.pos.y - gy < 3) {
        p.mode = 'msn'; p.msnPose = 'stand'; p.pos.y = gy + 0.9; p.vel.set(0, 0, 0); p.quat.identity(); faceTo(p, P.pos.x, P.pos.z);
        m.thanker = m.destKind === 'parent' ? m.parent : p;
        win(g, m); return;
      }
      m.phase = 'pickup'; m.target = p.pos;
      if (G().toast) G().toast(m.destKind === 'hospital' ? 'Set him down on the hospital pad.' : 'Set the kid down next to their parent.', '');
    }
    // dropped somewhere else: once they settle, they wait for you again
    if (p.mode === 'free' && !m.wasHeld) { p.mode = 'msn'; p.msnPose = m.destKind === 'hospital' ? 'lying' : 'stand'; if (p.msnPose === 'lying') p.pos.y = g.groundY(p.pos.x, p.pos.z) + 0.25; }
    const carrying = p.mode === 'held';
    const dd = Math.sqrt(hd2(P.pos, m.dest)), dp = p.pos.distanceTo(P.pos);
    m.qte = !carrying && dp < 6 ? { kind: 'hint', key: 'E', p: 1, cap: 'Pick up', sub: '' } : carrying && dd < rad ? { kind: 'hint', key: 'E', p: 1, cap: 'Set down here', sub: '' } : null;
    m.hint = m.qte ? null : carrying ? (m.destKind === 'hospital' ? 'Fly to the hospital pad' : 'Find the parent') : 'Pick them up';
    if (m.destKind === 'parent' && m.parent && Math.random() < 0.12 * dt) bark(m.parent, 'say', { prio: false, text: pick(['Has anyone seen my kid?', 'Sweetie?! Where are you?', 'Please, my child is missing!']) });
    if (m.destKind === 'hospital' && !carrying && Math.random() < 0.1 * dt) bark(p, 'hurt', { prio: true });
  }

  // ================================================================== mission lifecycle
  function go(m, s) {
    if (!TRANSITIONS[m.state] || !TRANSITIONS[m.state].includes(s)) { console.warn('[missions] invalid transition', m.state, '->', s); return false; }
    m.state = s; m.stT = 0; return true;
  }
  function spawn(type, forced) {
    const g = G(); if (!g || !g.started) return false;
    if (M) { if (!forced) return false; cleanup(g, M, true); M = null; }
    type = type && CFG.types[type] ? type : pickType();
    const m = { type, def: DEF[type], cfg: CFG.types[type], lines: DIALOGUE[type], state: 'idle', stT: 0, age: 0, npcs: [], phase: '', qte: null, hint: '', pinPos: new V3(), forced: !!forced };
    M = m;
    let ok = false;
    try { ok = m.def.setup(g, m); } catch (e) { console.warn('[missions] setup failed', e); ok = false; }
    if (!ok) { cleanup(g, m, true); M = null; return false; }
    go(m, 'flag'); lastType = m.type;
    stats.spawned++; stats.byType[m.type] = stats.byType[m.type] || { spawned: 0, success: 0, fail: 0 }; stats.byType[m.type].spawned++;
    m.flagBarkT = 0;
    if (m.giver) { m.giver.msnPose = m.giver.msnPose || 'wave'; }
    const t = g.toast;
    if (t) t(`Someone is waving for help: ${m.lines.label}. Follow the pink pin.`, '');
    if (!ev.tipDone) { ev.tipDone = true; at(3, () => g.toast && g.toast('Help requests: walk or fly up and press E to talk.', 'good')); }
    return true;
  }
  function pickType() {
    let tot = 0; for (const k of TYPES) if (k !== lastType) tot += CFG.types[k].w;
    let r = Math.random() * tot;
    for (const k of TYPES) { if (k === lastType) continue; r -= CFG.types[k].w; if (r <= 0) return k; }
    return TYPES[0];
  }
  function talk(g, m) {
    if (!go(m, 'talk')) return;
    const o = pick(m.lines.open);
    showCard(m.lines.who, o[0], o[1], 5);
    bark(m.giver, 'say', { prio: true, text: o[0] });
    faceTo(m.giver, g.P.pos.x, g.P.pos.z); m.giver.msnPose = 'stand';
    m.talkT = 0.8;
  }
  function win(g, m) {
    if (!go(m, 'success')) return;
    const L = g.ledger, c = m.cfg;
    L.missions = (L.missions || 0) + 1;
    stats.success++; stats.byType[m.type].success++;
    endSlow(g, m);
    const line = pick(m.lines.success), who = m.thanker || m.giver;
    showCard(who === m.giver ? m.lines.who : 'Rescued', line, '', 4);
    if (who) bark(who, 'say', { prio: true, text: line, tone: 'thanks' });
    const pos = who ? who.pos : g.P.pos;
    if (c.saves && g.addSave) g.addSave(1, pos, 'Help request: ' + m.lines.label);
    else { if (g.toast) g.toast('Help request: ' + m.lines.label + ' - done', 'good'); if (g.SFX) g.SFX.good(); onRescue(g, pos); }
    g.hopeAdd(c.reward);
    m.qte = null; m.hint = '';
    m.endT = CFG.resultHold;
  }
  function lose(g, m) {
    if (!go(m, 'fail')) return;
    const L = g.ledger, c = m.cfg;
    L.missionsFailed = (L.missionsFailed || 0) + 1;
    stats.fail++; stats.byType[m.type].fail++;
    endSlow(g, m);
    const line = pick(m.lines.fail);
    showCard(m.lines.who, line, '', 4.5);
    if (m.giver) bark(m.giver, 'say', { prio: true, text: line, tone: 'fear' });
    g.hopeHit(c.penalty);
    if (g.toast) g.toast('Help request failed: ' + m.lines.label, 'alert');
    m.qte = null; m.hint = '';
    m.endT = CFG.resultHold;
  }
  function expire(g, m, why) {
    if (!go(m, 'expired')) return;
    stats.expired++;
    if (why === 'emergency') { if (m.giver) bark(m.giver, 'waveOff', { prio: true }); }
    else { if (g.toast) g.toast('A call for help went unanswered.', ''); g.hopeHit(1); }
    m.endT = 1.5;
  }
  function cleanup(g, m, now) {
    endSlow(g, m);
    if (g.P.hold && m.npcs.includes(g.P.hold) && now) { /* leave whatever he carries in his arms */ }
    for (const p of m.npcs) {
      if (p === m.robber) { if (p.mode === 'thug' && p.cuffed) { const r = p; at(8, () => { if (r.mode === 'thug') r.mode = 'gone'; }); r.msnRole = null; } else freeNpc(g, p, 'gone'); continue; }
      const happy = m.state === 'success' && (p === m.thanker || p === m.giver || p === m.victim || p === m.parent);
      freeNpc(g, p, happy ? 'cheer' : 'free');
    }
    if (m.car && m.state !== 'success' && m.type === 'pinned' && m.car.sleeping) { m.car.sleeping = false; m.car.parked = false; }
    if (m.type === 'bay' && m.state !== 'success' && m.car && !m.car.dead && m.state !== 'idle' && m.phase) { /* the car stays in the bay */ }
    hideProp();
    m.npcs.length = 0;
  }
  function updateMission(g, dt, du) {
    const m = M;
    if (!m) {
      if (g.currentInc) return;
      spawnT -= dt;
      if (spawnT <= 0) {
        if (g.nextIncT !== undefined && g.nextIncT < CFG.spawn.minIncGap) { spawnT = CFG.spawn.retry; return; }
        if (!spawn(null, false)) spawnT = CFG.spawn.retry; else spawnT = R(CFG.spawn.every[0], CFG.spawn.every[1]);
      }
      return;
    }
    m.stT += dt; m.age += dt;
    // NPCs that got knocked about come back to their job once they settle
    for (const p of m.npcs) {
      if (p.mode === 'free' && p.msnRole && p.msnRole !== 'robber' && !(m.who === p && m.wasHeld)) { p.mode = 'msn'; p.pos.y = g.groundY(p.pos.x, p.pos.z) + 0.9; p.quat.identity(); }
    }
    if (m.state === 'flag') {
      const gv = m.giver;
      if (!gv || !canStand(gv)) { expire(g, m, 'lost'); return; }
      if (g.currentInc && !m.forced) { expire(g, m, 'emergency'); return; }
      faceTo(gv, g.P.pos.x, g.P.pos.z);
      m.flagBarkT -= du;
      const d = Math.sqrt(hd2(g.P.pos, gv.pos));
      if (m.flagBarkT <= 0 && d < 70) { m.flagBarkT = CFG.flagBarkEvery; bark(gv, 'flag', { prio: true }); }
      m.qte = d < CFG.talkDist ? { kind: 'hint', key: 'E', p: 1, cap: 'Talk', sub: m.lines.label } : null;
      m.hint = m.qte ? null : 'Someone needs help';
      if (m.stT > CFG.flagTimeout) expire(g, m, 'timeout');
    } else if (m.state === 'talk') {
      m.talkT -= du; m.qte = null;
      if (m.talkT <= 0) {
        go(m, 'active'); m.activeT = 0;
        if (m.def.start) m.def.start(g, m);
        if (M === m && m.state === 'active' && g.toast) g.toast(m.lines.task, '');
      }
    } else if (m.state === 'active') {
      m.activeT += dt;
      if (g.deferIncident) g.deferIncident(CFG.spawn.incDefer);
      m.def.update(g, m, dt, du);
      if (m.state === 'active' && m.activeT > m.cfg.limit) lose(g, m);
    } else {
      // success / fail / expired: let the moment breathe, then clean up
      m.qte = null; m.hint = '';
      m.endT -= dt;
      if (m.state === 'success' && m.type === 'beam' && prop && prop.visible) { prop.position.y += dt * 1.5; prop.position.x += m.side.x * dt * 2; prop.position.z += m.side.z * dt * 2; if (prop.position.y > m.propY + 2.5) hideProp(); }
      if (m.endT <= 0) {
        cleanup(g, m, false);
        go(m, 'idle'); M = null;
        spawnT = R(CFG.spawn.every[0], CFG.spawn.every[1]);
      }
    }
    if (M && M.qteFx > 0) M.qteFx -= du;
  }

  // ================================================================== HUD for missions
  function pinOf(m) {
    if (!m || (m.state !== 'flag' && m.state !== 'talk' && m.state !== 'active')) return null;
    const t = m.state === 'active' ? m.target || (m.giver && m.giver.pos) : m.giver && m.giver.pos;
    return t || null;
  }
  function updateUI(g, camera, du) {
    // dialogue card
    if (UI.cardT > 0) { UI.cardT -= du; if (UI.cardT <= 0) UI.card.hidden = true; else if (UI.cardT < 0.4) UI.card.classList.add('out'); }
    // world marker for the request
    const pos = pinOf(M);
    if (pos && UI.mk) {
      T1.set(pos.x, pos.y + 1.8, pos.z).project(camera);
      const w = innerWidth, h = innerHeight;
      let x = (T1.x * 0.5 + 0.5) * w, y = (-T1.y * 0.5 + 0.5) * h, edge = false;
      if (T1.z > 1) { x = w - x; y = h - 20; edge = true; }
      if (x < 30 || x > w - 30 || y < 60 || y > h - 30) edge = true;
      x = clamp(x, 30, w - 30); y = clamp(y, 60, h - 30);
      UI.mk.style.display = '';
      const cls = 'mk help' + (edge ? ' edge' : ''); if (UI.mk._c !== cls) UI.mk.className = UI.mk._c = cls;
      UI.mk.style.transform = `translate(${x | 0}px,${y | 0}px) translate(-50%,-100%)`;
      const label = M.hint || (M.state === 'active' ? M.lines.label : 'Help request');
      if (UI.mk._l !== label) UI.mk.firstChild.textContent = UI.mk._l = label;
      const sub = Math.round(pos.distanceTo(g.P.pos)) + ' m'; if (UI.mk._s !== sub) UI.mk.lastChild.textContent = UI.mk._s = sub;
    } else if (UI.mk && UI.mk.style.display !== 'none') UI.mk.style.display = 'none';
    // QTE prompt
    const q = M && M.qte;
    if (!q) { if (!UI.qte.hidden) UI.qte.hidden = true; }
    else {
      if (UI.qte.hidden) UI.qte.hidden = false;
      const cls = 'q-' + q.kind + (M.qteFx > 0 ? (M.qteResult === 'miss' ? ' miss' : ' ok') : '') + (M.tapFx > 0 ? ' tap' : '');
      if (UI.qte._c !== cls) UI.qte.className = UI.qte._c = cls;
      if (UI.qKey.textContent !== q.key) { UI.qKey.textContent = q.key; UI.qKey.setAttribute('class', 'q-key' + (q.key.length > 2 ? ' long' : '')); }
      if (UI.qCap.textContent !== q.cap) UI.qCap.textContent = q.cap;
      if (UI.qSub.textContent !== (q.sub || '')) UI.qSub.textContent = q.sub || '';
      UI.qArc.style.strokeDashoffset = (251.3 * (1 - clamp(q.p, 0, 1))).toFixed(1);
      if (q.kind === 'timing') {
        UI.qRing.setAttribute('r', (6 + 40 * q.ring).toFixed(1));
        UI.qWin.setAttribute('r', (6 + 40 * (q.win[0] + q.win[1]) / 2).toFixed(1));
        UI.qWin.style.strokeWidth = (40 * (q.win[1] - q.win[0])).toFixed(1);
        const inW = q.ring >= q.win[0] && q.ring <= q.win[1];
        UI.qRing.classList.toggle('in', inW);
      }
    }
    if (M && M.tapFx > 0) M.tapFx -= du;
    // HUD row
    const L = g.ledger, txt = (L.missions || 0) + (M && (M.state === 'flag' || M.state === 'talk' || M.state === 'active') ? ' · 1 open' : '');
    if (UI.row && txt !== UI.rowTxt) { UI.row.textContent = UI.rowTxt = txt; }
  }

  // ================================================================== input
  function keyAllowed() {
    const g = G(); if (!g || !g.started || (g.MAP && g.MAP.open)) return false;
    const pz = document.getElementById('paused'); return !pz || pz.hidden;
  }
  function handleKey(code, down) {
    if (code === 'KeyE' || code === 'Space') held[code] = down;
    if (!down || !M || !keyAllowed()) return false;
    const g = G();
    if (M.state === 'flag' && code === 'KeyE' && M.giver && hd2(g.P.pos, M.giver.pos) < CFG.talkDist * CFG.talkDist && Math.abs(g.P.pos.y - M.giver.pos.y) < 4) { talk(g, M); return true; }
    if (M.state === 'active' && M.def.key) return !!M.def.key(g, M, code);
    return false;
  }
  // capture phase on window: runs before game.js's keydown listener and can swallow a key it uses
  addEventListener('keydown', e => {
    if (e.code !== 'KeyE' && e.code !== 'Space') return;
    if (e.repeat) { if (M && M.qte && M.qte.kind !== 'hint') { e.preventDefault(); e.stopImmediatePropagation(); } return; }
    if (handleKey(e.code, true)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  addEventListener('keyup', e => { if (e.code === 'KeyE' || e.code === 'Space') held[e.code] = false; }, true);
  addEventListener('blur', () => { held.KeyE = held.Space = false; });

  // ================================================================== first run (needs __game)
  function firstRun(g) {
    ready = true;
    const L = g.ledger; if (L.missions === undefined) L.missions = 0; if (L.missionsFailed === undefined) L.missionsFailed = 0;
    ev.lastSaves = L.saves; ev.lastDamage = L.damage;
    if (g.PIN_COL) g.PIN_COL.help = CFG.colors.pin;
    if (g.BEACON_COL) g.BEACON_COL.help = new THREE.Color(CFG.colors.beacon[0], CFG.colors.beacon[1], CFG.colors.beacon[2]);
    if (g.mapPinHooks) g.mapPinHooks.push(pins => { const p = pinOf(M); if (p) pins.push([p.x, p.z, 'help', 'Help']); });
    if (!g.missions) g.missions = API;
    // a dozen of the pedestrians are kids
    let n = 0;
    for (const p of g.people) {
      if (n >= CFG.kids.count) break;
      if (p.mode !== 'free' || p.thug || p.slot % 9 !== 4) continue;
      p.kid = true; p.hs = CFG.kids.hs; p.ws = CFG.kids.ws; kids.push(p); n++;
    }
    spawnT = R(CFG.spawn.first[0], CFG.spawn.first[1]);
  }

  // ================================================================== plugin
  function update(wdt, camera) {
    const g = G(); if (!g || !g.started) return;
    if (!ready) firstRun(g);
    const dt = Math.min(0.1, wdt), du = Math.min(0.1, wdt / (g.P.slow ? 0.12 : 1));
    clock += du;
    for (let i = later.length - 1; i >= 0; i--) if (clock >= later[i].at) { const f = later[i].fn; later.splice(i, 1); try { f(); } catch (e) { console.warn('[missions]', e); } }
    detectEvents(g, dt);
    scanT -= du; if (scanT <= 0) { scanT = 1 / CFG.bark.scanHz; scan(g); }
    updateRunners(dt);
    updateMission(g, dt, du);
    applyPoses(g);
    updateBubbles(g, camera);
    updateUI(g, camera, du);
  }

  // ================================================================== debug / test API (__game.missions)
  const API = {
    cfg: CFG, lines: LINES, dialogue: DIALOGUE, types: TYPES, transitions: TRANSITIONS, stats,
    spawn(type) { return spawn(type, true); },
    get state() { return M ? M.state : 'idle'; },
    get phase() { return M ? M.phase : ''; },
    get type() { return M ? M.type : ''; },
    current() { return M; },
    cancel() { const g = G(); if (M) { cleanup(g, M, true); M = null; } },
    talk() { const g = G(); if (M && M.state === 'flag') { talk(g, M); return true; } return false; },
    press(code) { const used = handleKey(code, true); if (!used && code === 'KeyE' && keyAllowed()) G().grabOrRelease(); return used; },
    release(code) { handleKey(code, false); },
    qte() { const q = M && M.qte; if (!q) return null; return { kind: q.kind, key: q.key, p: q.p, ring: q.ring, inWindow: q.kind === 'timing' ? q.ring >= q.win[0] && q.ring <= q.win[1] : false }; },
    bark(cat, text) { const g = G(); const p = barkNearest(g.P.pos, 60, cat || 'landMid', text ? { text } : null); return !!p; },
    barkLog() { return barkLog.slice(); },
    visibleBarks() { let n = 0; if (UI.pool) for (const b of UI.pool) if (b.on) n++; return n; },
    lineCount() { let n = 0; for (const k in LINES) n += LINES[k].length; for (const k in DIALOGUE) { const d = DIALOGUE[k]; n += d.open.length * 2 + d.success.length + d.fail.length; } return n; },
    get clock() { return clock; },
    setSpawnTimer(s) { spawnT = s; },
    kids() { return kids.length; },
    runners() { return runners.length; }
  };
  window.SM_MISSIONS = API;

  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function missions(c) {
    ctx = c; THREE = c.THREE; C = c.CONST;
    V3 = THREE.Vector3; UP = new V3(0, 1, 0); ZAX = new V3(0, 0, 1); XAX = new V3(1, 0, 0);
    T1 = new V3(); T2 = new V3(); TP = new V3(); TS = new V3();
    TQ = new THREE.Quaternion(); TQ2 = new THREE.Quaternion();
    TM = new THREE.Matrix4(); TL = new THREE.Matrix4(); TR = new THREE.Matrix4();
    // the one prop mesh (beam, scaffold plank or cat), hidden until a mission needs it
    prop = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.6, metalness: 0.4 }));
    prop.castShadow = true; prop.receiveShadow = true; prop.visible = false; c.scene.add(prop);
    buildDOM();
    return { update };
  });
})();
