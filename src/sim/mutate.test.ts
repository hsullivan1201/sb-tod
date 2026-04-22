import { describe, expect, it } from 'vitest';
import type { DemandData, DemandPoint, Pop } from '../types';
import { createMutator, SPLIT_POP_PREFIX } from './mutate';

function point(
  id: string,
  jobs: number,
  residents: number,
  popIds: string[] = []
): DemandPoint {
  return {
    id,
    location: [-122, 37],
    jobs,
    residents,
    popIds,
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

function pop(id: string, residenceId: string, jobId: string, size: number): Pop {
  return {
    id,
    size,
    residenceId,
    jobId,
    drivingSeconds: 0,
    drivingDistance: 0,
    homeDepartureTime: 0,
    workDepartureTime: 0,
    lastCommute: {
      modeChoice: { walking: 0, driving: 0, transit: 0, unknown: 0 },
      transitPaths: [],
      walking: { time: 0, distance: 0 },
    },
  };
}

function fixture(points: DemandPoint[], pops: Pop[]): DemandData {
  return {
    points: new Map(points.map((p) => [p.id, p])),
    popsMap: new Map(pops.map((p) => [p.id, p])),
  };
}

// ---------------------------------------------------------------------------
// (a) scaling: increasing residents at P scales residence-origin pops
// ---------------------------------------------------------------------------
describe('proportional Pop scaling (decision 1a)', () => {
  it('scales residence-origin pops by the residents ratio', () => {
    const P = point('P', /*jobs*/ 500, /*residents*/ 1000);
    const Q = point('Q', 200, 300);
    const pops = [
      pop('a', 'P', 'Q', 100), // lives at P
      pop('b', 'P', 'Q', 50),  // lives at P
      pop('c', 'Q', 'Q', 80),  // doesn't live at P
    ];
    const demand = fixture([P, Q], pops);
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { residents: 500 }, 'deals');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.affectedPops).toBe(2); // a and b live at P
    expect(P.residents).toBe(1500);
    expect(P.jobs).toBe(500); // unchanged

    // residentsRatio = 1500 / 1000 = 1.5
    expect(demand.popsMap.get('a')!.size).toBeCloseTo(150, 10);
    expect(demand.popsMap.get('b')!.size).toBeCloseTo(75, 10);
    expect(demand.popsMap.get('c')!.size).toBe(80); // untouched
  });

  it('scales job-destination pops by the jobs ratio', () => {
    const P = point('P', 1000, 500);
    const Q = point('Q', 200, 300);
    const pops = [
      pop('a', 'Q', 'P', 100), // works at P
      pop('b', 'Q', 'Q', 50),  // doesn't work at P
    ];
    const demand = fixture([P, Q], pops);
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { jobs: 500 }, 'deals');

    expect(r.ok).toBe(true);
    expect(P.jobs).toBe(1500);
    // jobsRatio = 1.5
    expect(demand.popsMap.get('a')!.size).toBeCloseTo(150, 10);
    expect(demand.popsMap.get('b')!.size).toBe(50);
  });

  it('compounds residence and jobs ratios for pops sharing a point', () => {
    const P = point('P', 1000, 1000);
    const pops = [pop('x', 'P', 'P', 100)]; // lives AND works at P
    const demand = fixture([P], pops);
    // Use Infinity so this math test isolates the compound-ratio logic
    // from the split logic. (Split behavior has its own tests below.)
    const m = createMutator(demand, { splitThreshold: Infinity });

    // Add 50% residents and 50% jobs to P.
    m.applyDensityDelta('P', { residents: 500 }, 'deals');
    m.applyDensityDelta('P', { jobs: 500 }, 'deals');

    // size = 100 * 1.5 * 1.5 = 225
    expect(demand.popsMap.get('x')!.size).toBeCloseTo(225, 10);
  });

  it('compounds across two different mutated points', () => {
    const P = point('P', 100, 1000);
    const Q = point('Q', 1000, 100);
    const pops = [pop('x', 'P', 'Q', 80)]; // lives at P, works at Q
    const demand = fixture([P, Q], pops);
    const m = createMutator(demand);

    m.applyDensityDelta('P', { residents: 1000 }, 'deals'); // P residents 1000→2000, ratio 2.0
    m.applyDensityDelta('Q', { jobs: 250 }, 'deals');       // Q jobs 1000→1250, ratio 1.25

    // size = 80 * 2.0 * 1.25 = 200
    expect(demand.popsMap.get('x')!.size).toBeCloseTo(200, 10);
  });
});

