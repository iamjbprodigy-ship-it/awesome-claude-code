# Art Bible: Superman Over Metropolis

> **Status**: Draft
> **Owned By**: art-director
> **Last Updated**: 2026-10-02
> **Art Director Sign-Off (AD-ART-BIBLE)**: SKIPPED 2026-10-02 — solo mode

`/art-bible` writes these nine sections in this order and replaces each
section's `[To be designed]` line as that section is approved. A section still
holding its placeholder is incomplete; a later run fills only those.

Conventions used throughout:
- Hex colours are **sRGB display values**. In code, wrap them in `lin()` before they reach a material, as the code already does. Values written as `(r, g, b)` triples are **linear HDR** and go straight into shaders or `THREE.Color`.
- "Grade" means the `GradeShader` uniforms (`uExposure`, `uSat`, `uVig`, `uTint`, `uTintAmt`, `uAberr`, `uLift`).
- Distances are in metres. 1 block = 5 m x 5 m x 4 m, 1 storey = 4 m, 1 lot = 60 m (40 m buildable + 20 m road).
- Pixel sizes assume 1920x1080 at the default 70 degree vertical FOV. A 1.8 m person is about 46 px tall at 30 m and about 9 px at 150 m.

## 1. Visual Identity Statement

**One-line rule:** *A warm, solid, sunlit city that keeps a visible physical record of everything Superman does to it.*

- **Principle 1: Consequence outlasts the effect.** (Pillar: every power has real physical consequences)
  - Every power has two visual parts: the effect (beam, breath, shockwave) and the mark it leaves (scorch, frost, dust, cracks, debris, injured people). The mark stays on screen longer than the effect and is easier to read.
  - Heat-vision scorch stays at least 60 s. Frost stays at least 30 s before it thaws. Collapse dust stays at least 20 s. Debris stays until the plate sleeps.
  - **Design test:** if you are unsure whether to spend budget on the effect or on its mark, spend it on the mark. A dimmer beam that leaves a glowing, smoking wound in a wall beats a brighter beam that leaves nothing.
- **Principle 2: Only the hero is fully saturated.** (Pillar: powerful and responsible)
  - Fully saturated primaries (red `#b3121a`, blue `#1c3fb8`, yellow `#f2b705`) belong to Superman, his power effects and HUD meaning. The city stays warm and earthy, with saturation held to 0.55 or less.
  - The player should always find Superman first and the people he is responsible for second. Nothing else in the frame should compete with them.
  - **Design test:** if you are unsure whether a world asset (sign, car, awning, prop) should be bright, mute it. The exceptions are emergency signals, such as a fire or a trapped person's marker.
- **Principle 3: The city reads at every altitude.** (Pillar: powerful and responsible, because you cannot protect what you cannot read)
  - At 400 m+ the city is layered, haze-graded silhouettes. At 50–400 m it is facade rhythm and rooftops. Below 50 m it is storefronts, furniture and people.
  - Each altitude band gets its own detail source, so no band has to borrow detail from another.
  - **Design test:** if you must choose between surface detail and a clean silhouette, choose the silhouette. Detail that only shows below 20 m goes in the shader, never in geometry.

## 2. Mood & Atmosphere

The baseline is one fixed golden-hour moment. Time of day does not advance. States are told apart by **grade, fog and tint shifts on top of that one sun**, never by moving the sun.

**Baseline (all states inherit this unless noted):**
- Sun: `0xffd2a1` at intensity 3.3, about 18–21 degrees elevation (see section 6 for the azimuth).
- Hemisphere light: sky `0xa9c6ff`, ground `0x5e5446`, intensity 0.35.
- Sky: horizon `(1.0, 0.80, 0.62)`, zenith `(0.17, 0.34, 0.70)`, sun halo `(2.6, 1.3, 0.5)`, sun disc `(40, 32, 22)`.
- Fog: Exp2 at density 0.0011, coloured from the horizon hue x 1.15.
- Grade: exposure 1.0, saturation 1.08, vignette 0.55, lift `(0.012, 0.010, 0.020)`.
- Bloom: strength 0.6, radius 0.55, threshold 1.0.

