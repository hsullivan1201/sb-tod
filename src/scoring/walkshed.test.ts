import { describe, expect, it } from 'vitest';
import type { DemandPoint } from '../types';
import {
  findWalkshed,
  haversineMeters,
  linearDecay,
  totalsFromHits,
} from './walkshed';

function point(
  id: string,
  lng: number,
  lat: number,
  jobs = 100,
  residents = 50,
  residentTransit = 0,
  workerTransit = 0
): DemandPoint {
  return {
    id,
    location: [lng, lat],
    jobs,
    residents,
    popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: residentTransit, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: workerTransit, unknown: 0 },
  };
}

describe('haversineMeters', () => {
  it('returns 0 for the same point', () => {
    expect(haversineMeters([-122, 37], [-122, 37])).toBe(0);
  });

  it('matches a known short distance (~111m per 0.001 deg lat)', () => {
    // 1 degree of latitude ≈ 111,195 m; so 0.001 ≈ 111 m.
    const d = haversineMeters([-122, 37], [-122, 37.001]);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it('is symmetric', () => {
    const a: [number, number] = [-122.4, 37.78];
    const b: [number, number] = [-122.41, 37.79];
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe('linearDecay', () => {
  it('is 1 at the centre, 0 at the edge, halfway between', () => {
    expect(linearDecay(0, 500)).toBe(1);
    expect(linearDecay(500, 500)).toBe(0);
    expect(linearDecay(250, 500)).toBe(0.5);
  });

  it('clamps beyond the radius', () => {
    expect(linearDecay(1000, 500)).toBe(0);
  });
});

describe('findWalkshed', () => {
  it('keeps points inside the radius and drops points outside it', () => {
    const center: [number, number] = [-122, 37];
    const inside = point('inside', -122, 37.001); // ~111m
    const outside = point('outside', -122, 37.01); // ~1.1km
    const hits = findWalkshed(center, [inside, outside], { radiusMeters: 500 });
    expect(hits).toHaveLength(1);
    expect(hits[0].point.id).toBe('inside');
  });

  it('weights are highest near the centre', () => {
    const center: [number, number] = [-122, 37];
    const near = point('near', -122, 37.0005);
    const far = point('far', -122, 37.004);
    const hits = findWalkshed(center, [near, far], { radiusMeters: 500 });
    const nearHit = hits.find((h) => h.point.id === 'near')!;
    const farHit = hits.find((h) => h.point.id === 'far')!;
    expect(nearHit.weight).toBeGreaterThan(farHit.weight);
  });
});

describe('totalsFromHits', () => {
  it('weights jobs and residents by distance decay', () => {
    const p1 = point('p1', 0, 0, 1000, 500); // weight 1.0
    const p2 = point('p2', 0, 0, 1000, 500); // weight 0.5 (forced via decay)
    const hits = [
      { point: p1, distanceMeters: 0, weight: 1 },
      { point: p2, distanceMeters: 250, weight: 0.5 },
    ];
    const totals = totalsFromHits(hits);
    expect(totals.jobs).toBe(1500);
    expect(totals.residents).toBe(750);
    expect(totals.pointCount).toBe(2);
  });

  it('weights residentTransit and workerTransit by decay', () => {
    const p1 = point('p1', 0, 0, 1000, 500, /*resTransit*/ 100, /*workTransit*/ 200);
    const p2 = point('p2', 0, 0, 1000, 500, 100, 200);
    const hits = [
      { point: p1, distanceMeters: 0, weight: 1 },
      { point: p2, distanceMeters: 250, weight: 0.5 },
    ];
    const totals = totalsFromHits(hits);
    expect(totals.residentTransit).toBe(150); // 100 + 100*0.5
    expect(totals.workerTransit).toBe(300);   // 200 + 200*0.5
  });

  it('handles points with no mode-share fields (defaults to 0)', () => {
    const bare: DemandPoint = {
      id: 'bare',
      location: [0, 0],
      jobs: 100,
      residents: 50,
      popIds: [],
      // residentModeShare / workerModeShare deliberately omitted
    } as unknown as DemandPoint;
    const hits = [{ point: bare, distanceMeters: 0, weight: 1 }];
    const totals = totalsFromHits(hits);
    expect(totals.residentTransit).toBe(0);
    expect(totals.workerTransit).toBe(0);
  });
});
