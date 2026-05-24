/**
 * Walkshed — pure functions for "what demand sits within walking
 * distance of this point?"
 *
 * Phase 1 uses straight-line haversine distance. Real walksheds follow
 * the street network and respect barriers (highways, rivers); we don't
 * have a documented API for street-network queries yet, so we approximate.
 * The accuracy is imperfect, but *relative* rankings between stations
 * are usually correct, which is what matters for spotting opportunities.
 *
 * Distance decay is linear: a point at the edge of the walkshed
 * contributes ~0; a point at the centre contributes 1. Linear is the
 * easiest decay function to defend to a non-technical reader and avoids
 * over-weighting the immediate cluster around a station entrance the
 * way an exponential decay would. The decay function is exposed as a
 * parameter so we can swap it without rewriting callers.
 */

import type { DemandPoint } from '../types';
import { readModeBreakdown } from '../types';
import type { Coordinate } from '../types/core';

export interface WalkshedHit {
  point: DemandPoint;
  distanceMeters: number;
  weight: number;
}

/**
 * Walkshed aggregates.
 *
 * `residentTransit` and `workerTransit` are the distance-weighted
 * counts of *transit-using* residents and workers within the walkshed.
 * They come straight from `DemandPoint.residentModeShare.transit` and
 * `workerModeShare.transit`, which are raw counts from the sim's
 * gravity model. **Caveat**: a high `residentTransit` here means
 * "residents at this point happened to be assigned jobs that are
 * transit-accessible," not "this is a generically transit-accessible
 * location." The signal captures the FIT between the local commute
 * pattern and the current network — which is exactly what TOD wants
 * for opportunity scoring, but it's not the same as a network-aware
 * gravity-model accessibility number.
 */
export interface WalkshedTotals {
  jobs: number;
  residents: number;
  residentTransit: number;
  workerTransit: number;
  pointCount: number;
}

export interface WalkshedOptions {
  radiusMeters?: number;
  decay?: (distanceMeters: number, radiusMeters: number) => number;
}

const DEFAULT_RADIUS_M = 500;
const METERS_PER_DEGREE_LAT = 110_574;
const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111_320;

export interface WalkshedIndex {
  pointCount: number;
  find(center: Coordinate, options?: WalkshedOptions): WalkshedHit[];
}

export function linearDecay(d: number, r: number): number {
  if (d <= 0) return 1;
  if (d >= r) return 0;
  return 1 - d / r;
}

export function findWalkshed(
  center: Coordinate,
  points: Iterable<DemandPoint>,
  options: WalkshedOptions = {}
): WalkshedHit[] {
  const radius = options.radiusMeters ?? DEFAULT_RADIUS_M;
  const decay = options.decay ?? linearDecay;

  const hits: WalkshedHit[] = [];
  for (const point of points) {
    const distanceMeters = haversineMeters(center, point.location);
    if (distanceMeters > radius) continue;
    hits.push({
      point,
      distanceMeters,
      weight: decay(distanceMeters, radius),
    });
  }
  return hits;
}

export function createWalkshedIndex(
  points: Iterable<DemandPoint>,
  options: { cellSizeMeters?: number } = {}
): WalkshedIndex {
  const cellSizeDegrees = Math.max(
    0.0005,
    (options.cellSizeMeters ?? DEFAULT_RADIUS_M) / METERS_PER_DEGREE_LNG_AT_EQUATOR
  );
  const cells = new Map<string, DemandPoint[]>();
  let pointCount = 0;

  const keyFor = (lng: number, lat: number): string =>
    `${Math.floor(lng / cellSizeDegrees)}:${Math.floor(lat / cellSizeDegrees)}`;

  for (const point of points) {
    const [lng, lat] = point.location;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const key = keyFor(lng, lat);
    const bucket = cells.get(key);
    if (bucket) bucket.push(point);
    else cells.set(key, [point]);
    pointCount++;
  }

  return {
    pointCount,
    find(center: Coordinate, findOptions: WalkshedOptions = {}) {
      const radius = findOptions.radiusMeters ?? DEFAULT_RADIUS_M;
      const decay = findOptions.decay ?? linearDecay;
      const [lng, lat] = center;
      const lngCos = Math.max(0.01, Math.abs(Math.cos(toRad(lat))));
      const latDelta = radius / METERS_PER_DEGREE_LAT;
      const lngDelta = radius / (METERS_PER_DEGREE_LNG_AT_EQUATOR * lngCos);
      const minX = Math.floor((lng - lngDelta) / cellSizeDegrees);
      const maxX = Math.floor((lng + lngDelta) / cellSizeDegrees);
      const minY = Math.floor((lat - latDelta) / cellSizeDegrees);
      const maxY = Math.floor((lat + latDelta) / cellSizeDegrees);
      const hits: WalkshedHit[] = [];

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const bucket = cells.get(`${x}:${y}`);
          if (!bucket) continue;
          for (const point of bucket) {
            const distanceMeters = haversineMeters(center, point.location);
            if (distanceMeters > radius) continue;
            hits.push({
              point,
              distanceMeters,
              weight: decay(distanceMeters, radius),
            });
          }
        }
      }

      return hits;
    },
  };
}

export function totalsFromHits(hits: WalkshedHit[]): WalkshedTotals {
  let jobs = 0;
  let residents = 0;
  let residentTransit = 0;
  let workerTransit = 0;
  for (const hit of hits) {
    jobs += hit.point.jobs * hit.weight;
    residents += hit.point.residents * hit.weight;
    const rms = readModeBreakdown((hit.point as any).residentModeShare);
    const wms = readModeBreakdown((hit.point as any).workerModeShare);
    residentTransit += rms.transit * hit.weight;
    workerTransit += wms.transit * hit.weight;
  }
  return { jobs, residents, residentTransit, workerTransit, pointCount: hits.length };
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lng2 - lng1);
  const sinDφ = Math.sin(dφ / 2);
  const sinDλ = Math.sin(dλ / 2);
  const h = sinDφ * sinDφ + Math.cos(φ1) * Math.cos(φ2) * sinDλ * sinDλ;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
