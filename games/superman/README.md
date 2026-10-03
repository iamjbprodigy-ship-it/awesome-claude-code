# Superman Over Metropolis

A fan-made physics sandbox for PC: the whole power set in a destructible, golden-hour Metropolis.

## Play
**Easiest:** download `dist/superman-over-metropolis.html` and double-click it. It's one self-contained file and works offline in Chrome, Edge or Firefox.

**From the repo:** open `index.html` with the `js/`, `vendor/` and `style.css` files beside it.

On the title screen, press **Enter** or click **Start** for free play.

**Play the Demo** runs the curated 20-minute arc. You play all of it:
1. 90 seconds of free flight.
2. Six emergencies in order, each 25–40 s after you finish the previous one: the falling helicopter, the tenement fire, the bank robbery, the runaway bus, the Metro Air 207 airliner, and the Metallo finale.
3. The Daily Planet front page, whose headline reflects how you did.

You can also add `?demo` to the address to start the demo directly, or `?metallo` to jump straight to the finale. **Quality** cycles Low / Medium / High / Ultra and remembers your choice. Press `` ` `` or **F3** in game to show the frame rate.

**Graphics on Ultra:**
- Screen-space ambient occlusion: contact shadow where walls meet the street and cars sit on the road.
- A city reflection probe, so glass, car paint and wet asphalt reflect real buildings.
- Supersampling: it renders at 1.5× native resolution on strong GPUs such as the RTX 20 to 50 series, and 1.25× otherwise.

Add `?ss=2` to force 2× supersampling, `?ao=0` to turn ambient occlusion off, or `?ao=1` to force it on at High.

**Test it on your GPU:** pick **Benchmark** on the title screen (or open the file with `?bench` added). It flies a fixed route through the heaviest scenes for about 45 s, then shows your GPU, average fps, 1% lows and draw calls per scene, with a **Copy results** button.

## Controls
| Input | Action |
|---|---|
| Mouse | Look and aim (click the game to capture the mouse; Esc releases it) |
| W A S D | Fly or walk |
| Space / C | Climb / descend. Space on the ground leaps. |
| Shift | Super speed. In flight: supersonic above 150 m (and low down at power 3). On foot: a full sprint. |
| 1 / 2 / 3 | Power level for every power (remembered; 3, the maximum, is the default) |
| Left click | Punch (hold to charge); throws whatever you're carrying |
| E | Grab or set down cars, rubble, people, chunks of wall |
| Right click / R | Heat vision |
| Q | Freeze breath |
| X / H | X-ray vision / super hearing (tap H to toggle, or hold it) |
| G / V | Thunder clap / slow time |
| F | Switch between flying and walking |
| P / N | Pause and read the Daily Planet |
| M / Tab | City map: click to set a waypoint, scroll to zoom |
| K | Mute |
| F8 | Start (or retry) the Metallo finale |

**Power levels:** one dial scales the whole power set. Earned unlocks still stack on top.

| | Level 1 | Level 2 | Level 3 (default) |
|---|---|---|---|
| Flight top speed (at altitude) | about Mach 1 | about Mach 3 | Mach 10+ |
| Flight cap below 150 m | 300 m/s (no low booms) | 300 m/s (Mach 3 once *speed* is unlocked) | Mach 5, and the boom shatters glass |
| Ground sprint | 40 m/s | 90 m/s | 180 m/s |
| Punch and throw | weaker | normal | harder |
| Heat vision | slower, 600 m | normal, 1.2 km | faster, 2.5 km |
| Freeze breath, thunder clap | shorter, weaker | normal | longer, stronger |
| Heaviest lift | 25 t | 120 t | anything |
| Super hearing range | 300 m | 600 m | 1.2 km |

**Super hearing:** while it's on, the city goes muffled and every need in range plays from where it is: cries for help, the heartbeat of someone injured, alarm bells and gunshots at a robbery, fires crackling. Sounds are louder when they're close and when you face them, and each gets a marker. Street-level help requests (the person waving you down) are heard too, as a cry for help at the person's position. Press H on a fresh emergency and you're told what and where ("You hear: a robbery at ..."). Listening in a quiet moment surfaces someone in need: either a help request brought forward, or a smaller call (someone stranded on a roof, or a mugging).

**Super speed on foot:** Shift while walking (F toggles walking) is a real run, not a hover. He stays planted on the street and sidewalks with arms pumping and a forward lean. Dust and paper fly off to the sides, and the bow wave shoves cars and pedestrians out of his path. A whip-crack sounds at top speed. The camera drops low and pulls back.

**Why Mach 3 used to stall:** the *speed* unlock promised "Mach 3 at sea level", but it only raised the cap above 150 m. Below 150 m, boosted flight was always clamped to 300 m/s. Dropping under that line also braked you at 400 m/s² back down to it. Without the unlock, the top speed was 480 m/s (about Mach 1.4) until the thin air above roughly 10 km. On top of that, each block he smashed through cost 1-3% of his speed on every one of up to 80 sub-steps a frame, so one pass through a tower bled off most of a Mach 3 run. Now each power level sets its own top speed and its own low cap (Level 3 allows Mach 5 low down), and smash losses shrink as speed rises.

**Metallo (the finale):** a 3 m chrome cyborg with a Kryptonite heart lands in a plaza and holds a crowd hostage. Press **F8** in game (or add `?metallo` to the address) to fight him; the demo sequencer calls `__game.metallo.start()`. His heart weakens you and drains solar charge within 40 m, so fight from range:
- Dodge his telegraphed Kryptonite beam, radiation pulse (get 40 m away) and ground pound (get airborne).
- Catch the cars and paving slabs he throws at the crowd (E). The hostages are bait: he only throws at them once you come within 150 m.
- Freeze his armour with Q until it turns icy, then shatter a plate with a charged punch or a thrown object. He has six plates.
- With the heart exposed, grab the lead-lined plate from the corner (E). Carrying it cuts the radiation by 80%. Close in and rip the heart out (E).

Medals depend on bystanders unhurt, property damage and time. If your solar charge runs out, the Kryptonite floors you, too many people get hurt or 180 s pass, he escapes, and F8 retries.

**Map:** the minimap (bottom right) turns with you and zooms out as you speed up. Alerts appear as pins, with arrows on the rim when they're off-screen, and a tall coloured light beam rises from each one in the city: gold for emergencies, green for Kryptonite, red for the injured, blue for your waypoint.

**The catch (`js/catch.js`):** to save someone who is falling, match their speed. If the speed difference when you grab them is over 12 m/s, they are hurt; over about 15 m/s, they are badly hurt. Helicopter and car occupants can take up to 18 m/s. While you carry someone, more than 6 g for a quarter of a second also hurts them, and that counts boosts, hard turns and walls. If you let go of the controls while carrying someone, you brake gently at no more than 4 g. Get within 2 m of a faller at a matched speed and you catch them automatically and gently. You can also press E. A g-arc around the crosshair shows the g on the person you're carrying: green under 3 g, amber from 3 to 6 g, red above 6 g. Within 30 m of a faller, a "match speed" bar compares your speed difference with the safe limit. During an emergency, a line under the timer reads "Saved X / Y at risk". Saving everyone unhurt with a gold medal earns "Everyone home". Saves earn at most +10 Hope per emergency.

Gamepad: Back/View opens the map; the sticks fly and look; RT heat vision, LT freeze, RB punch, LB grab, X clap, Y x-ray.

**Settings (`js/settings.js`):** open **Settings** on the title menu, or on the pause front page (Enter, or Y on a gamepad). Menus work with the keyboard (arrows or W/S to select, left/right or A/D to adjust, Enter to change, Q/E or Tab to switch tabs, Backspace for the default, Esc to go back) and with a gamepad (D-pad or left stick, A, B to go back, LB/RB for tabs, X for the default). Choices are saved in the browser.
- **Controls:** remap every keyboard action, with a main and an alternate key each. A key already in use swaps places, and Delete clears a slot. Also invert Y and mouse sensitivity.
- **Camera:** field-of-view offset, camera distance, screen shake from 0 to 100%, hit-stop on or off, reduced motion, and the strength of motion blur and speed lines.
- **Display:** quality preset, supersampling and ambient occlusion (these three take effect when you pick **Apply and reload**), the FPS meter and HUD scale.
- **Audio:** master, effects, radio and music volume.
- **Accessibility:**
  - Subtitle size and background, for the radio card, mission cards and street speech bubbles.
  - A colour-blind-safe (Okabe–Ito) palette for map pins and light beams.
  - Hold-to-toggle for heat vision, freeze breath and the charge punch.
  - QTE assist: timing rings close 60% slower, and a burning airliner wing lasts 60% longer.
  - Reduced flashing.

**Set pieces** (after the first few minutes, now and then):
- **Runaway bus:** a packed bus loses its brakes on Centennial St and runs for the waterfront crosswalk. Standing passengers are hurt above about 1 g, so get in front early (about 40 m of stopping room at 25 m/s), press **E** on the front bumper and **hold E** for a smooth 0.85 g stop. **W** pushes harder and **S** eases off; the meter shows the deceleration. Tap E to let go. Blocking it dead, grabbing it from the side or punching it hurts the passengers.
- **Falling airliner:** an airliner with an engine fire glides down over the bay. Hold freeze breath (**Q**) on the burning engine for about 5 s, or the wing fails at 25 s. Press **E** at a push point (nose, either wingtip, tail), then **W/Space** push up, **S/C** push down and **A/D** push sideways. Set it down on the water with vertical speed under 6 m/s and roll under 15° to save all 140 aboard.

## Develop
- `node tools/playtest-bot.js [--shots]` drives every power, emergency, a tower collapse and the render budgets in headless Chromium. Needs Playwright.
- `node tools/build-single.js` rebuilds `dist/superman-over-metropolis.html`.
- Design docs are in `design/`: the brief, art bible, tuning, performance review and playtest plan.
