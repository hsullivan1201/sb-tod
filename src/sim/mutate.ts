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
 * Pop splitting
 * -------------
 * The naïve version above produces pops of arbitrary size when deltas
 * are large. The game's pop-as-atomic-boarding-unit model then breaks:
 * a pop of 2000 commuters can't board any single train, so everyone
 * just stacks up at the platform. We observed this in-game testing a
 * mega-development (3 pops of size ~1967 on one point).
 *
 * Solution: when a pop's scaled size exceeds `splitThreshold`, clone
 * the pop N times (same residenceId, jobId, timing, mode share, etc.),
 * each with size = target / N. All N units board independently. The
 * original pop stays in popsMap as one of the N units; we track the
 * derived children in `splitChildren`.
 *
 * Reversal: setting the cumulative delta back to zero yields a target
 * size at or below baseline, which is always ≤ threshold (we assume
 * baselines are boardable — the game authored them that way). So
 * splits collapse cleanly back to a single pop on revert.
 *
 * Tagged writes: mutated DemandPoints are tracked in a WeakSet so the
 * `onDemandChange` handler can ignore self-emissions and avoid the
 * unbounded feedback loop that would result from reacting to our own
 * writes (the game fires onDemandChange ~49× per game day even at rest).
 */

import type { DemandData, DemandPoint, Pop, PointDelta } from '../types';

export type DeltaSourceKind = 'deals' | 'organic';

export const SPLIT_POP_PREFIX = 'sb-tod-split:';

export interface DemandDelta {
  jobs?: number;
  residents?: number;
}

export interface ApplyOk {
  ok: true;
  pointId: string;
  /** What this individual call added to the cumulative buckets. */
  appliedDelta: { jobs: number; residents: number };
  /** Number of original pops whose group size was recomputed. */
  affectedPops: number;
  /** Number of new split children created this call. */
  splitsCreated: number;
  /** Number of split children retired this call (due to delta shrinking). */
  splitsRemoved: number;
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
  /**
   * When a pop's scaled size exceeds this, clone it into N sub-pops so
   * each one boards atomically. Default 200 — matches the game's own
   * pop granularity (every game-authored Pop has size 200), so split
   * children look indistinguishable from natural pops to the rest of
   * the simulation. Set to Infinity to disable splitting (legacy
   * single-pop behavior). Ignored when `strictUnitSize` is set.
   */
  splitThreshold?: number;
  /**
   * Force every pop produced by the mutator (originals + children) to
   * exactly this size. Number of units per origin pop is
   * `max(1, round(target / strictUnitSize))`, where target is the
   * baseline-anchored continuous size. The DemandPoint aggregate stays
   * tied to the user-requested cumulative delta — so sum-of-pop-sizes
   * may differ from `point.residents` by up to ±strictUnitSize/2.
   *
   * Production passes 200 here so all pops match the game's natural
   * granularity. Tests usually leave this unset to isolate the math
   * from the rounding discipline.
   */
  strictUnitSize?: number;
}

export interface MutatorSnapshot {
  baselineDemand: ReadonlyMap<string, { jobs: number; residents: number }>;
  baselinePopSizes: ReadonlyMap<string, number>;
  cumulativeDeltas: ReadonlyMap<string, PointDelta>;
  /** originalPopId → list of split child pop IDs currently live in popsMap. */
  splitChildren: ReadonlyMap<string, string[]>;
}

export interface DemandMutator {
  /**
   * Apply an incremental density delta to a point. Updates the point's
   * aggregates AND rescales every pop whose residence or job is at this
   * point, baseline-anchored. May create or retire split children as
   * the post-mutation size crosses `splitThreshold`. Returns a result;
   * does not throw on validation failures.
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
   * Restore every touched point and pop to its captured baseline AND
   * delete every split child from popsMap / DemandPoint.popIds. Clears
   * all cumulative deltas.
   */
  revertAll(): void;

  /** Read-only view for persistence and tests. */
  snapshot(): MutatorSnapshot;

