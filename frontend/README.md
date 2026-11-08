# Blast Radius · control-room view

3D floor map of the demo hall (three.js via React Three Fiber) with a dark dashboard shell.

```
cd frontend
npm install
npm run dev        # opens http://localhost:5173
npm run build      # typecheck + production build
```

## Presenting

| Key | Action |
| --- | --- |
| `Space` / `→` / `PageDown` | Next scenario step |
| `←` / `PageUp` | Previous step |
| `P` | Play / pause (one step every ~4 s) |
| `R` | Reset the scenario |
| `Esc` | Close the card, then back to the overview |
| `1` / `2` | Naive scheduler / Blast Radius mode |

Moving around the hall (map-style): drag to pan along the floor, right-drag to rotate, scroll to zoom toward the cursor, `WASD` to move, `Q`/`E` to turn, hold `Shift` to go faster.

Click any rack, node or facility part (CDU, chiller, PDU, UPS, switchgear, utility, leaf, spine) to fly to it and open its card; click empty floor to close the card. Click a decision in the feed to jump to what it's about. Clicking a step in the sidebar jumps straight to it.

## The hall

Rows pair up back-to-back around an enclosed hot aisle (warm glass roof and end doors); cold aisles with perforated tiles run between the pairs. Odd rows face north, even rows face south. Racks stay graphite while healthy: a faint green strip on each face means full backup, and amber or red lids mark racks one failure from an outage or with no working feed. Blue frames mark racks protected by a lease.

## Where things are

| Path | What |
| --- | --- |
| `src/scene/` | three.js scene: hall layout, racks + nodes (instanced), facility parts, aisles and containment, feed arcs, protection frames, camera shots and controls |
| `src/ui/` | HUD panels over the full-screen scene: sidebar, stat tiles, decision feed, detail card |
| `src/store.ts` | App state. The only place data enters the view |
| `src/model/types.ts` | Shapes the view consumes (site, world, events) |
| `src/mock/` | **Mock backend.** Demo hall generator, a stand-in for guard / diagnose / placement, and the scripted "big job failure" scenario |

## Mock vs real backend

The view holds no safety logic: it renders what `src/store.ts` holds. Until the SpacetimeDB backend exists, `src/mock/` computes margins, diagnosis, placement and lease checks and replays DESIGN.md §10.2 in both modes. When the backend lands, replace the scenario player in `store.ts` with a subscription that writes the same `World` and `DecisionEvent` shapes, and delete `src/mock/engine.ts`.

IDs the backend should keep so the scenario lines up: `cdu-3` cools `rack-r1-11`…`rack-r1-15` with `cdu-4` as backup (and `cdu-3` backs nobody); `node-417`…`node-424` live in `rack-r1-12`; `job-train-1` runs on the first 1,000 nodes (Rows 1–8); 160 free spares sit in Rows 9–10.
