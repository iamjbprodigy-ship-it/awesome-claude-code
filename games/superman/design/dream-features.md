# Dream Features: Superman Over Metropolis

Author: game-designer. Status: **proposal**. Nothing here is adopted until the creative director (you) picks it.
Inputs read: `design/game-brief.md`, `design/tuning.md`, `design/art/art-bible.md`, `design/playtest-1-plan.md`, `README.md`, `js/game.js` (ledger, emergencies, powers, player, camera, audio, front page, map, `window.__game` hooks) and `tools/playtest-bot.js`.

**What the player asked for:** "think of what would make a superhero game of someone's dreams who's always wanted a Superman style game", built as a **flagship demo**.

**What this document holds to.** These are the brief's pillar and the art bible's two rules:
- **Powerful and responsible.** The hardest thing you can do is hold back.
- **Consequence outlasts the effect.**
- **The city reads at every altitude.**

Every feature below names the pillar it serves. If it would be just as at home in a generic open-world game, it is ranked low or cut.

**Work already in flight elsewhere.** These are treated as dependencies, not redesigned here:
- power levels 1–3
- ground super speed
- directional super hearing
- NPC dialogue barks
- street help missions with quick-time events (QTEs)

---

## 0. Open decisions: pillar and scope tensions (you decide)

Some of what was asked for conflicts with documents that are already locked. Nothing below is decided until you rule on these.

| # | Tension | Locked document says | Options | Designer recommendation |
|---|---|---|---|---|
| T1 | **Villains and boss fights** (Metallo, Brainiac, Doomsday) | Brief, out of scope: "No villains or boss fights in this version." | (a) keep the scope: no villains, and the demo ends on the airliner; (b) allow **one** villain for the flagship demo; (c) allow all three | **(b), with Metallo.** He reuses the whole Kryptonite stack (`kryptoniteNear()`, the art-bible Kryptonite state, the frost-shatter rule) and he *is* the restraint pillar: you must fight from range while protecting a crowd. Brainiac and Doomsday stay post-demo. Needs a brief amendment. |
| T2 | **Day/night cycle** | Art bible §2: "Time of day does not advance." States change grade, never the sun. | (a) no cycle; (b) **per-session time-of-day presets** (dawn / golden hour / dusk / night), picked on the title screen; (c) a continuous cycle | **(b), and post-demo.** A continuous cycle re-opens the sun azimuth decision, the far-skyline haze bands and the 2048 shadow trade-off. Needs art-director sign-off. |
| T3 | **Persistence** (feats, Fortress trophies) | Brief: "No save system." Quality is already stored in `localStorage`. | (a) session-only; (b) `localStorage` for settings and feats only, with no mid-session saves | **(b).** It is a settings-class store, not a save system. Remapping (feature 15) needs it anyway. |
| T4 | **Power levels 1–3** (other team) versus "Superman is already powerful" | Brief: unlocks come from Hope and medals | (a) levels as earned stat tiers; (b) **levels as a player-chosen restraint dial** (1 Gentle / 2 Firm / 3 Full) for each power, with medals rewarding the lowest level that was enough | **(b).** It turns a stat ladder into the core skill of holding back. See feature 11. Please pass this to the engineer building power levels. |
| T5 | **The Hope economy at set-piece scale** | `addSave()` gives +2 Hope per person | An airliner with 140 passengers would add +280 Hope (the cap is 100) in one event | **Cap per-person Hope at +10 per incident.** Set pieces pay out through the medal. This is a balance bug waiting to happen, so fix it before building feature 4. |
| T6 | **Rebuilding versus persistent damage** | Art bible §6: "Damage persists for the session" | Rebuilding (feature 32) partly undoes the city's record | Keep it post-demo and opt-in. Only the player's own labour reduces the bill; the city never auto-heals. |

---

## 1. Ranked feature list

**How the ranking works.** Each feature is scored on three things:
- **Fantasy:** how uniquely Superman it is, ×2.
- **Demo impact:** what it adds to a 20-minute first impression.
- **Reuse:** how much existing code carries it.

Effort is then subtracted (S = 1, M = 2, L = 3). Build order is a separate list (section 2).

**Effort scale:**
- **S** is 1–3 days.
- **M** is about 1–2 weeks.
- **L** is 3 weeks or more.

**Engine constraints that apply to every sketch:**
- three.js r128, procedural only, with no external assets.
- Repeated geometry goes in `InstancedMesh`.
- Sound is WebAudio synthesis.
- Budgets: 335 draw calls or fewer (hard limit 400), 1.5M triangles in the main pass, 6 ms or less of CPU sim time per frame, and 3,000 or fewer particle sprites.

### Summary table

| Rank | Feature | Pillar | Effort | In demo |
|---|---|---|---|---|
| 1 | Launch and land: charged takeoff, three landing tiers | Powerful *and* responsible | S | yes |
| 2 | The Catch: velocity matching and the g-force rule | Holding back | M | yes |
| 3 | Breaking the sound barrier: vapour cone, audio hole, N-wave | Consequence / feel | M | yes |
| 4 | Falling airliner set piece | Holding back at scale | L | yes |
| 5 | Adaptive heroic score (original, synthesized) | Fantasy | M | yes |
| 6 | Voices of Metropolis: Lois, Jimmy, Perry, police radio | Relatedness | M | yes |
| 7 | Arrival moment and the wave | Relatedness | S | yes (in 8) |
| 8 | Hope-driven city mood | Consequence | M | yes |
| 9 | Save everyone: the triage counter | Responsibility | S | yes (in 2) |
| 10 | Bullets bounce: be the shield | Powerful | S | post-demo |
| 11 | Restraint mastery: feats and the holding-back dial | Holding back | M | post-demo |
| 12 | Runaway bus | Holding back | M | yes |
| 13 | Metallo: Kryptonite-hearted boss (needs T1) | Vulnerability | L | yes (finale) |
| 14 | Cloud deck and the punch-through tunnel | Consequence / feel | M | yes (in 1) |
| 15 | Accessibility suite | Everyone plays | M | yes |
| 16 | Photo mode | Expression | S | yes |
| 17 | A front page that tells the day | Consequence | S | yes (in 16) |
| 18 | Clark Kent: the change | Identity | M | post-demo |
| 19 | Orbit and re-entry | Scale | M | post-demo |
| 20 | Bridge collapse | Holding back | L | post-demo |
| 21 | Brainiac drone swarm (needs T1) | Powerful | L | post-demo |
| 22 | Doomsday brawl (needs T1) | Responsibility under pressure | L | post-demo |
| 23 | Constructive powers: heat-weld and ice-build | Responsibility | M | post-demo |
| 24 | Daily Planet hub | Identity / relatedness | S (roof), L (bullpen) | post-demo |
| 25 | Fortress of Solitude | Identity | L | post-demo |
| 26 | Time-of-day presets and weather (needs T2) | Mood | L | post-demo |
| 27 | Storm surge (the tsunami) | Holding back at scale | L | post-demo |
| 28 | Emergency director: overlapping crises | Responsibility | M | post-demo |
| 29 | Super-speed evacuation | Powerful | S | post-demo |
| 30 | Listen to the city | Relatedness | S | post-demo |
| 31 | Hero body language | Fantasy | S | post-demo |
| 32 | Rebuild (needs T6) | Consequence | M | post-demo |

---

### 1. Launch and land: charged takeoff, three landing tiers. Effort S

