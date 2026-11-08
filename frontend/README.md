# Squawk · control-room view

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
| `1` / `2` | Naive scheduler / Squawk mode |
| `T` | Put the tech on / off duty: it walks to each failure and repairs it (changes the hall: see below) |

Moving around the hall (map-style): drag to pan along the floor, right-drag to rotate, scroll to zoom toward the cursor, `WASD` to move, `Q`/`E` to turn, hold `Shift` to go faster.

Click any rack, node or facility part (CDU, chiller, PDU, UPS, switchgear, utility, leaf, spine) to fly to it and open its card; click empty floor to close the card. Click a decision in the feed to jump to what it's about. Clicking a step in the sidebar jumps straight to it.

Every panel collapses with its chevron: the sidebar and the decision feed fold into thin rails (the rail keeps play, next and reset), the metrics row and the narration fold away, and the legend has its own toggle. When the free space changes, the camera re-frames the current view unless you have moved it yourself.

## The hall

Rows pair up back-to-back around an enclosed hot aisle (warm glass roof and end doors); cold aisles with perforated tiles run between the pairs. Odd rows face north, even rows face south. Racks stay graphite while healthy: a faint blue strip on each face means full backup, and gold or red lids mark racks one failure from an outage or with no working feed. Racks protected by a lease get an azure lid inside an azure frame, with a lock on the first rack of each run; pale-blue server panels are a safe restart placement.

Close shots keep the subject clear: plain units standing in front of it fade to a ghost, the status arcs fade out near the camera, and floor labels fade wherever they would sit under a panel. Floor labels grow with distance so they stay readable from the overview.

## The crew

Squawk's floor tech is a chunky toy seagull in the spirit of the articulated pocket-pet prints: round body, big head, short orange bill, grey wings with black tips, stubby orange legs and flat webbed feet. It is built in code in `src/scene/Staff.tsx` (one merged geometry per body segment, instanced, matte filament shading) and it waddles: short quick steps, the body rocking over the planted foot, a head bob and a tail wag; in a hot aisle it sweats and flaps. Only gulls doing a repair are on the floor: there is no decorative crew.

Each hot aisle has sliding doors at both ends (`src/scene/Doors.tsx`): two leaves that slide apart along the rack ends when a gull comes near and close again once it has passed.

The hall has walls (`src/scene/Building.tsx`): a low solid base with clear glass above, so they never hide the racks. The way in is on the east side, between the spines: a short hallway with a door at each end, interlocked like a mantrap (`src/scene/airlock.ts`). A door opens only when someone asks for it and only once the other one is fully shut, and it stays open while someone stands in it. A lamp over each door shows red while it is locked, azure while it is open. The second door opens onto a long corridor that runs north-south past the hall to the rest of the site (`TO HALL B`, `TO HALL C`); its walls, floor and light bars fade away at both ends. The tech's office is on its own off that corridor, about ten metres south of the entrance, behind an ordinary door that opens as someone walks up to it.

### The tech

The tech wears an azure hard hat and waits at its desk in the office. Press `T` to put it on duty: it walks up the corridor and comes in through the two doors (waiting in the hallway for the first to shut before the second opens), then walks to the nearest failed or degraded node or part (hardware: a node is worked on from the hot aisle behind its rack, at the rear panel), works on it for a few seconds (pecking away, a ring at its feet filling up, sparks off the part), marks it repaired, then walks to the nearest one left; with nothing left it goes back out through both doors and down the corridor to its desk. `T` again calls it off, even mid-repair.

- **Routes** (`src/scene/nav.ts`): the floor is a grid of 15 cm cells; racks and equipment are obstacles, grown by a gull's half-width, and cells close to equipment cost more, so routes keep to the middle of aisles and only take a hot aisle when that saves a lot. One run of Dijkstra's algorithm from where the gull stands gives the cheapest route to every reachable cell, so "nearest" means nearest on foot (a row of racks is usually in the way) and the route comes from the same run. The cell path is then pulled taut into a few straight legs. The planned route shows as azure dots on the floor, the whole way: from the desk, through both doors, to the repair.
- **Order**: each time, the nearest repair left; that's not always the shortest tour of all of them, but it adapts as failures come and go.
- **Repairs change the hall.** They go through the store's `repair` action: on the mock, `src/mock/repair.ts` sets the part or node back to ok; live, the backend's `set_part_state` / `set_node_state`, which records a row in the decision feed like any other state change. Repairing CDU-3 early changes the story: before the diagnosis, node-417's failure comes out isolated instead of a shared cause; before the cooling agent's request, CDU-4 is still refused (the protection lease) but no longer as the racks' last cooling feed. So put the tech on duty once that request has been refused, or on the diagnostics test bed. Its rounds are in `src/scene/rounds.ts`, tested with the planner and the doors in `../spacetimedb/test/view-tech.test.ts`. The hall and the office side (the corridor and the office) are separate floor grids; the doors are the only way between them, and once the tech starts through it finishes going through before it changes plans. If the view rebuilds the tech (live mode's first sync, or a reset that reseeds the hall) it works out which side of the doors the gull is on, so a gull caught out in the hall walks home the legal way.

