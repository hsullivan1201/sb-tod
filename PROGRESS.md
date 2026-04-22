# SB TOD — Progress

Lab notebook. Each session adds an entry at the top. The orientation
section below should be enough for a fresh dev to pick up cold without
reading the session log; the log is the audit trail.

---

## Orientation (read this first if you're new)

### What this mod is
A Transit-Oriented Development dashboard for Subway Builder. Reads live
station + demand data, scores every station group on five axes, and
visualizes the top-N for each axis with a click-to-pin-walkshed map
overlay. Stage 2 (not yet built) will close the feedback loop by
mutating `DemandPoint.jobs` / `.residents` based on station performance
and explicit "developer deals."

### What ships today (Stage 1, complete)
- Toolbar panel (`Building2` icon → "TOD") that opens a side panel.
- Five sections: Top Residential TOD, Top Commercial TOD, Top Captured
  Value, Top TOD Risk, plus header counts (stations / demand points /
  pops / 15-min ridership total).
- Click any row → pins a translucent 500m walkshed disc on the live
  map and eases the camera to it. Click again or "Clear pin" to remove.
- Auto-calibrated per-map scoring (footer shows the live scales).
- Debug DL button → downloads a self-describing JSON snapshot (counts,
  calibration, top rows, deep shape probes of the API surface).