- **Pitch:** Every takeoff cracks the pavement if you want it to, and every landing is a choice: feather-soft, the hero pose, or a crater.
- **Why it's Superman:** The lift-off and the one-knee landing are the two most-drawn Superman poses. Landing tiers make restraint something you do with your hands. A soft landing among a crowd is skill; a crater is a choice with a $25K cost.
- **Build:**
  - **Charged takeoff:**
    - On the ground, hold Space for 0.15–0.6 s. Release sets `P.vel.y = lerp(38, 90, charge)`, where 38 is the current leap.
    - Above 70% charge it uses the existing `addDecal('crater', r = 1.2)` and `ring()` dust, and costs $5K. Below 70% it costs nothing.
    - Camera: FOV −4° while charging, then +8° on release, easing back over 0.25 s.
    - Audio: `SFX.whoosh` plus a sine sweep from 60 to 30 Hz.
  - **Landing flare:** Holding Space while descending within 20 m of the ground applies 60 m/s² of upward deceleration.
  - **Landing tiers**, by vertical speed at contact (they extend `superLanding()`):
    - **soft:** under 15 m/s. Six dust puffs, no decal, $0.
    - **hero:** 15–45 m/s. The art-bible kneel for 0.6 s, a dust ring, no decal, $0.
    - **crater:** over 45 m/s, unbraked. The existing crater, $25K, scaring people and knocking cars.
  - Emit a `land` event carrying `{tier, v}` (see the test-hook contract in section 2).
- **Depends on:** `superLanding`, `ring`, `addDecal`, `SFX`. Nothing new.

### 2. The Catch: velocity matching and the g-force rule. Effort M

- **Pitch:** Catching is a skill. Match their speed, absorb it gently, and everyone walks away.
- **Why it's Superman:** The 1978 helicopter catch, Lois falling from the Daily Planet: the catch is Superman's defining act. It turns strength into precision, which is the pillar.
- **Rules:**
  - When you grab a moving body (person, helicopter, car, bus, airliner hardpoint), compute the instant Δv as `|target.vel − P.vel|`.
    - People are **injured** if the instant Δv is over 12 m/s, or if sustained acceleration stays above 6 g (59 m/s²) for 0.25 s or longer.
    - Vehicles **crumple**: occupants are injured above 15 g, and the vehicle takes damage.
  - The same rule applies while carrying. If you boost to 300 m/s with a passenger in under 5 s, you hurt them. Speed and care now pull against each other.
  - **Soft hands:** holding E while carrying a fast body applies controlled deceleration capped at 4 g, so a gentle stop is always possible if you start early enough.
  - **HUD:** a g-arc around the crosshair, only while carrying:
    - green under 3 g, amber 3–6 g, red over 6 g;
    - plus a mono readout, for example "4.2 g";
    - colourblind backup: the arc also thickens and shows "!" above 6 g.
  - Falling people become catch chances: anyone knocked off a roof by a collapse or a shockwave.
  - Fold **feature 9** (save everyone) into this: the incident HUD shows "Safe 7/9".
- **Build:**
  - Sample acceleration per frame on the held body: `|Δvel| / dt`, smoothed over 0.1 s, then convert to g.
  - Store it on `P.catchG`.
  - Add a `danger` tag and an `injure()` call through the existing ledger, so the medal rules pick it up unchanged.
- **Tuning:**
  - `gHurtPerson` 6 (range 4–9)
  - `dvInstant` 12 m/s (8–18)
  - `gCrumple` 15
  - `softHandsDecel` 4 g
- **Depends on:** `grabOrRelease`, `heldPos`, ledger injuries, helicopter incident. **Changes the helicopter rescue:** catching at full fall speed while standing still is no longer a gold.

### 3. Breaking the sound barrier: vapour cone, audio hole, N-wave. Effort M

- **Pitch:** Pushing to Mach 1 is a held breath: the world goes quiet, a cone of vapour wraps you, then the sky cracks twice.
- **Why it's Superman:** "Faster than a speeding bullet" is the first line of the legend. The game already models Mach against air density. This makes the crossing an *event* the player chases.
- **Build:**
  - **Vapour cone mesh.** This is the Prandtl–Glauert cone.
    - Geometry: one open `CylinderGeometry(0, 2.6, 4, 32, 1, true)` parented behind the hero along `-P.vel`.
    - Shader: fresnel alpha, white `#f4f7ff` at 0.45 opacity or less, plus noise streaks scrolled by `uTime` along the axis. No bloom: keep the value under 1.0 HDR.
    - Visibility: from Mach 0.93 to 1.05, with scale `smoothstep(0.93, 0.99, mach)`. The existing `FX.vapor` ring particles stay on as the cone's frayed edge.
    - Cost: +1 transparent draw call.
  - **Audio hole.**
    - From Mach 0.95 to 1.0, ramp the wind loop's low-pass from 2,500 down to 300 Hz and its gain to 0.15× (the quiet before).
    - At crossing, play a **double crack 90 ms apart**: the N-wave, extending the current 70 ms pair.
    - Above Mach 1, the wind returns muffled: low-pass at 900 Hz. You have outrun your own sound.
  - **Riding the edge.** Holding Shift at Mach 0.97–1.0 keeps the cone up, so players can hold it for photo mode.
  - **Hysteresis.** Keep the existing `P.boomed` re-arm at Mach 0.9, so oscillating around 1.0 never spams booms.
  - Exposure flash and FOV punch: see section 3.
- **Depends on:** `sonicBoom()`, `soundSpeed()`, the wind loop `AU.wind`, the grade uniforms.

### 4. Falling airliner set piece. Effort L

- **Pitch:** An airliner loses both engines over the bay. You can't stop 80 tonnes dead, so you fly it down onto the water.
- **Why it's Superman:** It is the signature sequence of *Superman Returns*, and the only rescue bigger than any human answer. Brute force fails (it breaks up); guidance succeeds. It is the catch at the scale of a jet.
- **Rules:**
  - **Phase 1, 0–15 s.** The left engine is on fire and smoke trails. A freeze breath held on the engine for 4–6 s puts it out.
    - If the fire is left burning, the wing weakens and fails at 25 s.
    - Losing the wing doubles the roll rate and adds 40 injured.
  - **Phase 2, descent.**
    - The plane has attitude (pitch and roll) and a simple lift model: `lift = 0.5 · ρ · v² · CL(α)`, with `CL = 0.1·α`, clamped.
    - Its glide drifts toward the waterfront, where an unattended path impacts row 6.
  - **Four hardpoints:** nose underside, each wingtip, tail.
    - Pressing E at a hardpoint attaches you to it.
    - While attached, your WASD input becomes a push force of up to 2.5 MN at that point. That is enough to change attitude, not to hold the plane in the air.
    - **The skill:** pitch the nose up to bleed speed, level the wings, and aim for the water.
  - **Outcomes:**
    - **Success:** touchdown on the bay with vertical speed under 6 m/s and roll under 15°. All 140 passengers are saved; 40 instanced people appear standing on the wings.
    - **Hard ditch:** 6–12 m/s. Injuries are `round((vs − 6) × 10)`.
    - **Breakup:** over 12 m/s, or any building contact.
  - **Time limit:** 75 s.
  - **Hope:** T5 applies first. Per-person Hope is capped at +10 for the incident.
- **Build:**
  - **Mesh:** made from primitives.
    - Fuselage: cylinder, 4 m across × 38 m.
    - Wings: two tapered boxes, 34 m span.
    - Tail fin, plus two engine cylinders.
    - About 4k triangles. The art-bible vehicle budget is 3k, so this needs a one-off budget exception (one instance).
    - Livery: muted white with a grey stripe (saturation cap 0.55).
  - **Physics:** one `makeBody('airliner', …, mass 80000)` with custom attitude integration. Reuse `explode()` for breakup.
  - **Pilot radio** through feature 6.