### Software fixes

Software fixes have no one to walk to: while the Nemotron fixer agent works on one, a popup over what it is about (the node's rack, the part, the racks of a job or lease) shows its plan, each step as it happens and how it ended (`src/scene/FixerPopups.tsx`, grouped in `src/scene/fixes.ts`, tested in `../spacetimedb/test/view-fixes.test.ts`). They are the fixer's own rows in the decision feed (`agent_plan`, `agent_step`, `agent`, `notified`, `escalated`); `tech_dispatched` is hardware and left to the tech. A finished fix stays up for about 7 s. Rows that were already in the feed when the view connected don't pop up.

Every server panel carries two tiny LEDs at its right-hand end, a steady power light and an activity light that blinks in its own rhythm. Job nodes blink most, spares hardly at all, failed nodes go dark. They are a twinkle in close-ups and invisible from the overview.

## Design system

NMC² palette: black surfaces, azure `#2b9cfc` for the product acting (selection, protection, primary action), pale blue `#c0d1f1` for safe placements, sand gold `#ddb67c` for reduced backup, and red only for failures. Healthy states stay neutral, and red is only for what has failed: a denied request shows in azure (the interlock doing its job) and the shared-cause lines are gold. Type is Roboto (loaded from Google Fonts, with bundled Inter as the offline fallback) at weights 300, 400 and 500, on a 11 / 12 / 13 / 17 / 20 / 28 px scale. Surfaces are square and flush to the screen edges; only controls get a 2 px radius. The only gradients are the two scrims that keep text legible over the 3D scene.

## Where things are

| Path | What |
| --- | --- |
| `src/scene/` | three.js scene: hall layout, racks + nodes (instanced), facility parts, aisles and containment, feed arcs, protection frames, camera shots and controls, the gull model (`Staff.tsx`), the tech (`Tech.tsx`, its rounds in `rounds.ts`, routes in `nav.ts`), the fixer's popups (`FixerPopups.tsx`) |
| `src/ui/` | HUD panels over the full-screen scene: sidebar, stat tiles, decision feed, detail card |
| `src/store.ts` | App state. The only place data enters the view |
| `src/model/types.ts` | Shapes the view consumes (site, world, events) |
| `src/live/` | **Live mode.** Connection to the SpacetimeDB backend (`connection.ts`) and the row → `Site`/`World` mapping (`mapping.ts`) |
| `src/module_bindings/` | Generated by `npm run bindings` from `../spacetimedb`. A placeholder until then |
| `src/mock/` | **Mock backend.** Demo hall generator, a stand-in for guard / diagnose / placement, the scripted "big job failure" scenario, and the step lists of the backend-only scenarios |

## Live mode (SpacetimeDB)

The view holds no safety logic: it renders what `src/store.ts` holds. By default `src/mock/` fills it, as before. In live mode the SpacetimeDB backend in `../spacetimedb` does: the view subscribes to its tables, and Space, `R`, `1`/`2` and step clicks call the backend's scenario reducers (`scenario_next`, `scenario_start`, `scenario_goto`) instead of the mock. The tech's repairs call `set_part_state` / `set_node_state` (the control room is a shift lead, which may).

From the repo root, `bash dev.sh up` does all of this (with `bash dev.sh server` running in another terminal). By hand:

```
# once: backend running and published (see ../spacetimedb/README.md)
cd frontend
npm install                 # adds the spacetimedb SDK
npm run bindings            # spacetime generate -> src/module_bindings (rerun when tables change)
cp .env.example .env.local  # VITE_SPACETIMEDB_URI=http://localhost:3000, VITE_SPACETIMEDB_DB=squawk
npm run dev
```

On first connect the browser gets its own SpacetimeDB identity (kept in localStorage) and registers itself as a shift lead, which is what the presenter controls need. A fresh database shows the diagnostics test bed (five incidents for testing agents); press Space to run the demo scenario from a clean hall, or `R` for a clean hall in the current mode. Delete `.env.local` (or empty `VITE_SPACETIMEDB_URI`) to go back to the mock.

The sidebar's **Scenario** picker chooses what Space plays: *Big job failure* (with the Naive / Squawk scheduler toggle), *Software updates* or *Maintenance window*. The last two run on the backend only (the mock doesn't model software work scopes), so they are greyed out ("Live only") on the mock. What they show is in `../spacetimedb/README.md`, "Operations scenarios"; `../spacetimedb/test/runner.test.ts` keeps their step lists here in step with the backend's.

`spacetimedb/test/frontend-contract.test.ts` runs every scenario step on the backend, maps the rows with `src/live/mapping.ts`, and checks the result against `src/mock`, so the two stay in step. If you change the mock scenario or the types, run `npm test` in `../spacetimedb`.

IDs the backend keeps so the scenario lines up: `cdu-3` cools `rack-r1-11`…`rack-r1-15` with `cdu-4` as backup (and `cdu-3` backs nobody); `node-417`…`node-424` live in `rack-r1-12`; `job-train-1` runs on the first 1,000 nodes (Rows 1–8); 160 free spares sit in Rows 9–10.
