# Superman Over Metropolis

A fan-made physics sandbox for PC: the whole power set in a destructible, golden-hour Metropolis.

## Play
**Easiest:** download `dist/superman-over-metropolis.html` and double-click it. It's one self-contained file and works offline in Chrome, Edge or Firefox.

**From the repo:** open `index.html` with the `js/`, `vendor/` and `style.css` files beside it.

On the title screen, press **Enter** or click **Start**. If your PC struggles, pick **Quality: Low** on the title screen. Press `` ` `` or **F3** in game to show the frame rate.

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
| M | Mute |

Gamepad: the sticks fly and look; RT heat vision, LT freeze, RB punch, LB grab, X clap, Y x-ray.

## Develop
- `node tools/playtest-bot.js [--shots]` drives every power, emergency, a tower collapse and the render budgets in headless Chromium. Needs Playwright.
- `node tools/build-single.js` rebuilds `dist/superman-over-metropolis.html`.
- Design docs are in `design/`: the brief, art bible, tuning, performance review and playtest plan.