| State | Emotional target | Lighting / grade delta from baseline | Descriptors | Energy |
|---|---|---|---|---|
| **Free flight** | Freedom, scale, awe | Baseline. Above 300 m/s: `uAberr` up to 0.004 and vignette up to 0.70. Sonic boom: 1 frame of exposure 1.25, then ease back over 0.4 s. In cloud: fog density +0.02 (as now). | warm haze, long shadows, glittering bay, endless skyline | Medium-high, calm |
| **Street level** (walking, under 15 m altitude) | Intimacy, the place feels real | Saturation 1.0, vignette 0.45. Fog is not visible below 300 m, so street depth comes from shadow, not haze. Shopfront glow is subtle (section 6). | sun-striped avenues, warm brick, busy, lived-in | Medium-low |
| **Emergency active** | Urgency without panic | No global tint, because the world signals the emergency. Fire is a smoke column `#2b2522` rising 150 m, visible from 1.2 km, with a 6 m orange point light `(4.0, 1.6, 0.4)` at its base. A falling helicopter has nav strobes: red `(6, 0.2, 0.2)` and white `(6, 6, 6)` at 1 Hz. A meteor trails a streak through the sky. Vignette 0.62. | smoke against gold, one point of danger, everything else still calm | High, focused |
| **Robbery combat** (close camera, within 70 m) | Precise, controlled, Superman holding back | Vignette 0.75 and saturation 0.95. Robbers get a coral rim flash `#ff6b6b` for 0.25 s on telegraph. Muzzle flash `(6, 4.5, 2.0)` for 2 frames. A counter hit-stop of 60 ms freezes particles but not cloth. | tight, grounded, readable silhouettes, warm sidewalk | High, staccato |
| **Slow time** | Godlike clarity, a held breath | Saturation 0.35 (as now), tint `(0.92, 0.97, 1.08)` at 0.3, vignette 0.8. The suit gets emissive `(0.10, 0.05, 0.02)` so red and blue still read through the desaturation. Particles leave 3-frame ghost trails. | silver, still, crystalline, suspended dust | Low (deliberately) |
| **X-ray** | Analytical, seeing through | Tint `(0.75, 1.0, 1.2)` at 0.6 (as now), saturation 0.5. People inside walls show as warm amber `#ffb347` silhouettes, emissive `(3.0, 1.6, 0.5)`, the only warm colour on screen. Load-bearing columns tint pale blue-white `(0.8, 0.9, 1.2)`. | cold, blueprint, clinical, warm hearts inside | Low-medium |
| **Kryptonite** (`P.kryp` above 0.2) | Sickness, vulnerability | Tint `(0.85, 1.12, 0.85)` at `0.5 * P.kryp`. `uAberr` up to 0.006 x `P.kryp`. Vignette pulses 0.6–0.9 at 1.2 Hz, scaled by `P.kryp`. Suit emissive green `0.6 * P.kryp` (as now). The meteor carries a 90 m point light `#4dff6a`. | sour green, swimming edges, pulsing, wrong | Tense, unstable |
| **High altitude / space** (above 3 km, `uSpace` rising) | Isolation, the planet below | `uSpace` takes the zenith to `(0, 0, 0.012)`. Stars fade in from 20 km to 40 km. Fog follows air density (as now). Hemisphere intensity drops to 0.15. The sun disc whitens and bloom strength goes to 0.9. | black sky, thin blue rim, silent, cold | Very low |
| **Collapse aftermath** (within 25 s of a structural failure within 150 m) | Weight and regret | Local dust fog at density 0.006 within 80 m of the collapse, colour `#b8a58a`, decaying over 20 s. Sunbeams cross the dust (bloom radius 0.7). Embers `(4.5, 1.3, 0.22)` where there was heat. Saturation 0.95. | choking, gold-grey, sunbeams in dust, quiet | Falling |
| **Pause: Daily Planet front page** | Reflection, a verdict on the day | The game is frozen behind a blur. The paper `#f1ece1`, ink `#1b1b1d` and accent `#b3121a` carry the screen (style.css `.paper`). Hero photo: a canvas snapshot of the last save, greyscale with a 4 px halftone dot. | newsprint, tactile, calm, judged | Static |

- **Distinctness check:** every state must be identifiable from a greyscale thumbnail plus one colour cue. That cue is: smoke (emergency), vignette (combat), silver (slow time), cyan with amber (x-ray), green pulse (Kryptonite), black sky (space), dust (aftermath), paper (pause).
- **Stacking order** when states overlap: Kryptonite > x-ray > slow time > combat > emergency > baseline. Tints do not add up. The highest state wins, and lower states keep only their vignette.

## 3. Shape Language

**Characters:**
- **Superman** is a V-taper: shoulder width is 1.55 x hip width, built from stacked ellipsoids. Spheres and rounded cylinders only, no hard edges.
- His defining trait is the **cape**: an 8 x 12 cloth that widens 0.4 m to 0.7 m and adds a large red triangle to his silhouette at every angle. The cape is never shortened for performance.
- **Civilians** are narrow, upright capsules, 0.40 m wide, with a small sphere head. They are vertical, soft and passive.
- **Robbers** have the same capsule, plus one trait that changes the outline. Choose one per robber:
  - a 0.45 m duffel box at the hip, or
  - an extended gun arm (a horizontal 0.5 m bar at chest height).
  - Robbers also stand in a crouch, with their height scaled to 0.9. Squat and asymmetric means threat.
- **Thumbnail test:** at 64 px tall, Superman, a civilian and a robber must be identifiable by outline alone.

**Environment:**
- Buildings are **stacked rectangles that step back as they rise**. Mass gets lighter upward: a wide base, setback tiers, then a slim crown.
- The dominant direction is **vertical**. Horizontals (cornices, sign bands, ribbon windows) only punctuate it.
- Curves are reserved for landmarks: the copper dome, the Daily Planet globe and the gothic spire. Ordinary buildings are never round, so curves mean "landmark".
- Destruction breaks the grid. Debris pieces are angular, irregular fragments (`flatShading`) against the clean orthogonal city. A broken shape means something happened.
- Street furniture is **thin verticals**: lamps, signal poles and tree trunks under 0.3 m wide. They give scale without blocking the view.

**UI:**
- The UI grammar is **rectangles with 4–6 px radius**, plus the **45-degree diamond** for markers and the **shield pentagon** reserved for Superman-related UI (the streak and the Hope icon).
- Lines are 1 px edges at 20% alpha. Accents are 3 px left borders (toasts) or 4 px top borders (cards).

**Hero versus supporting shapes:**
- Hero shapes are the cape triangle, the shield pentagon and the landmark curves. They are allowed to be large, smooth and singular.
- Supporting shapes are repeated, small and orthogonal: windows, furniture and crowds. Repetition is how the city stays calm so the hero stands out.

## 4. Color System

**World palette (7 anchors):**

| # | Colour | Hex | Meaning / use |
|---|---|---|---|
| 1 | Golden-hour light | `#ffd2a1` | The sun, so warmth and safety. All lit faces lean toward it. |
| 2 | Sky / haze blue | `#a9c6ff` → horizon `#ffcc9e` | Distance and air. Shadow fill is blue, lit faces are gold. |
| 3 | Brick red-brown | `#8a4a36` (range `#6e3b2e`–`#9b5a42`) | Old, residential, human-scale Metropolis. |
| 4 | Limestone | `#cbbd9f` (range `#bfb29a`–`#d8ccb2`) | Civic, permanent, institutions. |
| 5 | Steel-glass | `#2a3440` frame, glass `(0.05, 0.065, 0.09)`→`(0.14, 0.18, 0.24)` | Modern, corporate, the core. Reflects the sky env map. |
| 6 | Verdigris copper | `#5f9e8a` (shadow `#3f6f60`) | Landmarks only, so the eye goes to them. |
| 7 | Bay water | `#173f57` with sun glitter | The edge of the city. Its warm reflections double the sunset. |