// ---------------------------------------------------------------------------
// (b) reversal exactness — no floating-point drift
// ---------------------------------------------------------------------------
describe('reversal exactness', () => {
  it('returns pop sizes to baseline bit-for-bit when delta is reversed', () => {
    const P = point('P', 500, 1000);
    const original = [
      { id: 'a', size: 0.1 + 0.2 }, // a notoriously messy float
      { id: 'b', size: 1234.567891234 },
      { id: 'c', size: 99.99999999 },
    ];
    const pops = original.map((o) => pop(o.id, 'P', 'P', o.size));
    const demand = fixture([P], pops);
    const m = createMutator(demand);

    // Add then subtract — fully reversed.
    m.applyDensityDelta('P', { residents: 333, jobs: 777 }, 'deals');
    m.applyDensityDelta('P', { residents: -333, jobs: -777 }, 'deals');

    // Cumulative net is exactly zero, so size = baseline * 1 * 1 = baseline.
    for (const o of original) {
      expect(demand.popsMap.get(o.id)!.size).toBe(o.size);
    }
    expect(P.residents).toBe(1000);
    expect(P.jobs).toBe(500);
  });

  it('revertAll restores every touched point and pop exactly', () => {
    const P = point('P', 500, 1000);
    const Q = point('Q', 800, 400);
    const pops = [
      pop('a', 'P', 'Q', 100),
      pop('b', 'P', 'P', 33.333),
      pop('c', 'Q', 'Q', 77.7),
    ];
    const demand = fixture([P, Q], pops);
    const m = createMutator(demand);

    m.applyDensityDelta('P', { residents: 250, jobs: 100 }, 'deals');
    m.applyDensityDelta('Q', { residents: -50, jobs: 200 }, 'organic');

    m.revertAll();

    expect(P.jobs).toBe(500);
    expect(P.residents).toBe(1000);
    expect(Q.jobs).toBe(800);
    expect(Q.residents).toBe(400);
    expect(demand.popsMap.get('a')!.size).toBe(100);
    expect(demand.popsMap.get('b')!.size).toBe(33.333);
    expect(demand.popsMap.get('c')!.size).toBe(77.7);
    // Cumulative deltas cleared.
    expect(m.getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
    expect(m.getCumulativeDeltaTotal('Q')).toEqual({ jobs: 0, residents: 0 });
  });

  it('round-trips through additive negative deltas across sources', () => {
    const P = point('P', 1000, 1000);
    const x = pop('x', 'P', 'P', 42);
    const demand = fixture([P], [x]);
    const m = createMutator(demand);

    m.applyDensityDelta('P', { residents: 200 }, 'deals');
    m.applyDensityDelta('P', { residents: 100 }, 'organic');
    m.applyDensityDelta('P', { residents: -200 }, 'deals');
    m.applyDensityDelta('P', { residents: -100 }, 'organic');

    expect(P.residents).toBe(1000);
    expect(demand.popsMap.get('x')!.size).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// (c) baseline anchoring — compounding across many small deltas matches
//     a single equivalent delta computed against baseline, not current
// ---------------------------------------------------------------------------
describe('baseline-anchored compounding', () => {
  it('many small deltas land on the same final size as one combined delta', () => {
    // Two parallel fixtures: one applies +10 residents fifty times,
    // the other applies +500 once. Pop sizes must match exactly.
    function build(): { demand: DemandData; pops: Pop[]; m: ReturnType<typeof createMutator> } {
      const P = point('P', 0, 1000);
      const ps = [
        pop('a', 'P', 'P', 10),
        pop('b', 'P', 'P', 73.31),
      ];
      const d = fixture([P], ps);
      return { demand: d, pops: ps, m: createMutator(d) };
    }

    const incremental = build();
    for (let i = 0; i < 50; i++) {
      const r = incremental.m.applyDensityDelta('P', { residents: 10 }, 'deals');
      expect(r.ok).toBe(true);
    }

    const oneShot = build();
    oneShot.m.applyDensityDelta('P', { residents: 500 }, 'deals');

    for (const id of ['a', 'b']) {
      const incSize = incremental.demand.popsMap.get(id)!.size;
      const oneSize = oneShot.demand.popsMap.get(id)!.size;
      expect(incSize).toBe(oneSize);
    }
  });

  it('does NOT scale by current size — alternating up and down stays stable', () => {
    // Naive (non-baseline) compounding would drift here because each
    // step would multiply by a different ratio computed off the
    // already-scaled current size. Baseline anchoring keeps the math exact.
    const P = point('P', 0, 1000);
    const x = pop('x', 'P', 'P', 100);
    const demand = fixture([P], [x]);
    const m = createMutator(demand);

    for (let i = 0; i < 20; i++) {
      m.applyDensityDelta('P', { residents: 200 }, 'deals');
      m.applyDensityDelta('P', { residents: -200 }, 'deals');
    }

    expect(P.residents).toBe(1000);
    expect(demand.popsMap.get('x')!.size).toBe(100);
  });

  it('baseline is captured at first touch and never overwritten', () => {
    const P = point('P', 100, 1000);
    const demand = fixture([P], [pop('x', 'P', 'P', 50)]);
    const m = createMutator(demand);

    // First mutation: baseline captured at residents=1000, jobs=100.
    m.applyDensityDelta('P', { residents: 500 }, 'deals');
    expect(m.getBaseline('P')).toEqual({ jobs: 100, residents: 1000 });

    // Subsequent mutations must NOT shift the baseline (it should still
    // anchor on 1000, even though current residents is now 1500).
    m.applyDensityDelta('P', { residents: 500 }, 'deals');
    expect(m.getBaseline('P')).toEqual({ jobs: 100, residents: 1000 });
    // Cumulative is now +1000; size = 50 * (1000+1000)/1000 = 100.
    expect(demand.popsMap.get('x')!.size).toBeCloseTo(100, 10);
  });
});

// ---------------------------------------------------------------------------
// (d) ghost-town rejection
// ---------------------------------------------------------------------------
describe('ghost-town rejection', () => {
  it('rejects positive residents delta on a point with zero baseline residents', () => {
    const P = point('P', 100, 0); // ghost town residentially
    const demand = fixture([P], [pop('x', 'Q', 'P', 10)]); // pop works here, doesn't live here
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { residents: 500 }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ghost-town-residents');
    expect(P.residents).toBe(0); // unchanged
    expect(P.jobs).toBe(100);
    expect(m.getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
  });

  it('rejects positive jobs delta on a point with zero baseline jobs', () => {
    const P = point('P', 0, 500); // ghost town commercially
    const demand = fixture([P], [pop('x', 'P', 'Q', 10)]);
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { jobs: 500 }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ghost-town-jobs');
    expect(P.jobs).toBe(0);
  });

  it('honors the configurable ghostTownThreshold', () => {
    const P = point('P', 100, 50); // residents below threshold of 100
    const demand = fixture([P], [pop('x', 'P', 'P', 10)]);
    const m = createMutator(demand, { ghostTownThreshold: 100 });

    const r = m.applyDensityDelta('P', { residents: 200 }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ghost-town-residents');
  });

  it('allows mixed deltas to partially succeed only if BOTH dimensions clear', () => {
    // This is the design choice: a mixed deal that has zero on one side
    // is fine, but if both sides have positive deltas, both must clear
    // their ghost-town gates. We reject the whole call if either fails
    // — atomicity matters for deal-application correctness.
    const P = point('P', 0, 500); // ghost town commercially
    const demand = fixture([P], [pop('x', 'P', 'P', 10)]);
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { jobs: 100, residents: 100 }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ghost-town-jobs');
    // Verify atomicity: NEITHER dimension was applied.
    expect(P.jobs).toBe(0);
    expect(P.residents).toBe(500);
    expect(m.getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
  });

  it('allows the positive delta on the populated dimension when the OTHER is zero', () => {
    const P = point('P', 0, 500); // ghost town commercially
    const demand = fixture([P], [pop('x', 'P', 'P', 10)]);
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { residents: 100 }, 'deals');
    expect(r.ok).toBe(true);
    expect(P.residents).toBe(600);
    expect(P.jobs).toBe(0); // not touched
  });

  it('rejects deltas that would drive a count below the floor', () => {
    const P = point('P', 100, 1000);
    const demand = fixture([P], [pop('x', 'P', 'P', 10)]);
    const m = createMutator(demand);

    const r = m.applyDensityDelta('P', { residents: -1500 }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('negative-result');
    expect(P.residents).toBe(1000); // rolled back
    expect(m.getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
  });
});

// ---------------------------------------------------------------------------
// Pop splitting — prevents mega-pops that exceed train capacity
// ---------------------------------------------------------------------------
describe('pop splitting', () => {
  it('splits a pop into N units when scaled size crosses the threshold', () => {
    // Baseline pop of 150, threshold 200. Scale to 3x → 450 → ceil(450/200) = 3 units of 150 each.
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 150);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    const r = m.applyDensityDelta('P', { residents: 200 }, 'deals');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.splitsCreated).toBe(2);
    expect(r.splitsRemoved).toBe(0);

    // Original plus 2 children, each 450/3 = 150.
    expect(demand.popsMap.size).toBe(3);
    expect(demand.popsMap.get('x')!.size).toBeCloseTo(150, 10);
    const childIds = [...demand.popsMap.keys()].filter((id) => id !== 'x');
    expect(childIds.length).toBe(2);
    for (const id of childIds) {
      expect(id.startsWith(SPLIT_POP_PREFIX)).toBe(true);
      expect(demand.popsMap.get(id)!.size).toBeCloseTo(150, 10);
      expect(demand.popsMap.get(id)!.residenceId).toBe('P');
      expect(demand.popsMap.get(id)!.jobId).toBe('P');
    }
  });

  it('adds child pop IDs to the residence AND job DemandPoint popIds arrays', () => {
    const P = point('P', 200, 100); // residence for x
    const Q = point('Q', 100, 100); // job for x
    const x = pop('x', 'P', 'Q', 150);
    const demand = fixture([P, Q], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    m.applyDensityDelta('P', { residents: 200 }, 'deals');

    const childIds = [...demand.popsMap.keys()].filter((id) => id !== 'x');
    // Both P and Q should carry the child IDs in their popIds.
    for (const cid of childIds) {
      expect(P.popIds).toContain(cid);
      expect(Q.popIds).toContain(cid);
    }
  });

  it('retires splits when the delta is reduced back below the threshold', () => {
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 150);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    m.applyDensityDelta('P', { residents: 200 }, 'deals'); // 3 units
    expect(demand.popsMap.size).toBe(3);

    const r = m.applyDensityDelta('P', { residents: -200 }, 'deals'); // back to baseline, 1 unit
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.splitsRemoved).toBe(2);
    expect(demand.popsMap.size).toBe(1);
    expect(demand.popsMap.get('x')!.size).toBe(150); // exact baseline
  });

  it('grows the split count when target scales further', () => {
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 150);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    m.applyDensityDelta('P', { residents: 100 }, 'deals'); // 150 * 2 = 300 → ceil(300/200) = 2 units
    expect(demand.popsMap.size).toBe(2);

    const r = m.applyDensityDelta('P', { residents: 900 }, 'deals'); // now 150 * 11 = 1650 → ceil(1650/200) = 9 units
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(demand.popsMap.size).toBe(9);
    // Each unit should be 1650 / 9 ≈ 183.33, well under threshold.
    for (const p of demand.popsMap.values()) {
      expect(p.size).toBeCloseTo(1650 / 9, 8);
      expect(p.size).toBeLessThanOrEqual(200);
    }
  });

  it('revertAll deletes all split children and restores the original pop size', () => {
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 150);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    m.applyDensityDelta('P', { residents: 500 }, 'deals');
    expect(demand.popsMap.size).toBeGreaterThan(1);
    const prevChildIds = [...demand.popsMap.keys()].filter((id) => id !== 'x');
    for (const cid of prevChildIds) expect(P.popIds).toContain(cid);

    m.revertAll();

    expect(demand.popsMap.size).toBe(1);
    expect(demand.popsMap.has('x')).toBe(true);
    expect(demand.popsMap.get('x')!.size).toBe(150);
    // Child ids are gone from the DemandPoint popIds.
    for (const cid of prevChildIds) expect(P.popIds).not.toContain(cid);
  });

  it('does not split when scaled size is at or below the threshold', () => {
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 100);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    m.applyDensityDelta('P', { residents: 100 }, 'deals'); // 100 * 2 = 200 → exactly threshold, 1 unit
    expect(demand.popsMap.size).toBe(1);
    expect(demand.popsMap.get('x')!.size).toBeCloseTo(200, 10);
  });

  it('legacy behavior: splitThreshold Infinity disables splitting entirely', () => {
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 100);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: Infinity });

    m.applyDensityDelta('P', { residents: 1000 }, 'deals'); // massive scale, would normally split
    expect(demand.popsMap.size).toBe(1);
    // With splitting disabled, the pop just carries the whole target size.
    expect(demand.popsMap.get('x')!.size).toBeCloseTo(1100, 8);
  });

  it('snapshot().splitChildren reflects the live set; hydrateTracking round-trips it', () => {
    const P = point('P', 0, 100);
    const x = pop('x', 'P', 'P', 150);
    const demand = fixture([P], [x]);
    const m = createMutator(demand, { splitThreshold: 200 });

    m.applyDensityDelta('P', { residents: 500 }, 'deals');
    const snap = m.snapshot();
    expect(snap.splitChildren.get('x')?.length).toBeGreaterThan(0);

    // Build a fresh mutator over the same demand and hydrate it.
    const m2 = createMutator(demand, { splitThreshold: 200 });
    m2.hydrateTracking(snap);
    const snap2 = m2.snapshot();
    expect([...snap2.splitChildren.get('x')!]).toEqual([...snap.splitChildren.get('x')!]);
  });
});