- **Depends on:** features 2 and 6, freeze breath, `makeBody`, bay water, T5.

### 5. Adaptive heroic score: original and synthesized. Effort M

- **Pitch:** An original brass fanfare rises as you take off, swells at Mach 1, and drops to a lone string line when someone is lost.
- **Why it's Superman:** The theme *is* half the fantasy, and no other superhero is so tied to a fanfare.
  - **It must be an original melody.** Do not quote or closely imitate the 1978 theme; it is under copyright.
  - Use the archetype instead: a rising perfect fifth, then an octave, in a major key, in a four-bar phrase.
- **Build:**
  - **Synth voices:**
    - brass: 3 detuned sawtooths, a low-pass with a 60 ms filter attack;
    - strings: 5 detuned sawtooths, 300 ms attack, delay-modulated chorus;
    - timpani: a sine from 80 to 50 Hz plus a noise burst;
    - pad: filtered noise plus sine.
  - **Scheduler:** lookahead (25 ms tick, 100 ms schedule-ahead, the "two clocks" pattern).
  - **Layers:**
    - `pad`: always on.
    - `ostinato`: at speeds over 75 m/s.
    - `motif`: during an emergency or boost.
    - `tension`: when the incident timer is under 30%.
  - **Stingers:** `arrival`, `gold` (the full motif), `loss` (a minor iv chord with the strings alone).
  - **Ducking and limits:**
    - Ducks −8 dB under dialogue.
    - Ducks −6 dB for 350 ms under heavy impacts.
    - 24 voices or fewer; 1 ms or less of audio-thread cost.
  - Expose `__game.music = { layers, voices }`.
- **Depends on:** the audio graph (`AU`) and the volume sliders in feature 15. Melody and arrangement belong to the audio director; this section only specifies the state machine.

### 6. Voices of Metropolis: Lois, Jimmy, Perry, police radio. Effort M

- **Pitch:**
  - Lois calls with leads.
  - Jimmy begs for the shot.
  - Perry wants the story.
  - The dispatcher reads you codes.
- **Why it's Superman:** Relatedness. Superman is defined by the people he protects and works beside. This is Self-Determination Theory's third need, and the current game has none of it.
- **Build:**
  - **This extends the other team's NPC bark system;** it does not duplicate it.
  - **Comms card** (DOM, outside the grade as the art bible requires):
    - a procedural canvas portrait: silhouette, initial, and a colour-coded rim;
    - speaker name and subtitle.
  - **Voice:** "radio babble" synthesis. Syllable-gated formant noise and sawtooth at 6–8 syllables per second:
    - pitch per speaker: Lois 220 Hz, Jimmy 260, Perry 120, Dispatch 140;
    - Dispatch also gets a 300–3,000 Hz band-pass;
    - `speechSynthesis` is an optional accessibility toggle (off by default, because offline voices vary).
  - **Trigger table** (data, not code), about 120 lines in total:
    - incident start, 50% of the timer, last-person-remaining, medal per tier, failure, collapse, Hope band change, Mach 1 near the Planet, first catch.
    - Every trigger has at least 2 variants.
  - **Line pacing:**
    - Rate limit: one line per 8 s.
    - Priority order: Dispatch > Lois > Perry > Jimmy. Dispatch may interrupt.
  - **Final line text is for the narrative director.** This document fixes only the triggers and their intent.
- **Depends on:** NPC barks (other team), the incident lifecycle, the ledger.

### 7. Arrival moment and the wave. Effort S

- **Pitch:** When Superman arrives, the street exhales: people look up and point, and after the save they cheer, and you can wave back.
- **Why it's Superman:** He is a symbol first ("a beacon"). Being *seen* arriving is the fantasy, and no other hero is greeted this way.
- **Build:**
  - **Arrival:** the first time per incident that the hero comes within 60 m of the marker while slowing below 20 m/s:
    - a 0.25 s time-scale ramp to 0.6 and back;
    - the `arrival` stinger;
    - up to 40 people within 80 m switch to `lookUp` (head pitch in the instance matrix).
  - **Wave emote** (T key, or the d-pad on a gamepad):
    - a 1.2 s raised-arm pose;
    - people within 40 m with line of sight wave back (the hop until arms exist);
    - +0.5 Hope, **capped at +3 per 60 s**, so it can't be farmed.
  - **Kids:** 15% of people are scaled to 0.62, and at Hope 55 or more they copy the fists-on-hips pose for 2 s.
- **Depends on:** people modes, feature 5, NPC barks.

### 8. Hope-driven city mood. Effort M

- **Pitch:** You can see the city's mood. At high Hope, banners go up and crowds gather. At low Hope, shutters close, crowds scatter, and the police ask you to leave.
- **Why it's Superman:** Superman's power is trust as much as strength, and the brief's "a city that reacts" needs a visible verdict between front pages.
- **Build:** Hope bands are 0–30, 30–55, 55–80 and 80–100. Each band sets:
  - **Crowd behaviour weights** (flee / gather / photograph):

    | Hope band | Flee | Gather | Photograph |
    |---|---|---|---|
    | 0–30 | 0.6 | 0.1 | 0.3 |
    | 80–100 | 0.05 | 0.6 | 0.35 |

  - **Banners:**
    - instanced cloth quads on avenue lamp posts, 60 or fewer, 1 draw call;
    - canvas `env_banner_thanks_256` in muted colours with a small shield;
    - visible only at Hope 80 or more.
  - **Graffiti decals** on walk-up walls below Hope 30 (S-tier canvas). Their text comes from the narrative director.
  - **A police cordon line** at incidents below Hope 30: the bark asks you to stand back. It is advisory; nothing stops you.
  - **Grade:** saturation ±0.03, and warm tint ±5%. That is subtle and stays inside the art-bible caps.
  - **Car horns:** frequency rises at low Hope.
- **Depends on:** `ledger.hope`, people, NPC barks, feature 7.

### 9. Save everyone: the triage counter. Effort S (built inside feature 2)

- **Pitch:** Every emergency shows who is still in danger ("Safe 7/9"), and your senses find the last ones.
- **Why it's Superman:** His standard is not "most". The ledger already makes gold require "0 lost". This puts that standard on screen while it can still be met.
- **Build:**
  - Add `inc.atRisk` (people with a `danger` flag).
  - The counter sits beside the timer.
  - When 2 or fewer remain and 20 s have passed, their markers become visible at any distance. This is an explicit exception to art-bible marker rule 2; flag it to the UX designer.
  - The medal toast and the front page add an "Everyone home" ribbon.
- **Depends on:** incidents, markers.

### 10. Bullets bounce: be the shield. Effort S

- **Pitch:** Gunfire sparks off your chest. Step into the line of fire to protect a bystander. Catch a slug in slow time and crush it.
- **Why it's Superman:** It is invulnerability made *visible*, and the bodyblock turns that invulnerability into protection, not just toughness.
- **Build:**
  - **Hits on the hero:** `FX.spark`, `SFX.ping`, and a flattened-slug debris piece that falls.
  - **Bodyblock:** if the hero is within 1.5 m of a bullet's line to a civilian, the hero takes the hit instead, for "Shielded" and +1 Hope (capped at +3 per incident).
  - **Bullet catch:** in slow time, E within 2 m of a bullet catches it, with a fist-close pose and a toast.