- **Ground:**
  - asphalt `#3a3a3c`
  - sidewalk `#9d968a`
  - curb `#b5aea2`
  - crosswalk and lane paint `#e9e5da`, kept off pure white so it does not bloom
  - yellow centre line `#d9a521`
  - tar roofs `(0.32, 0.31, 0.30)` ±15%
- **Vegetation:**
  - summer crown `#3e6b2f`
  - autumn mix: 60% `#3e6b2f`, 25% `#a5652a`, 15% `#c8902e`
  - trunk `#4a3527`
- **Temperature rule:**
  - Lit faces are warm (sun). Shadow faces are cool (hemisphere sky `#a9c6ff`).
  - Distance moves toward the horizon peach `#ffcc9e`. Altitude moves toward zenith blue.
  - Never use a cool key light or a warm shadow outside the power states.
- **Saturation cap:**
  - World albedo is held to HSV saturation 0.55 or less. Car paint 0.6 or less.
  - Civilian clothing 0.5 or less, from the existing muted `CLOTHES` list. Sign bands 0.6 or less.
  - Only the hero, powers, emergency lights and HUD may exceed these caps.

**Hero palette (fixed):**
- suit `#1c3fb8` (roughness 0.42)
- red: boots and trunks `#b3121a`, cape `#a80f16` (roughness 0.62)
- gold belt and shield `#f2b705`
- skin `#e2a987`
- hair `#0e0f12`

**Power colours:**

| Power | Core (linear HDR) | Glow / secondary | Mark left on world | Display hex (HUD) |
|---|---|---|---|---|
| Heat vision | `(14, 2.2, 0.5)` beam core, 0.04 m | `(3, 0.4, 0.1)` sheath at 0.35 opacity, additive | Scorch: albedo toward `(0.03, 0.025, 0.02)`. Glow `(4.5, 1.3, 0.22)` x heat^1.7. Smoke `#3a332e`. | `#ff6a2b` |
| Freeze breath | Mist particles `#dff4ff` at 0.4 opacity, no bloom | Frost albedo `(0.62, 0.86, 1.0)` at 80%. Emissive `(0.15, 0.35, 0.5)`. | Ice decal at roughness 0.1, thaws in 30 s or more | `#9be6ff` |
| X-ray | Grade tint `(0.75, 1.0, 1.2)` | People `#ffb347`, emissive `(3.0, 1.6, 0.5)` | none (perception only) | `#9be6ff` with a hollow-eye icon |
| Kryptonite | Emissive `(0.2, 2.5, 0.4)`, point light `#4dff6a` | Particles `(0.9, 6, 1)` | Green-lit debris. The suit gets a green emissive. | `#a6ff3d` |
| Clap / shockwave | Additive ring `(2.5, 2.3, 2.0)`, 0.3 s | Dust ring `#b8a58a` | Toppled people and cars, broken glass | `#ffc531` |
| Superman impacts | Flash `(1.2, 1.0, 0.6)` on the suit | Spark particles `(5, 3.5, 1.5)` | Crater decal, dust | none |

**Semantic HUD colours (from style.css, now locked):**

| Meaning | Colour | Shape backup (mandatory) |
|---|---|---|
| Incident / primary / Superman | `--sun #ffc531` | Diamond marker, plus a distance readout |
| Danger / alert / failure | `--cape #e2302a` (toast), `#ff6b6b` (hurt / shot coming) | Hurt: plus-cross. Shot coming: "!" in a triangle. Alert toast: a 3 px left bar and an alert sound. |
| Good / hospital / success | `--ok #57e39a` | Square marker with an "H". Success toast: a check glyph. |
| Trapped / ice / perception | `--ice #9be6ff` | Downward bracket marker, plus a "floor N" label |
| Heat | `--heat #ff6a2b` | Flame glyph on the chip |
| Kryptonite | `#a6ff3d` (new) | Hexagonal crystal glyph, plus a 1.2 Hz pulse |
| Text / dim / panel | `#eef3ff` / `#9aa9cf` / `rgba(7, 12, 30, 0.62)` | none |

**Colourblind safety:**
- Under deuteranopia and protanopia, `--cape` and `--ok`, and `--ok` and Kryptonite, collapse into the same hue. Under tritanopia, `--ice` and `--ok` get close. Every marker class therefore carries its **own glyph** (table above), and **colour is never the only carrier** of meaning.
- Kryptonite must also be signalled by the vignette pulse and the screen-edge aberration, so it is readable with all colour removed.
- Heat versus freeze on the power chips: these differ by luminance (`#ff6a2b` versus `#9be6ff` is about a 2.1:1 ratio) and by glyph (flame versus snowflake).
- Medal tiers are never colour-only. Bronze `#b0743a`, silver `#c9ced6` and gold `#ffc531` also carry 1, 2 and 3 stars.
- Validation: run every HUD screen through a simulator for deuteranopia, protanopia and tritanopia before each milestone.

**UI palette divergence:**
- The HUD lives in a cool **night navy** (`#060a17` base, `#9aa9cf` dim). That is the opposite of the warm world, so the panels separate from any frame.
- The front page diverges completely into newsprint (`#f1ece1` / `#1b1b1d` / `#b3121a`), because it is an artefact inside the world, not a HUD.

## 5. Character Design Direction

