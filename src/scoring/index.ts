/**
 * Scoring orchestrator — joins live station/demand/ridership data
 * with the pure walkshed and TOD scoring functions.
 *
 * Operates on station GROUPS, not individual platforms. The base game
 * groups multi-platform transfer stations under a single named record
 * (e.g. "Palm Av" with 4 platforms is one group). Scoring per-group
 * means:
 *   - one walkshed per real-world station (platforms ~10m apart used
 *     to produce 4 nearly-identical rows in the panel)
 *   - ridership summed across siblings, so a busy hub scores as a hub
 *   - display name is the human-readable group name, not a platform UUID
 *
 * This file is the only place in `src/scoring/` that touches the API.
 * Everything else under this folder is pure and unit-tested.
 */

import { gameState } from '../api';
import type { LngLat, StationGroup } from '../types';
import type { AccessScore, ScoreOptions, StationScore } from './todScore';
import { scoreAccess, scoreFromWalkshed } from './todScore';
import { createWalkshedIndex, totalsFromHits, type WalkshedTotals } from './walkshed';

export interface ScoredStation {
  /** Group id when grouped, station id when ungrouped fallback. */
  id: string;
  /** Human-readable group/station name. */
  name: string;
  /** Number of platforms aggregated. 1 for solo stations. */
  memberCount: number;
  /** Walkshed center (group center, or station coords for ungrouped). */
  center: LngLat;
  /** Walkshed totals (distance-weighted) for the panel + map layer. */
  totals: WalkshedTotals;
  /** Legacy ridership-driven potential / risk. */
  score: StationScore;
  /** Residential / commercial TOD opportunity scores. */
  access: AccessScore;
}

export interface ScoreAllOptions extends ScoreOptions {
  radiusMeters?: number;
  /**
   * If true (default), pick all calibration scales from the live
   * distribution so scores spread across [0,1] on this map instead of
   * pinning at the asymptote. Explicitly-supplied options always win.
   */
  autoCalibrate?: boolean;
}

export interface CalibrationInfo {
  ridershipScale: number;
  supplySaturation: number;
  residentSaturation: number;
  jobSaturation: number;
  residentTransitScale: number;
  workerTransitScale: number;
  source: 'auto' | 'option' | 'default';
}

export interface ScoreResult {
  scored: ScoredStation[];
  calibration: CalibrationInfo;
}

export function scoreAllStations(options: ScoreAllOptions = {}): ScoredStation[] {
  return scoreAllStationsDetailed(options).scored;
}

export function scoreAllStationsDetailed(options: ScoreAllOptions = {}): ScoreResult {
  const stations = gameState.getStations();
  const groups = gameState.getStationGroups();
  const points = gameState.getDemandData().points;
  const pointList = Array.from(points.values());
  const walkshedIndex = createWalkshedIndex(pointList, {
    cellSizeMeters: options.radiusMeters ?? 500,
  });

  // Build a stationId → station lookup for ridership + coord fallback.
  const stationById = new Map(stations.map((s) => [s.id, s] as const));

  // Track which stations the groups cover so we can fall back for any
  // stragglers. (Groups should cover all stations, but this keeps us
  // safe against a future mismatch.)
  const coveredStationIds = new Set<string>();

  type Intermediate = {
    id: string;
    name: string;
    memberCount: number;
    center: LngLat;
    totals: WalkshedTotals;
    ridership: number;
  };

  const intermediates: Intermediate[] = [];

  for (const group of groups) {
    const memberIds = group.stationIds ?? [];
    if (memberIds.length === 0) continue;

    for (const id of memberIds) coveredStationIds.add(id);

    const center = pickGroupCenter(group, memberIds, stationById);
    if (!center) continue;

    const hits = walkshedIndex.find([center[0], center[1]], {
      radiusMeters: options.radiusMeters,
    });
    const totals = totalsFromHits(hits);

    let ridership = 0;
    for (const sid of memberIds) {
      try {
        ridership += gameState.getStationRidership(sid)?.total ?? 0;
      } catch {
        // station may have no ridership record yet — treat as 0
      }
    }

    intermediates.push({
      id: group.id,
      name: group.name || `#${group.id.slice(0, 6)}`,
      memberCount: memberIds.length,
      center,
      totals,
      ridership,
    });
  }

  // Fallback: stations not in any group get scored individually.
  for (const station of stations) {
    if (coveredStationIds.has(station.id)) continue;
    const hits = walkshedIndex.find(station.coords, {
      radiusMeters: options.radiusMeters,
    });
    const totals = totalsFromHits(hits);
    let ridership = 0;
    try {
      ridership = gameState.getStationRidership(station.id)?.total ?? 0;
    } catch {
      // ignore
    }
    intermediates.push({
      id: station.id,
      name: station.name || `#${station.id.slice(0, 6)}`,
      memberCount: 1,
      center: [station.coords[0], station.coords[1]] as LngLat,
      totals,
      ridership,
    });
  }

  const calibration = resolveCalibration(intermediates, options);

  const scoreOptions: ScoreOptions = {
    ridershipScale: calibration.ridershipScale,
    supplySaturation: calibration.supplySaturation,
  };

  const accessOptions = {
    residentSaturation: calibration.residentSaturation,
    jobSaturation: calibration.jobSaturation,
    residentTransitScale: calibration.residentTransitScale,
    workerTransitScale: calibration.workerTransitScale,
  };

  const scored = intermediates.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.memberCount,
    center: row.center,
    totals: row.totals,
    score: scoreFromWalkshed(row.totals, row.ridership, scoreOptions),
    access: scoreAccess(row.totals, accessOptions),
  }));

  return { scored, calibration };
}

