/**
 * SB TOD — domain types
 *
 * Re-exports the relevant game types from the template's bundled `.d.ts`
 * files and adds TOD-specific types. The Coordinate tuple from the game
 * is [longitude, latitude] (probe-2 confirmed this).
 */

import type {
  DemandPoint as ApiDemandPoint,
  Pop as ApiPop,
  DemandData as ApiDemandData,
  ModeChoiceStats,
} from './types/game-state';
import type { Coordinate } from './types/core';

export type LngLat = readonly [lng: number, lat: number];

export function asLngLat(c: Coordinate): LngLat {
  return [c[0], c[1]] as LngLat;
}

export type DemandPoint = ApiDemandPoint;
export type Pop = ApiPop;
export type DemandData = ApiDemandData;
export type { ModeChoiceStats };

/**
 * Mode-share counts on `DemandPoint.residentModeShare` /
 * `workerModeShare`. Confirmed via Debug DL (2026-04-22) — raw counts
 * (not ratios) summing to `residents` or `jobs` respectively.
 *
 * Bundled types declared these as `object` only.
 */
export interface ModeBreakdown {
  walking: number;
  driving: number;
  transit: number;
  unknown: number;
}

export function readModeBreakdown(value: unknown): ModeBreakdown {
  const v = (value ?? {}) as Partial<ModeBreakdown>;
  return {
    walking: numOr0(v.walking),
    driving: numOr0(v.driving),
    transit: numOr0(v.transit),
    unknown: numOr0(v.unknown),
  };
}

function numOr0(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/**
 * Station group shape — confirmed via Debug DL probe (2026-04-22).
 * Bundled template types do not include this surface.
 */
export interface StationGroup {
  id: string;
  name: string;
  stationIds: string[];
  center: LngLat;
  bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number };
}

export interface BaselineDensity {
  jobs: number;
  residents: number;
}

export interface DeltaSource {
  fromDeals: number;
  fromOrganic: number;
}

export interface PointDelta {
  jobs: DeltaSource;
  residents: DeltaSource;
}