**Superman:**
- **Archetype:** the classic Silver-to-Modern-Age Superman, meaning a bright suit, red trunks, gold belt, a curl and a calm face. He is a reassuring idol, not a grim one.
- **Proportions:** about 1.9 m tall, a 7.5-head figure, with heroic shoulders (section 3).
- **The read order:**
  1. cape silhouette
  2. red, blue and gold blocking
  3. chest shield, a 0.23 x 0.20 m canvas emblem at 128x112
  4. face
- **Pose rules:**
  - **Flight:** body aligned with velocity, one fist forward above 80 m/s, both arms at the sides when hovering. The cape always trails along the velocity vector (the verlet cloth with wind clamped at 45 m/s).
  - **Hover / rest:** upright, fists on hips (the classic pose) after 1.5 s idle.
  - **Landing:** one knee and one fist down, with a crater decal and a dust ring. This is the only time he crouches.
  - **Combat:** an open, controlled stance, not a brawler crouch. Counters are short and exact, because he is holding back.
  - **Kryptonite:** shoulders drop 10 degrees and one hand goes to his chest. The flight attitude droops.
  - **Never:** cowering, flailing, or a gun-like pointing pose.
- **Expression:** none modelled. Read the emotion from posture and the cape.

**Civilians:**
- Capsule body plus a sphere head, using 9 muted clothing colours and 5 skin tones (existing lists).
- Variety comes from 3 height scales (0.92, 1.0, 1.06) and 2 width scales (0.9, 1.1).
- **Behaviours must read from silhouette:**
  - Walking: ±4 degree bob.
  - Fleeing: lean 15 degrees forward, at 2.5 x speed.
  - Cheering: both "arms" raised. Until arms exist, this is a vertical 0.4 m hop at 2 Hz.
  - Taking photos: head tilted plus a 2-frame white flash `(4, 4, 4)`.
  - Injured: lying horizontal, with the `#ff6b6b` plus-cross marker.
  - Trapped: visible only through x-ray or hearing.

**Robbers:**
- Clothing near-black `#161616`, head `#2a2a2a` (a ski-mask read), crouched to 0.9 height, plus one silhouette trait (section 3).
- The getaway van is the only vehicle painted `#161616`, with plain, unmarked sides. That keeps it the darkest vehicle on the street.
- **Telegraph:** a 0.25 s coral rim flash `#ff6b6b` plus a "!" triangle marker before each shot.
- **Cuffed:** kneeling, with a 0.6 m grey ring decal under them.

**Telling them apart:**

| Distance | Superman | Civilian | Robber |
|---|---|---|---|
| Under 30 m (46 px or more) | Cape and colour blocking | Upright capsule with muted colour | Black, crouched, with a duffel or gun arm |
| 30–150 m (46–9 px) | (player) | Moving dots of muted colour, flowing along sidewalks | Black dots that cluster and do not flow. The incident diamond sits above the group. |
| Over 150 m (under 9 px) | — | Not individually readable, and not required | HUD only: the incident marker plus a crew count. People below 9 px are never asked to carry meaning. |

**LOD philosophy:**
- **Superman:** full detail always. He is never further than about 8 m from the camera.
- **Civilians and robbers:** one instanced mesh each (body plus head, about 200 tris).
  - Skip shadow casting beyond 60 m.
  - Hide instances beyond 400 m. They are under 4 px there anyway.
- **Trait geometry** (duffel, gun arm): only within 60 m. Beyond that, the marker carries identity.
- **Detail budget rule:** anything smaller than 3 px at its usual viewing distance is cut or moved into a shader.

## 6. Environment Design Language

**Architectural identity:**
- Metropolis is a **sunlit, optimistic pre-war-meets-modern American city**. It is New York density with Chicago's civic pride. It is not Gotham: no gargoyle gloom and no wet night.
- History reads outward from the core: old brick at the edges, limestone civic buildings on the avenues, glass in the core.

**District layout on the 7x7 lot grid:**
- The lots run from row 0 (inland) to row 6 (the waterfront at z=240).
- Columns: column 3 is the main north-south avenue axis, and row 3 is the cross axis.

| District | Lots | Facade style | Height | Character |
|---|---|---|---|---|
| Core / Midtown | the central 3x3 (cols 2–4, rows 2–4) | 2 glass curtain wall, 60%; 1 limestone, 40% | 25–60 storeys (100–240 m) | Setback towers. This is where the Daily Planet is. |
| Avenue ring | the lots fronting col 3 and row 3, outside the core | 1 limestone, 60%; 3 modern ribbon, 40% | 10–25 storeys | Civic and commercial, with cornices. Storefronts on every ground floor. |
| Waterfront | row 6 | 3 modern ribbon, 50%; 1 limestone, 30%; park, 20% | 6–20 storeys | Open to the bay. The copper-dome City Hall sits here. |
| Neighbourhoods | the outer ring (rows 0–1, cols 0–1 and 5–6) | 0 brick walk-up, 80%; 1 limestone, 20% | 4–7 storeys (16–28 m) | Fire escapes, water tanks, trees, stoops |

- **Height falloff:** from the core outward, heights drop by about 30% per lot ring. The skyline should read as a **single mountain** from the bay, with its peak at the Daily Planet.

**The four facade styles (FACADE_GLSL):**
- **0 Brick walk-up**
  - 2 windows per 5 m bay, with stone lintels and sills `(0.55, 0.51, 0.45)`.
  - Brick base `#8a4a36`, randomised ±10% per brick.
  - A black fire-escape grille on 50% of buildings. It must read as **black `#151515`**, not as a frame tint.
  - Always a cornice.
- **1 Limestone**
  - 3 windows per bay, base `#cbbd9f`, a horizontal rustication band every storey.
  - A cornice on every tier top. A heavier base band `+5%` at the ground floor.