- **Depends on:** `fireBullet`, slow time, robbery.

### 11. Restraint mastery: feats and the holding-back dial. Effort M

- **Pitch:** You don't get stronger, you get *better*. Precision feats unlock control and expression, never damage.
- **Why it's Superman:** He is already the most powerful being on Earth. Growth comes from wisdom and control. This meets the need for competence (Self-Determination Theory) without power creep, and keeps Achievers fed with visible milestones.
- **Build:**
  - **The holding-back dial** (this resolves T4):
    - Each power's level from the other team's levels 1–3 becomes player-selectable: 1 Gentle, 2 Firm, 3 Full.
    - Inputs: mouse wheel while the power is held, or the d-pad.
    - If an incident is resolved where every power used was at the lowest level that worked, it earns a **"Measured"** mark. Gold plus Measured shows a 4th star on the medal.
  - **12 feats**, tracked in the ledger and persisted per T3. Examples:
    - Soft Hands: 10 catches under 3 g.
    - Feather: 20 soft landings within 30 m of people.
    - Surgeon: a heat-vision cut with 0 non-target blocks broken.
    - Quiet Sky: 10 Mach crossings above 500 m with no glass broken.
    - Everyone Home: 5 incidents with every person saved.
  - **What feats unlock:**
    - tools of *control*, such as a focused heat beam (narrower, longer dwell) or a single-block micro-freeze;
    - and *expression*: suit palettes, photo filters, Fortress rooms.
  - **Never** unlock more damage, speed or health.
- **Depends on:** power levels (other team), the ledger, `UNLOCKS`, T3.

### 12. Runaway bus. Effort M

- **Pitch:** A packed city bus loses its brakes on Siegel Ave heading for the waterfront crowd. Stop it, gently.
- **Why it's Superman:** "More powerful than a locomotive." A hard stop is easy for him, but standing passengers are hurt above about 1 g. The puzzle is the stopping distance.
  - From 25 m/s at 0.8 g, that is v²/2a ≈ **40 m**.
  - So you must get in front early, not late.
- **Rules:**
  - The bus starts on the column-3 avenue at 25 m/s and has 30 passengers.
  - Cars at intersections must be cleared. A gentle grab-and-set-down is fine; a thrown car costs damage.
  - Grab the bumper (E): you then push against it, up to the soft-hands cap.
  - Passenger injuries:
    - `ceil((g − 1) × 6)` for each 0.25 s spent above 1 g;
    - a stationary block at 25 m/s gives an instant 12 injuries.
  - **Time limit:** 45 s. If unattended, it reaches the waterfront crowd zone at about 38 s, which is a failure.
- **Build:**
  - Bus mesh: a 12 × 2.5 × 3 m box with window bands, about 400 triangles, 1 instance, using the art-bible "van/truck" budget.
  - It follows the lane spline from the car system.
  - **Later variant (L):** an elevated train on new rail geometry.
- **Depends on:** feature 2, the car lane system, `people`.

### 13. Metallo: the Kryptonite-hearted boss. Effort L (needs T1)

- **Pitch:** A cyborg with a Kryptonite heart who gets stronger the closer you get. Win without touching him until the very end.
- **Why it's Superman:** Weakness is what makes his strength mean something. The game already has the whole Kryptonite language (green state, droop pose, vignette pulse, "too weak up close"). Metallo turns it from a hazard into a duel.
- **Phases.** Each phase is gated on Metallo's health.
  - **Protect.** He hurls cars at the crowd every 6 s, with a 1.0 s coral telegraph like the robbers. Catch the cars (feature 2). A thrown-car hit on people counts against *him*, unless you deflected it into them.
  - **Strip.** His armour has 6 plates.
    - Freeze breath makes a plate brittle (the existing `frost > 0.75` rule).
    - A thrown object or a charged punch then shatters it.
    - His Kryptonite aura makes close punches weak, so freezing from range is the intended line.
  - **Heart.**
    - X-ray shows a **lead-lined** construction plate nearby (an instanced box with a dull grey material).
    - Carry it as a shield: holding lead between you and the heart cuts `P.kryp` by 80%.
    - Close in and rip the heart out (E).
- **Attacks:** all telegraphed for 1.0 s or more.
  - Eye beam.
  - Ground pound: a ring, dodged by leaving the ground.
  - **Kryptonite burst:** a radial pulse. Leave 40 m within 1.5 s.
- **Fail state:** `P.kryp` at 1.0 for 4 s means you collapse. Metallo escapes, Hope −10, and the streak resets. No game over, as the brief requires.
- **Build:**
  - Body: stacked capsules plus chrome `MeshStandardMaterial` (metalness 1, roughness 0.25), 5k triangles or fewer.
  - Heart: an icosahedron with emissive `(0.2, 2.5, 0.4)` and the 90 m `#4dff6a` point light, as the meteor uses.
  - Add him as a source in `kryptoniteNear()`: weakness scales linearly from 1 at 10 m to 0 at 40 m.
- **Depends on:** `kryptoniteNear`, frost, throw, x-ray, feature 2, feature 15 (telegraph glyphs), T1.

### 14. Cloud deck and the punch-through tunnel. Effort M

- **Pitch:** Burst up through a cloud deck into sunlight. The hole you punched stays there behind you.
- **Why it's Superman:** It is the shot from every Superman film. The persistent hole is art-bible principle 1 (consequence outlasts the effect) applied to the sky.
- **Build:**
  - **The deck:** a layer at 1,200–1,800 m. It extends the existing hittable `clouds`.
    - 50 clusters × 12 puffs, as one `InstancedMesh` of camera-facing quads.
    - Texture: a 64 px soft canvas puff.
    - 1 transparent draw call.
  - **Punch-through:** puffs within 15 m of the hero's path are pushed out radially at 6 m/s, decaying over 3 s. Alpha drops to 40%, and the tunnel refills over 20 s.
  - **In-cloud:**
    - speed streaks (up to 200 sprites stretched along velocity) above 150 m/s;
    - the wind loop muffled to 300 Hz;
    - the existing fog +0.02.
  - **Breaking out above the deck:** bloom strength 0.9 for 1 s.
- **Depends on:** `clouds`, `P.inCloud`, the particle pool caps.

### 15. Accessibility suite. Effort M

- **Pitch:** Everyone gets to be Superman.
- **Why it's Superman:** It isn't Superman-specific, but **it is required for a flagship demo**, and a hero fantasy that excludes players fails its own theme.
- **Build:**
  - **Input action layer:**
    - an `ACTIONS` map from action to codes and gamepad buttons, replacing the hard-coded `onKey` and `pollPad` switches;
    - full remapping UI on the title and pause screens, persisted to `localStorage` (T3);
    - hold-or-toggle per power (heat, freeze, boost, slow time).
  - **Colourblind:**
    - a glyph per marker class (the art bible makes this mandatory: diamond, plus-cross, "!" triangle, bracket, H-square, hexagon);
    - 3 palette presets (deuteranopia, protanopia, tritanopia), validated with a simulator.
  - **Subtitles:**
    - on by default, with speaker names;
    - sizes S/M/L;
    - a 62% navy backing.
  - **Sound to sight:** directional sound indicators for off-screen alerts, building on the other team's directional hearing.
  - **Motion:**
    - a camera shake slider, 0–100%;
    - a hit-stop on/off toggle;
    - FOV 60–100;
    - honour `prefers-reduced-motion`, plus a manual toggle that disables pulses, shake above 2 px and aberration (art bible §7).
  - **Assist:**
    - timer scale 1× / 1.5× / 2× / off (medals still scored, with "assist" noted on the front page);
    - heat-vision aim assist (6° snap);
    - a one-stick flight preset.
  - **Audio:** separate music / SFX / voice sliders, and mono.