function pickGroupCenter(
  group: StationGroup,
  memberIds: string[],
  stationById: Map<string, { coords: LngLat }>
): LngLat | null {
  if (Array.isArray(group.center) && group.center.length === 2) {
    return group.center as LngLat;
  }
  // Fallback: average member coords.
  let lng = 0;
  let lat = 0;
  let n = 0;
  for (const id of memberIds) {
    const s = stationById.get(id);
    if (!s) continue;
    lng += s.coords[0];
    lat += s.coords[1];
    n++;
  }
  return n > 0 ? ([lng / n, lat / n] as LngLat) : null;
}

function resolveCalibration(
  rows: Array<{ totals: WalkshedTotals; ridership: number }>,
  options: ScoreAllOptions
): CalibrationInfo {
  const explicit =
    options.ridershipScale !== undefined || options.supplySaturation !== undefined;

  if (options.autoCalibrate === false || explicit) {
    return {
      ridershipScale: options.ridershipScale ?? 500,
      supplySaturation: options.supplySaturation ?? 30_000,
      residentSaturation: 5_000,
      jobSaturation: 10_000,
      residentTransitScale: 200,
      workerTransitScale: 500,
      source: explicit ? 'option' : 'default',
    };
  }

  // Auto-calibration: every scale comes from a percentile of the live
  // distribution so the meaning of a 0.7 score is consistent within a
  // map. The footer warns that scores are per-map (a 0.7 on SF means
  // something different from a 0.7 on Phoenix).
  //
  // Choices:
  //   - p75 for ridership and the "transit users" scales — a station
  //     above the 75th percentile reads as a clear success.
  //   - p95 for the "saturation" scales — it takes a top-5%-dense
  //     walkshed for headroom to actually collapse. Bumped from p90 in
  //     session 4 because residential scores were ceiling-capped at
  //     ~0.33 on SF: most residential walksheds sit close to p90, so
  //     p90 saturation crushed headroom for moderate-density places
  //     that are exactly the upzoning targets the panel should surface.
  //     p95 keeps the "rare ultra-dense walksheds = no room" intent
  //     while restoring meaningful headroom for typical places.
  const onlyPositive = (xs: number[]) => xs.filter((x) => x > 0);

  const ridershipP75 = percentile(onlyPositive(rows.map((r) => r.ridership)), 0.75);
  const supplyP95 = percentile(
    onlyPositive(rows.map((r) => r.totals.jobs + r.totals.residents)),
    0.95
  );
  const residentSatP95 = percentile(onlyPositive(rows.map((r) => r.totals.residents)), 0.95);
  const jobSatP95 = percentile(onlyPositive(rows.map((r) => r.totals.jobs)), 0.95);
  const residentTransitP75 = percentile(
    onlyPositive(rows.map((r) => r.totals.residentTransit)),
    0.75
  );
  const workerTransitP75 = percentile(
    onlyPositive(rows.map((r) => r.totals.workerTransit)),
    0.75
  );

  return {
    ridershipScale: clampMin(ridershipP75, 100),
    supplySaturation: clampMin(supplyP95, 5_000),
    residentSaturation: clampMin(residentSatP95, 1_000),
    jobSaturation: clampMin(jobSatP95, 1_000),
    residentTransitScale: clampMin(residentTransitP75, 50),
    workerTransitScale: clampMin(workerTransitP75, 100),
    source: 'auto',
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function clampMin(value: number, min: number): number {
  return Number.isFinite(value) && value > min ? value : min;
}