- **2 Glass curtain wall**
  - Full-height glass with thin mullions, 4 per bay, frame `#2a3440`. Glass metalness 0.8, roughness 0.04.
  - The glass must reflect the sky env map so towers carry the sunset. No cornice; the crown is a flat setback instead.
- **3 Modern ribbon**
  - Horizontal glass bands from 0.34 to 0.82 of each storey, spandrels `#b9b6ae`. No cornice.
  - Used for 1960s–80s fill.
- **Mixing:** a single building may mix styles by tier only (for example, limestone on tiers 1–2 and glass above). Never mix styles on one face of one tier.

**Setbacks and massing:**
- Tower footprint is up to 8x8 blocks (40 m). Setbacks of 1 block (5 m) per side happen at about 35% and about 65% of height, and the crown is 2x2 to 4x4 blocks.
- Walk-ups have no setbacks and fill their lot edge to edge, as 2–4 separate buildings per lot frontage, each 2–4 blocks wide. That gives the varied roofline in reference 2.
- Each lot holds at least 2 buildings, so no lot reads as one monolith.

**Cornices (flag 16):**
- The top 16% of the storey goes 12% lighter, with no glass.
- Every brick and limestone tier top gets one, because it is the strongest horizontal cue for scale from the air.
- In geometry, a cornice is an overhang of 0.3 m on landmark buildings only.

**Rooftop props** (instanced, per building roof):
- Water tanks:
  - 1 per walk-up (100%) and 1 per limestone building (50%).
  - Wooden cylinder `#6b4a32`, 3 m across and 4 m tall, on a 2.5 m steel stand `#2b2b2b`, with a cone cap.
- HVAC boxes: 2–4 per glass or ribbon roof, `#8d8f8f`, 2x1.5x1.5 m.
- Parapets: 0.6 m on all roofs.
- Antennas or spires: on the 3 tallest towers only.
- Pigeons: none as geometry. Use a particle flock of 12–20 point sprites `#55524f` that scatter at a 15 m approach.
- Cap: 6 or fewer props per roof.

**Storefronts (flag 8, ground floor):**
- Display glass from 4% to 66% of the storey, a sign band from 71% to 90%.
- Sign colours come from the seed hue at saturation 0.6 or less, and 45% of signs are lit.
- Interior glow: `(1.0, 0.62, 0.30)` at **0.6 or less** in daylight.
  - The current 1.1 is a defect to fix: it crosses the bloom threshold, and lit windows must not bloom at golden hour. Only signs may reach 1.6.
- **Awnings:**
  - On 40% of walk-up and limestone storefronts.
  - An instanced 4.6 m x 1.2 m sloped quad at 3.2 m height.
  - Colours from: `#7a2b2b`, `#2f5a45`, `#3a3f5c`, `#8a6d3a`, and a stripe variant drawn in the shader.
  - No awning may use hero red `#b3121a`.

**Street layout and dressing (per 60 m road segment):**
- Road cross-section (20 m):
  - 3.5 m sidewalk `#9d968a`, raised **0.15 m**
  - curb `#b5aea2`, 0.3 m wide
  - 12.4 m roadway, made of 4 lanes at 3.1 m
  - 3.5 m sidewalk
- Ground markings live in the city ground canvas, so they cost zero draw calls:
  - Crosswalks: zebra, 4 per intersection, 3 m deep, with 0.6 m stripes and 0.6 m gaps.
  - Lane lines: dashed `#e9e5da` 3 m on / 6 m off.
  - Centre line: double `#d9a521`.

| Element | Main avenues (col 3, row 3) | Side streets | Neighbourhoods |
|---|---|---|---|
| Lamp posts (ornate on avenues, plain cobra-head elsewhere) | 2 per side (30 m spacing) | 2 per side | 2 per side |
| Trees (pits 1.2 m, 0.8 m from the curb) | 5 per side (10–12 m) | 2 per side | 4 per side |
| Hydrants (`#a13a2c`, a muted red, not hero red) | 1 per segment | 1 | 1 |
| Mast-arm traffic lights (`#2d2f2a`, 6.5 m pole, 7 m arm) | 2 per intersection, on diagonal corners | 2 | 1 (pole-mounted only) |
| Parked cars | 4 per side | 3 per side | 5 per side |
| Benches / bins / newsstands | 2 / 2 / 1 | 0 / 1 / 0 | 1 / 1 / 0 |

- **Lamp posts:**
  - Pole `#1f2a24` (dark green-black), 6 m tall.
  - The globe is lit at only `(1.2, 0.9, 0.6)` x 0.3 in daylight.
- **Traffic signals:** heads lit as follows (they may bloom):
  - red `(5, 0.3, 0.2)`
  - amber `(5, 2.8, 0.3)`
  - green `(0.3, 4, 1.5)`
- **Trees:** 60% summer, 40% autumn on avenues and in parks (reference 7). In neighbourhoods, 100% summer.

**Landmarks** (each unique, each visible from at least 1 km, each on a sightline):
- **The Daily Planet** sits at the core, on lot (3, 3).
  - A limestone and art-deco tower, 220 m tall, with 3 setbacks.
  - It is crowned by a 14 m gold-and-blue globe on a ring: `#d4a63a` metal 1.0 / roughness 0.3, with `#1d4f9c` continents.
  - It is the tallest peak and the skyline's focal point.
- **City Hall** sits on the waterfront, lot (3, 6).
  - A limestone base 5 storeys tall, with a **verdigris copper dome** `#5f9e8a` 24 m across.
  - Four gold finials `#d4a63a`, each 2.5 m (reference 4). A colonnade of 8 columns faces the bay.
- **The Gothic tower** sits at the north (inland) end of the col 3 avenue, lot (3, 0).
  - It **closes the avenue vista** (reference 5).
  - Limestone `#bfb29a`, 160 m tall, with a slate-pointed crown `#3b4048` and a 30 m spire.
  - Vertical ribbing every 2.5 m.
