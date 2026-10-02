# Tuning pass: reward and pressure loop (playtest 1)

Author: game-designer. Status: **adopted** into `js/game.js` before playtest 1. Re-run `/balance-check` after the playtest.
Verdict before the changes: CONCERNS. These were tuning-level problems, not exploits. Two of them were bugs that looked like balance issues: fire deaths depended on frame rate, and the medal ignored people lost.

## Decisions taken
These were open questions for you. I resolved them as the designer recommended; overrule any of them.
- **Sonic boom unlock:** "Bigger sonic boom" punished the player for earning it, because a bigger boom breaks more glass. It is now "Glass-safe sonic boom", unlocked at 10 saves.
- **Medal rules:** gold means no one lost or hurt, at most $0.75M damage, and finishing within 60% of the time limit.
- **Emergency order:** helicopter, meteor, fire, robbery. Each emergency teaches the next power: grab, then heat vision, then freeze breath, then the fight.

## Changes

| Area | Value | Before | After | Why |
|---|---|---|---|---|
| Hope | per person saved | +3 | +2 | The medal, not the headcount, carries the reward |
| Hope | gold / silver / bronze | +8 / +5 / +2 | +10 / +5 / +1 | Clean play is the visible payoff |
| Hope | failed emergency | -6 | -5, plus -3 per person lost | One consistent rule |
| Hope | person lost in a fire | -5 | -3 | Same per-person rule |
| Hope | building collapse | -min(12, fell/25) | -min(8, fell/40) | A whole tower shouldn't cost a quarter of the bar |
| Hope | sonic boom windows | -min(6, n/6) when more than 5 | -min(4, n/8) when more than 8 | It should teach, not fine |
| Hope | robber counter | +1.5 | +2.5 on a counter | Rewards reading the warning flash |
| Hope | cap | none | at most 10 lost within any 5 s | One accident doesn't sink the session |
| Medal | gold | under 50% of the time, 0 hurt, under $1.5M | 0 lost, 0 hurt, no stray shot, $0.75M or less, under 60% of the time | Clean first, fast second |
| Medal | silver | 1 or fewer hurt, under $6M | 0 lost, 1 or fewer hurt, $3M or less | $6M was a wrecked block |
| Medal | damage counted | everything | only what the player caused (fire burn-through excluded) | Fair blame |
| Medal | hospital delivery | +Hope only | also removes 1 from the emergency's injury count | Fixing a mistake can win the medal back |
| Medal | bystander hit by a robber's bullet | lost gold | only counts if the player deflected the bullet | Don't blame the player for the robbers |
| Cadence | first emergency | 14 s | 25 s | Learn to fly first |
| Cadence | gap between emergencies | 10–18 s | 35–50 s | Room to explore |
| Helicopter | time before it falls | 7 s | 10 s | Time to read the alert and turn |
| Helicopter | fall gravity | 1.0 g | 0.6 g (sputtering rotor) | About 17.6 s total window, catchable at cruise speed |
| Meteor | time limit | 60 s (did nothing) | 40 s | Gold needs a stop well before impact |
| Fire | spread per neighbour | 0.035/s | 0.03/s | Fewer runaway fires |
| Fire | freeze put-out rate | 1.5 | 1.2 | A facade takes 4–6 s of steady breath |
| Fire | trapped-person death roll | 0.002 per frame | 0.03 per s | Fixes the frame-rate bug |
| Robbery | warning before a shot | 0.75 s | 1.0 s, at least 0.8 s apart between robbers, flash out to 120 m | Fair to counter |
| Robbery | first aim | 1–3 s | 3–5 s | They shouldn't fire before you arrive |
| Solar | drain / low recharge / high bonus | 0.06 / 0.025 / +0.03 above 1 km | 0.05 / 0.02 / +0.05 above 500 m | "Fly into the sun" works and stays meaningful |
| Flight | boost below 150 m | up to 480 m/s | 300 m/s (Mach 0.88) | The first Shift press no longer breaks windows |
| Unlocks | landing / speed / boom | Hope 65 / 3 resolved / 5 saves | Hope 70 / 4 resolved / 10 saves | First unlock at about 2 min of good play |

## Onboarding tips (each fires once)
1. Start: "W A S D to fly, mouse to aim. Space climbs, C dives."
2. At 8 s, or the first Shift press below 150 m: "Shift to go fast. Climb first: low sonic booms break windows."
3. At 18 s: "Press E to grab a car or person. Press E again to set it down."
4. At the meteor alert, or the first right-click: "Hold right mouse (or R) for heat vision. Sunlight recharges it."
5. At the first injury, the first person carried, or 60 s: "Carry the injured to the hospital pad. It wins back Hope." The hospital marker shows while this tip is on screen.
6. The fire alert names Q (freeze breath). Pressing E near someone trapped explains how to free them.

## Top risks to watch in playtest 1
1. Does the low-altitude boost cap feel like a wall? Watch for frustration at 300 m/s.
2. Can a new player catch the helicopter on the first try?
3. Does gold read as "clean", or do players chase speed anyway?
4. Is 35–50 s between emergencies too quiet for some players?
5. Robbery counters: is 1.0 s readable at speed?
