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
- Full-price S / M / L deals complete over 1 / 2 / 3 game days
- Build buttons on rows prepare the selected station for a deal
- Clicking a station on the map while the panel is open selects it for building
- 500m walkshed pin on the map when a row is selected
- Section-colored map pins and row score bars
- Auto-refresh on day change, with manual refresh available
- Diagnostics drawer with calibration details, runtime trace status, and JSON debug export

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

Before deal ticks, the mod also rebinds its mutator to the latest live
DemandData object so developments still affect the data used by scoring
if the game refreshes demand behind the scenes.

Persistence tries the official `api.storage` backend first and verifies
every write with an immediate readback. If the game runtime no-ops that
API, the mod falls back to Electron settings storage, then localStorage,
and reports the backend in Diagnostics. New deals are disabled only if no
backend can round-trip, so a development can't charge the player unless
it can also survive save/load. Save names are read before first init,
Save As copies state into the new slot, and dirty state flushes on game
end.

The build flow guards against duplicate clicks, validates the live
budget immediately before charging, and records a money trace in Debug
DL so we can diagnose whether any duplicate debit comes from duplicate
build events, the money hook stream, or the game budget API itself. If a
save already contains a zero-progress active deal with a negative budget,
load recovery cancels/refunds that stuck deal. The trace is kept in a
bounded in-memory buffer and is not logged on every money event.

Debug DL also keeps a rolling runtime trace for freeze diagnosis: current
game time, speed, budget, ridership/mode-choice stats, completed commute
counts, day-tick phase, and TOD split-pop counts. The export includes
split-pop timing histograms and transit-path sanity checks so freezes can
be correlated with the synthetic commute batch that was about to run.

When deals add population, the mutator updates both DemandPoint
aggregates and Pops. New demand materializes as separate split child
Pops at the game's natural size of 200, rather than one oversized Pop.
Split children are indexed only on the side whose aggregate changed
(homes for housing, jobs for commercial), clone their commute state, and
stagger departure times so they behave like independent game-authored
Pops without creating phantom jobs or residents at the other end of the
commute. The mutator also normalizes resident/worker mode-share totals
after TOD changes. On load, reconcile removes tracked and orphaned TOD
split children from older builds, then rebuilds a canonical set from
persisted baselines and deltas.
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
    storage-adapter.ts api.storage/Electron/localStorage fallback
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

- Manifest id: `tod`
- Package/repo name: `sb-tod`
- Railyard display name: `Transit-Oriented Development[beta]`
- Release manifest author: `hsullivan1201`
- GitHub update repo: `hsullivan1201/sb-tod`
- Main bundle: `dist/index.js`
- Game dependency: Subway Builder modding API `>=1.0.0`

## Railyard Publishing

For a normal version release, do not open a Railyard "Update Mod" issue.
The registry entry for `tod` already points at GitHub Releases for
`hsullivan1201/sb-tod`, so Railyard should discover new complete
semver releases from GitHub.

Release checklist:

1. Update the version in `package.json`, `manifest.json`, and
   `src/main.ts`.
2. Confirm `manifest.json` keeps `id: "tod"` and
   `author.name: "hsullivan1201"`.
3. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. Create `sb-tod-vX.Y.Z.zip` with top-level `manifest.json` and
   `dist/index.js`.
5. Tag and push `vX.Y.Z`.
6. Create a GitHub Release with the changelog in the release notes.
7. Upload both `sb-tod-vX.Y.Z.zip` and standalone `manifest.json` as
   release assets.

Only use a Railyard "Update Mod" issue when changing registry metadata,
such as display name, description, tags, source URL, gallery, or update
source. A no-op issue with only `Mod ID = tod` can validate the fields
but fail when the bot has nothing to commit. If an update issue fails
because a field was wrong, edit the issue body, then comment
`revalidate`.

## Notes

The bundled template types are useful but not complete. A few runtime
surfaces are wrapped with guarded casts in `src/api.ts`, including
station groups, transfer siblings, and demand `popsMap`.
