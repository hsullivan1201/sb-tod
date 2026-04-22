/**
 * SB TOD — DemandMutator
 *
 * The single seam through which TOD writes touch game demand state.
 *
 * Implements decision 1a from ARCHITECTURE.md: proportional Pop scaling
 * anchored on captured baselines. Mutating a DemandPoint's `jobs` or
 * `residents` aggregate without also rescaling its associated Pops would
 * be cosmetic — the sim iterates Pops, not aggregates, so trips wouldn't
 * actually change. We do BOTH on every call.
 *
 * Math contract:
 *   pop.size = pop.baselineSize × residenceRatio × jobRatio
 * where for any point P,
 *   ratio(P, dimension) = (baseline + cumulativeDelta) / baseline
 *
 * Anchoring on baseline (not current) gives exact reversibility under
 * floating point: applying +N then -N restores pop.size to baseline
 * bit-for-bit, with no compounding drift.
 *
 * Tagged writes: mutated DemandPoints are tracked in a WeakSet so the
 * `onDemandChange` handler can ignore self-emissions and avoid the
 * unbounded feedback loop that would result from reacting to our own
 * writes (the game fires onDemandChange ~49× per game day even at rest).
 */

import type { DemandData, DemandPoint, Pop, PointDelta } from '../types';

export type DeltaSourceKind = 'deals' | 'organic';

export interface DemandDelta {
  jobs?: number;
  residents?: number;
}

export interface ApplyOk {
  ok: true;
  pointId: string;
  /** What this individual call added to the cumulative buckets. */
  appliedDelta: { jobs: number; residents: number };
  /** Number of pops whose size was rescaled. */
  affectedPops: number;
  /** Total cumulative delta on this point after the call (sum of all sources). */
  cumulativeDelta: { jobs: number; residents: number };
}

export type ApplyFailReason =
  | 'unknown-point'
  | 'ghost-town-residents'
  | 'ghost-town-jobs'
  | 'nan-delta'
  | 'negative-result';

export interface ApplyErr {
  ok: false;
  pointId: string;
  reason: ApplyFailReason;
  message: string;
}

export type ApplyResult = ApplyOk | ApplyErr;

export interface MutatorOptions {
  /**
   * A point with baseline below this in a dimension cannot receive a
   * positive delta in that dimension. Default 0 — any baseline > 0 is
   * eligible. Tunable upward to require minimum density before deals.
   */
  ghostTownThreshold?: number;
  /**
   * Lower clamp for the post-mutation jobs / residents value on a point.
   * Default 0 — a delta that would drive a point's count below this is
   * rejected wholesale (the mutation is rolled back). No silent clamping.
   */
  minFloor?: number;
}

export interface MutatorSnapshot {
  baselineDemand: ReadonlyMap<string, { jobs: number; residents: number }>;
  baselinePopSizes: ReadonlyMap<string, number>;
  cumulativeDeltas: ReadonlyMap<string, PointDelta>;
}

export interface DemandMutator {
  /**
   * Apply an incremental density delta to a point. Updates the point's
   * aggregates AND rescales every pop whose residence or job is at this
   * point, baseline-anchored. Returns a result; does not throw on
   * validation failures.
   */
  applyDensityDelta(
    pointId: string,
    delta: DemandDelta,
    source: DeltaSourceKind
  ): ApplyResult;

  getBaseline(pointId: string): { jobs: number; residents: number } | undefined;
  getCumulativeDelta(pointId: string): PointDelta | undefined;
  getCumulativeDeltaTotal(pointId: string): { jobs: number; residents: number };

  /** True if the given point reference was last written by this mutator. */
  isTaggedWrite(point: DemandPoint): boolean;

  /**
   * Snapshot baselines for every current point and pop. Idempotent —
   * already-captured entries are not overwritten. Call once at game
   * load before any mutation.
   */
  captureBaselines(): void;

  /**
   * Restore every touched point and pop to its captured baseline.
   * Clears all cumulative deltas. Touched-but-since-deleted entities
   * are silently skipped.
   */
  revertAll(): void;