- **Depends on:** touches all input code, so **build it early** (section 2, step 2).

### 16. Photo mode. Effort S

- **Pitch:** Freeze the world, frame the hero, and get it on Jimmy's front page.
- **Why it's Superman:** Superman is the most *photographed* hero. Jimmy Olsen exists for this. It serves Expression (Creativity in Quantic Foundry's motivation model) and is the demo's shareability engine.
- **Build:**
  - **Freezing:**
    - P toggles photo mode from pause;
    - the sim stops, but rendering keeps running;
    - the HUD is hidden.
  - **Camera:**
    - a free orbit within 40 m of the hero, with collision;
    - FOV 20–100 and roll ±30°.
  - **Exposure:** −1 to +1, using `uExposure`.
  - **Filters:**
    - Golden;
    - Newsprint (halftone);
    - Silver Age (posterised with Ben-Day dots);
    - Noir.
  - **6 hero poses:** hover, fists on hips, flight fist, landing kneel, wave, carry.
  - **Capture:** render through the composer, then `canvas.toBlob`.
    - Downloads `metropolis-YYYYMMDD-HHMMSS.png`.
    - Becomes the front-page photo.
  - Exposed as `__game.photo`.
- **Depends on:** `composer`, the grade shader, feature 17.

### 17. A front page that tells the day. Effort S

- **Pitch:** The Daily Planet headline names *what you did*, with the photo of your best moment.
- **Why it's Superman:** He works at the paper that judges him. That verdict is the brief's session goal, and right now it is generic.
- **Build:**
  - Event-specific headline templates keyed on the best medal, for example "SUPERMAN CATCHES FLIGHT 227" or "BUS STOPPED, 30 RIDERS UNHURT". Text comes from the narrative director.
  - **Auto best moment:** on every gold medal, snapshot the frame to a 1024 halftone canvas (L tier).
  - Optional: a Perry quote and a letters-to-the-editor line for each Hope band.
- **Depends on:** `headline()`, `renderFrontPage()`, feature 16.

### 18. Clark Kent: the change. Effort M

- **Pitch:** Duck out of sight, spin, and the shirt tears open to the shield, but only if nobody is looking.
- **Why it's Superman:** The dual identity is Superman's core drama, and no other hero has a costume change this iconic.
- **Rules:**
  - In Clark mode you walk, with super hearing only. The hero mesh swaps to a grey suit, tie and glasses using the same body.
  - **To change:** hold F for 0.8 s where the witness check passes.
    - **Witness check:** no person within 40 m has line of sight to you.
    - It is budgeted at 30 raycasts, nearest first, run once when you start holding F.
  - **Where:**
    - alleys;
    - rooftops;
    - revolving doors;
    - 12 instanced phone booths at street corners (1 draw call).
  - **If someone sees:** an Identity Risk meter rises by 25 per witness. At 100, Lois asks pointed questions (a narrative beat). No fail state.
  - Emergencies are heard in Clark mode. Getting to cover fast becomes part of the response.
- **Depends on:** directional hearing (other team), people, NPC barks, hero materials.

### 19. Orbit and re-entry. Effort M

- **Pitch:** Climb until the sky goes black and the Earth curves below, listen to the whole world, then dive back in a plasma sheath.
- **Why it's Superman:** Only he can do this. "Listening to the world from orbit" is a canonical image (Returns, Man of Steel).
- **Build:**
  - The space ramp, stars, the Kármán toast and the plasma above 1,100 m/s already exist.
  - **Above 30 km:**
    - fade in an Earth sphere: a 1024 procedural continent canvas, an atmosphere-rim fresnel shell, and a terminator;
    - fade out the city ground.
  - **Orbit map:** pins for emergencies and the Fortress. Selecting one sets the re-entry vector.
  - **Re-entry:**
    - an orange grade;
    - 0.3 continuous trauma;
    - a low rumble;
    - 6 s or more from orbit to the skyline.
- **Depends on:** `updateAtmosphere`, `MAP`, feature 25.

### 20. Bridge collapse. Effort L

- **Pitch:** Cables snap one by one on the Hob's Bay bridge. Hold the deck up, weld the cables, and clear the cars before it goes.
- **Why it's Superman:** Holding a structure together with your body is classic Superman. Welding with heat vision turns a weapon into a repair tool (pillar: responsibility).
- **Build:**
  - **A new 600 m suspension bridge** from the waterfront (lot 3, 6) out over the bay to a small island.
    - **The deck is built as a "building" lying flat** (nx 4, ny 1, nz 120), so it **reuses the structural-collapse code**, with supports at the two towers.
    - Cables: instanced cylinders with tension health.
  - **The event:**
    - a cable snaps every 4 s;
    - deck sections lose support;
    - 12 cars are stranded.
  - **What the player can do:**
    - Holding a deck block with E counts as a support in `structuralCheck`.
    - Heat vision held on a snapped cable end for 2 s re-welds it (feature 23).
  - **Perf:** about 480 deck plates against the 13,000-plate budget. Check headroom with the performance review first.
- **Depends on:** `structuralCheck`, feature 23, cars.

### 21. Brainiac drone swarm. Effort L (needs T1)

- **Pitch:** 120 silver drones descend and start lifting city blocks into a ship overhead, bottling Metropolis piece by piece.
- **Why it's Superman:** The bottle city of Kandor is core Superman lore. Sweeping a swarm with heat vision is pure power fantasy with no human targets.
- **Build:**
  - **Drones:** an `InstancedMesh` of 120 drones (octahedron plus ring, 60 triangles or fewer each, 2 draw calls).
  - **Steering:** boids (separation, alignment, cohesion) on the CPU, about 0.3 ms.
  - **Drone states:**
    - patrol;
    - tractor: a beam cylinder lifts a block toward the mothership, and that damage is blamed on Brainiac;
    - attack: a 0.6 s pale-cyan telegraph.
  - **Weapons:**
    - heat vision kills a drone in 0.15 s of dwell;
    - the clap downs drones in a cone.
  - **Consequence:** downed drones fall. Catch them, or they hit the street, and that damage is yours.
  - **X-ray** reveals relay drones. Killing a relay stalls its sub-swarm for 5 s.
  - **Mothership:** a 60 m dodecahedron. Weak points open when fewer than 30 drones remain.
- **Depends on:** heat vision, clap, `ledger` blame attribution, T1.

### 22. Doomsday brawl. Effort L (needs T1)

- **Pitch:** The one fight where you can't hold back, so the skill is *where* you fight. Drive it out of the city.
- **Why it's Superman:** It is *The Death of Superman* scale. It inverts the restraint pillar meaningfully: restraint becomes spatial.
- **Rules:**
  - Doomsday ploughs through buildings using the hero's own smash code.
  - **Ledger blame** depends on where the fight is: in the core, you are charged 100% of the damage; on the waterfront, 50%; over the bay, in the sky or in orbit, 0%.
  - Charged punches launch him along your aim, so the player steers the fight.
  - **Adaptation:** each repeat of the same power does 30% less. This rewards variety, which is Autonomy.
  - **Finisher:** grab and carry him above 100 km and hurl him away, or slam him into the bay.
