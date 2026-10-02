# Performance review (static, pre-playtest 1)

Author: performance-analyst. Method: code reading only, with no profile captured yet. Every millisecond figure is an estimate to confirm with a Chrome Performance capture and a Spector.js GPU frame on the target PC (GTX 1660 / RTX 3060 class, 1080p, 60 fps = 16.6 ms).

Status column: **fixed** means applied before playtest 1, **open** means not yet.

| # | Issue | Where | Est. cost | Fix | Status |
|---|---|---|---|---|---|
| 1 | Hash keys outside V8's small-integer range; per-substep array churn | `hk`, `skey`, `colKey`, `physStep` | 1.5–3 ms + GC | Wrap keys into 30 bits (collisions only add a distance test) | fixed (keys); typed-array grid open |
| 2 | Each car is 11 meshes with its own material, all casting shadows: about 790 draw calls ×2 | `makeCarMesh` | 2–5 ms CPU | Only the body casts shadows; long term, instance cars into 6 InstancedMeshes | shadows fixed; instancing open |
| 3 | Full attribute uploads every frame while anything is hot | `cool`, `setBlockHeat`, `setDebrisHeat` | 0.3–1 ms | Cool at 10 Hz; per-range uploads later | 10 Hz fixed; ranges open |
| 4 | Allocations in per-frame code (fire neighbour arrays, closures, HUD objects) | `updateFires`, `exposedFace`, `staticCollide`, `raycast`, `updateHUD` | GC hitches 1–5 ms | Hoist constants and reuse scratch objects | partly fixed (fires) |
| 5 | Particle buffers walk and upload all 17k slots even when idle | `PSys.update` | 0.4–0.8 ms | Skip when nothing is live | fixed |
| 6 | Collapse spikes: sort and `shift` every frame, 60 breaks per frame | `processFallQueue` | 3–10 ms spikes | Head index, sort only after a push, at most 30 breaks per frame | fixed |
| 7 | Car-ahead check is O(n²) plus a scan of every body | `updateCars` | 0.2–0.5 ms | Lane buckets plus a grid query | open |
| 8 | Raycast scans every building and allocates | `raycast`, `slab`, `rayBuilding` | 0.1–0.3 ms + GC | Scalar slab, caller-owned hit, 2D lot DDA | open |
| 9 | HUD markers rewrite class and text every frame | `markers` | 0.2–1 ms | Write only on change | fixed |
| 10 | GPU: log depth disables early-Z; PCF-soft shadows; DPR up to 2 with 4× MSAA | renderer setup | 2–6 ms GPU | PCF shadows, cap DPR at 1.5, keep skyline out of the shadow pass; altitude-driven near/far instead of log depth later | partly fixed |

## Budgets (proposed; technical director signs off)
- **Draw calls:** at most 150 in the main pass and 60 in the shadow pass (requires car instancing).
- **Instances:** about 35k per frame (city 14k, debris 3.6k, skyline at most 12k, props at most 4k). The shadow pass should stay at or below about 18k: only the city near the player and debris cast shadows.
- **Shadow map:** 2048², PCF, covering ±150 m around the player; snap the shadow camera to texel-sized steps to stop shimmer (open).
- **Particles:** 17k slots, but aim for about 8k live; point size clamped at 200 px (open); emit nothing beyond 600–900 m.
- **Live bodies:** 600 awake debris cap; re-measure after item 1's typed-array grid.

## Verify on the playtest PC
1. A Chrome Performance capture of 30 s: idle flight, one tower collapse, heat vision on a fire. Script it with `__game.step` and `__game.explode`.
2. One Spector.js frame capture, for the real draw-call and shadow-pass counts.
3. Re-rank this list from the measured numbers.