- **The Library / museum** sits on lot (1, 3).
  - Low limestone (4 storeys) with 6 columns and 3 vertical banners: `#7a2b2b` and `#2f4a7a` (reference 7).
- Landmarks are **non-destructible**, or they need a scripted, minimal collapse. Flagged for game design.

**Far skyline and far shore (z = 1,000–2,000+, across the bay):**
- **Composition:** 3 depth bands of extruded boxes. Each band is merged into 1 draw call, has no shadows, and uses `fog: false` with custom haze.

| Band | Distance | Count | Heights | Haze mix toward horizon `(1.0, 0.80, 0.62)` |
|---|---|---|---|---|
| Near far shore | 1.0–1.4 km | about 600 | 20–180 m | 0.55 |
| Mid | 1.4–1.8 km | about 800 | 30–260 m | 0.68 |
| Far | 1.8–2.6 km | about 600 | 40–320 m | 0.80 |

- Each band gets a 2-tone canvas window-grid texture (256x256) at 30% contrast, plus a few lit windows at `(1, 0.62, 0.3)` x 0.3.
- Arrange the heights as **two clusters with a valley**, so the far skyline does not out-peak the Daily Planet seen from the city. Keep at least 1 recognisable far tower, 320 m with a spire, offset 25 degrees from the Daily Planet axis.
- **Why custom haze:** Exp2 fog at 0.0011 fogs 98% of anything at 1.8 km, which would erase the far skyline that is in every reference. Near-city fog stays as it is, and the far layers get explicit per-band haze.
- **Mountains:** one 2-tone ridge silhouette at 8–12 km, haze 0.88, rising 2–4 degrees above the horizon (reference 3).

**Golden-hour sun angle:**
- **Elevation 18 degrees.** That gives shadows 3.1 x object height, so long striped avenues.
- **Azimuth: the sun sits over the bay, about 40 degrees right of the +z (toward the far shore) view axis.**
  - Target `SUN_DIR ≈ normalize(-0.61, 0.31, 0.73)`. The current code has `(-0.55, 0.36, -0.75)`, with the sun behind the city as seen from the bay.
  - **Trade-off:** placing the sun over the bay gives the reference 1 shot: glare upper right, a glittering water path and a backlit far skyline. The cost is that the city's bay-facing facades go backlit and cooler.
  - Decision: adopt the bay-side sun. The inland-facing views (toward the gothic tower) then get fully front-lit gold facades, which suits the street-level references 5–7.
- **Shadow camera:** ±150 m. A 220 m tower casts a 680 m shadow, so shadows beyond 150 m must come from the darker hemisphere fill and fog. That is accepted. Don't stretch the cascade.

**Texture philosophy:**
- **Procedural PBR with stylised restraint.** Real roughness and metalness values let glass and paint pick up the sunset env map, but surface noise is kept to ±10%. Readable rhythm beats grime.
- No dirt maps at all on clean civic stone. Grime appears only as a **consequence** (scorch, soot above fire windows, dust after a collapse).

**Environmental storytelling:**
- Damage persists for the session: scorch, cracks, missing blocks, wrecked cars.
- The city keeps a visible ledger of the player's day: the more damage, the more the session's skyline shows it.
- Saves leave positive traces too: crowds cheering where a save happened, and a hospital pad with ambulances that stay 60 s.

## 7. UI/HUD Visual Direction

**Diegetic versus screen-space:**
- Mostly **screen-space**, pinned to the four corners plus a bottom-centre power rail (as now). Flight at speed needs a fixed, peripheral HUD that never moves with the world.
- **Diegetic elements:** smoke columns, strobes, crowd behaviour and the newspaper. **World-anchored markers** sit in between.
- **Rule:** the world tells you *where*, the HUD tells you *how much* (time, distance, count).

**Layout and safe zones:**
- Corners have a 16 px inset, plus a 14 px top and bottom inset.
- The centre 40% of the screen (the flight focus cone) holds **nothing persistent** except the 40 px crosshair and charge ring. Toasts go at the top centre, at most 520 px wide, with at most 3 stacked, each fading after 3.5 s.
- **Speed readability:** above 150 m/s, corner panels drop to 60% opacity and non-critical rows hide, leaving only speed, timer and Hope. Restore them below 100 m/s.

**Typography (from style.css, locked):**

| Role | Font | Weight | Size (1080p) |
|---|---|---|---|
| Display: speed, card titles, front-page headline | Big Shoulders Display | 800–900 | 46 px speed. 32–78 px titles. |
| UI labels, chips, toasts | Barlow Condensed | 600–700, uppercase, tracking 0.06–0.16 em | 12–16 px |
| Numbers | JetBrains Mono, tabular | 500–600 | 11–18 px |
| Newspaper body | Georgia | 400 / italic | 15–18 px |

- **Minimum readable size:**
  - 12 px uppercase or 13 px mixed case at 1080p.
  - Marker sub-labels may be 11 px only in mono, with the existing text shadow `0 1px 3px rgba(0,0,0,0.8)`.
  - Scale all UI with `clamp()` at 1440p and above (x 1.25 at 1440p, x 1.5 at 4K).
- **Contrast:** HUD text needs 4.5:1 or better against the panel over the brightest sky. Check it against `#ffcc9e` behind a 62% navy panel. The `--dim` text `#9aa9cf` passes at about 5:1.

