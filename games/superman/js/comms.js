/* "Voices of Metropolis" for Superman Over Metropolis (dream-features #6, demo step 5).
 *
 * Radio calls in your ear: Lois Lane (leads, banter, reactions), Jimmy Olsen (begs for the shot,
 * reacts to stunts), Perry White (front-page verdicts on your conduct) and Metropolis PD dispatch
 * (incident callouts), plus the cockpit of a stricken airliner when that set piece runs.
 *
 *   - Comms card: a DOM portrait card (outside the colour grade) with a procedurally drawn canvas
 *     portrait, channel, name, word-synced subtitle and a live waveform.
 *   - Triggers come from a data table (LINES), watched from window.__game: emergency start / half
 *     time / last person / lost / end + medal, tower collapse, big damage, Hope band swings, first
 *     use of each power, Mach 1 / 3 / 10 records, Mach 1 near the Daily Planet, help missions
 *     (window.SM_MISSIONS stats), set pieces (any non-base incident type, or __game.setpieces),
 *     and idle city flavour.
 *   - Pacing: one call at a time. Dispatch for an emergency is urgent: it starts at once and may
 *     cut a lower call short. Incident-tied calls wait 8 s after the last call started; chatter
 *     waits a rolled 20-40 s. Nothing overlaps.
 *   - Voice: WebAudio "radio babble" on the game's context (__game.AU): sawtooth + noise through
 *     three moving formant filters, gated per syllable at 6-8 syllables/s and timed to the
 *     subtitle, a squelch at each end, a per-speaker timbre and a crackle bed for police. K mutes.
 *     No audio context (headless) just means silent calls; subtitles never depend on audio.
 *   - Barks (js/missions.js) stay street-level speech bubbles; comms are only ever radio.
 *
 * API: window.SM_COMMS = { say(who, text, opts), queue, history, ... } (also __game.comms).
 * Performance: one DOM card, two small canvases redrawn only while a call is on screen; no
 * per-frame allocations (calls allocate their schedule once when they start).
 */
