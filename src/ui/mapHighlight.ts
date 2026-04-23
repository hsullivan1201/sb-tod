/**
 * Map highlight — a single 500m walkshed disc the panel can move
 * around when the user clicks a station row.
 *
 * Implementation: one geojson source (`sb-tod-highlight`) holding either
 * an empty FeatureCollection or a single polygon approximating a circle.
 * Two layers reference it — a translucent fill for the disc area and a
 * stronger outline so the boundary remains legible over busy basemaps.
 *
 * The circle is approximated as a 64-vertex polygon. We compute the
 * vertices in lat/lng directly using local meters-per-degree, which is
 * accurate at city scale (the small distortion vs. a true geodesic
 * circle is invisible at 500m / zoom 14+).
 */

import { getMap, map as mapApi } from '../api';
import type { LngLat } from '../types';

const SOURCE_ID = 'sb-tod-highlight';
const FILL_LAYER_ID = 'sb-tod-highlight-fill';
const LINE_LAYER_ID = 'sb-tod-highlight-line';
const POINTS_SOURCE_ID = 'sb-tod-highlight-points';
const POINTS_LAYER_ID = 'sb-tod-highlight-points-circles';

// Minimal GeoJSON shapes — `@types/geojson` isn't a dep and we only
// need the polygon + point + FeatureCollection forms MapLibre accepts.
interface PolygonFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
}
interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: PolygonFeature[];
}
interface PointFeatureCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
}

const EMPTY: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

const EMPTY_POINTS: PointFeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

let registered = false;

interface FeatureCollectionSource {
  setData(data: FeatureCollection | PointFeatureCollection): void;
}

/**
 * Register the source + layers. Safe to call multiple times — the API's
 * idempotency isn't documented, so we guard.
 */
export function initMapHighlight(): void {
  if (registered) return;
  try {
    mapApi.registerSource(SOURCE_ID, { type: 'geojson', data: EMPTY });
    mapApi.registerLayer({
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': '#fbbf24',
        'fill-opacity': 0.18,
      },
    });
    mapApi.registerLayer({
      id: LINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': '#fbbf24',
        'line-width': 2,
        'line-opacity': 0.85,
      },
    });
    // Second source/layer for per-point markers (used when highlighting
    // a deal's eligible walkshed targets, not just the disc).
    mapApi.registerSource(POINTS_SOURCE_ID, { type: 'geojson', data: EMPTY_POINTS });
    mapApi.registerLayer({
      id: POINTS_LAYER_ID,
      type: 'circle',
      source: POINTS_SOURCE_ID,
      paint: {
        // Per-feature color set in properties; MapLibre style-expression
        // reads it. Falls back to amber so a missing property doesn't
        // blow up rendering.
        'circle-color': ['coalesce', ['get', 'color'], '#fbbf24'],
        'circle-radius': ['coalesce', ['get', 'radius'], 6],
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 1,
        'circle-opacity': 0.85,
      },
    });
    registered = true;
  } catch (err) {
    console.error('[sb-tod] initMapHighlight failed:', err);
  }
}

export interface SetHighlightOptions {
  /**
   * If true (default), pan + zoom the camera to the highlighted point.
   * Pass false when the user clicked the spot themselves on the map —
   * they're already looking at it and a camera move feels wrong.
   */
  easeCamera?: boolean;
}

export function setHighlight(
  center: LngLat,
  radiusMeters: number,
  options: SetHighlightOptions = {}
): void {
  const m = getMap();
  if (!m) return;
  const easeCamera = options.easeCamera ?? true;
  try {
    const src = m.getSource(SOURCE_ID) as FeatureCollectionSource | undefined;
    if (!src?.setData) return;
    src.setData({
      type: 'FeatureCollection',
      features: [circlePolygon(center, radiusMeters)],
    });
    // Wipe any prior point markers — the caller (deal-locate path)
    // re-adds them after this call if they want them.
    const ptsSrc = m.getSource(POINTS_SOURCE_ID) as FeatureCollectionSource | undefined;
    ptsSrc?.setData?.(EMPTY_POINTS);
    if (easeCamera && typeof m.easeTo === 'function') {
      m.easeTo({
        center: [center[0], center[1]],
        zoom: Math.max(m.getZoom?.() ?? 13, 14),
        duration: 600,
      });
    }
  } catch (err) {
    console.error('[sb-tod] setHighlight failed:', err);
  }
}

export function clearHighlight(): void {
  const m = getMap();
  if (!m) return;
  try {
    const src = m.getSource(SOURCE_ID) as FeatureCollectionSource | undefined;
    src?.setData?.(EMPTY);
    const ptsSrc = m.getSource(POINTS_SOURCE_ID) as FeatureCollectionSource | undefined;
    ptsSrc?.setData?.(EMPTY_POINTS);
  } catch (err) {
    console.error('[sb-tod] clearHighlight failed:', err);
  }
}

export interface MarkedPoint {
  lngLat: LngLat;
  color: string;
  radiusPx?: number;
}

/**
 * Drop a set of point markers on the map, in addition to (or instead
 * of) the walkshed disc. Used to surface a deal's eligible target
 * points so the player can see exactly where a deal lands density.
 */
export function setHighlightPoints(points: MarkedPoint[]): void {
  const m = getMap();
  if (!m) return;
  try {
    const src = m.getSource(POINTS_SOURCE_ID) as FeatureCollectionSource | undefined;
    if (!src?.setData) return;
    const features: PointFeature[] = points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lngLat[0], p.lngLat[1]] },
      properties: { color: p.color, radius: p.radiusPx ?? 6 },
    }));
    src.setData({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('[sb-tod] setHighlightPoints failed:', err);
  }
}

function circlePolygon(center: LngLat, radiusMeters: number): PolygonFeature {
  const [lng, lat] = center;
  const steps = 64;
  // local degrees per meter — accurate enough at city scale
  const dLat = 1 / 110_574;
  const dLng = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const θ = (i / steps) * 2 * Math.PI;
    const x = lng + Math.cos(θ) * radiusMeters * dLng;
    const y = lat + Math.sin(θ) * radiusMeters * dLat;
    ring.push([x, y]);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {},
  };
}