**Marker rules (world-anchored, `.mk`):**
1. **At most 1 primary marker** (the current incident, `--sun` diamond). It stays visible at every distance and clamps to the screen edge as a circle (`.edge`) with an arrow pointing toward the target.
2. **Secondary markers** (hurt, trapped, shot coming, hospital) show only within 250 m, or when hearing or x-ray is active. Cap them at **8 on screen**, nearest first.
3. **Distance-based scale:** 100% at 0–100 m, down to 75% at 1 km, never smaller. Labels hide beyond 600 m; keep the glyph and the distance.
4. **Occlusion:** markers never hide behind geometry. Behind a wall they drop to 60% opacity and get a dashed outline.
5. **No marker for anything the world already shows** within 60 m and on screen (for example, a visible fire). The marker fades to 30% inside 60 m.
6. **Telegraphs** (the shot-coming "!") are the only markers that animate: 2 pulses over 0.25 s. Nothing else blinks, except the Kryptonite glyph.
7. **Glyph per class** (colourblind backup, section 4): diamond, plus-cross, triangle "!", bracket, H-square, hexagon.

**Iconography:**
- Flat, single-colour line icons on a 2 px stroke and a 16 px grid. Rounded caps.
- Power chips show a glyph, a label and the key hint (`kbd`). On gamepad, swap the `kbd` text for a button glyph drawn in canvas or SVG. No icon fonts.
- The shield pentagon is reserved for Superman-owned meaning: the streak and the Hope gauge.

**Animation feel:**
- **Fast in, slow out:** toasts arrive in 0.3 s ease-out and leave in 0.5 s. Chip state changes take 0.15 s.
- The Hope change pulses the gauge once (1.08 scale over 0.2 s) in `--ok` or `--cape`, plus an up or down arrow.
- **Reduced motion:** honour `prefers-reduced-motion`. That disables pulses, screen shake above 2 px, aberration and the Kryptonite vignette pulse; a steady vignette replaces it.

**Front page (pause):**
- Newsprint card, at most 640 px wide.
- Masthead *DAILY PLANET* in Georgia 700. The headline is Big Shoulders 900, which reflects the day.
- Halftone photo of the best moment, 3 stat columns in mono, and an unlocks list with `●`/`○` bullets plus red `#b3121a` for unlocked.
- Tone rule: a good day gets a heroic headline, a bad day gets a sober one. Never mock the player.

**Art-direction versus readability conflicts:**
1. **Warm golden haze versus HUD contrast.** Art wants transparent, airy panels. UX needs legibility against the brightest sky.
   - Decided: a 62% navy panel with a 6 px backdrop blur. Readability wins, and the cool panel is the art justification for the contrast.
2. **Slow-time desaturation versus semantic colour.** A full-screen saturation of 0.35 would wash out the HUD and markers.
   - Decided: HUD and markers are DOM, outside the grade, so they keep full colour. That is correct and must stay that way. No HUD drawn into the WebGL canvas.
3. **Kryptonite green versus `--ok` green.** Both are green.
   - Decided: Kryptonite is the lime `#a6ff3d` with a hexagon glyph and a pulse; ok keeps `#57e39a` with an H or check glyph. Escalate to the creative director if testing still confuses them.

## 8. Asset Standards

**Context:**
- The game is code-only: three.js r128, WebGL2 with a WebGL1 fallback, no imported meshes or textures.
- An "asset" here is a **factory function plus its geometry, material and canvas texture**.
- Target: a mid-range PC GPU (GTX 1660 / RX 5600 / RTX 3050 class), **60 fps at 1080p**, a 16.6 ms frame with 9 ms or less on the GPU.

**Naming convention, adapted for code:**
- **Canvas texture cache keys and material registry keys** use `[category]_[name]_[variant]_[size]`:
  - `env_storefront_sign_256`
  - `ui_icon_heat_32`
  - `char_hero_emblem_128`
  - `vfx_smoke_puff_64`
- **Factory functions** use `make[Category][Name]()`, for example `makeEnvLampPost()`, `makeCharRobber()`, `makeVfxScorch()`.
- **InstancedMesh variables** are `[name]Inst`, for example `lampInst` or `treeCrownInst`.
- Categories are `env`, `char`, `veh`, `prop`, `vfx`, `ui`, `sky`, `far`.

**Geometry budgets (triangles per unit):**

| Category | Per unit | Instances (max) | Notes |
|---|---|---|---|
| Superman (all parts plus cape) | 12k or less | 1 | Currently about 10k. Spheres at 20x14 segments are the max. |
| Civilian / robber (body plus head) | 300 or less | `MAXP` (at most 400) | 8-segment body, 10x8 head. Robber traits are 50 tris or less each. |
| Car | 1.5k or less | 120 | Instanced by part: body, glass, tyres, lights. |
| Helicopter / van / truck | 3k or less | 4 | |
| Building plates (5x5x4 boxes) | 12 | 13,000 | One instanced mesh. Facade detail is all shader. |
| Debris fragments | 24–60 | 600 live | `flatShading`, 3 shape variants |
| Lamp post (ornate / plain) | 250 / 120 | 500 | |
| Mast-arm traffic light | 300 | 130 | Lit heads are a separate instance set. |
| Tree (trunk plus crown) | 220 | 700 | Crown is an icosahedron at detail 1, scaled per instance. |
| Hydrant / bench / bin / newsstand | 60 / 80 / 40 / 120 | 100 / 60 / 120 / 30 | |
| Water tank / HVAC / awning | 120 / 12 / 4 | 300 / 400 / 600 | |
| Landmark (each) | 25k or less | 4 | Dome and globe at 48x24 segments at most. |
| Far skyline (all bands) | 60k or less in total | 3 merged meshes | No shadows, no normals detail |
| Sky sphere | 2.2k | 1 | 48x24 |

- **Frame totals:** 1.5M visible triangles or fewer in the main pass, and 0.8M or fewer in the shadow pass.

**Draw-call budget (per frame):**

