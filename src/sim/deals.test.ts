import { describe, expect, it } from 'vitest';
import type { DemandPoint, LngLat } from '../types';
import {
  validateProposal,
  confirmProposal,
  computeDailyApply,
  DEFAULT_TIER_TABLE,
  DEVELOPMENT_COST_PER_JOB,
  DEVELOPMENT_COST_PER_RESIDENT,
  DEVELOPMENT_COST_ROUNDING,
  MIXED_DEVELOPMENT_COMPLEXITY_MULTIPLIER,
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
      budget: 1_000_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalCost).toBe(45_000_000);
    expect(r.totalDensity.residents).toBe(600);
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
      budget: 1_000_000_000,
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
      budget: 1_000_000_000,
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

  it('applies costMultiplier to totalCost and the funds check', () => {
    const points = [point('p1', 100, 200, 0, 0.001)];
    // Housing/L is normally $600M; at 1% it's $6M. Budget of $7M
    // wouldn't cover the original but easily covers the discounted.
    const r = validateProposal({
      kind: 'housing',
      tier: 'L',
      centerLngLat: CENTER,
      radiusMeters: 500,
      walkshedPoints: points,
      budget: 7_000_000,
      costMultiplier: 0.01,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalCost).toBe(6_000_000);
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

  it('every default density is a clean multiple of 200 (chunkable)', () => {
    for (const kind of ['housing', 'commercial', 'mixed'] as const) {
      for (const tier of ['S', 'M', 'L'] as const) {
        const t = DEFAULT_TIER_TABLE[kind][tier];
        expect(t.totalDensity.residents % 200).toBe(0);
        expect(t.totalDensity.jobs % 200).toBe(0);
      }
    }
  });

  it('mixed tiers approximate 70% of housing/commercial (within one chunk of 200)', () => {
    for (const tier of ['S', 'M', 'L'] as const) {
      const m = DEFAULT_TIER_TABLE.mixed[tier];
      const h = DEFAULT_TIER_TABLE.housing[tier];
      const c = DEFAULT_TIER_TABLE.commercial[tier];
      expect(Math.abs(m.totalDensity.residents - h.totalDensity.residents * 0.7)).toBeLessThan(200);
      expect(Math.abs(m.totalDensity.jobs - c.totalDensity.jobs * 0.7)).toBeLessThan(200);
    }
  });

  it('prices tiers around the residential $75k-per-person baseline', () => {
    expect(DEFAULT_TIER_TABLE.housing.S.cost).toBe(45_000_000);

    for (const tier of ['S', 'M', 'L'] as const) {
      const h = DEFAULT_TIER_TABLE.housing[tier];
      const c = DEFAULT_TIER_TABLE.commercial[tier];
      expect(h.cost / h.totalDensity.residents).toBe(DEVELOPMENT_COST_PER_RESIDENT);
      expect(c.cost / c.totalDensity.jobs).toBe(DEVELOPMENT_COST_PER_JOB);
    }
  });

  it('prices mixed tiers from blended residents/jobs plus the mixed complexity premium', () => {
    for (const tier of ['S', 'M', 'L'] as const) {
      const m = DEFAULT_TIER_TABLE.mixed[tier];
      const raw =
        (m.totalDensity.residents * DEVELOPMENT_COST_PER_RESIDENT +
          m.totalDensity.jobs * DEVELOPMENT_COST_PER_JOB) *
        MIXED_DEVELOPMENT_COMPLEXITY_MULTIPLIER;
      expect(m.cost).toBe(
        Math.round(raw / DEVELOPMENT_COST_ROUNDING) * DEVELOPMENT_COST_ROUNDING
      );
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
      centerStationGroupName: 'Test Station',
      centerLngLat: CENTER,
      radiusMeters: 500,
      idGenerator: () => `test-${++counter}`,
    });
    expect(deal.id).toBe('test-1');
    expect(deal.state).toBe('active');
    expect(deal.startDay).toBe(7);
    expect(deal.totalDensity).toEqual({ residents: 600, jobs: 0 });
    expect(deal.appliedSoFar).toEqual({ residents: 0, jobs: 0 });
    expect(deal.pending).toEqual({ residents: 0, jobs: 0 });
    expect(deal.durationDays).toBe(1); // housing/S default
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
    expect(v.totalCost).toBe(600_000_000);
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
      centerStationGroupName: 'Test Station',
      centerLngLat: CENTER,
      radiusMeters: 500,
      totalDensity: { residents: 600, jobs: 0 },
      totalCost: 150_000_000,
      startDay: 1,
      durationDays: 60,
      state: 'active',
      appliedSoFar: { residents: 0, jobs: 0 },
      pending: { residents: 0, jobs: 0 },
      ...overrides,
    };
  }

  it('accrues into pending on small ticks; materializes chunks once cumulative crosses chunkSize', () => {
    // 600-res deal over 6 days → 100 res/day. 1 walkshed point.
    // Day 1: pending 100, no chunks (floor(100/200) = 0).
    // Day 2: pending 200, 1 chunk → +200 to point.
    const points = [point('p1', 0, 1000, 0, 0.001)];
    const day1 = computeDailyApply({
      deal: activeDeal({ totalDensity: { residents: 600, jobs: 0 }, durationDays: 6 }),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(day1.targets.length).toBe(0);
    expect(day1.newPending.residents).toBeCloseTo(100, 8);

    // Pretend day 1's outcome was applied (appliedSoFar still 0 since
    // nothing materialized; pending carries the 100). On day 2 we
    // expect another 100 accrued, total pending 200, 1 chunk fires.
    const day2 = computeDailyApply({
      deal: activeDeal({
        totalDensity: { residents: 600, jobs: 0 },
        durationDays: 6,
        pending: day1.newPending,
      }),
      currentDay: 2,
      walkshedPoints: points,
    });
    expect(day2.targets.length).toBe(1);
    expect(day2.targets[0].delta.residents).toBe(200);
    expect(day2.newPending.residents).toBeCloseTo(0, 8);
    expect(day2.aggregateDelta.residents).toBe(200);
  });

  it('apportions chunks across multiple eligible walkshed points by weight', () => {
    // 800-res deal over 1 day = 4 chunks, 2 equal-weight points → 2 each.
    const points = [
      point('p1', 0, 100, 0, 0.001),
      point('p2', 0, 100, 0, -0.001),
    ];
    const plan = computeDailyApply({
      deal: activeDeal({ totalDensity: { residents: 800, jobs: 0 }, durationDays: 1 }),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(plan.aggregateDelta.residents).toBe(800);
    const p1 = plan.targets.find((t) => t.pointId === 'p1');
    const p2 = plan.targets.find((t) => t.pointId === 'p2');
    expect(p1?.delta.residents).toBe(400);
    expect(p2?.delta.residents).toBe(400);
  });

  it('skips ghost-town points in chunk distribution', () => {
    const points = [
      point('p1', 0, 200, 0, 0.001),
      point('ghost', 0, 0, 0, -0.001), // no residents
    ];
    const plan = computeDailyApply({
      deal: activeDeal({ totalDensity: { residents: 400, jobs: 0 }, durationDays: 1 }),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(plan.targets.length).toBe(1);
    expect(plan.targets[0].pointId).toBe('p1');
    expect(plan.targets[0].delta.residents).toBe(400);
  });

  it('catches up via expected − applied − pending so missed days don\'t over-accrue', () => {
    // Deal day 1 of 6, 600 total → 100/day. If we somehow pre-applied
    // 200 and have 0 pending, on day 1 we expect 100 expected − 200
    // applied − 0 pending = -100 → clamped to 0.
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({
        totalDensity: { residents: 600, jobs: 0 },
        durationDays: 6,
        appliedSoFar: { residents: 200, jobs: 0 },
      }),
      currentDay: 1,
      walkshedPoints: points,
    });
    // Already past expected, so today accrues 0; pending stays at 0.
    expect(plan.newPending.residents).toBe(0);
    expect(plan.targets.length).toBe(0);
  });

  it('marks completion on the final day of the deal', () => {
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({ startDay: 1, durationDays: 30 }),
      currentDay: 30,
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

  it('rounds residual UP to a chunk on the final day so the player gets ≥ what they paid for', () => {
    // Smaller-than-chunk deal that would otherwise deliver 0:
    // 100-res deal over 1 day. Final-day rounding: ceil(100/200) = 1.
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({ totalDensity: { residents: 100, jobs: 0 }, durationDays: 1 }),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(plan.marksCompletion).toBe(true);
    expect(plan.targets[0].delta.residents).toBe(200); // overshoots paid 100
  });

  it('handles mixed deals: chunks of residents and jobs route independently to eligible points', () => {
    const points = [
      point('residential', 0, 500, 0, 0.001),
      point('commercial', 500, 0, 0, -0.001),
      point('both', 200, 200, 0.001, 0),
    ];
    // Mixed deal sized so chunks materialize in one tick.
    const plan = computeDailyApply({
      deal: activeDeal({
        kind: 'mixed',
        totalDensity: { residents: 400, jobs: 600 },
        durationDays: 1,
      }),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(plan.aggregateDelta.residents).toBe(400); // 2 chunks
    expect(plan.aggregateDelta.jobs).toBe(600); // 3 chunks
    // Residential-only point should never see job chunks; vice versa.
    const res = plan.targets.find((t) => t.pointId === 'residential');
    expect(res?.delta.jobs).toBeUndefined();
    const com = plan.targets.find((t) => t.pointId === 'commercial');
    expect(com?.delta.residents).toBeUndefined();
  });

  it('produces empty plan when expected = applied + pending (already on schedule)', () => {
    const points = [point('p1', 0, 200, 0, 0.001)];
    const plan = computeDailyApply({
      deal: activeDeal({
        totalDensity: { residents: 600, jobs: 0 },
        durationDays: 6,
        appliedSoFar: { residents: 0, jobs: 0 },
        pending: { residents: 100, jobs: 0 }, // already accrued day 1
      }),
      currentDay: 1,
      walkshedPoints: points,
    });
    expect(plan.targets.length).toBe(0);
    expect(plan.newPending.residents).toBeCloseTo(100, 8);
  });
});