### Tech stack and commands
- TypeScript strict, vite (rolldown-vite fork), pnpm, vitest.
- `pnpm build` — emits `dist/index.js` (the file the game loads).
- `pnpm test` — vitest, currently 24/24 passing.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm dev` — `vite build --watch` + the game runner script.
- Mod loads from `~/Library/Application Support/metro-maker4/mods/sb-tod/`.
  Manifest: `id: dev.hazel.sb-tod`, `main: dist/index.js`.

### File map
```
src/
  main.ts                  entry — registers toolbar panel + map highlight
  api.ts                   typed wrapper over window.SubwayBuilderAPI
  types.ts                 LngLat brand, ModeBreakdown, StationGroup, deltas
  types/                   bundled .d.ts from the template (don't edit)
  scoring/
    walkshed.ts            pure: haversine + linear decay → WalkshedHits
    todScore.ts            pure: scoreStation, scoreAccess
    index.ts               only file in scoring/ that touches the API.
                           Joins live data → ScoredStation[] + auto-cal.
    *.test.ts              vitest, pure-function coverage
  ui/
    HelloTodPanel.tsx      the dashboard
    mapHighlight.ts        geojson source + 2 layers + circlePolygon
```

Design invariant: anything in `scoring/` other than `index.ts` must stay
pure and unit-tested. The orchestrator is the seam.

### The five scores in one paragraph
For each station group we compute a 500m walkshed (distance-weighted
haversine, linear decay). From the walkshed totals plus the station's
ridership, we derive: **potential** = `ridershipSignal × headroom` (good
place to add density), **risk** = `densityPressure × (1 − capture)`
(dense area, station capturing badly), **capturedValue** =
`densityPressure × capture` (dense area, station capturing well).
Separately, **residential** = `transit-using-residents-signal ×
residentHeadroom` and **commercial** = `transit-using-workers-signal ×
jobHeadroom`. Risk + capturedValue ≤ densityPressure (partition
invariant — see `todScore.test.ts`). All scales are auto-calibrated per
map from percentiles of the live distribution; see `resolveCalibration`
in `scoring/index.ts`. **Scores are per-map rankings, not absolute** —
0.7 on SF means something different from 0.7 on Phoenix. The footer
makes this explicit.

### Auto-calibration knobs
Set in `resolveCalibration` (scoring/index.ts):
- `ridershipScale = p75(ridership)` — bounded transform scale
- `supplySaturation = p95(jobs+residents)` — density pressure ceiling
- `residentSaturation = p95(residents)` — residential headroom ceiling
- `jobSaturation = p95(jobs)` — commercial headroom ceiling
- `residentTransitScale = p75(residentTransit)` — residential signal scale
- `workerTransitScale = p75(workerTransit)` — commercial signal scale

p75 for "scale" thresholds, p95 for "saturation" thresholds. Saturation
was p90 originally; bumped to p95 in session 4 because residential
scores ceiling-capped at ~0.33 on SF — most residential walksheds sat
near p90, crushing headroom for the moderate-density places that are
exactly the upzoning targets. p95 keeps "rare ultra-dense walksheds =
no room" while restoring meaningful headroom elsewhere.

### Gotchas (will bite you)
1. **No DevTools in the game.** Use the Debug DL button: it dumps a
   JSON snapshot including deep shape probes of any API we're not
   sure of. Add probes to `probeStationGroups` or `probeDemandShape`
   in `HelloTodPanel.tsx` when you need to confirm shapes. Open the
   downloaded file in your editor.
2. **Bundled `.d.ts` is stale.** Several runtime methods/fields aren't
   in `src/types/`: `getStationGroups`, `getTransferStationIds`,
   `getSiblingStationIds`, `popsMap`. We cast through `any` in `api.ts`
   at the wrapper boundary. If you hit a 5th instance, consider a
   "type reconciliation" pass (validate live shape at startup).
3. **JSX runtime bug in the template.** The shipped `src/types/react.ts`
   binds `jsx` and `jsxs` directly to `React.createElement`, which has
   a different signature (children as rest args vs `props.children`).
   Symptom was data rows rendering as bare UUIDs because `key` was
   overwriting `children`. We patched it locally with a `jsxAdapter`.
   Worth opening an upstream issue against
   `Subway-Builder-Modded/template-mod`.
4. **`location` is `[lng, lat]`**, not `[lat, lng]`. Use the `LngLat`
   brand from `types.ts` to keep it straight.
5. **`getDemandData().points` is a Map**, not an array. So is `popsMap`.
6. **`onDemandChange` fires ~49× per game day.** Use it for diagnostics
   only. TOD logic must run on `onDayChange`. Stage 2 will need a
   reentrancy guard (a `WeakSet` tagging our own writes) to avoid loops
   when our mutations trigger the event.
7. **`utils.getMap()` returns the live MapLibre instance.** Not under
   `map.*` despite the namespace name. We use it for `getSource().setData()`
   and `easeTo()` — the modding API itself has no source-update path.
8. **Mode-share fields are RAW COUNTS not ratios.** `residentModeShare`
   and `workerModeShare` are `{ walking, driving, transit, unknown }`
   counts that sum to `residents` / `jobs`. See `readModeBreakdown` in
   `types.ts`. Caveat baked into walkshed.ts: `residentModeShare.transit`
   is "residents here whose ASSIGNED jobs are transit-reachable" — a fit
   metric for the current commute pattern, not generic accessibility.
9. **Station ridership can throw or return undefined** for unbuilt or
   no-traffic stations. Always wrap `getStationRidership(id)` in try/catch
   and treat missing as 0.

### Stage 2 status (in progress)
Mutator (session 5) + mod-state with persistence + game-hook wiring +
in-panel debug poke UI (session 6) all landed. End-to-end testable:
pin a station, click "Stage 2 debug · mutator", poke residents/jobs,
save the game, reload, see whether the mutation persisted, replayed,
or got dropped as a baseline shift. No deal data model yet — that's
the next slice.

**The single most important design decision for stage 2 is 1a in
ARCHITECTURE.md**: DemandPoint.jobs/residents are aggregates, but the
sim iterates Pops. Mutating the point alone is cosmetic; we must *also*
rescale the relevant Pops. The mutator does this via proportional Pop
scaling anchored on captured baselines (so reversal is bit-exact).
Ghost-town points (zero baseline in a dimension) are rejected — we
can't bootstrap density where no pops originate.

### Quick references
- `HANDOFF.md`, `probe-1-findings.md`, `probe-2-findings.md` —
  upstream context
- `ARCHITECTURE.md` — design decisions and "do not do this" list
- Subway Builder modding API docs: https://www.subwaybuilder.com/docs/v1.0.0
- Template repo: https://github.com/Subway-Builder-Modded/template-mod
- Reference mod (analytics + storage + UI patterns):
  https://github.com/stefanorigano/advanced_analytics

---

## Session 6 — 2026-04-22 — Stage 2 mod-state, hook wiring, debug poke UI

### Built
- **`src/state/mod-state.ts`** — the singleton holding the mutator + everything that has to survive across save/load. In-memory is the source of truth (probe 1 found storage round-trips occasionally fail); `api.storage` is persistence, not state. Serializes baselines + cumulative deltas as `PersistedState v1` (Maps → Arrays of tuples for JSON safety). `ensureInit()` is async and idempotent — first call hydrates, subsequent calls return the existing init promise.
- **Per-point load reconciliation** — Decision 2 says we don't know whether the game preserves our writes through save/load (open question #4). Rather than guess globally, we check each persisted point: if live ≈ baseline + cumulative delta, the game preserved → just rehydrate tracking; if live ≈ baseline, game reset → replay deltas via the mutator (rescales pops); if neither, baseline shift → drop the stale delta and rebaseline to live. Approx tolerance 1.0 to swallow JSON float round-trip. Reported per-session as `lastHydrate.{preserved,replayed,baselineShift,missingPoint}` for visibility.
- **Hook wiring in `main.ts`**: `onDayChange` calls `state.onDayTick(day)` (which lazily inits if needed and persists if dirty); `onDemandChange` increments a counter only (per ARCHITECTURE decision 4 — never mutate from this handler, ~49× per game day means a feedback loop hazard); `onGameSaved` flushes pending state; `onGameLoaded` resets and re-inits to pick up the new save's demand.
- **`hydrateTracking()` on the mutator** — seeds baseline + delta maps without applying any mutation. Needed for the "preserved" load path so we don't double-mutate already-mutated game state.
- **Debug poke UI in `HelloTodPanel`** — collapsible "Stage 2 debug · mutator" section. Pin a station → buttons +/-100 res, +/-100 jobs target the heaviest-weighted DemandPoint in that walkshed for the chosen dimension. Reports affected pop count, cumulative delta, ghost-town rejections, etc. Plus "Persist now" / "Revert all" / live stats (initialized, day, ticks, baselines, demandChange events, last hydrate report). This is the first thing in the mod that actually CALLS the mutator at runtime.
- **`api.ts` made lazy** — `getRaw()` defers the `window.SubwayBuilderAPI` lookup so test environments (no `window`) can import `mod-state` without erroring at module evaluation. Added `storage` namespace to the wrapper. Fixed `onDemandChange` signature to accept `popCount: number` per the actual game API.
- **`src/state/mod-state.test.ts`** — 12 vitest cases: fresh init, persist roundtrip with replay, preserved-case detection (no double-application), baseline-shift drop + rebaseline, new-point capture, JSON-roundtrip safety, day-tick persistence cadence, dirty-tracking, no-mutation-from-onDemandChange invariant, no-persist-on-failed-mutation. **57/57 tests passing total** (24 stage 1 + 21 mutator + 12 mod-state). Typecheck clean. Bundle 53.16 kB.

### API edge cases discovered
- **`window.SubwayBuilderAPI` lookup at module-eval was a test blocker.** The original `api.ts` threw at import time if the global was missing, which broke vitest the moment a test file transitively imported `api.ts`. Made the lookup lazy — first wrapper-method call is what enforces presence. `apiVersion` falls back to `'unset'` in test env.
- **`onDemandChange` callback signature was wrong** in the wrapper (`() => void`) — actual game passes `popCount: number`. Fixed.
- **`getDemandData()` is typed `DemandData | null`** in the bundled API; the wrapper hides the null for ergonomics, and consumers do their own defensive null check (mod-state.doInit and the panel both do).
- No new instances of stale-bundled-`.d.ts` this session (still 4 total).

### Blocked / uncertain
- **Don't yet know** which save/load case the game actually does (preserved vs reset). The reconciliation logic handles both; load it in-game and the debug panel's `lastHydrate` line will report which path fired. **This is the biggest thing to verify in-game next.**
- **Pop sizes through save/load** — same uncertainty. If pops are preserved but DemandPoint aggregates are reset (or vice versa), the per-point preserved/reset detection could disagree with the per-pop reality. We treat the per-DemandPoint check as authoritative for now; if we see weird in-game results, add a per-pop sanity check.
- **Mode-share fields and TOD scoring don't yet recompute after a mutation** — the scoring functions read `residentModeShare.transit` etc. as-is. After a Pop is rescaled, the underlying mode-share doesn't auto-update on the DemandPoint (those fields are aggregates the game maintains, not derived live). Probably fine for v1 since the proportional scaling assumption is "new residents look like existing" — mode share at the point is unchanged in proportion. Worth confirming in-game whether `residentModeShare` updates after a mutation, or stays frozen at city-load values.
- **`utils` is now a Proxy** so it stays lazy and typed-`any` — the existing usage site (`utils.components.Button`) continues to work but TS won't catch typos. Fine for now.

### Next session
1. **Verify the load-replay path in-game.** Smoke procedure: load a save, pin a station, poke +500 residents three times, click Persist Now, save the game, restart the app, load the save, open the panel → `lastHydrate` should say `preserved 1` or `replayed 1` (and we'll know which case the game actually does). Also confirm the affected DemandPoint's residents and the rescaled pop sizes look right.
2. **`src/sim/deals.ts`** — deal data model + lifecycle (housing / commercial / mixed; proposed → active → completed → cancelled). Daily delta distribution across walkshed points weighted by distance decay. Validity check (ghost-town rejection at proposal time, not just on apply). All deltas go through `state.applyDensityDelta` so the state-tracking + persistence wiring just works.
3. **Deals tab UI** + propose-deal modal — only after the data model is in.
4. **Optional**: a "what-if" preview mode that applies a deal in a SHADOW mutator (separate from the live one) so the player can see projected ridership impact before committing money. Stretch.

### Followups (carried forward)
- Upstream JSX runtime bug — still open.
- Stale bundled `.d.ts` types — hit count still 4.
- Visual differentiation of pin color (residential / commercial / risk) — deferred.
- Approach B "slow transit" filter — deferred.
- In-both-lists live-work badge — deferred.
- Verify `residentModeShare` / `workerModeShare` update after a Pop-scaling mutation, or stay frozen at city-load values.

---

## Session 5 — 2026-04-22 — Stage 2 mutator primitive

### Built
- **`src/sim/mutate.ts`** — the `DemandMutator`, the single seam through which all TOD writes touch demand state. Implements ARCHITECTURE decision 1a: proportional Pop scaling, baseline-anchored. `applyDensityDelta(pointId, {jobs?, residents?}, source)` updates the point's aggregate fields AND rescales every pop whose `residenceId` or `jobId` is at that point, as `pop.size = pop.baselineSize × residenceRatio × jobRatio`. Ratios recomputed per call from captured baselines and cumulative deltas. No compound drift.
- **Separate delta buckets** (`fromDeals` / `fromOrganic`) per point per dimension, matching the `PointDelta` type already in `types.ts`. Enables attribution in the eventual dashboard.
- **Ghost-town guard**: positive residents delta rejected if baseline.residents ≤ threshold; same for jobs. Mixed deltas are atomic — if either dimension's guard fails, neither is applied. Configurable threshold (default 0).
- **Negative-result floor**: a delta that would drive a count below 0 (configurable) is rejected wholesale and the cumulative bucket rolled back. No silent clamping.
- **Reentrancy guard** via `WeakSet<DemandPoint>` of tagged writes; `isTaggedWrite(point)` tells the (future) `onDemandChange` handler to ignore self-emissions, blocking the feedback-loop scenario.
- **`captureBaselines()` / `revertAll()` / `snapshot()`** — lifecycle hooks for first-day baseline capture, full rollback, and serialization. No live callers yet.
- **`src/sim/mutate.test.ts`** — 21 new vitest cases covering the four required scenarios from the prompt (proportional scaling, reversal exactness, baseline anchoring, ghost-town rejection) plus surface checks. 45/45 tests passing overall (24 from stage 1 preserved).

### API edge cases discovered
None new this session. Mutator is pure-function-plus-Map-mutation over the `DemandData` shape already confirmed in probe-2; no API surface was exercised beyond reading/writing `DemandPoint.jobs`, `DemandPoint.residents`, and `Pop.size`.

### Blocked / uncertain
- **No runtime caller yet.** The mutator is a module plus tests. Nothing in `main.ts` or the UI invokes it. This is intentional — decision 3 says build it in isolation, then wire.
- **Save/load behavior still unknown** (open question #4 from probe-2). The delta-not-absolute design in decision 2 is specifically defensive against this. Next session's mod-state module needs to persist deltas + baselines via `api.storage` and replay on `onGameLoaded`. This is where the storage-unreliability gotcha from probe 1 will matter.
- **Performance on large maps.** Each mutation does a linear scan of `popsMap` looking for pops linked to the point. On a map with 100k pops and ~20 mutations per game day that's 2M pop-touches/day. Probably fine; if not, build a reverse index at baseline-capture time.

### Next session
1. **`src/state/mod-state.ts`** — in-memory mod state keyed off baseline-capture on first `onDayChange` (or first-day-ready hook). Persists snapshot to `api.storage` on `onGameSaved` and on day checkpoints. Replays deltas from storage on `onGameLoaded` by calling `mutator.captureBaselines()` then reapplying cumulative deltas via `applyDensityDelta`. In-memory is source of truth per gotcha #4 in the orientation.
2. **A debug "poke density" button** in the existing Hello-TOD panel for manual in-game testing before we ship deals. One click applies a small residents delta to a chosen station's walkshed, prints a summary, and lets the user verify via the panel that ridership at that station's nearest stop responds over the next N game days. This is the fastest end-to-end smoke test of the mutator in-sim.
3. **`src/sim/deals.ts`** deal data model (housing / commercial / mixed; lifecycle states; daily delta distribution across walkshed points) — only after the mutator is confirmed to work end-to-end in-game.

### Followups (carried forward)
- **Upstream JSX runtime bug** — still open.
- **Stale bundled `.d.ts` types** — hit count still 4.
- **Visual differentiation of pin color** (residential / commercial / risk) — deferred.
- **Approach B "slow transit" filter** — deferred.
- **In-both-lists live-work badge** — deferred.

---

## Session 4 — 2026-04-22 — Captured value, calibration fix, risk filter

### Built
- **`capturedValue` score** added to `StationScore` — `densityPressure × capture`. Partitions the "stuff happens at dense walksheds" signal with risk: `capturedValue + risk ≤ densityPressure` (asserted by a new vitest invariant). Exposed as a new "Top captured value" panel section directly above "Top TOD risk."
- **Saturation calibration p90 → p95** for `residentSaturation`, `jobSaturation`, `supplySaturation`. Residential scores were ceiling-capped at ~0.33 on SF because most residential walksheds sat close to p90; p95 restores headroom for moderate-density walksheds (the actual upzoning targets). Commercial scores improved too. Comment in `resolveCalibration` documents the why so the next dev doesn't revert it.
- **Risk false-positive filter**: stations with `ridership === 0` are excluded from the risk list. These are almost always brand-new builds or stations not yet on a route — not "land use is failing the station" stories. The panel shows a small italic line "N stations excluded (no recorded ridership — likely new or disconnected)" so the filter is transparent and the methodology stays auditable.
- **`Section` component** extended with optional `footnote` and a `'capturedValue'` metric variant. Bundle `panel-v9-captured-and-calibration`, 31.15 kB. 24/24 vitest tests passing, typecheck clean.

### API edge cases discovered
None new this session. Stale-types hit count still 4 (no new instances).

### Blocked / uncertain
- **Visual differentiation of pin color** (residential blue vs commercial orange vs risk red?) was deferred from session 3. Still open. Low priority.
- **Sort toggles within sections** (sort by transit count vs total vs score) would help expert users but adds UI complexity. Punted.

### Next session
1. **Approach B teaser**: surface `Pop.lastCommute.duration` as a "slow transit" filter. A walkshed where transit works but takes 60 min is a worse TOD target than one where it takes 20. Probe was already done in session 2 (see Debug DL `samplePopsFromResidentsHeavy`); implementation pending.
2. **Stage 2 baseline + deltas**: when the user is ready to re-architect. Snapshot baseline densities on first day, persist deltas via `api.storage`, replay on `onGameLoaded`. Reference mutation pattern from `probe-2-findings.md` (Scenario A, confirmed). The mutator MUST tag its writes in a `WeakSet` so `onDemandChange` handlers can ignore self-triggered events.
3. **In-both-lists badge**: 24 St shows up in both top-5 residential AND top-5 commercial on the SF map. Worth a small "live-work candidate" marker. Defer until somebody asks.

### Followups (not blocking, carried forward)
- **Upstream JSX runtime bug**: still want to file an issue against `Subway-Builder-Modded/template-mod`. Every mod using the template has this latent.
- **Stale bundled `.d.ts` types**: 4 instances tracked. Build a "type reconciliation" pass at startup if/when we hit 7.
- **Per-map score meaning**: footer surfaces the calibration; verify the disclaimer reads cleanly on a non-SF map (NYC, Phoenix) when one becomes available.
- **Walkshed disc styling per axis** (deferred from session 3).

---

## Session 3 — 2026-04-22 — Map highlight on row click

### Built
- **Map walkshed pin**: clicking any row in the panel (residential / commercial / risk) draws a translucent 500m disc at the group center on the live MapLibre map, eases the camera to it, and outlines the boundary. Clicking the same row again, or the new "Clear pin" button, removes it.
- `src/ui/mapHighlight.ts`: registers one geojson source (`sb-tod-highlight`) with two layers — translucent amber fill (`#fbbf24` @ 0.18) + amber outline. Updates the source via the live MapLibre instance from `utils.getMap()` rather than re-registering. Polygon approximation is 64 vertices using local meters-per-degree (accurate to <1m at 500m city-scale).
- `ScoredStation` now carries `center: LngLat` so the panel can pin without re-querying the group registry.
- `ClickableRow` shared component for the three list flavors — hover background, amber bar + tint when highlighted, accessible title tooltip.
- `api.ts`: added `map.registerSource` / `map.registerLayer` and `getMap()` wrapper. Bundle now 29.83 kB (panel-v8-map-highlight). 22/22 vitest tests still passing, typecheck clean.

### API edge cases discovered
- `utils.getMap()` returns the raw MapLibre instance (`maplibregl.Map`) — `getSource()` / `easeTo()` / `getZoom()` are all available directly. The bundled types put it under `utils` not `map`, which is non-obvious from the namespace name.
- `map.registerSource` accepts inline geojson via `{ type: 'geojson', data: {...} }`. Updating `data` later requires going through MapLibre's `getSource(id).setData(...)` — the modding API has no update path.

### Next session
1. **Stage 2 baseline + deltas** — snapshot baseline densities on first day, persist deltas via `api.storage`, replay on `onGameLoaded`. The persistence path that lives or dies on correctness.
2. **Approach B teaser** — surface `Pop.lastCommute.duration` as a "slow transit" filter to flag walksheds where transit works but takes 60 min.
3. **Walkshed disc styling** — consider differentiating residential (blue?) vs commercial (orange?) highlights so the pinned color hints at why the row was interesting. Low priority.

---

## Session 2 — 2026-04-22 — Stage 1 scoring + station groups

### Built
- **Walkshed + TOD scoring** as pure functions under `src/scoring/`. Walkshed uses haversine + linear distance decay (defended in code comments — it's the easiest decay to explain to a non-technical reader and avoids over-weighting the immediate cluster around the entrance). 14 vitest tests, all passing.
- **`scoreAllStationsDetailed`** orchestrator joins live stations + demand + ridership and returns ranked rows.
- **Auto-calibration**: `ridershipScale` defaults to p75 of nonzero ridership, `supplySaturation` to p90 of nonzero walkshed supply. Scores spread across [0,1] on a per-map basis instead of pinning at the asymptote. Footer of the panel shows the live values + source (`auto` / `option` / `default`) so the methodology is auditable.
- **Station-group scoring**: orchestrator now operates on `getStationGroups()` instead of raw stations. One walkshed per group (using `group.center`), ridership summed across member platforms. 349 stations collapse into 294 groups; multi-platform transfers no longer appear as 4 near-duplicate rows. Panel marks transfers with `⇄N`.
- **Hello-TOD panel** evolved into a working dashboard: counts, top 5 by potential, top 5 by risk, transfer markers, calibration footer, Debug DL.
- **Debug DL** dumps a self-describing snapshot (counts, calibration, top rows, plus a probe of `getStationGroups`/`getTransferStationIds`/`getSiblingStationIds` with type/length/sample data). This is the workaround for not having browser DevTools — single-button JSON export.

### API edge cases discovered
- **JSX runtime bug in the template's `src/types/react.ts`** — original had `export const jsx = React.createElement` and `export const jsxs = React.createElement`. Signatures don't match: `jsx(type, props, key)` puts children in `props.children`, but `createElement(type, props, ...children)` reads them as rest args. Symptom: any element built with the automatic JSX runtime where a `key` was passed had its `children` overwritten by the key. Manifested as data rows rendering as bare UUIDs. Fixed with a `jsxAdapter` that calls `createElement(type, props)` only, leaving `props.children` untouched.
- **`getStationGroups()` returns `Array<{ id, name, stationIds, center: [lng,lat], bounds }>`** with proper human-readable names. 294 groups for 349 stations on the SF map. `manualAdditions` and `manualRemovals` are `undefined` when the player hasn't customized grouping.
- **`getTransferStationIds()` returns a flat `string[]`** of station IDs that participate in transfer relationships (99 on the SF map). `getSiblingStationIds(id)` returns `[]` for non-transfer stations.
- **Bundled `.d.ts` types are stale** — `getStationGroups`, `getTransferStationIds`, `getSiblingStationIds`, `popsMap` all exist at runtime but aren't in `src/types/game-state.d.ts`. We cast through `any` at the API boundary in `src/api.ts` and validate the shape via Debug DL before depending on it.
- **`StationRidership.total`** is the field we sum across siblings. `getStationRidership(id)` can throw or return `undefined` for stations with no recorded riders — wrapped in try/catch returning 0.
- Auto-calibration footer suggests sane defaults emerge from the live data: SF map ran with `ridershipScale ≈ 13k riders` and `supplySaturation ≈ 7k`. The hardcoded defaults (500 riders / 30k supply) were way off.

### Blocked / uncertain
- **Job access is not yet in the score.** Current scoring treats jobs and residents as fungible "supply." Real TOD is about whether residents can *reach* jobs via transit. Three approaches sketched (mode-share aggregate, pop-pair routing via `lastCommute`, network gravity model). Recommendation is to start with mode-share and use Pop's `lastCommute` for the principled version after probing its shape.
- **`residentModeShare` / `workerModeShare` shapes** still un-probed. Probe-2 noted "Shape TBD." We need a quick Debug DL extension to dump one of these per station before we use them.
- **Auto-calibration p-thresholds are guesses** (p75 ridership, p90 supply). They produce sensible-looking output on SF but should be tuned once we have a sense of how scores look on a different map (NYC, etc.).

### Next session
1. **Probe `residentModeShare` / `workerModeShare` + `Pop.lastCommute` shapes** — Debug DL `panel-v6-modeshare-probe` already extended to dump full deep shape for: first DemandPoint, residents-heaviest point, jobs-heaviest point, and the first 3 Pops attached to the residents-heavy point. One round trip.
2. **Two-score split, not one combined access score**:
   - `Residential TOD` ≈ `residents × residentModeShare.transit` (interpretation: "residents here use transit" — fit between this point's commute pattern and the network, NOT generic accessibility. Worth flagging in a code comment.)
   - `Commercial TOD` ≈ `jobs × workerModeShare.transit` (interpretation: "workers arrive here by transit" — proxy assumes new workers behave like existing; breaks down for massive upzoning.)
   - Combined column = `max(residential, commercial)` with a sort toggle for the other.
   - Don't average them; that loses the "upzone housing here" vs "upzone offices here" distinction that deals will care about.
3. **Map highlight on row click** — `api.map.registerLayer` draws the 500m walkshed circle at `group.center`. Probably the single most addictive feature; treat as high priority.
4. **`Pop.lastCommute.duration`** as a "slow transit" filter (Approach B teaser). A walkshed where transit works but takes 60 minutes is a worse TOD target than one where it takes 20. Flag those as a separate signal once the per-pop data is in.
5. State persistence (panel sort/filter via `api.storage`) is fine to punt. The actual TOD state — Stage 2's baseline snapshot + deltas + `onGameLoaded` replay — is the persistence path that lives or dies on correctness.

### Followups (not blocking)
- **Upstream JSX runtime bug**: open an issue against [`Subway-Builder-Modded/template-mod`](https://github.com/Subway-Builder-Modded/template-mod) describing the `jsx = React.createElement` signature mismatch. Every TS-template-using mod has this latent — patches saving the next dev several hours.
- **Stale bundled `.d.ts` types**: keep tracking instances. Hit count so far: `getStationGroups` / `getTransferStationIds` / `getSiblingStationIds` / `popsMap` (4 fields). If we hit 3 more we should build a "type reconciliation" pass — probe live API at startup, regenerate types from observed shape, fail loudly when surface drifts.
- **Per-map score meaning**: auto-calibration means "0.8 potential" on SF means something different from "0.8 potential" on Phoenix. Footer now reads "scores ranked relative to this map" to make that explicit. A genuinely cross-map "absolute TOD potential" score is a different (harder) problem; do not conflate.

---

## Session 1 — 2026-04-22 — Stage 0 scaffolding

### Built
- Cloned `Subway-Builder-Modded/template-mod` into `mods/sb-tod/`.
- Manifest: `id: dev.hazel.sb-tod`, `author: { name: "hazel" }`, `main: dist/index.js`, `version: 0.1.0`.
- `src/types.ts` — re-exports the template's bundled `DemandPoint`/`Pop`/`DemandData`/`ModeChoiceStats` types and adds a `LngLat` brand + `BaselineDensity` / `PointDelta` for the upcoming delta tracking. The template's `Coordinate` is already `[longitude, latitude]`, matching probe-2.
- `src/api.ts` — typed wrapper over `window.SubwayBuilderAPI`. Only exposes the surface we use today (`gameState`, `hooks`, `ui`, `utils`). Future stages extend here.
- `src/ui/HelloTodPanel.tsx` — minimal panel showing station count, demand point count, pop count, plus a Refresh button. Uses `api.utils.components.Button` per the template pattern.
- `src/main.ts` — registers a single `addToolbarPanel` (combined toolbar entry + panel) inside `onMapReady`, double-init guarded.
- `pnpm install` + `pnpm build` clean. `pnpm typecheck` clean.

### API edge cases discovered
- `addToolbarButton` requires `tooltip` and `icon`, NOT `label`. The HANDOFF said "label" but the actual `UIToolbarButtonOptions` shape (in the template's bundled `src/types/ui.d.ts`) wants `{ id, icon, tooltip, onClick, isActive? }`. Switched to `addToolbarPanel` instead — it's a combined toolbar entry + panel, simpler than wiring `addToolbarButton` + `addFloatingPanel` separately. Worth confirming the choice in-game; `addFloatingPanel` is still a fallback.
- The template's bundled `.d.ts` files already cover the corrected `DemandPoint` shape from probe-2 (including `residentModeShare` / `workerModeShare` and `popsMap`). `src/types.ts` re-exports these rather than redeclaring.

### Blocked / uncertain
- Have not yet loaded the built mod in-game and confirmed it appears in the toolbar / shows real numbers. **Next session must do this first** — it's the explicit Stage 0 ship gate.
- `addToolbarPanel` vs `addToolbarButton + addFloatingPanel`: chose the combined form. If the toolbar slot is too cramped or the panel chrome differs from what we want for the eventual sortable station table, switch to the split form.

### Next session
1. Launch Subway Builder, enable the mod in Settings > Mods, restart, verify the TOD toolbar entry shows up and the panel displays non-zero counts.
2. If the panel works, start Stage 1: scaffold `src/scoring/walkshed.ts` and `src/scoring/todScore.ts` as pure functions with vitest tests.
3. If `addToolbarPanel` UX is wrong, fall back to `addToolbarButton` (with `tooltip`) + `addFloatingPanel`.