| Pass | Budget | Notes |
|---|---|---|
| Main opaque | 180 or less | Everything repeated must be instanced. Static street dressing is merged per type. |
| Transparent / additive (particles, decals, beams, water) | 40 or less | Particles go into at most 4 pooled `Points` / instanced sprite systems. |
| Shadow pass | 100 or less | Only within ±150 m. Furniture under 1 m wide casts no shadow. |
| Post (bloom about 11, grade 1, copy 1) | 15 or less | Bloom runs at 256x256, as now. |
| **Total** | **335 or less (hard limit 400)** | |

**Materials and shaders:**
- **Unique compiled programs:** 32 or fewer. Facade variants: 2 (`WORLD_UV` on and off). Avoid new `onBeforeCompile` variants; add attributes instead.
- **Material slots:** 1 per mesh, using vertex or instance colour for variety (`setColorAt`), never one material per colour.
- **Shader complexity:**
  - Facade fragment: about 150 ALU or less. No loops, no extra texture fetches, all branching on uniform-ish `vStyle`.
  - Post grade: 3 or fewer texture fetches (aberration only).
  - Sky: analytic, with no raymarching.
- **Overdraw:** about 2.5x or less on average. Particles are capped at 3,000 sprites, each at 64 px screen size or less. Smoke uses at most 120 sprites per column.

**Canvas texture tiers:**

| Tier | Size | Use |
|---|---|---|
| XS | 32–64 | Particles, puffs, icons |
| S | 128 | Hero emblem, decals (scorch, frost, crater) |
| M | 256 | Signs and banners (256x64), far-skyline window grids |
| L | 1024 | Newspaper halftone photo |
| XL | 2048 | City ground plane (roads, crosswalks, markings), 1 only |

- **Texture memory:** 48 MB or less for canvas textures (mipmaps included). Shadow map: 2048² by default (16 MB as RGBA depth); 4096² (64 MB) is the high preset only.
- **Colour space:** canvas textures are authored in sRGB and flagged so `tex(c, true)` decodes them. Never paint linear values into a canvas.

**LOD levels:**
- People: full (under 60 m), no shadow (60–400 m), culled (over 400 m).
- Street furniture: shadow-casting under 80 m, visible under 600 m, culled beyond. Lamps and trees stay to 900 m on avenues.
- Buildings: all plates visible (the city fits inside the fog). Window-light emissive is masked beyond 900 m to stop shimmer.
- Far skyline: a single LOD.

**Art preference versus technical limit (recorded trade-offs):**
1. **Per-building geometric cornices and fire escapes** (reference 6) versus 13,000 destructible plates.
   - Chosen: shader-drawn on plates, with geometric overhangs only on the 4 landmarks. A one-sided extra instanced fire-escape layer for walk-up fronts within 120 m is allowed if it stays under 2 draws.
2. **A 4096 shadow map with crisp long golden shadows** versus the GPU budget.
   - Chosen: 2048 by default, 4096 on the high preset.
3. **Dense traffic and crowds** (references 6, 8, 9) versus physics bodies.
   - Chosen: at most 400 people and 120 cars instanced. The rest of the density comes from parked cars and the far-skyline lights.

## 9. Reference Direction

1. **Marvel's Spider-Man / Spider-Man 2 (Insomniac): aerials and street level** (user references 1, 2, 6, 7)
   - **Take:**
     - the golden-hour haze that grades depth into warm peach
     - the dense skyline running to the horizon
     - rooftop clutter: water tanks, HVAC
     - sidewalk density: walk-ups, fire escapes, awnings, mast-arm signals
     - autumn trees on civic avenues
   - **Avoid:**
     - Manhattan's literal landmarks (no Statue of Liberty, Empire State or Chrysler silhouettes). Use our own: the Daily Planet globe, the copper dome, the gothic tower.
     - the photoreal grime layer
     - Spider-Man's red-and-blue owning the city signage. Our city stays muted so Superman's primaries are unique.
2. **Superman Returns (EA, 2006)** (user references 3, 8, 9)
   - **Take:**
     - stylised setback towers
     - the bay with blue-grey mountains on the horizon
     - wide avenues with zebra crosswalks, as a playable scale for a flying hero
     - the sense that Metropolis is designed for Superman to be seen in
   - **Avoid:**
     - its flat, low-contrast blue-grey grade (ours is warm, high dynamic range)
     - empty, sterile streets
     - towers with no ground-floor life
3. **Unreal Engine fan demos of classic-suit Superman** (user references 4, 5)
   - **Take:**
     - the verdigris dome with gold finials as a colour accent
     - ornate pre-war cornices
     - the avenue closed by a gothic tower, as one-point perspective composition
     - the ledge shot from behind, with the cape blowing, as the signature "hero over city" framing for the idle camera
   - **Avoid:**
     - a darker modern suit or a muted cape: keep `#1c3fb8` / `#b3121a`
     - over-the-top lens flares and heavy film grain (our grain stays at 0.018)
     - asset density that a code-only city cannot match; get the impression of ornament through shader rhythm instead
4. **Art-deco civic illustration and 1940s Fleischer Superman cartoons**
   - **Take:**
     - bold setback silhouettes
     - strong value contrast between sunlit faces and shadow faces
     - optimistic monumentality
     - the Daily Planet globe as the city's crown
     - the idea that the city itself is a character
   - **Avoid:**
     - flat cel shading or outlines (we are PBR)
     - the sepia or retro palette in the world
     - pastiche typography in the HUD (deco is allowed only on the front-page masthead)
5. **Batman: Arkham series, robbery combat only**
   - **Take:**
     - counter telegraphs that read instantly: a single coloured glyph over the attacker's head
     - silhouettes that tell thug types apart
     - the slight vignette and pull-in for combat focus
   - **Avoid:**
     - the night, rain and grime palette
     - grim violence. Superman's combat stays bright, sunlit and restrained: no blood, no bone-crack slow motion, and defeated robbers kneel cuffed rather than lie broken.