  /**
   * Hydrate tracking state (baselines + cumulative deltas + split
   * children) from a previously-captured snapshot WITHOUT applying
   * deltas to live demand. Use this when the game itself preserved
   * our mutations across save/load — the aggregates, pop sizes, and
   * split pop entries are already correct in `demand`, we just need
   * to re-establish our tracking.
   * Clears any existing tracking state first (last-write-wins).
   */
  hydrateTracking(persisted: {
    baselineDemand: Iterable<readonly [string, { jobs: number; residents: number }]>;
    baselinePopSizes: Iterable<readonly [string, number]>;
    cumulativeDeltas: Iterable<readonly [string, PointDelta]>;
    splitChildren?: Iterable<readonly [string, string[]]>;
  }): void;
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

function isSplitChildId(id: string): boolean {
  return id.startsWith(SPLIT_POP_PREFIX);
}

/**
 * Largest-fractional-remainder apportionment. Distributes `total`
 * units across items proportional to their `weight`, with each item
 * getting an integer count. The total is exact: ∑ result = total.
 *
 * Example: weights [2, 1, 1], total = 4
 *   exact = [2.0, 1.0, 1.0] → all integer → [2, 1, 1]
 *
 * Example: weights [1, 1, 1], total = 4
 *   exact = [1.33, 1.33, 1.33] → floors [1, 1, 1] = 3 allocated
 *   leftover = 1, distributed to highest-remainder → [2, 1, 1]
 */
function apportionLargestRemainder(
  items: Array<{ id: string; weight: number }>,
  total: number
): Map<string, number> {
  const result = new Map<string, number>();
  const sumWeight = items.reduce((s, i) => s + i.weight, 0);
  if (sumWeight <= 0 || total <= 0 || items.length === 0) {
    for (const i of items) result.set(i.id, 0);
    return result;
  }
  const remainders: Array<{ id: string; remainder: number }> = [];
  let allocated = 0;
  for (const item of items) {
    const exact = (item.weight / sumWeight) * total;
    const base = Math.floor(exact);
    result.set(item.id, base);
    allocated += base;
    remainders.push({ id: item.id, remainder: exact - base });
  }
  remainders.sort((a, b) => b.remainder - a.remainder);
  let leftover = total - allocated;
  let idx = 0;
  while (leftover > 0 && remainders.length > 0) {
    const winner = remainders[idx % remainders.length].id;
    result.set(winner, (result.get(winner) ?? 0) + 1);
    leftover--;
    idx++;
  }
  return result;
}

export function createMutator(
  demand: DemandData,
  options: MutatorOptions = {}
): DemandMutator {
  const ghostTownThreshold = options.ghostTownThreshold ?? 0;
  const minFloor = options.minFloor ?? 0;
  const splitThreshold = options.splitThreshold ?? 200;
  const strictUnitSize = options.strictUnitSize; // undefined = fractional mode

  const baselineDemand = new Map<string, { jobs: number; residents: number }>();
  const baselinePopSizes = new Map<string, number>();
  const cumulativeDeltas = new Map<string, PointDelta>();
  const splitChildren = new Map<string, string[]>();
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

  function addPopIdToPoint(pointId: string, popId: string): void {
    const pt = demand.points.get(pointId);
    if (!pt) return;
    if (!pt.popIds.includes(popId)) {
      pt.popIds = [...pt.popIds, popId];
      tagged.add(pt);
    }
  }

  function removePopIdFromPoint(pointId: string, popId: string): void {
    const pt = demand.points.get(pointId);
    if (!pt) return;
    if (pt.popIds.includes(popId)) {
      pt.popIds = pt.popIds.filter((id) => id !== popId);
      tagged.add(pt);
    }
  }

  function nextChildId(originalId: string, takenIndex: number): string {
    // Base format: sb-tod-split:<originalId>:<n>. If that's already
    // in popsMap (shouldn't happen but we're defensive), bump.
    let id = `${SPLIT_POP_PREFIX}${originalId}:${takenIndex}`;
    let bump = 0;
    while (demand.popsMap.has(id)) {
      bump++;
      id = `${SPLIT_POP_PREFIX}${originalId}:${takenIndex}:${bump}`;
    }
    return id;
  }

  /**
   * Reconcile one pop's split group to a target total size.
   *
   * Total is distributed evenly across N units (original pop + N−1
   * children). Children are created or retired as needed so live
   * popsMap matches the desired N.
   *
   * The effective per-unit ceiling is `max(splitThreshold, baselineSize)`.
   * Rationale: the game authored this pop at baselineSize, so we assume
   * that size is already boardable (otherwise the base game is broken).
   * Splitting below the game's own granularity creates churn on reverse:
   * target = baseline at zero delta, and we'd otherwise fragment the
   * original pop into a bunch of tiny pieces. With this ceiling, reverse
   * always collapses cleanly back to 1 unit at exactly baselineSize.
   */
  function reconcilePopGroup(
    originalPop: Pop,
    targetTotalSize: number,
    baselineSize: number
  ): { created: number; removed: number } {
    let totalUnits: number;
    let perUnitSize: number;
    if (strictUnitSize !== undefined && strictUnitSize > 0) {
      // Strict mode: every pop is exactly strictUnitSize. Round the
      // continuous target to the nearest integer multiple. A target of
      // 0.5×strictUnitSize rounds to 1 unit (max(1, ...)) — we never
      // delete the original pop entirely, even if a deep negative
      // delta would suggest 0 units.
      totalUnits = Math.max(1, Math.round(targetTotalSize / strictUnitSize));
      perUnitSize = strictUnitSize;
    } else {
      // Fractional mode: distribute the continuous target across
      // ceil(target / threshold) units. Ceiling on max(threshold,
      // baseline) keeps us from fragmenting below the game's own
      // baseline granularity (see split design comment above).
      const effectiveThreshold = Math.max(splitThreshold, baselineSize);
      totalUnits = Math.max(1, Math.ceil(targetTotalSize / effectiveThreshold));
      perUnitSize = targetTotalSize / totalUnits;
    }
    const desiredChildCount = totalUnits - 1;

    // Load existing children, dropping any that have since disappeared
    // from popsMap (game reset, manual deletion, etc.).
    const existing = (splitChildren.get(originalPop.id) ?? []).filter((id) =>
      demand.popsMap.has(id)
    );

    let created = 0;
    let removed = 0;

    // Shrink if too many.
    while (existing.length > desiredChildCount) {
      const childId = existing.pop()!;
      demand.popsMap.delete(childId);
      removePopIdFromPoint(originalPop.residenceId, childId);
      if (originalPop.jobId !== originalPop.residenceId) {
        removePopIdFromPoint(originalPop.jobId, childId);
      }
      removed++;
    }

    // Grow if too few.
    while (existing.length < desiredChildCount) {
      const childId = nextChildId(originalPop.id, existing.length);
      const childPop: Pop = {
        ...originalPop,
        id: childId,
        size: 0, // will be set below
      };
      demand.popsMap.set(childId, childPop);
      addPopIdToPoint(originalPop.residenceId, childId);
      if (originalPop.jobId !== originalPop.residenceId) {
        addPopIdToPoint(originalPop.jobId, childId);
      }
      existing.push(childId);
      created++;
    }

    if (existing.length > 0) splitChildren.set(originalPop.id, existing);
    else splitChildren.delete(originalPop.id);

    // Apply per-unit size. In strict mode every unit (including the
    // original pop) is set to exactly strictUnitSize. In fractional
    // mode each unit gets target / totalUnits — see the branch above.
    originalPop.size = perUnitSize;
    for (const id of existing) {
      const child = demand.popsMap.get(id);
      if (child) child.size = perUnitSize;
    }

    return { created, removed };
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
        splitsCreated: 0,
        splitsRemoved: 0,
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

    // First find the ORIGINAL pops affected by this mutation. Snapshot
    // to an array so we don't reprocess split children we create during
    // the loop (Map iteration includes entries added mid-iteration).
    const affectedOriginals: Pop[] = [];
    for (const pop of demand.popsMap.values()) {
      if (isSplitChildId(pop.id)) continue;
      const homeAtP = pop.residenceId === pointId;
      const jobAtP = pop.jobId === pointId;
      if (!homeAtP && !jobAtP) continue;
      affectedOriginals.push(pop);
    }
    // Capture baselines for affected pops up front so the apportionment
    // weights have access to them whether we go strict or fractional.
    for (const pop of affectedOriginals) ensurePopBaseline(pop);

    let totalCreated = 0;
    let totalRemoved = 0;

    if (strictUnitSize !== undefined && strictUnitSize > 0) {
      // PER-POINT apportionment in strict mode. Total pops at the point
      // = floor(point.residents / unitSize) (and same for jobs). Extras
      // are apportioned across origin pops by their baseline size using
      // largest-fractional-remainder. Each pop's actual child count is
      // the max of the residence-side and jobs-side allocations (one
      // child satisfies both).
      const r = reconcilePointStrict(pointId, affectedOriginals);
      totalCreated += r.created;
      totalRemoved += r.removed;
    } else {
      // Fractional mode: existing per-origin scaling.
      for (const pop of affectedOriginals) {
        const baselineSize = baselinePopSizes.get(pop.id) ?? pop.size;
        const rRatio = residentsRatioFor(pop.residenceId);
        const jRatio = jobsRatioFor(pop.jobId);
        const target = baselineSize * rRatio * jRatio;
        const { created, removed } = reconcilePopGroup(pop, target, baselineSize);
        totalCreated += created;
        totalRemoved += removed;
      }
    }

    point.jobs = nextJobs;
    point.residents = nextRes;
    tagged.add(point);

    return {
      ok: true,
      pointId,
      appliedDelta: { jobs: dJobs, residents: dRes },
      affectedPops: affectedOriginals.length,
      splitsCreated: totalCreated,
      splitsRemoved: totalRemoved,
      cumulativeDelta: totals,
    };
  }

  /**
   * Strict-mode reconciliation: drives pop counts at the point level
   * rather than per-origin. Total pops at the point = floor(target /
   * unitSize), apportioned across origins by baseline size using
   * largest-fractional-remainder. Each origin's child count is the
   * larger of its residence-share and jobs-share allocations.
   *
   * Note: this only reconciles `pointId`. A child added here also
   * lives at the origin's OTHER point (residence ≠ jobId case);
   * that other point's pop totals shift but won't be reconciled
   * until it's mutated itself. v1 accepts this slight asymmetry.
   */
  function reconcilePointStrict(
    pointId: string,
    _affected: Pop[]
  ): { created: number; removed: number } {
    if (strictUnitSize === undefined || strictUnitSize <= 0) {
      return { created: 0, removed: 0 };
    }
    const baseline = baselineDemand.get(pointId);
    if (!baseline) return { created: 0, removed: 0 };
    const cum = cumulativeDeltas.get(pointId);
    const totals = cum ? totalOf(cum) : { jobs: 0, residents: 0 };

    // Origin pops touching this point on each side.
    const residenceOrigins: Pop[] = [];
    const jobsOrigins: Pop[] = [];
    for (const p of demand.popsMap.values()) {
      if (isSplitChildId(p.id)) continue;
      if (p.residenceId === pointId) residenceOrigins.push(p);
      if (p.jobId === pointId) jobsOrigins.push(p);
    }

    const targetR = baseline.residents + totals.residents;
    const targetJ = baseline.jobs + totals.jobs;
    // floor: only materialize a new pop once a full unitSize chunk has
    // accumulated. max(numBaseline, ...) so we never delete originals
    // even if the floor would suggest a smaller count.
    const desiredR = Math.max(residenceOrigins.length, Math.floor(targetR / strictUnitSize));
    const desiredJ = Math.max(jobsOrigins.length, Math.floor(targetJ / strictUnitSize));
    const extraR = desiredR - residenceOrigins.length;
    const extraJ = desiredJ - jobsOrigins.length;

    const apportionedR = apportionLargestRemainder(
      residenceOrigins.map((p) => ({
        id: p.id,
        weight: baselinePopSizes.get(p.id) ?? p.size,
      })),
      extraR
    );
    const apportionedJ = apportionLargestRemainder(
      jobsOrigins.map((p) => ({
        id: p.id,
        weight: baselinePopSizes.get(p.id) ?? p.size,
      })),
      extraJ
    );

    // For every origin touching this point: desired children = max of
    // residence-side and jobs-side allocations. A single child satisfies
    // both dimensions.
    const allTouching = new Set<string>();
    for (const p of residenceOrigins) allTouching.add(p.id);
    for (const p of jobsOrigins) allTouching.add(p.id);

    let created = 0;
    let removed = 0;
    for (const originId of allTouching) {
      const fromR = apportionedR.get(originId) ?? 0;
      const fromJ = apportionedJ.get(originId) ?? 0;
      const desiredChildren = Math.max(fromR, fromJ);
      const origin = demand.popsMap.get(originId);
      if (!origin) continue;
      const r = setSplitChildCount(origin, desiredChildren);
      created += r.created;
      removed += r.removed;
    }
    return { created, removed };
  }

  /** Bring origin's split-child count to exactly N. Sizes set to strictUnitSize. */
  function setSplitChildCount(
    origin: Pop,
    desiredCount: number
  ): { created: number; removed: number } {
    const existing = (splitChildren.get(origin.id) ?? []).filter((id) =>
      demand.popsMap.has(id)
    );
    let created = 0;
    let removed = 0;
    while (existing.length > desiredCount) {
      const childId = existing.pop()!;
      demand.popsMap.delete(childId);
      removePopIdFromPoint(origin.residenceId, childId);
      if (origin.jobId !== origin.residenceId) removePopIdFromPoint(origin.jobId, childId);
      removed++;
    }
    while (existing.length < desiredCount) {
      const childId = nextChildId(origin.id, existing.length);
      const childPop: Pop = {
        ...origin,
        id: childId,
        size: strictUnitSize ?? origin.size,
      };
      demand.popsMap.set(childId, childPop);
      addPopIdToPoint(origin.residenceId, childId);
      if (origin.jobId !== origin.residenceId) addPopIdToPoint(origin.jobId, childId);
      existing.push(childId);
      created++;
    }
    if (existing.length > 0) splitChildren.set(origin.id, existing);
    else splitChildren.delete(origin.id);
    // Force original + children to strictUnitSize.
    const sz = strictUnitSize ?? origin.size;
    origin.size = sz;
    for (const id of existing) {
      const child = demand.popsMap.get(id);
      if (child) child.size = sz;
    }
    return { created, removed };
  }

  function captureBaselines(): void {
    for (const point of demand.points.values()) {
      ensurePointBaseline(point);
    }
    for (const pop of demand.popsMap.values()) {
      // Skip our own split children if they're somehow in popsMap at
      // capture time (shouldn't happen for a fresh init, but defensive).
      if (isSplitChildId(pop.id)) continue;
      ensurePopBaseline(pop);
    }
  }

  function revertAll(): void {
    // Tear down all split children first. We walk splitChildren rather
    // than popsMap so we know which IDs are ours to delete.
    for (const [originalId, childIds] of splitChildren) {
      const original = demand.popsMap.get(originalId);
      for (const childId of childIds) {
        demand.popsMap.delete(childId);
        if (original) {
          removePopIdFromPoint(original.residenceId, childId);
          if (original.jobId !== original.residenceId) {
            removePopIdFromPoint(original.jobId, childId);
          }
        }
      }
    }
    splitChildren.clear();

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
        splitChildren,
      };
    },
    hydrateTracking(persisted) {
      baselineDemand.clear();
      baselinePopSizes.clear();
      cumulativeDeltas.clear();
      splitChildren.clear();
      for (const [id, b] of persisted.baselineDemand) {
        baselineDemand.set(id, { jobs: b.jobs, residents: b.residents });
      }
      for (const [id, s] of persisted.baselinePopSizes) {
        baselinePopSizes.set(id, s);
      }
      for (const [id, d] of persisted.cumulativeDeltas) {
        cumulativeDeltas.set(id, {
          jobs: { fromDeals: d.jobs.fromDeals, fromOrganic: d.jobs.fromOrganic },
          residents: { fromDeals: d.residents.fromDeals, fromOrganic: d.residents.fromOrganic },
        });
      }
      if (persisted.splitChildren) {
        for (const [id, children] of persisted.splitChildren) {
          if (children.length > 0) splitChildren.set(id, [...children]);
        }
      }
    },
  };
}
