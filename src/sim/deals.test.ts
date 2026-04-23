import { describe, expect, it } from 'vitest';
import type { DemandPoint, LngLat } from '../types';
import {
  validateProposal,
  confirmProposal,
  computeDailyApply,
  DEFAULT_TIER_TABLE,
  type Deal,
} from './deals';

const CENTER: LngLat = [-122.0, 37.0];

function point(
  id: string,
  jobs: number,
  residents: number,
  // Offset in degrees from CENTER. ~0.001 deg ≈ 111m.
  lngOffset = 0,
  latOffset = 0
): DemandPoint {
  return {
    id,
    location: [CENTER[0] + lngOffset, CENTER[1] + latOffset],
    jobs,
    residents,
    popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

// ---------------------------------------------------------------------------
// validateProposal
// ---------------------------------------------------------------------------
describe('validateProposal', () => {
  it('accepts a housing-S proposal when at least one walkshed point has residents', () => {
    const points = [
      point('p1', 100, 200, 0, 0.001),  // ~111m N
      point('p2', 0, 0, 0, 0.002),       // ~222m N — ghost town
    ];
    const r = validateProposal({
      kind: 'housing',
      tier: 'S',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 100_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalCost).toBe(25_000_000);
    expect(r.totalDensity.residents).toBe(500);
    expect(r.totalDensity.jobs).toBe(0);
    expect(r.eligiblePoints.length).toBe(2);
    expect(r.eligiblePoints[0].residentsEligible).toBe(true);
    expect(r.eligiblePoints[1].residentsEligible).toBe(false);
  });

  it('rejects a residential deal when no walkshed point has residents', () => {
    const points = [point('p1', 1000, 0, 0, 0.001)];
    const r = validateProposal({
      kind: 'housing',
      tier: 'S',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 100_000_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-eligible-residential-points');
  });

  it('rejects a commercial deal when no walkshed point has jobs', () => {
    const points = [point('p1', 0, 1000, 0, 0.001)];
    const r = validateProposal({
      kind: 'commercial',
      tier: 'M',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 1_000_000_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-eligible-commercial-points');
  });

  it('rejects a mixed deal if either dimension lacks eligible points', () => {
    const points = [point('p1', 0, 1000, 0, 0.001)]; // residents only
    const r = validateProposal({
      kind: 'mixed',
      tier: 'S',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 100_000_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-eligible-commercial-points');
  });

  it('rejects when budget is short', () => {
    const points = [point('p1', 100, 200, 0, 0.001)];
    const r = validateProposal({
      kind: 'housing',
      tier: 'L',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 1_000_000, // tiny
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-funds');
  });

  it('rejects when walkshed is empty', () => {
    const points = [point('p1', 100, 200, 0, 0.01)]; // ~1.1km away, outside 500m
    const r = validateProposal({
      kind: 'housing',
      tier: 'S',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 100_000_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('walkshed-empty');
  });

  it('honors residentsEligibilityThreshold (matches mutator ghostTownThreshold)', () => {
    const points = [point('p1', 0, 50, 0, 0.001)];
    const r = validateProposal({
      kind: 'housing',
      tier: 'S',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 100_000_000,
      residentsEligibilityThreshold: 100,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-eligible-residential-points');
  });
});

// ---------------------------------------------------------------------------
// Tier table consistency
// ---------------------------------------------------------------------------
describe('default tier table', () => {
  it('has all 9 deal-kind/tier combinations', () => {
    for (const kind of ['housing', 'commercial', 'mixed'] as const) {
      for (const tier of ['S', 'M', 'L'] as const) {
        const t = DEFAULT_TIER_TABLE[kind][tier];
        expect(t.cost).toBeGreaterThan(0);
        expect(t.duration).toBeGreaterThan(0);
        expect(t.totalDensity.residents).toBeGreaterThanOrEqual(0);
        expect(t.totalDensity.jobs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('housing tiers add only residents; commercial tiers add only jobs', () => {
    for (const tier of ['S', 'M', 'L'] as const) {
      expect(DEFAULT_TIER_TABLE.housing[tier].totalDensity.jobs).toBe(0);
      expect(DEFAULT_TIER_TABLE.housing[tier].totalDensity.residents).toBeGreaterThan(0);
      expect(DEFAULT_TIER_TABLE.commercial[tier].totalDensity.residents).toBe(0);
      expect(DEFAULT_TIER_TABLE.commercial[tier].totalDensity.jobs).toBeGreaterThan(0);
    }
  });

  it('mixed tiers add both, at 70% of housing/commercial respectively', () => {
    for (const tier of ['S', 'M', 'L'] as const) {
      const m = DEFAULT_TIER_TABLE.mixed[tier];
      const h = DEFAULT_TIER_TABLE.housing[tier];
      const c = DEFAULT_TIER_TABLE.commercial[tier];
      expect(m.totalDensity.residents).toBe(Math.round(h.totalDensity.residents * 0.7));
      expect(m.totalDensity.jobs).toBe(Math.round(c.totalDensity.jobs * 0.7));
      expect(m.cost).toBe(Math.round((h.cost + c.cost) * 0.7));
    }
  });
});

// ---------------------------------------------------------------------------
// confirmProposal → Deal
// ---------------------------------------------------------------------------
describe('confirmProposal', () => {
  it('builds an active Deal from a valid proposal', () => {
    const points = [point('p1', 100, 200, 0, 0.001)];
    const v = validateProposal({
      kind: 'housing',
      tier: 'S',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 100_000_000,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;

    let counter = 0;
    const deal = confirmProposal({
      proposal: v,
      startDay: 7,
      centerStationGroupId: 'sg-1',
      centerLngLat: CENTER,
      radiusMeters: 500,
      idGenerator: () => `test-${++counter}`,
    });
    expect(deal.id).toBe('test-1');
    expect(deal.state).toBe('active');
    expect(deal.startDay).toBe(7);
    expect(deal.totalDensity).toEqual({ residents: 500, jobs: 0 });
    expect(deal.appliedSoFar).toEqual({ residents: 0, jobs: 0 });
    expect(deal.durationDays).toBe(5); // housing/S default
  });

  it('honors a durationOverride from the proposal', () => {
    const points = [point('p1', 100, 200, 0, 0.001)];
    const v = validateProposal({
      kind: 'housing',
      tier: 'L',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 1_000_000_000,
      durationOverride: 7,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.durationDays).toBe(7);
    // Cost and density stay tied to the tier — only pacing changed.
    expect(v.totalCost).toBe(250_000_000);
    expect(v.totalDensity.residents).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// computeDailyApply
// ---------------------------------------------------------------------------
describe('computeDailyApply', () => {
  function activeDeal(overrides: Partial<Deal> = {}): Deal {
    return {
      id: 'test-deal',
      kind: 'housing',
      tier: 'M',
      centerStationGroupId: 'sg-1',
      centerLngLat: CENTER,
      radiusMeters: 500,
      totalDensity: { residents: 600, jobs: 0 },
      totalCost: 80_000_000,
      startDay: 1,
      durationDays: 60,
      state: 'active',
      appliedSoFar: { residents: 0, jobs: 0 },
      ...overrides,
    };
  }

  it('distributes today residents across eligible walkshed points by weight', () => {
    // Two points equidistant; should split 50/50.
    const points = [
      point('p1', 0, 100, 0, 0.001),
      point('p2', 0, 100, 0, -0.001),
    ];
    const plan = computeDailyApply({
      deal: activeDeal(),
      currentDay: 1, // first day
      walkshedPoints: points,
    });
    // Day 1 of 60-day deal: expected = 600/60 = 10 residents.
    const total = plan.targets.reduce((s, t) => s + (t.delta.residents ?? 0), 0);
    expect(total).toBeCloseTo(10, 8);
    // Equal split.
    expect(plan.targets[0].delta.residents).toBeCloseTo(5, 8);
    expect(plan.targets[1].delta.residents).toBeCloseTo(5, 8);
    expect(plan.aggregateDelta.residents).toBeCloseTo(10, 8);
  });

  it('weights closer points higher than farther ones (linear decay)', () => {
    const points = [
      point('near', 0, 100, 0, 0.0009),  // ~100m N — high weight
      point('far', 0, 100, 0, 0.0045),    // ~500m N — at radius edge, weight ~0
    ];
    const plan = computeDailyApply({
      deal: activeDeal(),
      currentDay: 1,
      walkshedPoints: points,
    });
    const near = plan.targets.find((t) => t.pointId === 'near');
    const far = plan.targets.find((t) => t.pointId === 'far');
    expect(near).toBeDefined();
    if (near && far) {
      expect(near.delta.residents!).toBeGreaterThan(far.delta.residents ?? 0);
    }
  });

  it('skips ghost-town points in distribution', () => {
    const points = [
      point('p1', 0, 200, 0, 0.001),
      point('ghost', 0, 0, 0, -0.001), // no residents
    ];
    const plan = computeDailyApply({
      deal: activeDeal(),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(plan.targets.length).toBe(1);
    expect(plan.targets[0].pointId).toBe('p1');
    // All 10 today goes to the one eligible point.
    expect(plan.targets[0].delta.residents).toBeCloseTo(10, 8);
  });

  it('catches up from missed days using cumulative schedule', () => {
    // Deal started day 1, 60-day duration, 600 total residents → 10/day.
    // Currently day 5 but appliedSoFar shows we only delivered 10 (one day's worth).
    // Today should apply (5/60 × 600) - 10 = 50 - 10 = 40 residents.
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({ appliedSoFar: { residents: 10, jobs: 0 } }),
      currentDay: 5,
      walkshedPoints: points,
    });
    expect(plan.aggregateDelta.residents).toBeCloseTo(40, 8);
  });

  it('marks completion on the final day of the deal', () => {
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({ startDay: 1, durationDays: 30 }),
      currentDay: 30, // start + duration - 1
      walkshedPoints: points,
    });
    expect(plan.marksCompletion).toBe(true);
  });

  it('does not mark completion mid-deal', () => {
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({ startDay: 1, durationDays: 30 }),
      currentDay: 15,
      walkshedPoints: points,
    });
    expect(plan.marksCompletion).toBe(false);
  });

  it('handles mixed deals: residents go to res-eligible points, jobs to jobs-eligible', () => {
    const points = [
      point('residential', 0, 500, 0, 0.001),  // residents only
      point('commercial', 500, 0, 0, -0.001),   // jobs only
      point('both', 200, 200, 0.001, 0),         // mixed
    ];
    const plan = computeDailyApply({
      deal: activeDeal({
        kind: 'mixed',
        totalDensity: { residents: 60, jobs: 90 }, // simplified for math
        durationDays: 30,
      }),
      currentDay: 1,
      walkshedPoints: points,
    });
    // Day 1 of 30: expected = 2 residents, 3 jobs.
    const totalRes = plan.targets.reduce((s, t) => s + (t.delta.residents ?? 0), 0);
    const totalJobs = plan.targets.reduce((s, t) => s + (t.delta.jobs ?? 0), 0);
    expect(totalRes).toBeCloseTo(2, 8);
    expect(totalJobs).toBeCloseTo(3, 8);
    // Residential point should not receive jobs.
    const res = plan.targets.find((t) => t.pointId === 'residential');
    expect(res?.delta.jobs).toBeUndefined();
    // Commercial point should not receive residents.
    const com = plan.targets.find((t) => t.pointId === 'commercial');
    expect(com?.delta.residents).toBeUndefined();
  });

  it('produces empty plan when nothing changes (e.g., deal already fully applied)', () => {
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({
        appliedSoFar: { residents: 10, jobs: 0 }, // equal to expected at day 1
      }),
      currentDay: 1,
      walkshedPoints: points,
    });
    // expected = 10, applied = 10, today = 0 → no targets.
    expect(plan.targets.length).toBe(0);
    expect(plan.aggregateDelta.residents).toBe(0);
  });
});