- **Build:**
  - A 3.2 m humanoid, mass 4 × 10⁵ kg, with cone spikes.
  - Reuses `playerCollide`'s smash path for his movement.
  - The heaviest feel moments in the game (section 3).
- **Depends on:** destruction, feature 19, section 3, T1.

### 23. Constructive powers: heat-weld and ice-build. Effort M

- **Pitch:**
  - Heat vision welds snapped beams.
  - Freeze breath builds ice walls and plugs.
- **Why it's Superman:** He fixes things. Powers as tools for good serve the pillar directly.
- **Build:**
  - **Weldable blocks:** cracked columns get a `crack` flag from near-miss impacts.
    - Holding heat for 1.5 s within 15 m clears the flag and restores support.
    - Overheating past 3 s melts the block (the existing behaviour), which is a precision skill.
  - **Ice-build:** extends the existing frozen water (`onIce`).
    - Freeze breath on the water surface stacks ice-wall segments: instanced boxes, 4 m tall, holding for 30 s.
    - It also plugs burst water mains for street help.
- **Depends on:** heat vision, freeze breath, `structuralCheck`, features 20 and 27.

### 24. Daily Planet hub. Effort S (roof) / L (bullpen)

- **Pitch:** Start the session on the Daily Planet roof under the great globe, then walk into the newsroom as Clark, where Perry hands out leads.
- **Why it's Superman:** The Planet is his home and his alibi. Choosing the next lead gives Autonomy over the emergency order, which is currently fixed.
- **Build:**
  - **(a) Roof (S):**
    - spawn under the 14 m globe;
    - a lead board with 3 leads offered by Lois, Perry and Jimmy (each one picks the next incident type);
    - the front page on an easel.
  - **(b) Bullpen (L):**
    - carve the interior of floors 40–41 out of the Planet's blocks;
    - desks and monitors as instanced props;
    - a close camera, 3 m;
    - Perry's office (leads), Jimmy's darkroom (the photo-mode gallery), Lois's desk (story threads).
- **Depends on:** features 18, 16 and 6.

### 25. Fortress of Solitude. Effort L

- **Pitch:** Fly north to your crystal fortress: a trophy from every rescue, Jor-El's hologram, and a training ground.
- **Why it's Superman:** It is his only private space, the place where Kal-El is not Clark and not a symbol. It gives the progression somewhere to live.
- **Build:**
  - **Separate region** at about z = −60 km.
    - Fly north at Mach 3 or more for 20 km, or pick it on the orbit map.
    - A white-out transition swaps the city group off and the Fortress group on, which keeps the draw budget.
  - **The Fortress:**
    - 200 instanced hexagonal prisms with a crystal shader (env-map reflection, fresnel, cyan-white emissive);
    - a snow plane;
    - an aurora band in the sky shader.
  - **Rooms:**
    - Trophy hall: procedural keepsakes per completed incident type, such as a rotor blade or a meteor shard.
    - Jor-El hologram: lore from the narrative director.
    - **Training:** time trials for feature 11's feats. These are easy to test with the bot.
    - Settings, presented diegetically.
- **Depends on:** features 19 and 11, T3.

### 26. Time-of-day presets and weather. Effort L (needs T2)

- **Pitch:** Dawn patrol, golden hour, blue-hour dusk or Metropolis by night, plus rain and storms that change the rescues.
- **Why it's Superman:** It is atmosphere, not Superman-specific. It ranks here because night flight over a lit city and storm rescues are strong fantasy multipliers.
- **Build:**
  - **4 presets**, each a full set of art-bible baseline values: sun, hemisphere, sky, fog, grade.
    - Night uses the existing window-emissive mask and lamp globes at full intensity.
  - **Weather:**
    - Rain: 2,000 streak sprites near the camera, wet asphalt roughness 0.15, puddles from the env probe.
    - Storm: lightning through `flashLight`, and the wind clamp raised for the cape.
    - Fog.
  - **Weather as an emergency modifier:** a storm makes the airliner harder; rain slows fire spread by 30%.
- **Depends on:** the sky shader, the grade, art-director sign-off.

### 27. Storm surge (the tsunami). Effort L

- **Pitch:** An 18 m surge rolls across the bay toward the waterfront. Freeze a wall across its path before it lands.
- **Why it's Superman:** Holding back nature is a classic beat. The city has a bay, not a dam, so a surge fits the map.
- **Build:**
  - **The wave:** a 600 m wave-front strip with vertex displacement, moving at 30 m/s from 1,200 m out, so about 40 s.
  - **Counters:**
    - ice wall segments (feature 23) must cover at least 80% of the waterfront width;
    - the clap at the crest reduces its height by 30%;
    - evacuate the piers.
  - **Failure:** row 6 floods 2 m for 30 s and cars float.
- **Depends on:** features 23 and 2, the water shader.

### 28. Emergency director: overlapping crises. Effort M

- **Pitch:** At high Hope, two emergencies overlap. Be fast enough for both, or choose.
- **Why it's Superman:** "He can't be everywhere" is his recurring tragedy. Used sparingly, it gives the restraint fantasy its stakes.
- **Build:**
  - Refactor `currentInc` into a list.
  - A second incident spawns only if:
    - Hope is 70 or more;
    - the session is 10 minutes or longer;
    - the first incident is more than 50% resolved;
    - and at most once per 5 minutes.
  - The director keeps an intensity budget.
- **Depends on:** a refactor of the incident system.

### 29. Super-speed evacuation. Effort S (after the other team's ground speed)

- **Pitch:** In slow time at ground speed, carry people out of a collapse zone one at a time while the dust hangs in the air.
- **Why it's Superman:** It is the "everyone is frozen, I have all the time in the world" fantasy, and it serves "save everyone".
- **Build:**
  - Carry-and-drop chaining with slow time.
  - Each person handed off within 30 m of safety counts as a save.
  - Capped by `P.solar` drain, so it can't be farmed.
- **Depends on:** ground super speed (other team), slow time.

### 30. Listen to the city. Effort S (after directional hearing)

- **Pitch:** Hover still, close your eyes, and hear Metropolis: heartbeats, snippets of talk, and one cry for help.
- **Why it's Superman:** Hearing is the sense that makes him *choose* to help.
- **Build:**
  - Hover still with H held for 2 s.
  - The audio mix ducks.
  - Bark snippets float as faded subtitles.
  - The cry for help launches the other team's street help missions.
- **Depends on:** directional hearing and street help (other team).

### 31. Hero body language. Effort S

- **Pitch:** He looks at what matters: head toward the emergency, a glance at Lois, fists on hips when idle.
- **Why it's Superman:** It is the art bible's read order: posture carries the emotion.
- **Build:** a head look-at that blends between the incident marker, the nearest waving person and the aim direction. Plus the arms-crossed slow descent pose.
- **Depends on:** `updateHeroPose`.

### 32. Rebuild. Effort M (needs T6)

- **Pitch:** After a disaster, lift the beams back and haul rubble to the trucks. The bill shrinks only by your own effort.
- **Build:**
  - Rubble delivered to an instanced dump truck refunds 30% of that block's damage value.
  - The truck can't be used in the first 60 s after an incident ends.
- **Depends on:** `rubble`, the ledger, T6.

---

## 2. Flagship demo: 20 minutes, 10 features, in build order

**The demo arc:**

| Time | Beat |
|---|---|
| 0–3 min | Free flight and onboarding |
| 3–6 | Helicopter (now a catch) |
| 6–9 | Fire |
| 9–11 | Robbery |
| 11–14 | Runaway bus |
| 14–17 | Airliner |
| 17–20 | Metallo finale, then the front page |

