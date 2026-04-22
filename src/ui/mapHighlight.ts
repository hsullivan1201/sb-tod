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

// Minimal GeoJSON shapes — `@types/geojson` isn't a dep and we only
// need the polygon + FeatureCollection forms MapLibre accepts.
interface PolygonFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: PolygonFeature[];
}

const EMPTY: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

let registered = false;

interface FeatureCollectionSource {
  setData(data: FeatureCollection): void;
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
    registered = true;
  } catch (err) {
    console.error('[sb-tod] initMapHighlight failed:', err);
  }
}

export function setHighlight(center: LngLat, radiusMeters: number): void {
  const m = getMap();
  if (!m) return;
  try {
    const src = m.getSource(SOURCE_ID) as FeatureCollectionSource | undefined;
    if (!src?.setData) return;
    src.setData({
      type: 'FeatureCollection',
      features: [circlePolygon(center, radiusMeters)],
    });
    if (typeof m.easeTo === 'function') {
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
  } catch (err) {
    console.error('[sb-tod] clearHighlight failed:', err);
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
