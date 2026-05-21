# SB TOD

Transit-Oriented Development for Subway Builder / Metro Maker 4.

SB TOD adds an in-game dashboard that reads live station, ridership, and
demand data, then ranks station areas by where transit can support more
housing, more jobs, or where dense areas are not being captured well by
the current network.

## Current Status

Stage 2 is the playable dashboard plus persisted developer deals:

- Toolbar panel: `Building2` icon, titled `TOD`
- Residential and commercial growth rankings
- Captured-value and TOD-risk rankings
- New Development card with Housing / Jobs / Mixed and S / M / L deal sizing
- Build buttons on rows prepare the selected station for a deal
- Clicking a station on the map while the panel is open selects it for building
- 500m walkshed pin on the map when a row is selected
- Section-colored map pins and row score bars
- Auto-refresh on day change, with manual refresh available
- Diagnostics drawer with calibration details and JSON debug export

The remaining future loop is organic growth/decay: letting station
performance influence land use automatically over time.

## How It Works

For each station group, the mod computes a 500m distance-weighted
walkshed from live demand points. It then scores the group on several
axes:

- `residential`: transit-using residents nearby, with room for more homes
- `commercial`: transit-using workers nearby, with room for more jobs
- `capturedValue`: dense walkshed, strong transit capture
- `risk`: dense walkshed, weak transit capture
- `potential`: older ridership/headroom signal retained in the model

Scores are calibrated per map from the live distribution, so they are
rankings for the current city rather than absolute cross-city grades.

Developer deals are persisted per save. A deal stores baseline demand,
cumulative deltas, split-pop children, and lifecycle state. On load, the
mod reconciles live demand against storage: if the game preserved the
mutation it rehydrates tracking; if the game reset it, the mod replays
the deltas.

When deals add population, the mutator updates both DemandPoint
aggregates and Pops. New demand materializes as separate split child
Pops at the game's natural size of 200, rather than one oversized Pop.
Any selected station can start a deal when the live walkshed and budget
validation pass.

## Development

Use pnpm for package management.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Useful scripts:

| Command | Description |
| --- | --- |
| `pnpm build` | Build the mod into `dist/` |
| `pnpm test` | Run Vitest coverage for scoring, deals, and persistence |
| `pnpm typecheck` | Run TypeScript without emitting files |
| `pnpm dev` | Watch build and launch the game with logging |
| `pnpm dev:link` | Symlink `dist/` into the game mods folder |
| `pnpm dev:unlink` | Remove the symlink |

## Project Map

```text
src/
  main.ts              Registers the toolbar panel and map highlight
  api.ts               Typed wrapper around window.SubwayBuilderAPI
  types.ts             TOD domain types and live-shape helpers
  sim/
    deals.ts           Deal validation, lifecycle, daily chunks
    mutate.ts          Baseline-anchored DemandPoint + Pop mutator
  state/
    mod-state.ts       Persisted per-save state and load replay
    storage-adapter.ts api.storage/localStorage fallback
  scoring/
    walkshed.ts        Pure walkshed distance + aggregation logic
    todScore.ts        Pure TOD scoring formulas
    index.ts           Joins live API data to scoring functions
    *.test.ts          Unit tests for pure scoring behavior
  ui/
    TodPanel.tsx       In-game TOD dashboard
    mapHighlight.ts    MapLibre source/layers for walkshed pins
```

The design invariant: `scoring/walkshed.ts` and `scoring/todScore.ts`
stay pure and unit-tested. Live game API access is isolated in
`api.ts` and `scoring/index.ts`.

## Mod Metadata

- Manifest id: `dev.hazel.sb-tod`
- Main bundle: `dist/index.js`
- Game dependency: Subway Builder modding API `>=1.0.0`

## Notes

The bundled template types are useful but not complete. A few runtime
surfaces are wrapped with guarded casts in `src/api.ts`, including
station groups, transfer siblings, and demand `popsMap`.