If T1 is "no villains", the airliner becomes the finale and step 10 becomes "Daily Planet roof epilogue" (feature 24a).

### Test-hook contract (build this first, about 1 day)

Extend `window.__game` with:
- `events`: an append-only list of `{t, type, ...data}` entries.
  - Types: `takeoff`, `land`, `sonicBoom`, `catch`, `injure`, `incidentStart`, `incidentEnd`, `medal`, `line`, `stinger`, `photo`, `telegraph`, `attack`.
- `feel`: `{lastHitStopMs, trauma}`.
- `music`: `{layers, voices}`.
- `comms`: `{queue, last}`.
- `settings`.

**Audio criteria report SKIP, not PASS, when `AU.ctx` is null in headless Chromium.** A check with nothing to measure has not passed.

Every scenario must also keep the existing bot gates passing:
- draw calls 400 or fewer;
- triangles 3M or fewer (shadow pass included);
- CPU sim cost under 6 ms;
- no NaN bodies.

### Step 1: Flight feel pass (features 1, 3 and 14). S + M + M

| # | Acceptance criterion (headless) |
|---|---|
| 1.1 | Hold Space for 36 frames grounded, then release: `P.vel.y >= 80` within 2 frames, and a `takeoff` event with `charge >= 0.9` |
| 1.2 | Drop from 40 m with Space held below 20 m: a `land` event with `tier === 'soft'`, and `ledger.damage` unchanged |
| 1.3 | Set `P.vel.y = -60` at 5 m, no input: a `land` event with tier `crater`, and damage +25,000 ± 1 |
| 1.4 | Accelerate from Mach 0.8 to 1.1 at 400 m: the cone mesh is `visible` for 4 or more frames between Mach 0.95 and 1.0; exactly **one** `sonicBoom` event |
| 1.5 | Hold speed oscillating between Mach 0.99 and 1.01 for 5 s: still exactly one `sonicBoom` event (hysteresis) |
| 1.6 | Audio (or SKIP): wind gain at Mach 0.99 is 0.35 × the gain at Mach 0.8 or less |
| 1.7 | Fly through a deck cloud at 200 m/s: 1 s later, 10 or more puffs within 15 m of the path have moved more than 4 m; 15 s later, they are still displaced by more than 2 m |
| 1.8 | Existing `flight` and `render-budget` scenarios still pass |

### Step 2: Input layer and accessibility baseline (feature 15). M

| # | Acceptance criterion |
|---|---|
| 2.1 | Every action in `ACTIONS` has at least one binding, and no two actions share a binding within the same context |
| 2.2 | Rebind heat to `KeyT`: holding KeyT makes `beams[0].visible` true; holding KeyR does not |
| 2.3 | Bindings survive a `localStorage` round-trip (serialize, reload, compare deep-equal) |
| 2.4 | With shake at 0%, `sonicBoom()` moves the camera by 0 from its un-shaken pose; at 100%, by more than 0 |
| 2.5 | With reduced motion on, `uAberr <= 0.0005` at Mach 2, and `feel.lastHitStopMs === 0` after a charged punch, if hit-stop is off |
| 2.6 | Every marker class emitted by `markers()` maps to a non-empty glyph (`inc`, `hurt`, `trap`, `hosp`, `kryp`, `way`) |
| 2.7 | Timer scale 2×: `currentInc.limit` is twice the 1× value for all 5 incident types |
| 2.8 | Subtitles on: the `line` events from step 5 render a DOM subtitle containing the speaker name |

### Step 3: The Catch and Save Everyone (features 2 and 9). M

| # | Acceptance criterion |
|---|---|
| 3.1 | Helicopter in `falling`. Bot matches velocity (`P.vel = h.vel`), grabs, then holds E for 4 s: `inc.injuries === 0`, then the helicopter lands and the incident ends with success |
| 3.2 | Same helicopter, but the bot grabs while stationary at a Δv of 20 m/s or more: an `injure` event fires, and the medal is not gold |
| 3.3 | Carrying a person, boost from 0 to 300 m/s in 2 s: the person ends up injured. Ramping at 4 g instead: not injured |
| 3.4 | `P.catchG` is within ±0.5 g of `|Δv|/dt/9.81`, computed by the bot over the same window |
| 3.5 | The fire incident exposes `atRisk`, and the HUD counter text matches `"Safe " + safe + "/" + total` |
| 3.6 | Re-run the `emergencies` scenario: every type still starts and ends unattended |

### Step 4: Citizens and Hope mood (features 7 and 8). M

| # | Acceptance criterion |
|---|---|
| 4.1 | At Hope 90: within 3 s of a successful incident end, 60% or more of people within 80 m are in `cheer` |
| 4.2 | At Hope 20: within 3 s of the hero landing within 20 m of a crowd, 50% or more of those people are in `flee` |
| 4.3 | Banner instance count is above 0 at Hope 85, and 0 at Hope 50. The street-rig draw count rises by 1 or less |
| 4.4 | Calling `wave()` 100 times in 60 s of sim raises Hope by +3.0 or less |
| 4.5 | The first approach to an incident (inside 60 m, below 20 m/s) emits exactly one `stinger: 'arrival'`, and 1 or more people enter `lookUp` |

### Step 5: Voices of Metropolis (feature 6). M

| # | Acceptance criterion |
|---|---|
| 5.1 | Each `incidentStart` is followed by exactly one Dispatch `line` event within 1.0 s |
| 5.2 | Over a 10-minute sim, no two `line` events (except Dispatch) start less than 8 s apart |
| 5.3 | Every trigger in the line table has 2 or more variants. The same variant never plays twice in a row |
| 5.4 | Every `line` event's `incidentType` tag equals `currentInc.type`, or is `null` for ambient lines |
| 5.5 | Voice off: subtitles still render. Voice on with no `AU.ctx`: SKIP |

### Step 6: Adaptive score (feature 5). M

| # | Acceptance criterion (all SKIP if there is no `AU.ctx`) |
|---|---|
| 6.1 | Idle hover: `music.layers` equals `['pad']` |
| 6.2 | Flying above 75 m/s includes `ostinato`. An active incident includes `motif`. A timer under 30% includes `tension` |
| 6.3 | `ledger.lost` increments: a `stinger: 'loss'` event follows within 0.5 s |
| 6.4 | Over 60 s of sim, every scheduled note time is at or after `ctx.currentTime`, and `music.voices` stays at 24 or fewer |
| 6.5 | A `line` event is playing: the music bus gain is −8 dB ± 1 dB |

### Step 7: Runaway bus (feature 12). M

| # | Acceptance criterion |
|---|---|
| 7.1 | Unattended: the incident ends in failure within its limit plus 5 s, and `lost > 0` |
| 7.2 | Bot solution (get in front at 40 m or more, grab, hold E): the bus stops, 0 injuries, 30 people spawned at the doors, success |
| 7.3 | A stationary block at 25 m/s: 10 or more injuries |
| 7.4 | The bus's position is never inside a live block (checked every frame), and no NaN |
| 7.5 | Sim cost during the bus stays under 6 ms per frame |

### Step 8: Falling airliner (feature 4). L

**Prerequisite:** T5, the Hope cap.

