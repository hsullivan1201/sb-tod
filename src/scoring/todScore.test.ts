import { describe, expect, it } from 'vitest';
import { scoreAccess, scoreStation } from './todScore';
import type { WalkshedTotals } from './walkshed';

function totals(partial: Partial<WalkshedTotals> = {}): WalkshedTotals {
  return {
    jobs: 0,
    residents: 0,
    residentTransit: 0,
    workerTransit: 0,
    pointCount: 0,
    ...partial,
  };
}

describe('scoreStation', () => {
  it('returns zero scores for an empty walkshed and zero ridership', () => {
    const s = scoreStation({ walkshedSupply: 0, ridership: 0 });
    expect(s.potential).toBe(0);
    expect(s.risk).toBe(0);
    expect(s.capturedValue).toBe(0);
    expect(s.capture).toBe(0);
  });

  it('high ridership with empty walkshed → high potential, low risk', () => {
    const s = scoreStation({ walkshedSupply: 0, ridership: 2000 });
    expect(s.potential).toBeGreaterThan(0.5);
    expect(s.risk).toBe(0);
    expect(s.capturedValue).toBe(0);
  });

  it('saturated walkshed with low ridership → low potential, high risk, low captured value', () => {
    const s = scoreStation({ walkshedSupply: 60_000, ridership: 10 });
    expect(s.potential).toBeLessThan(0.1);
    expect(s.risk).toBeGreaterThan(0.5);
    expect(s.capturedValue).toBeLessThan(0.1);
  });

  it('saturated walkshed with high ridership → high captured value, low risk', () => {
    const s = scoreStation({ walkshedSupply: 30_000, ridership: 5_000 });
    expect(s.capturedValue).toBeGreaterThan(0.5);
    expect(s.risk).toBeLessThan(0.5);
  });

  it('captured value + risk ≤ density pressure (partition invariant)', () => {
    for (const supply of [1_000, 10_000, 30_000, 60_000]) {
      for (const riders of [0, 100, 1_000, 10_000]) {
        const s = scoreStation({ walkshedSupply: supply, ridership: riders });
        const densityPressure = Math.min(1, supply / 30_000);
        expect(s.capturedValue + s.risk).toBeLessThanOrEqual(densityPressure + 1e-9);
      }
    }
  });

  it('balanced station — moderate density and moderate ridership — scores middling on both', () => {
    const s = scoreStation({ walkshedSupply: 15_000, ridership: 500 });
    expect(s.potential).toBeGreaterThan(0.1);
    expect(s.potential).toBeLessThan(0.5);
    expect(s.risk).toBeGreaterThan(0.05);
    expect(s.risk).toBeLessThan(0.5);
  });

  it('clamps gracefully on negative inputs', () => {
    const s = scoreStation({ walkshedSupply: -100, ridership: -50 });
    expect(s.potential).toBe(0);
    expect(s.risk).toBe(0);
  });

  it('respects custom saturation tunable', () => {
    const tight = scoreStation({ walkshedSupply: 10_000, ridership: 200 }, { supplySaturation: 10_000 });
    const loose = scoreStation({ walkshedSupply: 10_000, ridership: 200 }, { supplySaturation: 100_000 });
    expect(tight.risk).toBeGreaterThan(loose.risk);
    expect(tight.potential).toBeLessThan(loose.potential);
  });
});

describe('scoreAccess', () => {
  it('returns zero scores on empty totals', () => {
    const s = scoreAccess(totals());
    expect(s.residential).toBe(0);
    expect(s.commercial).toBe(0);
    expect(s.combined).toBe(0);
  });

  it('high residentTransit + low residents → high residential, low commercial', () => {
    const s = scoreAccess(
      totals({ residents: 500, residentTransit: 1000, jobs: 0, workerTransit: 0 }),
      { residentSaturation: 5_000, jobSaturation: 10_000 }
    );
    expect(s.residential).toBeGreaterThan(0.5);
    expect(s.commercial).toBe(0);
  });

  it('high workerTransit + low jobs → high commercial, low residential', () => {
    const s = scoreAccess(
      totals({ jobs: 500, workerTransit: 5000, residents: 0, residentTransit: 0 }),
      { residentSaturation: 5_000, jobSaturation: 10_000 }
    );
    expect(s.commercial).toBeGreaterThan(0.5);
    expect(s.residential).toBe(0);
  });

  it('saturated walkshed → headroom → 0 → score → 0 even with high transit', () => {
    const s = scoreAccess(
      totals({ residents: 5_000, residentTransit: 10_000 }),
      { residentSaturation: 5_000 }
    );
    expect(s.residential).toBe(0);
  });

  it('combined is the max of residential and commercial', () => {
    const s = scoreAccess(
      totals({
        residents: 500, residentTransit: 200,
        jobs: 500, workerTransit: 5000,
      }),
      { residentSaturation: 5_000, jobSaturation: 10_000 }
    );
    expect(s.combined).toBe(Math.max(s.residential, s.commercial));
    expect(s.combined).toBeGreaterThan(0);
  });

  it('mirrors raw transit counts on the score result', () => {
    const s = scoreAccess(totals({ residentTransit: 123.4, workerTransit: 567.8 }));
    expect(s.residentTransit).toBe(123.4);
    expect(s.workerTransit).toBe(567.8);
  });
});
