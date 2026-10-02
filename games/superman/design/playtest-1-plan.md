# Playtest 1 Plan: Superman Over Metropolis

Build under test: `games/superman/index.html`, opened straight from disk (file://) in current Chrome, Edge, Firefox or Safari on a Windows or Mac PC.
Who runs it: one facilitator (reads this, takes notes) and one player (does not read this). Keep DevTools closed while the player plays; the facilitator opens the console only for the debug commands in section 5.

## 1. Pre-playtest smoke check (about 5-7 minutes)

Run on the playtest machine the same day. One FAIL on items 1-5 or 13 means no playtest: fix first.

| # | Check | Pass when |
|---|---|---|
| 1 | Turn Wi-Fi off, double-click `index.html` | Intro card ("Superman Over Metropolis") shows within 10 s; no "WebGL is unavailable" card |
| 2 | Open the console (F12) before clicking anything | No red errors. Specifically, `js/skyline.js` and `js/streets.js` are not reported as missing (both are referenced by index.html) |
| 3 | Look behind the intro card | City is drawn and the camera slowly circles (attract mode) |
| 4 | Click "Take flight" (or press Enter) | Intro hides, HUD appears, toast "Fly with W A S D..." |
| 5 | Click the city | Cursor disappears; moving the mouse turns the view with no drift |
| 6 | Hold W, then Shift; tap Space and C | Hero flies forward; HUD speed and Mach climb with Shift; Space climbs, C descends |
| 7 | Press F, land, press Space | "Walking" toast; on the ground Space leaps; F again returns to flight |
| 8 | Tap left click at a wall; hold left click 1 s then release | Tap: small punch; hold: crosshair ring fills, release breaks wall blocks that fall |
| 9 | Aim at a car in reach, press E, then left click | Car is carried; left click throws it |
| 10 | Hold right click (then R); hold Q; press X, H, G, V once each | Red eye beams + Solar % drops; frost spray; walls fade (x-ray); "Listening" toast; clap ring; "world slows" toast. Each power chip lights up |
| 11 | Low over the streets, hold Shift until Mach reads 1.00 | Boom sound, shock rings, "Mach 1" or windows-shattered toast |
| 12 | Wait about 14 s after starting | First emergency (a fire) starts: alert sound, toast, "Fire" marker with distance, countdown in the mode line |
| 13 | Step through the other types: C3 to end the fire, click back in, then C2; repeat. Let the helicopter and meteor finish on their own | Each of fire, helicopter, robbery and meteor starts with a marker and ends with a result toast (medal, or failure) |
| 14 | Press P; then click; then press Esc | Daily Planet front page with saves, lost, damage, Hope, medals, unlocks; click returns to play and recaptures the mouse; Esc releases the mouse and shows the page once (no flicker back to play) |
| 15 | Press M twice | "Sound off" then "Sound on"; audio actually stops and returns |
| 16 | With a gamepad: press A, move both sticks, pull RT and LT, press RB, LB, X, Y, Start | Starts game, flies and looks, heat, freeze, punch, grab, clap, x-ray, pause. Mark N/A if no pad |
| 17 | Fly fast across the city for 30 s (Chrome: DevTools > Rendering > Frame rendering stats) | Holds 30 fps or better with no hitch over 0.5 s. Write down the number |

## 2. Guided first-playtest script (25 minutes)

Rules for the facilitator: do not explain controls beyond the intro card unless the player is stuck for 60 s. Say "think out loud". Note the time of every stumble, laugh, complaint or bug. Watch the frame rate counter if visible.

| Min | Ask the player to... | Observe |
|---|---|---|
| 0-2 | Read the intro card and start | How long they read; do they find "Take flight"; do they click the city to capture the mouse without help |
| 2-6 | Fly anywhere: low between towers, then high, then fast with Shift | Flight feel: weight, turning, banking, camera. Do they collide with towers by accident? Do they notice the Mach number and the sonic boom? Did the boom break windows and cost Hope, and did they understand why? |
| 6-8 | Fly straight up as high as you can, then dive and land on a street | Sky change at altitude, Solar % recharging, frame rate at altitude. A fast landing should crater with dust and shake: was it satisfying? Damage counter rises by $25K |
| 8-10 | Walk (F), leap (Space), pick up a car (E) and set it down, then throw one (left click) | Weight of grab and throw; can they tell what is grabbable; do civilians react (cheer or scatter) |
| 10-12 | Punch a tower: taps, then a fully charged punch | Destruction readability: do blocks fall and pile; any floating blocks; frame rate during collapse; the "Too solid" toast on weak punches |
| -- | First emergency should have started around minute 0-1 of play (fire). If it timed out, note it and move on | Did they notice the alert, the toast and the marker? Did they look for it or ignore it? |
| 12-16 | Fire: "Find the fire and deal with it" | Do they find it from the marker? Do they try freeze breath and the clap on flames? Do they use x-ray or hearing to see the trapped people? Do they carry anyone to the hospital marker? Medal result and whether they understood it |
| 16-19 | Helicopter (facilitator: C2 if not yet up): "Save the chopper" | Is the 7 s warning before the fall readable? Can they catch (E) and lower it below the crash speed? Do they understand "Hard landing" vs crash |
| 19-22 | Robbery (C2 if needed): "Stop the robbers" | Do they see the red "!" shot-coming markers and react in time (counter)? Pulled punch vs clap; deflected bullets; any civilian hurt. Do they punch a civilian and see "Superman doesn't hit civilians"? |
| 22-24 | Meteor (C2 if needed): "Stop the meteor" | Do they pick heat vision, punch (shatter) or throw it to space? Do they watch where burning pieces land? Impact is about 25 s after the alert: is that enough time? If green (Kryptonite): do they notice weakness and switch to range |
| 24-25 | Use slow time (V), x-ray (X) and hearing (H) once if not yet used; then press P | Did any power go unused or undiscovered? Can they read the Daily Planet front page, and does the headline match how they felt they played |

After the session: hand over the feedback form (section 3) before discussing anything.

## 3. Feedback form (player fills in, 5 minutes)

1. Flying felt (1 = floaty or stiff, 5 = heavy, fast and in control): 1 2 3 4 5
2. I felt powerful (1 = not at all, 5 = like Superman): 1 2 3 4 5
3. I held back on purpose at least once to avoid hurting people or the city: Yes / No. If yes, when? If no, why not?
4. Holding back mattered: the game noticed and the result changed (1 = no difference, 5 = big difference): 1 2 3 4 5
5. When an emergency started, I knew what it was, where it was and what to do (1 = lost, 5 = always clear): 1 2 3 4 5
6. Which emergency was hardest to understand or solve, and what confused you?
7. Compared with Marvel's Spider-Man (city, golden-hour light, street life) and Arkham (fight flow in robberies), the visuals and combat were (1 = far behind, 5 = on par): 1 2 3 4 5. What looked the most off?
8. The game ran smoothly (1 = stutters a lot, 5 = smooth throughout). When did it slow down, if ever? 1 2 3 4 5
9. Best moment and worst moment, one sentence each.
10. Your PC, browser, and whether you used a gamepad.

## 4. Bug reports

Use one report per bug. Facilitator files them after the session with `/bug-report`; fill this in on paper or in notes first.

```
Title:            [What broke, where]  e.g. "Helicopter falls through roof during catch"
Severity:         S1 / S2 / S3 / S4 (see below)
Frequency:        Always / Often (>50%) / Sometimes (10-50%) / Rare (<10%)
Browser + OS:     e.g. Chrome 129, Windows 11, RTX 3060 / Safari 18, MacBook Air M2
Input:            Keyboard and mouse / Gamepad (model)
Game state:       Emergency type and seconds left, flying or walking, holding what,
                  Hope, Solar %, x-ray/hearing/slow time on or off
Position:         Paste output of:  __game.P.pos.toArray().map(Math.round)
Steps:            1. ...  2. ...  3. ...
Expected:         ...
Actual:           ...
Console errors:   Paste any red lines from F12 > Console
Evidence:         Screenshot or clip file name; FPS reading if performance
```

Severity scale for this game:

- **S1 Critical**: game does not load from file://, freezes, crashes the tab, or throws a red console error that stops input; mouse capture or pause cannot be exited; an emergency can never end (no new emergencies ever start); hero falls out of the world with no way back.
- **S2 High**: a power or an emergency type cannot be used or won as designed (e.g. heli cannot be caught, robbers cannot be stopped, heat vision never fires); emergency marker missing or pointing to the wrong place; ledger, medals or Hope clearly wrong; sustained frame rate under 20 fps on the test PC.
- **S3 Medium**: works but degraded and a workaround exists: unclear toast or marker, camera clips into towers, floating blocks after collapse, short hitches (under 1 s), gamepad mapping differs from the intro card, audio does not mute fully.
- **S4 Low**: cosmetic: typo, HUD overlap, minor visual pop, missing sound on one action.

## 5. Console debug commands

Open with F12 > Console, paste one line, press Enter, then click the city to recapture the mouse. The game pauses while the mouse is free, so most commands take effect only after you click back in (C5 runs even while paused). Everything lives on `window.__game` (shortened to `__game`). Coordinates are metres: the city spans x and z from -210 to 210; the bay is z > 240; the start corner is (-90, 45, 150); the hospital is (-180, 0, 190).

| ID | Purpose | Paste this |
|---|---|---|
| C1 | Skip the intro | `__game.begin()` |
| C2 | Start the next emergency. Types rotate fire, heli, robbery, meteor; check first that no emergency is running | `__game.currentInc ? __game.currentInc.type : __game.startIncident()` |
| C3 | Force the current emergency to time out (fire and robbery fail; heli starts falling; meteor ignores it) | `__game.currentInc.age = __game.currentInc.limit + 1` |
| C4 | Show the current emergency type and seconds left | `__game.currentInc && [__game.currentInc.type, Math.round(__game.currentInc.limit - __game.currentInc.age)]` |
| C5 | Advance the game 10 seconds instantly (600 frames at 1/60 s; screen updates after) | `__game.step(600)` |
| C6 | Teleport above the city centre and stop | `__game.P.pos.set(0, 120, 0); __game.P.vel.set(0, 0, 0)` |
| C7 | Teleport above the hospital | `__game.P.pos.set(-180, 40, 190); __game.P.vel.set(0, 0, 0)` |
| C8 | Teleport over the bay (water landing) | `__game.P.pos.set(0, 30, 400); __game.P.vel.set(0, 0, 0)` |
| C9 | Teleport to the sky edge (solar recharge, sky colour) | `__game.P.pos.set(0, 20000, 0); __game.P.vel.set(0, 0, 0)` |
| C10 | Face north (towards -z), looking slightly down. Yaw and pitch are radians; pitch limit is +/-1.45 | `__game.setYawPitch(0, -0.3)` |
| C11 | Force a superhero landing at the start corner | `__game.P.flying = false; __game.P.pos.set(-90, 200, 150); __game.P.vel.set(0, -60, 0)` |
| C12 | Explosion 40 m north of the hero (heli-crash size; meteor size is 2.5e8) | `__game.explode(__game.P.pos.clone().add(new THREE.Vector3(0, 0, -40)), 3e7)` |
| C13 | Explosion at a fixed point (repeatable) | `__game.explode(new THREE.Vector3(0, 30, 0), 3e7)` |
| C14 | Fully charged punch where the hero is aiming (power 1 to 4) | `__game.punch(4)` |
| C15 | Thunder clap (1 s cooldown) | `__game.clap()` |
| C16 | Sonic boom at the hero's position (breaks glass, may cost Hope) | `__game.sonicBoom()` |
| C17 | Empty the solar charge (heat vision refuses) | `__game.P.solar = 0` |
| C18 | Set Hope to test front-page headlines (80+, 55+, 30+, below 30) | `__game.ledger.hope = 85` |
| C19 | Print where the hero is (for bug reports) | `__game.P.pos.toArray().map(Math.round)` |

Notes for testers:
- Do not call `startIncident()` while an emergency is running (C2 guards this). It replaces the current one without cleaning up, leaving stray fires, robbers or a helicopter behind.
- Reaching a specific type: fire is first; repeat C3 then C2 to step through. The helicopter only ends when it lands or crashes, and the meteor only ends when it is stopped or hits the city (about 25 s), so let those finish.
- A Kryptonite (green) meteor cannot be forced: it is possible only from the 8th emergency on, at 60% odds.
- Descend with C, not Ctrl: Ctrl also descends, and Ctrl+W closes the browser tab.
