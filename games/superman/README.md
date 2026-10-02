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
| Shift | Super speed (supersonic above 150 m) |
| Left click | Punch (hold to charge); throws whatever you're carrying |
| E | Grab or set down cars, rubble, people, chunks of wall |
| Right click / R | Heat vision |
| Q | Freeze breath |
| X / H | X-ray vision / super hearing |
| G / V | Thunder clap / slow time |
| F | Switch between flying and walking |
| P / N | Pause and read the Daily Planet |
| M / Tab | City map: click to set a waypoint, scroll to zoom |
| K | Mute |

**Map:** the minimap (bottom right) turns with you and zooms out as you speed up. Alerts appear as pins, with arrows on the rim when they're off-screen, and a tall coloured light beam rises from each one in the city: gold for emergencies, green for Kryptonite, red for the injured, blue for your waypoint.

Gamepad: Back/View opens the map; the sticks fly and look; RT heat vision, LT freeze, RB punch, LB grab, X clap, Y x-ray.

## Develop
- `node tools/playtest-bot.js [--shots]` drives every power, emergency, a tower collapse and the render budgets in headless Chromium. Needs Playwright.
- `node tools/build-single.js` rebuilds `dist/superman-over-metropolis.html`.
- Design docs are in `design/`: the brief, art bible, tuning, performance review and playtest plan.