(function () {
  'use strict';

  // ================================================================== tuning
  const CFG = {
    gapChatter: [20, 40],  // s from the last call's start before a non-urgent call may start
    gapEvent: 8,           // s from the last call's start before an incident-tied call may start
    gapAfter: 0.6,         // s of radio silence after a call hangs up
    open: 0.45,            // s of squelch / "incoming" before the first syllable
    hold: 1.5,             // s the card stays after the last word
    idle: [38, 70],        // s of quiet (no emergency, no call) before city flavour
    hello: 14,             // s after takeoff for the first friendly call
    maxQueue: 6,
    vol: 0.55,             // radio bus loudness
    damageWin: 6,          // s window for the "big damage" detector
    damageBig: 1.5e6,      // $ in that window
    collapseBlocks: 40,    // falling blocks that count as a tower collapse
    hopeEdge: 2,           // Hope points past a band edge before a band change counts
    machHold: 0.3          // s above a Mach mark before it counts as a record
  };

  // ================================================================== speakers
  // pitch per design doc: Lois 220 Hz, Jimmy 260, Perry 120, Dispatch 140
  const SPK = {
    lois: {
      name: 'Lois Lane', role: 'Daily Planet · City Desk', chan: 'PLANET LINE 2', col: '#ff5d7c', ini: 'L',
      pitch: 220, form: 1.12, rate: 7.1, voiced: 0.8, breath: 0.22, band: [240, 3900], drive: 0, crackle: 0, inton: 0.16, wave: 'sawtooth'
    },
    jimmy: {
      name: 'Jimmy Olsen', role: 'Daily Planet · Photo Desk', chan: 'PLANET MOBILE', col: '#ffb43a', ini: 'J',
      pitch: 260, form: 1.2, rate: 7.9, voiced: 0.75, breath: 0.25, band: [320, 3600], drive: 0.25, crackle: 0.15, inton: 0.24, wave: 'sawtooth'
    },
    perry: {
      name: 'Perry White', role: 'Editor-in-Chief', chan: 'PLANET LINE 1', col: '#e8d6a3', ini: 'P',
      pitch: 120, form: 0.86, rate: 6.0, voiced: 0.7, breath: 0.4, band: [180, 3400], drive: 0.15, crackle: 0, inton: 0.1, wave: 'sawtooth'
    },
    dispatch: {
      name: 'MPD Dispatch', role: 'Metropolis Police · Citywide', chan: 'MPD BAND 3', col: '#5aa9ff', ini: 'D',
      pitch: 140, form: 0.96, rate: 6.7, voiced: 0.65, breath: 0.3, band: [300, 3000], drive: 0.6, crackle: 1, inton: 0.06, wave: 'square'
    },
    pilot: {
      name: 'Capt. Reyes', role: 'Metro Air 207 · Cockpit', chan: 'GUARD 121.5', col: '#5fe0c8', ini: 'R',
      pitch: 112, form: 0.9, rate: 6.3, voiced: 0.65, breath: 0.35, band: [350, 2800], drive: 0.5, crackle: 0.7, inton: 0.08, wave: 'square'
    }
  };
  const PRIO_RANK = { dispatch: 4, pilot: 3, lois: 2, perry: 1, jimmy: 0 }; // tie-break: Dispatch > Lois > Perry > Jimmy

  // ================================================================== the line table (data)
  // Each trigger has 2+ variants. {where} = the incident's cross streets ("5th and Bessolo"),
  // {street} = a random corner, {dmg} = the damage figure. All dialogue is original.
  const L = (w, t) => ({ w, t });
  const LINES = {
    // ---------------- emergency start: dispatch (urgent)
    start_fire: [
      L('dispatch', 'All units, 10-70, structure fire at {where}. Occupants trapped above the fire floor. Engines are four minutes out.'),
      L('dispatch', 'Dispatch to all cars: working fire, {where}. Multiple callers report people at the windows. Clear the block for FD.'),
      L('dispatch', 'Code 3, structure fire at {where}. Heavy smoke from the upper floors. Any unit near, set up a perimeter.'),
      L('dispatch', 'Be advised, fire at {where} upgraded to a second alarm. Persons trapped. Ladder company still six minutes out.')
    ],
    start_heli: [
      L('dispatch', 'All units, aircraft in distress over {where}. News chopper reporting engine failure. Clear the streets below.'),
      L('dispatch', 'Priority traffic: rotorcraft losing altitude near {where}. The tower has lost its transponder.'),
      L('dispatch', 'Code 3 to {where}. Helicopter in an uncontrolled descent. Get those sidewalks empty, now.')
    ],
    start_meteor: [
      L('dispatch', 'All units, the observatory reports an object on an impact track for {where}. Evacuate the area. This is not a drill.'),
      L('dispatch', 'Dispatch to all cars: incoming debris from above, projected impact at {where}. Clear civilians, then clear yourselves.'),
      L('dispatch', 'Priority traffic: something bright coming down over {where}. The plot gives us under half a minute.')
    ],
    start_kryp: [
      L('dispatch', 'All units, the object falling near {where} reads green on the hazmat scope. Keep everyone back. And I mean everyone.'),
      L('dispatch', 'Be advised: radiation spike on that inbound rock over {where}. The lab says nobody gets close to it.')
    ],
    start_robbery: [
      L('dispatch', 'All units, 10-31 in progress at {where}. Shots fired. Multiple armed suspects. Hold the perimeter for backup.'),
      L('dispatch', 'Dispatch to all cars, armed robbery at {where}. The alarm company confirms gunfire inside. Approach with caution.'),
      L('dispatch', 'Code 3 to {where}. Robbery in progress, possible hostages. Units on scene are pinned behind their cars.'),
      L('dispatch', 'Any unit near {where}: shots fired, officer requesting assistance. Repeat, shots fired.')
    ],
    start_bus: [
      L('dispatch', 'All units, runaway transit bus through {where}. Driver unresponsive, passengers aboard. Clear the intersections.'),
      L('dispatch', 'Dispatch to all cars: Metro Transit reports a bus with no brakes near {where}. Block cross traffic if you can.'),
      L('dispatch', 'Code 3, city bus out of control at {where}. The brakes are gone and it is picking up speed.')
    ],
    start_airliner: [
      L('dispatch', 'All units, the tower reports an airliner in trouble on approach over {where}. Fire and rescue to the bay shore.'),
      L('dispatch', 'Priority one: a passenger jet is losing hydraulics over the city near {where}. Every unit is on this one.'),
      L('dispatch', 'Code 3 citywide. Commercial plane coming down over {where}. Clear the waterfront.')
    ],
    start_other: [
      L('dispatch', 'All units, major incident reported at {where}. Respond Code 3. Details to follow.'),
      L('dispatch', 'Dispatch to all cars: emergency in progress at {where}. Callers are reporting something big.')
    ],
    // ---------------- set piece voices (after the callout)
    pilot_airliner: [
      L('pilot', 'Mayday, mayday, Metro Air two-zero-seven. Both hydraulic systems are gone. If anybody out there can hear this, we could use a miracle.'),
      L('pilot', 'Two-zero-seven. The controls are mush and I have a hundred and forty souls aboard. Whoever you are, I will hold her as level as I can.'),
      L('pilot', 'Metropolis approach, two-zero-seven. Something red and blue just pulled alongside my left wing. Tell me that is who I think it is.')
    ],
    driver_bus: [
      L('dispatch', 'Transit control patched through: the driver is slumped over the wheel. Passengers are trying to reach the brake.'),
      L('dispatch', 'Update on the runaway bus: next stop is a red light at a full intersection. Units, clear that crossing.')
    ],
    // ---------------- Lois's lead, a few seconds after the callout
    tip_fire: [
      L('lois', 'Lois here. My source at the fire marshal says the stairwell is gone. Those people can only come down the outside.'),
      L('lois', 'It is Lois. That building failed its last inspection and the sprinklers are dry. Freeze it from the top.'),
      L('lois', 'I am two blocks from {where}. You can see people at the windows from here. Go.')
    ],
    tip_heli: [
      L('lois', 'That is the Channel Six chopper! I know the pilot. Please, catch it gently.'),
      L('lois', 'Lois. There is a news crew in that helicopter. If it hits {where} it takes the whole crosswalk with it.'),
      L('lois', 'I am watching it spin from the newsroom window and I cannot breathe. Hurry.')
    ],
    tip_meteor: [
      L('lois', 'Lois. The observatory says it is the size of a car. Break it up high; the gravel is safer than the whole thing.'),
      L('lois', 'It is headed for {where}. There is a school two streets over. Just so you know.')
    ],
    tip_kryp: [
      L('lois', 'Do not go near that rock. Use your eyes from a distance. I mean it.'),
      L('lois', 'Lois. That meteor is glowing green. You know what that means. Stay back and burn it from range.')
    ],
    tip_robbery: [
      L('lois', 'Lois here. That looks like the crew from the armored car job last month. They do not give up easily.'),
      L('lois', 'My scanner says three shooters, maybe four. Try not to leave the police anything to sweep up.'),
      L('lois', 'Careful. There are customers inside at {where}. Get between the bullets and the people.')
    ],
    tip_bus: [
      L('lois', 'Transit says there are twenty riders on that bus. Stop it. Just do not stop it all at once.'),
      L('lois', 'Lois. That bus is heading for the waterfront. If it goes in, it sinks fast.')
    ],
    tip_airliner: [
      L('lois', 'I checked the manifest. There is a youth choir on that flight. No pressure.'),
      L('lois', 'Lois. The airport says the landing gear is jammed too. You are the landing gear now.')
    ],
    tip_other: [
      L('lois', 'Lois. Something is happening at {where}. I am on my way, but you will beat me there.'),
      L('lois', 'Every scanner in the newsroom just lit up for {where}. Go.')
    ],
    // ---------------- incident progress
    half: [
      L('dispatch', 'Units on scene, give me a status. The clock is running at {where}.'),
      L('dispatch', 'Dispatch to all units: still no all-clear at {where}. Hold your positions.'),
      L('lois', 'Whatever you are doing, do it faster. It is getting worse at {where}.'),
      L('lois', 'I am watching the live feed. Half the time is gone. You have got this.')
    ],
    lastOne: [
      L('dispatch', 'Spotter reports one civilian still inside at {where}. One.'),
      L('lois', 'One left. Just one. Bring them home.')
    ],
    lost: [
      L('lois', 'Someone did not make it out. I am so sorry.'),
      L('lois', 'We lost someone. Keep going. The others still need you.'),
      L('dispatch', 'Be advised, one civilian casualty confirmed at {where}.')
    ],
    // ---------------- outcomes (medal tiers from the ledger)
    gold: [
      L('perry', 'Perry White. Clean save, no casualties, nothing broken. That is the kind of story I put above the fold.'),
      L('perry', 'Now that is a front page. Lois, drop everything and file it before the competition does.'),
      L('perry', 'Not a scratch on the city and everybody walked away. You just made my week.'),
      L('perry', 'Thirty years of headlines, and this one I am framing.'),
      L('lois', 'Perfect. Not one window broken. I will have it filed within the hour.'),
      L('lois', 'You made that look easy. I know it was not.'),
      L('lois', 'Everybody is out and everybody is fine. Thank you. From all of us.')
    ],
    silver: [
      L('perry', 'Good work, mostly. The fire department will want a word about the mess, but the people are safe.'),
      L('perry', 'Second best is still a headline. Page two, maybe page one if nothing else burns tonight.'),
      L('lois', 'Everyone made it. That is what counts. The cleanup crews will grumble.'),
      L('lois', 'Nice save. A little rough around the edges, but so is good journalism.')
    ],
    bronze: [
      L('perry', 'It is done, I will give you that. But I cannot put a crater on page one and call it a rescue.'),
      L('perry', 'The job got done and the city paid for it. Do better. I know you can.'),
      L('lois', 'You got there. Some people got hurt along the way. Next time will be better, right?'),
      L('lois', 'It is over. I am going to need a softer headline than I hoped.')
    ],
    fail: [
      L('perry', 'We lost that one. I am not printing excuses, I am printing what happened. Learn from it.'),
      L('perry', 'Some nights the city does not get a happy ending. It still needs you tomorrow.'),
      L('lois', 'It is over. It was not your fault. Not all of it. Come by the office when you can.'),
      L('lois', 'I am sorry. I know you tried. Talk to me later?'),
      L('dispatch', 'All units, the scene at {where} is now a recovery operation. Stand by.')
    ],
    allClear: [
      L('dispatch', 'All units, {where} is code 4. Scene secure. Thanks for the assist, big guy.'),
      L('dispatch', 'Dispatch to all cars: all clear at {where}. Return to patrol.')
    ],
    shot: [
      L('jimmy', 'Got it! The whole thing, frame by frame! Mister White is going to flip!'),
      L('jimmy', 'That was unreal. I had the long lens on you the entire time. Front page, I swear.'),
      L('jimmy', 'I think I just took the best picture of my whole life. My hands are still shaking!')
    ],
    // ---------------- city-scale events
    collapse: [
      L('dispatch', 'All units, structural collapse! A tower just came down. Search and rescue to the debris field.'),
      L('dispatch', 'Multiple callers: building collapse in progress. Units, get back from the dust cloud.'),
      L('perry', 'Did I just watch a skyscraper fall on live television? Somebody tell me that was empty.'),
      L('lois', 'A building just fell. Please tell me you checked it was empty first.')
    ],
    damage: [
      L('perry', 'The repair estimate just passed {dmg}. I want heroics, not demolition.'),
      L('perry', 'Every hole you punch in this city, the taxpayers fill. Ease up, son.'),
      L('perry', 'I have the mayor on line two asking who pays for the windows. Do not make me answer that.'),
      L('perry', 'The insurance pages are going to need their own section after today.'),
      L('lois', 'Easy. Those buildings have people in them.'),
      L('lois', 'That is a lot of broken glass. The city is going to start sending you invoices.'),
      L('jimmy', 'Whoa, that was loud! Great photo though. Is that going to be expensive?'),
      L('jimmy', 'I got the dust cloud. Mister White says I cannot run it without a damage figure.')
    ],
    // ---------------- Hope swings (Perry's front page + Lois on the street)
    hopeUp: [
      L('perry', 'Letters to the editor are running nine to one in your favour. Do not let it go to your head.'),
      L('perry', 'People are starting to look up again. That is worth more than any headline.'),
      L('lois', 'Have you seen the street? People are smiling at strangers. That is you.'),
      L('lois', 'The city is talking about you, and for once it is all good.'),
      L('jimmy', 'Kids are chalking the shield on the sidewalk outside the Planet! I got a picture!')
    ],
    hopeHigh: [
      L('perry', 'Our readers just voted you citizen of the year. I did not rig it. Much.'),
      L('lois', 'I have never seen Metropolis like this. The whole city is standing up straighter.')
    ],
    hopeDown: [
      L('perry', 'Our phones are ringing and it is not fan mail. People are scared of you. Fix it.'),
      L('perry', 'The opinion page wants to call you a menace. I can only hold them off so long.'),
      L('lois', 'People are flinching when you fly over. I do not like that, and neither do you.'),
      L('lois', 'The city is losing faith. Slow down. Help someone small. It matters.'),
      L('jimmy', 'Somebody gave me a dirty look for wearing my shield shirt today. Rough week, huh?')
    ],
    hopeLow: [
      L('perry', 'We are at the bottom, son. The only way out is one decent act at a time.'),
      L('lois', 'They do not trust you right now. Earn it back. I will be watching.')
    ],
    // ---------------- first use of each power
    power_heat: [
      L('jimmy', 'Was that a beam out of your eyes? I need that again with better light!'),
      L('lois', 'Careful with the heat. Half this city is glass and the other half is gas lines.')
    ],
    power_freeze: [
      L('jimmy', 'Frost on my lens! You froze my camera from a block away!'),
      L('lois', 'Freeze breath. Remind me to call you the next time the newsroom air conditioning dies.')
    ],
    power_xray: [
      L('lois', 'If you are using the x-ray trick, stay out of my desk drawers.'),
      L('jimmy', 'Can you see through the darkroom door? Do not open it, the film is still out!')
    ],
    power_hear: [
      L('lois', 'If you can hear the whole city, you can hear me telling you to be careful.'),
      L('dispatch', 'Dispatch, uh, to our friend with the good ears: we appreciate the help on this channel.')
    ],
    power_clap: [
      L('jimmy', 'My ears are still ringing! Was that a thunderclap? With your hands?'),
      L('perry', 'Something just rattled every window on our floor. I am going to assume that was you.')
    ],
    power_slow: [
      L('jimmy', 'Everything went weird for a second. Was that you? Did time just slow down?'),
      L('lois', 'My coffee stopped in mid-pour. I am not even going to ask.')
    ],
    power_grab: [
      L('jimmy', 'You picked that up like a lunchbox! Do it again, slower, for the camera!'),
      L('lois', 'Put it down gently. Somebody owns that.')
    ],
    power_punch: [
      L('jimmy', 'That punch knocked my camera off the tripod! Totally worth it!'),
      L('perry', 'Easy on the haymakers. The city is not a punching bag.')
    ],
    // ---------------- speed records
    mach1: [
      L('jimmy', 'Sonic boom! I felt it in my teeth! Do it over the bay so I can catch the cone!'),
      L('lois', 'Was that a sonic boom? Every car alarm on Fifth just went off.')
    ],
    mach3: [
      L('jimmy', 'Mach three! I cannot even pan that fast! You are a red streak!'),
      L('lois', 'Mach three. Showing off already? I am writing that down.')
    ],
    mach10: [
      L('jimmy', 'Mach ten?! The weather service thinks you are a meteor!'),
      L('perry', 'The Air Force just called asking about something doing Mach ten. I told them no comment.'),
      L('lois', 'Mach ten. You could lap the planet before I finish this sentence. Please do not.')
    ],
    machPlanet: [
      L('perry', 'That boom rattled the globe on our roof. Do it again and the repair bill goes to you.'),
      L('jimmy', 'You flew right past the globe! The whole newsroom hit the floor!')
    ],
    // ---------------- help missions (missions.js owns the street talk; this is the word getting round)
    missionWin: [
      L('lois', 'Someone just called the newsroom to say you helped them on the street. Small things count.'),
      L('lois', 'Not every rescue makes the paper, but I heard about that one.'),
      L('jimmy', 'A lady just showed me a phone video of you helping her! Can I buy it off her?'),
      L('perry', 'We got a letter about you helping a regular joe today. I am running it on page three.'),
      L('perry', 'Big saves sell papers. Little ones build a city. Keep doing both.')
    ],
    missionFail: [
      L('lois', 'I heard about the trouble on the street. You cannot be everywhere. Still hurts, I know.'),
      L('perry', 'You let one slip. Shake it off and get back out there.')
    ],
    // ---------------- first call of the session
    hello: [
      L('lois', 'Lois. Perry finally gave me the city beat, so I guess we will be talking. I will call if anything breaks.'),
      L('lois', 'It is Lois. The scanners are quiet for now. Enjoy the view while it lasts.'),
      L('perry', 'Perry White. My reporters chase the news. You stop it before it happens. Do not make me choose.')
    ],
    // ---------------- idle city flavour
    idle_dispatch: [
      L('dispatch', 'Unit 12, 10-50 minor collision at {street}. No injuries. Tow requested.'),
      L('dispatch', 'Any unit, report of a loose dog on {street}. Animal control is backed up.'),
      L('dispatch', 'Unit 7, noise complaint, {street}. Someone practising the trumpet. Again.'),
      L('dispatch', 'Dispatch to traffic: signal outage at {street}. An officer is needed to direct.'),
      L('dispatch', 'Unit 3, check on a stalled delivery truck at {street}. Driver is fine; the horns are not.'),
      L('dispatch', 'Be advised, the harbour parade permit for Saturday has been approved. Plan accordingly.'),
      L('dispatch', 'Unit 14, welfare check at {street}. A neighbour has not seen the tenant in three days.'),
      L('dispatch', 'Any unit near the waterfront, kids climbing the pier railing again. Swing by.'),
      L('dispatch', 'Unit 9, shoplifter detained at {street}. The store wants a report.'),
      L('dispatch', 'Traffic advisory: lane closures on {street} for water main work.'),
      L('dispatch', 'All units, quiet shift so far. Let us keep it that way.'),
      L('dispatch', 'Unit 5, cat stuck on a fire escape at {street}. Yes, really.')
    ],
    idle_lois: [
      L('lois', 'Lois. Quiet out there today. I am almost suspicious.'),
      L('lois', 'Perry is on me about a deadline. If you see anything exciting, call me first.'),
      L('lois', 'I am working on a piece about the harbour contracts. The numbers do not add up.'),
      L('lois', 'If you fly past the office, wave. I will pretend I did not see you.'),
      L('lois', 'There is a rumour about a break-in at the university lab. Keep your eyes open.'),
      L('lois', 'Most people take the weekend off. Not you, huh?'),
      L('lois', 'I am interviewing the mayor tomorrow. Anything you want me to ask her?'),
      L('lois', 'The night shift brought doughnuts. I would save you one, but you are fast enough to take it.')
    ],
    idle_jimmy: [
      L('jimmy', 'Jimmy here! Could you fly past the globe at sunset? I am on the roof with the long lens!'),
      L('jimmy', 'Can you do a loop over the bay? Mister White wants a cover with sky in it.'),
      L('jimmy', 'Any chance you could hover by the bridge for a second? Just strike a pose. Kidding! Mostly.'),
      L('jimmy', 'If you swoop low down the avenue, I will get a great streak shot from the corner!'),
      L('jimmy', 'My editor says my last picture of you was a red blur. Could you slow down for one?'),
      L('jimmy', 'If something exciting happens, could it happen near the Planet? My knees hurt from running.'),
      L('jimmy', 'Do you ever land on rooftops? That would make an awesome portrait.')
    ],
    idle_perry: [
      L('perry', 'Perry White. A quiet day is good for the city and bad for my circulation.'),
      L('perry', 'When this paper prints your name, it should mean help is on the way. Keep it that way.'),
      L('perry', 'Great reporters and great heroes have one thing in common: they show up.'),
      L('perry', 'I do not care how fast you fly. I care what you do when you land.'),
      L('perry', 'Do not let the cheers or the boos steer you. Do the right thing and let the presses sort it out.'),
      L('perry', 'When I started, the biggest story in town was a pier fire. Now there is a man flying past my window.')
    ]
  };
  // which trigger groups replace each other in the queue (newest wins)
  const GROUP = { mach1: 'speed', mach3: 'speed', mach10: 'speed', hopeUp: 'hope', hopeHigh: 'hope', hopeDown: 'hope', hopeLow: 'hope' };
  const BASE_TYPES = { fire: 1, heli: 1, meteor: 1, robbery: 1 };

  // ================================================================== module state
  let THREE = null, ctx = null, ready = false;
  let clock = 0;                 // real seconds while the game runs (pauses with it)
  let cur = null;                // the call on air
  let lastStart = -99, lastEnd = -99, nextGap = 25, idleNext = 50, lastNonDispatch = -99;
  const queue = [];              // pending calls, best first
  const history = [];            // every call: {who, text, trigger, prio, incidentType, t0, t1, cut}
  const lastPick = {};           // trigger -> last variant index (never the same twice running)
  const recentText = [];         // last few lines, to keep variety across triggers
  const cooldown = {};           // trigger key -> clock when it may fire again
  const stats = { calls: 0, cut: 0, dropped: 0, byWho: {} };
  const W = {                    // watchers
    inc: null, incHalf: false, incTrapped: -1, medals: 0, resolved: 0, lost: 0,
    dmg: 0, dmgT: 0, dmgBase: 0, band: -1, hopeT: 0, used: {}, mach: 0, machT: 0, machMark: 0,
    fall: 0, ms: 0, mf: 0, hello: false, sp: new Set(), started: false, planet: null
  };
  const opts0 = {};
  const S = { voice: true, tts: false };

  // ================================================================== helpers
  const R = (a, b) => a + Math.random() * (b - a);
  const G = () => window.__game;
  const shortWhere = (s) => {
    if (!s) return 'downtown';
    const m = /^(.+?) & (.+)$/.exec(s);
    if (!m) return s;
    const strip = (x) => x.replace(/\s+(St|Ave|Blvd|Rd)\.?$/, '').replace(/’s Bay/, '’s Bay');
    return strip(m[1]) + ' and ' + strip(m[2]);
  };
  const STREETS = ['1st', '2nd', '3rd', 'Centennial', '5th', '6th', '7th', 'Harbor'];
  const AVES = ['Siegel', 'Shuster', 'Kane', 'Clinton', 'Bessolo', 'Lincoln', 'River Road'];
  const randStreet = () => STREETS[(Math.random() * STREETS.length) | 0] + ' and ' + AVES[(Math.random() * AVES.length) | 0];
  function fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, (_, k) => {
      if (k === 'street') return randStreet();
      if (vars && vars[k] !== undefined) return vars[k];
      return 'downtown';
    });
  }
  function fmtDmg(d) { return d >= 1e9 ? '$' + (d / 1e9).toFixed(1) + ' billion' : '$' + Math.max(1, Math.round(d / 1e6)) + ' million'; }

  // pick a variant: never the one this trigger used last, avoid recent texts, optional speaker filter
  function pickLine(trigger, onlyWho) {
    const list = LINES[trigger]; if (!list || !list.length) return null;
    const cand = [];
    for (let i = 0; i < list.length; i++) {
      if (onlyWho && onlyWho.indexOf(list[i].w) < 0) continue;
      if (i === lastPick[trigger] && list.length > 1) continue;
      cand.push(i);
    }
    if (!cand.length) return null;
    const fresh = cand.filter(i => recentText.indexOf(list[i].t) < 0);
    const pool = fresh.length ? fresh : cand;
    const i = pool[(Math.random() * pool.length) | 0];
    lastPick[trigger] = i;
    return list[i];
  }

  // ================================================================== queueing
  // prio 3 = urgent (dispatch callout: starts now, may cut in); 2 = incident-tied (8 s gap);
  // 1 = chatter (20-40 s gap, and not during an emergency unless it is a reaction).
  function enqueue(item) {
    if (item.group) for (let i = queue.length - 1; i >= 0; i--) if (queue[i].group === item.group) queue.splice(i, 1);
    queue.push(item);
    queue.sort((a, b) => (b.prio - a.prio) || ((PRIO_RANK[b.who] || 0) - (PRIO_RANK[a.who] || 0)) || (a.at - b.at));
    while (queue.length > CFG.maxQueue) { queue.pop(); stats.dropped++; }
    return item;
  }
  function trig(trigger, o) {
    o = o || opts0;
    if (o.cd) { if (clock < (cooldown[o.cdKey || trigger] || 0)) return null; cooldown[o.cdKey || trigger] = clock + o.cd; }
    const line = pickLine(trigger, o.who); if (!line) return null;
    return enqueue({
      who: line.w, text: fill(line.t, o.vars), trigger, prio: o.prio || 1, at: clock,
      notBefore: clock + (o.delay || 0), exp: clock + (o.ttl || 30), inc: o.inc || null,
      incidentType: o.incidentType !== undefined ? o.incidentType : null, group: GROUP[trigger] || null,
      reaction: !!o.reaction, interrupt: !!o.interrupt, after: !!o.after
    });
  }
  function say(who, text, o) {
    o = o || {};
    if (!SPK[who]) who = 'dispatch';
    const g = G(), inc = g && g.currentInc;
    const urgent = !!(o.urgent || o.interrupt);
    return enqueue({
      who, text: String(text), trigger: o.trigger || 'say', prio: o.prio || (urgent ? 3 : 2), at: clock,
      notBefore: clock + (o.delay || 0), exp: clock + (o.ttl || 60), inc: null,
      incidentType: o.incidentType !== undefined ? o.incidentType : (inc ? inc.type : null),
      group: null, reaction: true, interrupt: urgent, onEnd: o.onEnd || null
    });
  }

  function canStart(it, g) {
    if (clock < it.notBefore) return false;
    if (it.prio >= 3) return true;
    if (clock - lastEnd < CFG.gapAfter) return false;
    if (it.prio === 2) return clock - lastStart >= CFG.gapEvent;
    if (g.currentInc && !it.reaction) return false;
    return clock - lastStart >= nextGap;
  }
  function pump(g) {
    // drop stale items (expired, or tied to an emergency that is no longer the current one)
    for (let i = queue.length - 1; i >= 0; i--) {
      const it = queue[i];
      if (clock > it.exp || (it.inc && it.inc !== g.currentInc) || (it.after && g.currentInc)) { queue.splice(i, 1); stats.dropped++; }
    }
    if (!queue.length) return;
    if (cur) {
      // only urgent calls cut in, and never on another urgent call
      const it = queue[0];
      if (it.prio >= 3 && it.interrupt && cur.prio < 3 && clock >= it.notBefore) { hangUp(true); }
      else return;
    }
    for (let i = 0; i < queue.length; i++) {
      if (canStart(queue[i], g)) { const it = queue.splice(i, 1)[0]; startCall(it, g); return; }
    }
  }

  // ================================================================== speech timeline (also drives subtitles + waveform)
  const VOW = { a: [800, 1200, 2500], e: [500, 1850, 2600], i: [330, 2250, 3000], o: [560, 900, 2450], u: [360, 850, 2300], y: [330, 2100, 2900] };
  function plan(text, spk) {
    const words = text.split(/\s+/).filter(Boolean);
    const syl = [], wordT = [], wordEnd = [];
    let t = 0, chars = 0, sent = 0;
    const per = 1 / spk.rate;
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      chars += (wi ? 1 : 0) + w.length;
      wordT.push(t); wordEnd.push(chars);
      const lw = w.toLowerCase();
      let groups = lw.match(/[aeiouy]+/g) || [];
      const digits = lw.match(/[0-9]/g);
      if (digits) { groups = groups.concat(digits.map(() => 'e')); }
      if (!groups.length) groups = ['a'];
      if (groups.length > 1 && /e$/.test(lw) && !/le$/.test(lw)) groups.pop(); // silent e
      const consonantStart = /^[^aeiouy0-9]/.test(lw);
      for (let k = 0; k < groups.length; k++) {
        const d = per * R(0.78, 1.22) * (k === groups.length - 1 && groups.length > 1 ? 1.15 : 1);
        syl.push({ t, d, v: groups[k][0], a: (k === 0 ? 1 : 0.78) * R(0.85, 1), c: k === 0 ? consonantStart : Math.random() < 0.55, s: sent });
        t += d;
      }
      t += 0.035;
      const end = w[w.length - 1];
      if (end === ',' || end === ';' || end === ':') t += 0.17;
      else if (end === '.' || end === '!' || end === '?') { t += 0.3; sent++; syl[syl.length - 1].q = end === '?'; syl[syl.length - 1].x = end === '!'; syl[syl.length - 1].end = true; }
      else if (end === '-') t += 0.12;
    }
    return { syl, wordT, wordEnd, dur: t + 0.05 };
  }

  // ================================================================== calls
  function startCall(it, g) {
    const spk = SPK[it.who];
    const pl = plan(it.text, spk);
    const t0 = clock;
    cur = {
      who: it.who, spk, text: it.text, trigger: it.trigger, prio: it.prio, incidentType: it.incidentType,
      t0, tSpeak: t0 + CFG.open, tEnd: t0 + CFG.open + pl.dur + CFG.hold, plan: pl, word: -1, sylI: 0, audio: null, onEnd: it.onEnd || null
    };
    lastStart = t0;
    if (it.who !== 'dispatch') lastNonDispatch = t0;
    nextGap = R(CFG.gapChatter[0], CFG.gapChatter[1]);
    stats.calls++; stats.byWho[it.who] = (stats.byWho[it.who] || 0) + 1;
    recentText.push(it.text); if (recentText.length > 12) recentText.shift();
    const rec = { who: it.who, name: spk.name, text: it.text, trigger: it.trigger, prio: it.prio, incidentType: it.incidentType, t0, t1: cur.tEnd, simT: g.simT, cut: false };
    history.push(rec); if (history.length > 400) history.shift();
    cur.rec = rec;
    // test-hook contract: __game.events gets a `line` entry per call
    try {
      if (!Array.isArray(g.events)) g.events = [];
      g.events.push({ t: g.simT, type: 'line', who: it.who, speaker: spk.name, text: it.text, trigger: it.trigger, incidentType: it.incidentType });
    } catch (_) { /* events may be a frozen getter */ }
    showCard(cur);
    if (S.tts) speakTTS(cur); else if (S.voice) cur.audio = voiceCall(cur, g);
  }
  function hangUp(cut) {
    const c = cur; if (!c) return;
    cur = null;
    c.rec.t1 = clock; c.rec.cut = !!cut;
    if (cut) stats.cut++;
    lastEnd = clock;
    if (c.audio) stopAudio(c.audio, cut);
    if (S.tts && window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch (_) { /* optional */ }
    hideCard();
    if (c.onEnd) try { c.onEnd(c.rec); } catch (e) { console.warn('[comms] onEnd', e); }
  }

  // ================================================================== radio audio (WebAudio on __game.AU)
  let bus = null, driveCurve = null, warned = false;
  function audioReady() {
    const g = G(), AU = g && g.AU;
    if (!AU || !AU.ctx || !AU.noise) return null;
    if (!bus || bus.context !== AU.ctx) {
      const c = AU.ctx;
      bus = c.createGain(); bus.gain.value = AU.muted ? 0 : CFG.vol;
      // straight to the output: the radio is in his ear, so super hearing's city muffle doesn't touch it
      bus.connect(c.destination);
      if (!driveCurve) {
        const n = 1024; driveCurve = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; driveCurve[i] = Math.tanh(2.6 * x) / Math.tanh(2.6); }
      }
    }
    return AU;
  }
  function noiseSrc(c, AU, t, dur) {
    const s = c.createBufferSource(); s.buffer = AU.noise; s.loop = true;
    s.start(t, Math.random() * 1.5); s.stop(t + dur);
    return s;
  }
  // squelch: a short band-limited hiss burst (police: with the tail of the carrier dropping out)
  function squelch(c, AU, t, spk, closing, dest) {
    const police = spk.crackle >= 0.6;
    const s = noiseSrc(c, AU, t, 0.4);
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(police ? 2400 : 1600, t);
    f.frequency.exponentialRampToValueAtTime(police ? 900 : 1200, t + (closing ? 0.22 : 0.12));
    const gg = c.createGain();
    const pk = police ? 0.5 : 0.22, len = closing ? (police ? 0.28 : 0.12) : (police ? 0.16 : 0.08);
    gg.gain.setValueAtTime(0.0001, t); gg.gain.linearRampToValueAtTime(pk, t + 0.006);
    gg.gain.setValueAtTime(pk * 0.8, t + len * 0.6); gg.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(f); f.connect(gg); gg.connect(dest);
    if (!closing || !police) {
      // the "chirp" of a keyed mic (police) or the click of a phone line (Planet)
      const o = c.createOscillator(), og = c.createGain();
      o.type = police ? 'sine' : 'square';
      o.frequency.setValueAtTime(police ? (closing ? 1100 : 1500) : 2200, t);
      og.gain.setValueAtTime(police ? 0.09 : 0.05, t); og.gain.exponentialRampToValueAtTime(0.0001, t + (police ? 0.07 : 0.012));
      o.connect(og); og.connect(dest); o.start(t); o.stop(t + 0.1);
    }
  }
  function voiceCall(call, g) {
    let AU;
    try {
      AU = audioReady(); if (!AU || AU.muted) return null;
      const c = AU.ctx, spk = call.spk, pl = call.plan;
      const now = c.currentTime + 0.02, ts = now + CFG.open, tEnd = ts + pl.dur;
      const out = c.createGain(); out.gain.value = 1;  // per-call fader (for cutting in)
      out.connect(bus);
      squelch(c, AU, now, spk, false, out);
      // ---- voice: saw (voiced) + noise (breath / consonants) -> three formants -> gate -> radio band
      const osc = c.createOscillator(); osc.type = spk.wave;
      osc.frequency.setValueAtTime(spk.pitch, now);
      const vib = c.createOscillator(), vibG = c.createGain(); vib.frequency.value = R(4.5, 6); vibG.gain.value = spk.pitch * 0.012;
      vib.connect(vibG); vibG.connect(osc.frequency);
      const oscG = c.createGain(); oscG.gain.value = spk.voiced * (spk.wave === 'square' ? 0.6 : 1);
      const nz = noiseSrc(c, AU, now, pl.dur + CFG.open + 0.4);
      const nzG = c.createGain(); nzG.gain.setValueAtTime(spk.breath, now);
      osc.connect(oscG); nz.connect(nzG);
      const F = [], fq = [7, 9, 11], fl = [1, 0.7, 0.35];
      const mix = c.createGain(); mix.gain.value = 1;
      for (let k = 0; k < 3; k++) {
        const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = fq[k];
        f.frequency.setValueAtTime(VOW.a[k] * spk.form, now);
        const fg = c.createGain(); fg.gain.value = fl[k] * 3.2;
        oscG.connect(f); nzG.connect(f); f.connect(fg); fg.connect(mix); F.push(f);
      }
      const gate = c.createGain(); gate.gain.setValueAtTime(0, now);
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = spk.band[0]; hp.Q.value = 0.8;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = spk.band[1]; lp.Q.value = 0.8;
      mix.connect(gate); gate.connect(hp); hp.connect(lp);
      const vg = c.createGain(); vg.gain.value = 0.9;
      if (spk.drive > 0) {
        const pre = c.createGain(); pre.gain.value = 1 + spk.drive * 3;
        const sh = c.createWaveShaper(); sh.curve = driveCurve;
        lp.connect(pre); pre.connect(sh); sh.connect(vg);
        vg.gain.value = 0.55;
      } else lp.connect(vg);
      vg.connect(out);
      // ---- syllable schedule: gate envelope, formant glides, pitch contour, consonant hiss
      let sentStart = 0;
      for (let i = 0; i < pl.syl.length; i++) {
        const s = pl.syl[i], t = ts + s.t, d = s.d;
        const fm = VOW[s.v] || VOW.a;
        for (let k = 0; k < 3; k++) F[k].frequency.setTargetAtTime(fm[k] * spk.form * R(0.94, 1.06), t, 0.018);
        // declination across a sentence, a rise on questions, a lift on exclamations
        const frac = (s.t - sentStart) / 2.5;
        let p = spk.pitch * (1 + spk.inton * (Math.random() - 0.5) * 2) * (1 - 0.1 * Math.min(1, frac));
        if (s.q) p *= 1.25; if (s.x) p *= 1.12;
        osc.frequency.setTargetAtTime(p, t, 0.025);
        if (s.end) sentStart = s.t + d;
        const a = s.a * 0.9;
        gate.gain.setValueAtTime(0.0001, t);
        gate.gain.linearRampToValueAtTime(a, t + Math.min(0.03, d * 0.25));
        gate.gain.setValueAtTime(a * 0.85, t + d * 0.62);
        gate.gain.linearRampToValueAtTime(0.0001, t + d * 0.96);
        if (s.c) { nzG.gain.setValueAtTime(spk.breath * 3.2, t); nzG.gain.setTargetAtTime(spk.breath, t + 0.02, 0.02); }
      }
      osc.start(now); vib.start(now); osc.stop(tEnd + 0.5); vib.stop(tEnd + 0.5);
      // ---- crackle bed (police / cockpit / Jimmy's cell): steady hiss with random pops
      let crk = null;
      if (spk.crackle > 0) {
        crk = noiseSrc(c, AU, now, pl.dur + CFG.open + 0.4);
        const hf = c.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 1800;
        const cg = c.createGain(); const base = 0.025 * spk.crackle;
        cg.gain.setValueAtTime(base, now);
        for (let t = now + 0.05; t < tEnd; t += R(0.04, 0.22)) {
          cg.gain.setValueAtTime(base + R(0.05, 0.22) * spk.crackle, t);
          cg.gain.exponentialRampToValueAtTime(base, t + R(0.008, 0.03));
        }
        cg.gain.setValueAtTime(base, tEnd); cg.gain.linearRampToValueAtTime(0.0001, tEnd + 0.05);
        crk.connect(hf); hf.connect(cg); cg.connect(out);
      }
      squelch(c, AU, tEnd + 0.04, spk, true, out);
      return { out, osc, vib, nz, crk, c };
    } catch (e) {
      if (!warned) { warned = true; console.warn('[comms] radio audio unavailable:', e && e.message); }
      return null;
    }
  }
  function stopAudio(a, cut) {
    try {
      const t = a.c.currentTime;
      if (!cut) return; // natural end: everything is already scheduled to stop
      a.out.gain.cancelScheduledValues(t); a.out.gain.setValueAtTime(a.out.gain.value, t); a.out.gain.linearRampToValueAtTime(0.0001, t + 0.06);
      for (const n of [a.osc, a.vib, a.nz, a.crk]) if (n) try { n.stop(t + 0.08); } catch (_) { /* already stopped */ }
    } catch (_) { /* context closed */ }
  }
  function speakTTS(call) {
    try {
      const ss = window.speechSynthesis; if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return;
      const u = new SpeechSynthesisUtterance(call.text);
      u.pitch = Math.max(0.1, Math.min(2, call.spk.pitch / 170)); u.rate = call.spk.rate / 6.8;
      const g = G(); u.volume = g && g.AU && g.AU.muted ? 0 : 1;
      ss.cancel(); ss.speak(u);
    } catch (_) { /* optional accessibility path */ }
  }

  // ================================================================== the comms card (DOM)
  const UI = { el: null, port: null, pctx: null, wave: null, wctx: null, name: null, role: null, chan: null, said: null, rest: null, state: '', who: '', hideT: 0 };
  const PORTRAITS = {};
  function buildDOM() {
    const host = document.getElementById('hud') || document.body;
    const el = document.createElement('div');
    el.id = 'comms'; el.className = 'comms'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="cm-lights"><i></i><i></i></div>' +
      '<div class="cm-port"><canvas width="152" height="152"></canvas><span class="cm-ini"></span></div>' +
      '<div class="cm-body">' +
        '<div class="cm-head"><span class="cm-chan"></span><span class="cm-live"><i></i><b>INCOMING</b></span></div>' +
        '<div class="cm-name"></div><div class="cm-role"></div>' +
        '<p class="cm-sub"><span class="cm-said"></span><span class="cm-rest"></span></p>' +
        '<canvas class="cm-wave" width="300" height="44"></canvas>' +
      '</div>';
    host.appendChild(el);
    UI.el = el;
    UI.port = el.querySelector('.cm-port canvas'); UI.pctx = UI.port.getContext('2d');
    UI.wave = el.querySelector('.cm-wave'); UI.wctx = UI.wave.getContext('2d');
    UI.name = el.querySelector('.cm-name'); UI.role = el.querySelector('.cm-role'); UI.chan = el.querySelector('.cm-chan');
    UI.said = el.querySelector('.cm-said'); UI.rest = el.querySelector('.cm-rest'); UI.ini = el.querySelector('.cm-ini');
    UI.live = el.querySelector('.cm-live b');
    for (const k in SPK) PORTRAITS[k] = drawPortrait(k);
  }
  function setState(s) { if (UI.state === s) return; UI.state = s; UI.el.className = 'comms' + (s ? ' ' + s : '') + (UI.who ? ' cm-' + UI.who : ''); }
  function showCard(call) {
    if (!UI.el) return;
    UI.who = call.who;
    UI.el.style.setProperty('--cm', call.spk.col);
    UI.name.textContent = call.spk.name; UI.role.textContent = call.spk.role; UI.chan.textContent = call.spk.chan; UI.ini.textContent = call.spk.ini;
    UI.said.textContent = ''; UI.rest.textContent = call.text; UI.live.textContent = call.who === 'dispatch' ? 'PRIORITY' : 'INCOMING';
    UI.state = ''; setState('on ring');
    drawPortraitFrame(call, 0);
  }
  function hideCard() { if (UI.el) setState('out'); UI.hideT = 0.4; }

  // procedural portrait: newsprint / radio-grid backdrop, a silhouette with a coloured rim, props
  function drawPortrait(who) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 152;
    const x = cv.getContext('2d'), spk = SPK[who], W2 = 152;
    // backdrop
    const bg = x.createRadialGradient(W2 * 0.5, W2 * 0.38, 8, W2 * 0.5, W2 * 0.5, W2 * 0.75);
    bg.addColorStop(0, spk.col); bg.addColorStop(0.55, shade(spk.col, 0.35)); bg.addColorStop(1, '#05070f');
    x.fillStyle = bg; x.fillRect(0, 0, W2, W2);
    x.globalAlpha = 0.16; x.fillStyle = '#000';
    if (who === 'dispatch' || who === 'pilot') {
      x.strokeStyle = '#000'; x.lineWidth = 1;
      for (let i = 0; i < W2; i += 12) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, W2); x.moveTo(0, i); x.lineTo(W2, i); x.stroke(); }
    } else {
      for (let yy = 4; yy < W2; yy += 7) for (let xx = (yy / 7 & 1) * 3.5; xx < W2; xx += 7) { const r = 1.2 + 1.6 * (yy / W2); x.beginPath(); x.arc(xx, yy, r, 0, 6.283); x.fill(); }
    }
    x.globalAlpha = 1;
    // silhouette (dark), drawn as one path so a single stroke gives the rim
    const sil = new Path2D();
    const cx = W2 / 2;
    const shoulders = who === 'perry' ? 64 : who === 'jimmy' ? 50 : who === 'lois' ? 48 : 56;
    const headR = who === 'perry' ? 25 : who === 'jimmy' ? 22 : 22;
    const headY = who === 'jimmy' ? 66 : 64;
    // shoulders + neck
    sil.moveTo(cx - shoulders, W2 + 2);
    sil.bezierCurveTo(cx - shoulders, 118, cx - 30, 108, cx - 11, 104);
    sil.lineTo(cx - 10, headY + headR - 6); sil.lineTo(cx + 10, headY + headR - 6); sil.lineTo(cx + 11, 104);
    sil.bezierCurveTo(cx + 30, 108, cx + shoulders, 118, cx + shoulders, W2 + 2);
    sil.closePath();
    sil.ellipse(cx, headY, headR * 0.86, headR, 0, 0, 6.283);
    if (who === 'lois') {
      // a sharp bob with a side part
      sil.moveTo(cx - 24, headY + 16);
      sil.bezierCurveTo(cx - 30, headY - 10, cx - 18, headY - 28, cx + 2, headY - 25);
      sil.bezierCurveTo(cx + 22, headY - 24, cx + 30, headY - 6, cx + 25, headY + 17);
      sil.lineTo(cx + 15, headY + 14); sil.lineTo(cx - 14, headY + 15); sil.closePath();
    } else if (who === 'jimmy') {
      // a cowlick that will not lie flat
      sil.moveTo(cx - 19, headY - 8);
      sil.bezierCurveTo(cx - 18, headY - 26, cx + 8, headY - 30, cx + 19, headY - 12);
      sil.lineTo(cx + 6, headY - 22); sil.lineTo(cx + 9, headY - 36); sil.lineTo(cx - 2, headY - 24); sil.closePath();
    } else if (who === 'perry') {
      // big frame, receding hair at the temples
      sil.moveTo(cx - 22, headY - 4); sil.bezierCurveTo(cx - 24, headY - 22, cx - 10, headY - 27, cx - 2, headY - 20);
      sil.bezierCurveTo(cx + 8, headY - 27, cx + 24, headY - 22, cx + 22, headY - 4); sil.closePath();
    } else if (who === 'pilot') {
      // peaked captain's cap
      sil.moveTo(cx - 24, headY - 10); sil.lineTo(cx - 20, headY - 26); sil.bezierCurveTo(cx - 8, headY - 34, cx + 8, headY - 34, cx + 20, headY - 26);
      sil.lineTo(cx + 24, headY - 10); sil.lineTo(cx + 30, headY - 6); sil.lineTo(cx - 6, headY - 8); sil.closePath();
    }
    x.save();
    x.shadowColor = spk.col; x.shadowBlur = 14;
    x.strokeStyle = spk.col; x.lineWidth = 3; x.stroke(sil);
    x.restore();
    const fillG = x.createLinearGradient(0, 30, 0, W2); fillG.addColorStop(0, '#11131c'); fillG.addColorStop(1, '#06070c');
    x.fillStyle = fillG; x.fill(sil);
    // props
    x.lineWidth = 2.2; x.strokeStyle = spk.col; x.fillStyle = spk.col;
    if (who === 'lois') {
      x.beginPath(); x.arc(cx + 18, headY + 9, 2.2, 0, 6.283); x.fill(); // earring glint
      x.globalAlpha = 0.85; x.beginPath(); x.moveTo(cx - 12, 106); x.lineTo(cx, 124); x.lineTo(cx + 12, 106); x.stroke(); x.globalAlpha = 1; // collar
    } else if (who === 'jimmy') {
      x.beginPath(); x.moveTo(cx, 108); x.lineTo(cx - 11, 102); x.lineTo(cx - 11, 114); x.closePath(); x.moveTo(cx, 108); x.lineTo(cx + 11, 102); x.lineTo(cx + 11, 114); x.closePath(); x.fill(); // bow tie
      x.globalAlpha = 0.9; x.beginPath(); x.moveTo(cx - 40, 112); x.lineTo(cx + 22, 150); x.stroke(); x.globalAlpha = 1; // strap
      x.fillStyle = '#0b0c12'; x.fillRect(cx + 14, 128, 30, 20); x.strokeRect(cx + 14, 128, 30, 20); // camera
      x.beginPath(); x.arc(cx + 29, 138, 6, 0, 6.283); x.stroke(); x.fillStyle = spk.col; x.fillRect(cx + 36, 130, 5, 3);
    } else if (who === 'perry') {
      x.beginPath(); x.moveTo(cx - 5, 106); x.lineTo(cx + 5, 106); x.lineTo(cx + 7, 140); x.lineTo(cx, 150); x.lineTo(cx - 7, 140); x.closePath(); x.fill(); // tie
      x.globalAlpha = 0.9; x.beginPath(); x.rect(cx - 17, headY - 2, 13, 8); x.rect(cx + 4, headY - 2, 13, 8); x.moveTo(cx - 4, headY + 1); x.lineTo(cx + 4, headY + 1); x.stroke(); x.globalAlpha = 1; // glasses
    } else if (who === 'dispatch') {
      x.beginPath(); x.arc(cx, headY - 2, headR + 3, Math.PI * 1.05, Math.PI * 1.95); x.stroke(); // headset band
      x.fillRect(cx - headR - 5, headY - 6, 7, 14); x.fillRect(cx + headR - 2, headY - 6, 7, 14); // ear cups
      x.beginPath(); x.moveTo(cx - headR - 1, headY + 6); x.quadraticCurveTo(cx - 18, headY + 24, cx - 4, headY + 20); x.stroke(); // boom mic
      badge(x, cx + 34, 128, 11, spk.col);
    } else if (who === 'pilot') {
      x.fillRect(cx - 20, headY - 12, 40, 3); // cap band
      x.beginPath(); x.moveTo(cx - 28, 124); x.lineTo(cx - 12, 124); x.moveTo(cx - 28, 129); x.lineTo(cx - 12, 129); x.moveTo(cx - 28, 134); x.lineTo(cx - 12, 134); x.stroke(); // stripes
      x.beginPath(); x.moveTo(cx + headR - 1, headY + 4); x.quadraticCurveTo(cx + 18, headY + 24, cx + 4, headY + 20); x.stroke();
    }
    // vignette
    const vg = x.createRadialGradient(cx, cx, W2 * 0.35, cx, cx, W2 * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    x.fillStyle = vg; x.fillRect(0, 0, W2, W2);
    return cv;
  }
  function badge(x, bx, by, r, col) {
    x.save(); x.fillStyle = col; x.beginPath();
    for (let i = 0; i < 14; i++) { const a = -Math.PI / 2 + i * Math.PI / 7, rr = i & 1 ? r * 0.55 : r; x.lineTo(bx + Math.cos(a) * rr, by + Math.sin(a) * rr); }
    x.closePath(); x.fill(); x.fillStyle = '#0b0c12'; x.beginPath(); x.arc(bx, by, r * 0.32, 0, 6.283); x.fill(); x.restore();
  }
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) * k | 0, g = ((n >> 8) & 255) * k | 0, b = (n & 255) * k | 0;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // envelope of the speech at time t (s since speech start): 0..1, follows the syllable gate
  function envAt(call, t) {
    const syl = call.plan.syl;
    if (t < 0 || !syl.length) return 0;
    let i = call.sylI;
    while (i < syl.length - 1 && syl[i].t + syl[i].d <= t) i++;
    call.sylI = i;
    const s = syl[i]; if (t < s.t || t > s.t + s.d) return 0;
    const u = (t - s.t) / s.d;
    return s.a * (u < 0.12 ? u / 0.12 : u < 0.62 ? 1 - 0.15 * (u - 0.12) / 0.5 : Math.max(0, 0.85 * (0.96 - u) / 0.34));
  }
  let scan = 0;
  function drawPortraitFrame(call, env) {
    const x = UI.pctx; if (!x) return;
    x.globalAlpha = 1; x.drawImage(PORTRAITS[call.who], 0, 0);
    // moving scanline band + fine lines
    scan = (scan + 1.6) % 190;
    x.globalAlpha = 0.1; x.fillStyle = '#fff'; x.fillRect(0, scan - 30, 152, 20);
    x.globalAlpha = 0.18; x.fillStyle = '#000';
    for (let y = 0; y < 152; y += 4) x.fillRect(0, y, 152, 1);
    // talk glow on the rim
    x.globalAlpha = 0.25 + 0.75 * env; x.strokeStyle = call.spk.col; x.lineWidth = 5;
    x.strokeRect(2.5, 2.5, 147, 147);
    x.globalAlpha = 1;
  }
  const BARS = 30, barH = new Float32Array(BARS), barSeed = new Float32Array(BARS);
  for (let i = 0; i < BARS; i++) barSeed[i] = Math.random();
  function drawWave(call, env, t) {
    const x = UI.wctx; if (!x) return;
    const w = 300, h = 44, bw = w / BARS;
    x.clearRect(0, 0, w, h);
    x.globalAlpha = 0.25; x.fillStyle = call.spk.col; x.fillRect(0, h / 2 - 0.5, w, 1);
    x.globalAlpha = 1;
    const static0 = call.spk.crackle * 0.08;
    for (let i = 0; i < BARS; i++) {
      // a band-shaped spectrum that breathes with the syllable envelope
      const centre = 1 - Math.abs(i - BARS * 0.42) / (BARS * 0.6);
      const wob = 0.55 + 0.45 * Math.sin(t * (9 + barSeed[i] * 13) + barSeed[i] * 40);
      const target = Math.max(static0 * Math.random(), env * Math.max(0.15, centre) * wob);
      barH[i] += (target - barH[i]) * 0.45;
      const bh = Math.max(1.5, barH[i] * (h - 4));
      x.fillRect(i * bw + 1.5, (h - bh) / 2, bw - 3, bh);
    }
  }
  function updateCard(dt) {
    if (UI.hideT > 0) { UI.hideT -= dt; if (UI.hideT <= 0 && !cur) setState(''); }
    if (!cur) return;
    const t = clock - cur.tSpeak;
    if (t >= 0 && UI.state.indexOf('ring') >= 0) { setState('on'); UI.live.textContent = cur.who === 'dispatch' ? 'ON AIR' : 'LIVE'; }
    // subtitle: reveal word by word as each word's first syllable starts
    const pl = cur.plan;
    let wI = cur.word;
    while (wI + 1 < pl.wordT.length && pl.wordT[wI + 1] <= t) wI++;
    if (wI !== cur.word) {
      cur.word = wI;
      const n = wI >= 0 ? pl.wordEnd[wI] : 0;
      UI.said.textContent = cur.text.slice(0, n); UI.rest.textContent = cur.text.slice(n);
    }
    const env = envAt(cur, t);
    drawPortraitFrame(cur, env);
    drawWave(cur, env, clock);
  }

  // ================================================================== trigger detection
  function machOf(P) { return P.vel.length() / Math.max(295, 340.3 - 0.0041 * P.pos.y); }
  function medalTotal(L) { return L.medals.gold + L.medals.silver + L.medals.bronze; }
  function incTypeKey(inc) {
    if (inc.type === 'meteor' && ((inc.m && inc.m.kryp) || /kryptonite/i.test(inc.title || ''))) return 'kryp';
    return inc.type;
  }
  function onIncStart(g, inc, loose) {
    if (!loose) { W.incHalf = false; W.incTrapped = -1; }
    const tie = loose ? null : inc;
    const key = incTypeKey(inc), where = shortWhere(inc.where);
    const vars = { where };
    const sk = LINES['start_' + key] ? 'start_' + key : 'start_other';
    // the callout: urgent, starts now (cuts in on chatter)
    trig(sk, { prio: 3, interrupt: true, inc: tie, incidentType: inc.type, vars, ttl: 1.0, reaction: true });
    if (!BASE_TYPES[inc.type]) {
      // a set piece (bus, airliner, ...): its own voice follows the callout
      if (inc.type === 'airliner' || inc.type === 'plane') trig('pilot_airliner', { prio: 2, inc: tie, incidentType: inc.type, vars, delay: 2, ttl: 20, reaction: true });
      else if (inc.type === 'bus') trig('driver_bus', { prio: 2, inc: tie, incidentType: inc.type, vars, delay: 2, ttl: 20, reaction: true });
    }
    const tk = LINES['tip_' + key] ? 'tip_' + key : 'tip_other';
    trig(tk, { prio: 2, inc: tie, incidentType: inc.type, vars, delay: R(6, 9), ttl: 25, reaction: true });
  }
  function onIncEnd(g, inc) {
    const Lg = g.ledger, total = medalTotal(Lg);
    const vars = { where: shortWhere(inc.where) };
    let tier = null;
    if (total > W.medals) tier = Lg.medals.gold > W.gold ? 'gold' : Lg.medals.silver > W.silver ? 'silver' : 'bronze';
    W.medals = total; W.gold = Lg.medals.gold; W.silver = Lg.medals.silver;
    if (tier) {
      // the verdict comes from the newsroom; ambient (incidentType null) because the emergency is over
      trig(tier, { prio: 2, delay: 1.2, ttl: 30, reaction: true, after: true });
      if (tier === 'gold' && Math.random() < 0.5) trig('shot', { prio: 1, delay: 4, ttl: 45, reaction: true, after: true });
      else if (Math.random() < 0.35) trig('allClear', { prio: 1, delay: 3, ttl: 30, vars, reaction: true, after: true });
    } else {
      trig('fail', { prio: 2, delay: 1.5, ttl: 30, vars, reaction: true, after: true });
    }
  }
  function detect(g, dt) {
    const Lg = g.ledger, P = g.P, inc = g.currentInc;
    if (!W.started) {
      W.started = true; W.medals = medalTotal(Lg); W.gold = Lg.medals.gold; W.silver = Lg.medals.silver;
      W.lost = Lg.lost; W.dmg = W.dmgBase = Lg.damage; W.band = Math.floor(Lg.hope / 20);
      const b = (g.buildings || []).find(bb => bb.lot && bb.lot.i === 3 && bb.lot.j === 3);
      if (b) W.planet = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
      const M = window.SM_MISSIONS; if (M && M.stats) { W.ms = M.stats.success; W.mf = M.stats.fail; }
    }
    // ---- emergencies
    if (inc !== W.inc) {
      if (W.inc) onIncEnd(g, W.inc);
      W.inc = inc;
      if (inc) onIncStart(g, inc);
    }
    if (inc) {
      if (!W.incHalf && inc.limit && inc.age > inc.limit * 0.5) { W.incHalf = true; trig('half', { prio: 2, inc, incidentType: inc.type, vars: { where: shortWhere(inc.where) }, ttl: 12, reaction: true }); }
      if (inc.trapped && inc.trapped.length > 1) {
        let n = 0; for (const p of inc.trapped) if (p.mode === 'trapped') n++;
        if (W.incTrapped > 1 && n === 1) trig('lastOne', { prio: 2, inc, incidentType: inc.type, vars: { where: shortWhere(inc.where) }, ttl: 15, reaction: true });
        W.incTrapped = n;
      }
    }
    if (Lg.lost > W.lost) {
      W.lost = Lg.lost;
      trig('lost', { prio: 2, cd: 30, inc, incidentType: inc ? inc.type : null, vars: { where: shortWhere(inc && inc.where) }, ttl: 12, reaction: true });
    }
    // ---- a tower coming down
    const fq = g.fallQueue ? g.fallQueue.length : 0;
    if (fq >= CFG.collapseBlocks && W.fall < CFG.collapseBlocks) trig('collapse', { prio: 2, cd: 60, ttl: 15, incidentType: inc ? inc.type : null, inc, reaction: true });
    W.fall = fq;
    // ---- big damage in a short window
    W.dmgT += dt;
    if (Lg.damage - W.dmgBase >= CFG.damageBig) {
      trig('damage', { prio: 1, cd: 75, ttl: 30, reaction: true, incidentType: inc ? inc.type : null, inc, vars: { dmg: fmtDmg(Lg.damage) } });
      W.dmgBase = Lg.damage; W.dmgT = 0;
    } else if (W.dmgT > CFG.damageWin) { W.dmgBase = Lg.damage; W.dmgT = 0; }
    // ---- Hope bands (with an edge so jitter on a boundary doesn't chatter)
    const h = Lg.hope, b0 = W.band;
    let band = b0;
    if (h >= (b0 + 1) * 20 + CFG.hopeEdge) band = Math.min(4, Math.floor((h - CFG.hopeEdge) / 20));
    else if (h <= b0 * 20 - CFG.hopeEdge) band = Math.max(0, Math.floor((h + CFG.hopeEdge) / 20));
    if (band !== b0) {
      W.band = band;
      const up = band > b0, k = up ? (band >= 4 ? 'hopeHigh' : 'hopeUp') : (band <= 0 ? 'hopeLow' : 'hopeDown');
      trig(k, { prio: 1, cd: 50, cdKey: up ? 'hopeUp' : 'hopeDown', ttl: 45, reaction: true, incidentType: inc ? inc.type : null, inc });
    }
    // ---- first use of each power
    const used = W.used;
    const first = (k, on) => { if (on && !used[k]) { used[k] = true; trig('power_' + k, { prio: 1, ttl: 40, reaction: true, incidentType: inc ? inc.type : null, inc }); } };
    first('heat', g.heatOn); first('freeze', P.freeze); first('xray', P.xray); first('hear', g.hearOn);
    first('clap', P.clapT > 0); first('slow', P.slow); first('grab', !!P.hold); first('punch', P.punchT > 0 && !(P.clapT > 0));
    // ---- speed records
    const mach = machOf(P);
    const mark = mach >= 10 ? 10 : mach >= 3 ? 3 : mach >= 1 ? 1 : 0;
    if (mark > W.machMark) {
      W.machT += dt;
      if (W.machT >= CFG.machHold) {
        W.machMark = mark; W.machT = 0;
        trig('mach' + mark, { prio: 1, ttl: 35, reaction: true, incidentType: inc ? inc.type : null, inc });
      }
    } else W.machT = 0;
    if (mach >= 1 && W.planet && P.pos.y < 420) {
      const dx = P.pos.x - W.planet.x, dz = P.pos.z - W.planet.z;
      if (dx * dx + dz * dz < 350 * 350) trig('machPlanet', { prio: 1, cd: 120, ttl: 30, reaction: true, incidentType: inc ? inc.type : null, inc });
    }
    // ---- help missions: the word gets round (missions.js owns the street dialogue)
    const M = window.SM_MISSIONS;
    if (M && M.stats) {
      if (M.stats.success > W.ms) { W.ms = M.stats.success; if (Math.random() < 0.6) trig('missionWin', { prio: 1, cd: 40, delay: 4, ttl: 40 }); }
      if (M.stats.fail > W.mf) { W.mf = M.stats.fail; if (Math.random() < 0.5) trig('missionFail', { prio: 1, cd: 60, delay: 4, ttl: 40 }); }
    }
    // ---- set pieces registered through another API (__game.setpieces), if present
    const sp = g.setpieces;
    if (sp) {
      const list = Array.isArray(sp) ? sp : (Array.isArray(sp.active) ? sp.active : (sp.active ? [sp.active] : (sp.current ? [sp.current] : null)));
      if (list) for (const s of list) {
        if (!s || typeof s !== 'object' || W.sp.has(s) || s === inc) continue;
        if (s.active === false || s.done) continue;
        W.sp.add(s);
        if (!inc || s.type !== inc.type) onIncStart(g, { type: s.type || s.kind || 'other', where: s.where || s.name, title: s.title || '' }, true);
      }
    }
    // ---- quiet city: hello, then flavour
    if (!W.hello && clock > CFG.hello && !inc) { W.hello = true; trig('hello', { prio: 1, ttl: 60 }); }
    if (!inc && !cur && !queue.length && clock - lastEnd > idleNext && clock - lastStart > nextGap) {
      const r = Math.random();
      const k = r < 0.36 ? 'idle_dispatch' : r < 0.6 ? 'idle_lois' : r < 0.8 ? 'idle_jimmy' : 'idle_perry';
      trig(k, { prio: 1, ttl: 10 });
      idleNext = R(CFG.idle[0], CFG.idle[1]);
    }
  }

  // ================================================================== plugin
  let errOnce = false;
  function update(wdt) {
    const g = G(); if (!g || !g.started) return;
    if (!ready) { ready = true; if (!g.comms) try { g.comms = API; } catch (_) { /* read-only */ } }
    const dt = Math.min(0.1, wdt / (g.P && g.P.slow ? 0.12 : 1));
    clock += dt;
    try {
      detect(g, dt);
      if (cur && clock >= cur.tEnd) hangUp(false);
      pump(g);
      updateCard(dt);
      // mute (K) and the radio bus
      if (bus && g.AU) { const v = g.AU.muted ? 0 : CFG.vol; if (bus.gain.value !== v) bus.gain.value = v; }
    } catch (e) { if (!errOnce) { errOnce = true; console.warn('[comms]', e); } }
  }

  // ================================================================== API (window.SM_COMMS, also __game.comms)
  const API = {
    cfg: CFG, speakers: SPK, lines: LINES, stats,
    say, queue, history,
    get current() { return cur ? { who: cur.who, text: cur.text, trigger: cur.trigger, prio: cur.prio, incidentType: cur.incidentType, t0: cur.t0, tEnd: cur.tEnd } : null; },
    get last() { return history.length ? history[history.length - 1] : null; },
    get speaking() { return !!cur && clock >= cur.tSpeak && clock < cur.tSpeak + cur.plan.dur; },
    get clock() { return clock; },
    get voice() { return S.voice; }, set voice(v) { S.voice = !!v; },
    get tts() { return S.tts; }, set tts(v) { S.tts = !!v; },
    trigger(name, o) { return trig(name, Object.assign({ prio: 2, reaction: true, ttl: 30 }, o || {})); },
    hangUp() { hangUp(true); },
    clear() { queue.length = 0; if (cur) hangUp(true); },
    // card state for tests: '' (hidden), 'on ring', 'on', 'out'
    cardState() { return UI.state; },
    cardVisible() { if (!UI.el) return false; const cs = getComputedStyle(UI.el); return cs.visibility === 'visible' && +cs.opacity > 0.5 && /\bon\b/.test(UI.el.className); },
    cardText() { return UI.el ? { name: UI.name.textContent, text: UI.said.textContent + UI.rest.textContent, said: UI.said.textContent } : null; },
    lineCount() { let n = 0; for (const k in LINES) n += LINES[k].length; return n; },
    nextGap() { return nextGap; }
  };
  window.SM_COMMS = API;

  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function comms(c) {
    ctx = c; THREE = c.THREE;
    buildDOM();
    return { update };
  });
})();
