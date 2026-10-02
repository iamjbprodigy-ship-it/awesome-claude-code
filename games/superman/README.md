# Superman Over Metropolis

A fan-made physics sandbox for PC: the whole power set in a destructible, golden-hour Metropolis.

## Play
**Easiest:** download `dist/superman-over-metropolis.html` and double-click it. It's one self-contained file and works offline in Chrome, Edge or Firefox.

**From the repo:** open `index.html` with the `js/`, `vendor/` and `style.css` files beside it.

On the title screen, press **Enter** or click **Start**. **Quality** cycles Low / Medium / High / Ultra and remembers your choice. Press `` ` `` or **F3** in game to show the frame rate.

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

**Super hearing:** while it's on, the city goes muffled and every need in range plays from where it is: cries for help, the heartbeat of someone injured, alarm bells and gunshots at a robbery, fires crackling. Sounds are louder when they're close and when you face them, and each gets a marker. Listening between emergencies sometimes picks up a smaller call: someone stranded on a roof, or a mugging.

**Map:** the minimap (bottom right) turns with you and zooms out as you speed up. Alerts appear as pins, with arrows on the rim when they're off-screen, and a tall coloured light beam rises from each one in the city: gold for emergencies, green for Kryptonite, red for the injured, blue for your waypoint.

Gamepad: Back/View opens the map; the sticks fly and look; RT heat vision, LT freeze, RB punch, LB grab, X clap, Y x-ray.

## Develop
- `node tools/playtest-bot.js [--shots]` drives every power, emergency, a tower collapse and the render budgets in headless Chromium. Needs Playwright.
- `node tools/build-single.js` rebuilds `dist/superman-over-metropolis.html`.
- Design docs are in `design/`: the brief, art bible, tuning, performance review and playtest plan.