  /** Read-only view for persistence and tests. */
  snapshot(): MutatorSnapshot;
}

function emptyPointDelta(): PointDelta {
  return {
    jobs: { fromDeals: 0, fromOrganic: 0 },
    residents: { fromDeals: 0, fromOrganic: 0 },
  };
}

function totalOf(d: PointDelta): { jobs: number; residents: number } {
  return {
    jobs: d.jobs.fromDeals + d.jobs.fromOrganic,
    residents: d.residents.fromDeals + d.residents.fromOrganic,
  };
}

const sourceField: Record<DeltaSourceKind, 'fromDeals' | 'fromOrganic'> = {
  deals: 'fromDeals',
  organic: 'fromOrganic',
};

export function createMutator(
  demand: DemandData,
  options: MutatorOptions = {}
): DemandMutator {
  const ghostTownThreshold = options.ghostTownThreshold ?? 0;
  const minFloor = options.minFloor ?? 0;

  const baselineDemand = new Map<string, { jobs: number; residents: number }>();
  const baselinePopSizes = new Map<string, number>();
  const cumulativeDeltas = new Map<string, PointDelta>();
  const tagged = new WeakSet<DemandPoint>();

  function ensurePointBaseline(point: DemandPoint): { jobs: number; residents: number } {
    let baseline = baselineDemand.get(point.id);
    if (!baseline) {
      baseline = { jobs: point.jobs, residents: point.residents };
      baselineDemand.set(point.id, baseline);
    }
    return baseline;
  }

  function ensurePopBaseline(pop: Pop): number {
    let baseline = baselinePopSizes.get(pop.id);
    if (baseline === undefined) {
      baseline = pop.size;
      baselinePopSizes.set(pop.id, baseline);
    }
    return baseline;
  }

  function getOrInitCumulative(pointId: string): PointDelta {
    let cum = cumulativeDeltas.get(pointId);
    if (!cum) {
      cum = emptyPointDelta();
      cumulativeDeltas.set(pointId, cum);
    }
    return cum;
  }

  function residentsRatioFor(pointId: string): number {
    const baseline = baselineDemand.get(pointId);
    const cum = cumulativeDeltas.get(pointId);
    if (!baseline || !cum || baseline.residents <= 0) return 1;
    const total = cum.residents.fromDeals + cum.residents.fromOrganic;
    return (baseline.residents + total) / baseline.residents;
  }

  function jobsRatioFor(pointId: string): number {
    const baseline = baselineDemand.get(pointId);
    const cum = cumulativeDeltas.get(pointId);
    if (!baseline || !cum || baseline.jobs <= 0) return 1;
    const total = cum.jobs.fromDeals + cum.jobs.fromOrganic;
    return (baseline.jobs + total) / baseline.jobs;
  }

  function applyDensityDelta(
    pointId: string,
    delta: DemandDelta,
    source: DeltaSourceKind
  ): ApplyResult {
    const point = demand.points.get(pointId);
    if (!point) {
      return {
        ok: false,
        pointId,
        reason: 'unknown-point',
        message: `DemandPoint "${pointId}" not found`,
      };
    }

    const dJobs = delta.jobs ?? 0;
    const dRes = delta.residents ?? 0;

    if (!Number.isFinite(dJobs) || !Number.isFinite(dRes)) {
      return {
        ok: false,
        pointId,
        reason: 'nan-delta',
        message: `non-finite delta { jobs: ${dJobs}, residents: ${dRes} }`,
      };
    }

    if (dJobs === 0 && dRes === 0) {
      // No-op: capture baseline so callers see consistent state, but skip
      // the pop scan and the tagged-write side effect.
      ensurePointBaseline(point);
      const cum = getOrInitCumulative(pointId);
      const totals = totalOf(cum);
      return {
        ok: true,
        pointId,
        appliedDelta: { jobs: 0, residents: 0 },
        affectedPops: 0,
        cumulativeDelta: totals,
      };
    }

    const baseline = ensurePointBaseline(point);

    // Ghost-town guard: proportional scaling can't bootstrap density at
    // a point with no pops in the relevant dimension. Reject *positive*
    // deltas there. (Negative deltas on zero are nonsensical but harmless;
    // we let them through and the negative-result guard below will
    // typically catch them.)
    if (dRes > 0 && baseline.residents <= ghostTownThreshold) {
      return {
        ok: false,
        pointId,
        reason: 'ghost-town-residents',
        message: `point "${pointId}" baseline residents (${baseline.residents}) <= threshold (${ghostTownThreshold}); proportional scaling cannot create density from zero`,
      };
    }
    if (dJobs > 0 && baseline.jobs <= ghostTownThreshold) {
      return {
        ok: false,
        pointId,
        reason: 'ghost-town-jobs',
        message: `point "${pointId}" baseline jobs (${baseline.jobs}) <= threshold (${ghostTownThreshold}); proportional scaling cannot create density from zero`,
      };
    }

    const cum = getOrInitCumulative(pointId);
    const field = sourceField[source];

    // Tentatively apply the delta to cumulative buckets, then validate
    // the resulting total. Roll back on rejection so caller-visible state
    // never partially-mutates.
    cum.jobs[field] += dJobs;
    cum.residents[field] += dRes;
    const totals = totalOf(cum);
    const nextJobs = baseline.jobs + totals.jobs;
    const nextRes = baseline.residents + totals.residents;
    if (nextJobs < minFloor || nextRes < minFloor) {
      cum.jobs[field] -= dJobs;
      cum.residents[field] -= dRes;
      const which = nextRes < minFloor ? 'residents' : 'jobs';
      const v = nextRes < minFloor ? nextRes : nextJobs;
      return {
        ok: false,
        pointId,
        reason: 'negative-result',
        message: `would drive ${which} to ${v}, below floor ${minFloor}`,
      };
    }

    // Rescale every pop whose residence OR job is at this point. A pop
    // whose other side is at a different mutated point is recomputed as
    // the full product over both ratios; non-mutated points contribute 1.
    let affected = 0;
    for (const pop of demand.popsMap.values()) {
      const homeAtP = pop.residenceId === pointId;
      const jobAtP = pop.jobId === pointId;
      if (!homeAtP && !jobAtP) continue;

      const baselineSize = ensurePopBaseline(pop);
      const rRatio = residentsRatioFor(pop.residenceId);
      const jRatio = jobsRatioFor(pop.jobId);
      pop.size = baselineSize * rRatio * jRatio;
      affected++;
    }

    point.jobs = nextJobs;
    point.residents = nextRes;
    tagged.add(point);

    return {
      ok: true,
      pointId,
      appliedDelta: { jobs: dJobs, residents: dRes },
      affectedPops: affected,
      cumulativeDelta: totals,
    };
  }

  function captureBaselines(): void {
    for (const point of demand.points.values()) {
      ensurePointBaseline(point);
    }
    for (const pop of demand.popsMap.values()) {
      ensurePopBaseline(pop);
    }
  }

  function revertAll(): void {
    for (const [pointId, baseline] of baselineDemand) {
      const point = demand.points.get(pointId);
      if (!point) continue;
      point.jobs = baseline.jobs;
      point.residents = baseline.residents;
      tagged.add(point);
    }
    for (const [popId, baseline] of baselinePopSizes) {
      const pop = demand.popsMap.get(popId);
      if (!pop) continue;
      pop.size = baseline;
    }
    cumulativeDeltas.clear();
  }

  return {
    applyDensityDelta,
    getBaseline(pointId) {
      const b = baselineDemand.get(pointId);
      return b ? { jobs: b.jobs, residents: b.residents } : undefined;
    },
    getCumulativeDelta(pointId) {
      return cumulativeDeltas.get(pointId);
    },
    getCumulativeDeltaTotal(pointId) {
      const cum = cumulativeDeltas.get(pointId);
      return cum ? totalOf(cum) : { jobs: 0, residents: 0 };
    },
    isTaggedWrite(point) {
      return tagged.has(point);
    },
    captureBaselines,
    revertAll,
    snapshot() {
      return {
        baselineDemand,
        baselinePopSizes,
        cumulativeDeltas,
      };
    },
  };
}