// ---------------------------------------------------------------------------
// Strict unit-size mode — production setting where every pop is size 200
// ---------------------------------------------------------------------------
describe('strict unit-size mode', () => {
  it('keeps every pop at exactly strictUnitSize regardless of scale', () => {
    const P = point('P', 0, 600);
    const pops = [
      pop('a', 'P', 'P', 200),
      pop('b', 'P', 'P', 200),
      pop('c', 'P', 'P', 200),
    ];
    const demand = fixture([P], pops);
    const m = createMutator(demand, { strictUnitSize: 200 });

    // Scale residents by 3x: each pop's continuous target is 600,
    // round(600/200) = 3 units of 200 each per origin. 3 origins × 3
    // units = 9 pops total.
    m.applyDensityDelta('P', { residents: 1200 }, 'deals');

    expect(demand.popsMap.size).toBe(9);
    for (const p of demand.popsMap.values()) {
      expect(p.size).toBe(200);
    }
  });

  it('rounds the per-origin unit count to nearest, never below 1', () => {
    const P = point('P', 0, 600);
    const pops = [pop('x', 'P', 'P', 200)];
    const demand = fixture([P], pops);
    const m = createMutator(demand, { strictUnitSize: 200 });

    // +200 res on baseline 600 → ratio 1.333, target = 200 * 1.333 = 266.67
    // round(266.67/200) = round(1.333) = 1 (round half up only kicks in
    // at exact .5, and 1.333 rounds down). So we stay at 1 pop.
    m.applyDensityDelta('P', { residents: 200 }, 'deals');
    expect(demand.popsMap.size).toBe(1);
    expect(demand.popsMap.get('x')!.size).toBe(200);

    // +600 res → ratio 2.0, target = 400, round(2.0) = 2 units.
    m.applyDensityDelta('P', { residents: 400 }, 'deals'); // cumulative now +600
    expect(demand.popsMap.size).toBe(2);
    for (const p of demand.popsMap.values()) expect(p.size).toBe(200);
  });

  it('reverts cleanly back to the single original pop at strictUnitSize', () => {
    const P = point('P', 0, 200);
    const pops = [pop('x', 'P', 'P', 200)];
    const demand = fixture([P], pops);
    const m = createMutator(demand, { strictUnitSize: 200 });

    m.applyDensityDelta('P', { residents: 800 }, 'deals'); // 5x → 5 units
    expect(demand.popsMap.size).toBe(5);

    m.applyDensityDelta('P', { residents: -800 }, 'deals'); // back to baseline
    expect(demand.popsMap.size).toBe(1);
    expect(demand.popsMap.get('x')!.size).toBe(200);
  });

  it('never deletes the original pop, even on deep negative deltas', () => {
    // ghostTownThreshold default = 0; minFloor default = 0. A -100 res
    // delta on a baseline-200 point sets target to 100, which would
    // round(100/200) to round(0.5) = 1 (round half-to-even gives 0 in
    // some impls but Math.round in JS rounds .5 toward +Infinity → 1).
    // Either way our max(1, ...) guards against zero.
    const P = point('P', 0, 200);
    const pops = [pop('x', 'P', 'P', 200)];
    const demand = fixture([P], pops);
    const m = createMutator(demand, { strictUnitSize: 200, minFloor: 0 });

    m.applyDensityDelta('P', { residents: -100 }, 'deals');
    expect(demand.popsMap.size).toBe(1);
    expect(demand.popsMap.has('x')).toBe(true);
    expect(demand.popsMap.get('x')!.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------
describe('mutator surface', () => {
  it('rejects unknown points without mutating anything', () => {
    const P = point('P', 100, 100);
    const demand = fixture([P], []);
    const m = createMutator(demand);
    const r = m.applyDensityDelta('NOPE', { residents: 10 }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-point');
  });

  it('rejects non-finite deltas', () => {
    const P = point('P', 100, 100);
    const demand = fixture([P], []);
    const m = createMutator(demand);
    const r = m.applyDensityDelta('P', { residents: NaN }, 'deals');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('nan-delta');
  });

  it('tags mutated points as self-writes for the onDemandChange handler', () => {
    const P = point('P', 100, 100);
    const demand = fixture([P], []);
    const m = createMutator(demand);
    expect(m.isTaggedWrite(P)).toBe(false);
    m.applyDensityDelta('P', { residents: 10 }, 'deals');
    expect(m.isTaggedWrite(P)).toBe(true);
  });

  it('keeps deal and organic deltas in separate buckets', () => {
    const P = point('P', 1000, 1000);
    const demand = fixture([P], []);
    const m = createMutator(demand);
    m.applyDensityDelta('P', { residents: 100 }, 'deals');
    m.applyDensityDelta('P', { residents: 50 }, 'organic');
    const cum = m.getCumulativeDelta('P')!;
    expect(cum.residents.fromDeals).toBe(100);
    expect(cum.residents.fromOrganic).toBe(50);
    expect(m.getCumulativeDeltaTotal('P').residents).toBe(150);
  });

  it('captureBaselines snapshots all current points and pops idempotently', () => {
    const P = point('P', 100, 200);
    const x = pop('x', 'P', 'P', 25);
    const demand = fixture([P], [x]);
    const m = createMutator(demand);

    m.captureBaselines();
    expect(m.getBaseline('P')).toEqual({ jobs: 100, residents: 200 });
    expect(m.snapshot().baselinePopSizes.get('x')).toBe(25);

    // Second call must not overwrite — even if we hand-mutated state.
    P.jobs = 999;
    x.size = 999;
    m.captureBaselines();
    expect(m.getBaseline('P')).toEqual({ jobs: 100, residents: 200 });
    expect(m.snapshot().baselinePopSizes.get('x')).toBe(25);
  });
});