| # | Acceptance criterion |
|---|---|
| 8.1 | Unattended: impact before the limit, incident failure, and Hope loss of 10 or less in any 5 s (the existing cap holds) |
| 8.2 | Freeze breath held on the burning engine: the fire is out in 6 s or less of breath |
| 8.3 | Bot solution (nose hardpoint, pitch up, then level wings): touchdown with vertical speed under 6 m/s and roll under 15°, 140 saves, success |
| 8.4 | Hope gained from this incident is +10 for passengers plus the medal amount, or less |
| 8.5 | Draw calls stay at 400 or fewer, triangles at 3M or fewer, and sim cost under 6 ms while the airliner is active |

### Step 9: Photo mode and the front page (features 16 and 17). S + S

| # | Acceptance criterion |
|---|---|
| 9.1 | Entering photo mode: `simT` is unchanged over 60 render frames, and the `#hud` computed `display` is `none` |
| 9.2 | Camera distance to the hero stays at 40 m or less under any input |
| 9.3 | `capture()` returns a PNG blob larger than 10 KB, with dimensions equal to the canvas size |
| 9.4 | The front-page `<img>` src equals the last capture, or else the auto snapshot from the most recent gold medal (within ±1 s of that `medal` event) |
| 9.5 | Exiting photo mode: `simT` advances again |

### Step 10: Metallo finale and the demo running order (feature 13, plus a `?demo` sequencer). L

| # | Acceptance criterion |
|---|---|
| 10.1 | `?demo`: no incident before 90 s. Then the order is helicopter, fire, robbery, bus, airliner, Metallo, each starting 25–40 s after the previous one ends |
| 10.2 | At par (the bot solution scripts), the total is 20 minutes ± 2 of sim time |
| 10.3 | `P.kryp` is 0.5 or more at 10 m from Metallo, and 0.05 or less at 45 m |
| 10.4 | Holding the lead plate between the hero and the heart lowers `P.kryp` by 70% or more at 10 m |
| 10.5 | A plate with `frost > 0.75` hit by a charged punch reduces the plate count by 1 |
| 10.6 | Every `attack` event has a `telegraph` event for the same attacker 1.0 s or more earlier |
| 10.7 | Unattended for 180 s: he escapes, the incident fails, and it ends with no softlock |
| 10.8 | Bot solution (freeze, throw, lead, grab) wins in 240 s of sim or less |
| 10.9 | The final front page renders a headline from the "Metallo" template set |

---

## 3. Feel targets: Spider-Man flight, Arkham impact

**What the code does today:**
- `hitStop(0.05 * power)` reaches **200 ms** on a full-charge punch. That is too long, and reads as a stall.
- `addShake` is a **white-noise positional** jitter that reaches about 2.2 m. That is too large, and it can push the camera into walls.

The targets below replace both.

### Camera

| Situation | Target |
|---|---|
| Cruise follow | Critically damped spring, 70 ms half-life. Distance 6.8 m + 0.025 × speed (existing) |
| Boost onset | For the first 0.5 s of acceleration, the follow half-life rises to 140 ms. The hero surges 1–1.5 m ahead in frame, then the camera settles: acceleration you can *see* (Spider-Man swing-exit) |
| FOV | 68° hover, 78° at 75 m/s, 88° at Mach 1, capped at 94°. Rate 40°/s or less, except scripted punches |
| Mach crossing | FOV −5° over 80 ms, then +10° over 400 ms ease-out. 1 frame at exposure 1.25 (art bible) |
| Banking roll | Camera roll up to 12° at full bank (the existing 0.35 × bank, clamped) |
| Landing | Camera dips 0.2 / 0.4 / 0.7 m for the soft / hero / crater tiers and recovers over 250 ms |
| Combat framing (Arkham) | Frame every active threat within 70 m. Distance = clamp(threat bounding radius × 1.6, 5.2, 12) m, with a 200 ms half-life. Vignette 0.75 |
| Boss framing | Keep both Superman and the boss in frame. Pull out to 18 m or less on telegraphs, so the attack reads |

### Hit-stop (freeze the sim; camera shake and cloth keep moving)

| Event | Hit-stop | Then |
|---|---|---|
| Light punch or pulled punch on a robber | 33 ms | — |
| Counter (art bible) | 60 ms | — |
| Charged punch | `min(100, 20 + 20 × power)` ms, so 40–100 ms | Time scale 0.25 → 1 over 150 ms at full charge |
| Flying through a wall (each smash) | 12 ms, at most once per 80 ms (existing) | — |
| Sonic boom | 50 ms (existing) | — |
| Crater landing | 80 ms | — |
| Metallo plate shatter | 90 ms | — |
| Doomsday clash | 140 ms | — |

**Hard ceiling:** 150 ms, outside scripted finishers. Hit-stop is halved under reduced motion and is 0 when hit-stop is turned off.

### Screen shake (a trauma model, replacing positional jitter)

- **Model:** `trauma` runs from 0 to 1, and `shake = trauma²`. Trauma decays at 1.6 per second.
- **Rotational, not positional:** offsets come from smooth noise at 18–25 Hz for impacts and 6 Hz for rumble.
  - Maximum yaw and pitch: 2.5°.
  - Maximum roll: 4°.
  - Positional offset: 0.15 m or less, and only above trauma 0.7.
- **Directional kick:** a 0.3 m camera impulse along the hit normal, on a 120 ms spring.
- **Distance falloff:** for remote events, trauma × (1 − d / 150 m).
- **Trauma added per event:**

  | Event | Trauma |
  |---|---|
  | Light punch | 0.15 |
  | Counter | 0.2 |
  | Wall smash | 0.25 |
  | Charged punch | 0.45 |
  | Sonic boom | 0.5 |
  | Crater landing | 0.3–0.7 |
  | Metallo slam | 0.6 |
  | Doomsday | 0.8 |
  | Re-entry | 0.3, sustained |

- Accessibility: the shake slider multiplies all of this.

### Sound

- **Three layers per impact:**
  - **transient:** a high-passed noise click, 0–15 ms;
  - **body:** a sine sweep from 120 to 38 Hz over 200–350 ms (the existing punch);
  - **tail:** low-passed rumble and debris, 0.6–2 s.
- **Variation:** randomise pitch ±6% and gain ±2 dB per instance. Keep the existing `sfxOK` gaps.
- **Charge-up:** a rising high-pass noise sweep while the charge ring fills, then 150 ms of silence before release (the Arkham "pre-hit suck").
- **Mix:**
  - heavy impacts duck music by −6 dB (10 ms attack, 350 ms release);
  - the master stays under the existing compressor, peaking at −1 dBFS.
- **Physical delay:** booms and collapses more than 150 m away are delayed by `d / 343` s. You see it first, then hear it. This is cheap, and it sells scale.
- **Sonic boom:** see feature 3 (audio hole, 90 ms double crack, muffled wind above Mach 1).
- **Flight:**
  - add a 40–60 Hz sub-rumble that scales with speed;
  - add a short whoosh on hard banks (more than 60°/s at more than 60 m/s), the Spider-Man swing-whoosh equivalent.

### Gamepad rumble (`vibrationActuator.playEffect('dual-rumble')` where supported)

| Event | Duration | Strong | Weak |
|---|---|---|---|
| Light punch | 60 ms | 0.3 | 0.2 |
| Charged punch | 140 ms | 0.8 | 0.4 |
| Sonic boom | 250 ms | 0.8 | 0.5 |
| Crater landing | 200 ms | 0.5–1.0 | 0.3 |

Rumble follows the shake slider.

### Latency budget

- Visual response to any input: on the next frame (16 ms or less).
- Audio scheduled at `ctx.currentTime`.
- Every action has readable feedback within 0.5 s (flow guideline). Every telegraph lasts 1.0 s or more (`tuning.md`).
