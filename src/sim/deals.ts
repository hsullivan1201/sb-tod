/**
 * SB TOD — Developer Deals
 *
 * Implements ARCHITECTURE decision 1b: housing / commercial / mixed
 * deals tied to a station-group walkshed. Each deal commits a fixed
 * total density delta over a duration in days. Daily ticks apply
 * incremental fractions, distributed across walkshed DemandPoints by
 * the same distance-decay function the scoring layer uses.
 *
 * Pure module — no api calls, no I/O, no mutator coupling. Returns
 * declarative "what to apply" descriptions; the caller (mod-state's
 * day tick) feeds those into the mutator.
 */

import type { DemandPoint } from '../types';
import type { LngLat } from '../types';
import { findWalkshed, type WalkshedHit } from '../scoring/walkshed';

export type DealKind = 'housing' | 'commercial' | 'mixed';
export type DealTier = 'S' | 'M' | 'L';
export type DealState = 'active' | 'completed' | 'cancelled';

export interface DealTotalDensity {
  jobs: number;
  residents: number;
}

export interface TierConfig {
  totalDensity: DealTotalDensity;
  cost: number;
  duration: number;
}

/**
 * Default tier table. Densities follow the spirit of ARCHITECTURE.md
 * decision 1b but are now rounded to multiples of 200 — the game's pop
 * granularity. Each tier delivers a clean integer count of pops over
 * its duration, so the chunked daily-apply loop never has to fudge
 * residuals.
 *
 * Housing/S of 500 → 600 (+100, slight bump), Commercial/S of 1500 →
 * 1600 (+100). Mixed = 70% of housing + 70% of commercial, then
 * rounded to nearest 200 per dimension. Costs unchanged.
 *
 * Durations are tuned for the game's quick day cadence: S/M/L deals
 * complete in 1/2/3 days.
 */
export const DEFAULT_TIER_TABLE: Record<DealKind, Record<DealTier, TierConfig>> = {
  housing: {
    S: { totalDensity: { residents: 600, jobs: 0 }, cost: 25_000_000, duration: 1 },
    M: { totalDensity: { residents: 2000, jobs: 0 }, cost: 80_000_000, duration: 2 },
    L: { totalDensity: { residents: 8000, jobs: 0 }, cost: 250_000_000, duration: 3 },
  },
  commercial: {
    S: { totalDensity: { residents: 0, jobs: 1600 }, cost: 30_000_000, duration: 1 },
    M: { totalDensity: { residents: 0, jobs: 6000 }, cost: 100_000_000, duration: 2 },
    L: { totalDensity: { residents: 0, jobs: 25_000 }, cost: 320_000_000, duration: 3 },
  },
  // Mixed: 70% of housing residents + 70% of commercial jobs, rounded
  // to nearest 200 per dimension (so it stays pop-clean).
  mixed: {
    S: {
      totalDensity: { residents: 400, jobs: 1200 }, // 70% × 600 = 420 → 400; 70% × 1600 = 1120 → 1200
      cost: Math.round((25_000_000 + 30_000_000) * 0.7),
      duration: 1,
    },
    M: {
      totalDensity: { residents: 1400, jobs: 4200 }, // 70% × 2000 = 1400; 70% × 6000 = 4200
      cost: Math.round((80_000_000 + 100_000_000) * 0.7),
      duration: 2,
    },
    L: {
      totalDensity: { residents: 5600, jobs: 17_600 }, // 70% × 8000 = 5600; 70% × 25000 = 17500 → 17600
      cost: Math.round((250_000_000 + 320_000_000) * 0.7),
      duration: 3,
    },
  },
};

/** Duration choices the propose-deal UI offers as quick-pick buttons. */
export const DURATION_PRESETS = [1, 2, 3] as const;

/**
 * Global cost multiplier. Kept as a single exported constant so future
 * balance passes can adjust display and validation together.
 */
export const DEAL_COST_MULTIPLIER: number = 1;

export interface Deal {
  id: string;
  kind: DealKind;
  tier: DealTier;
  /** ID of the station group anchoring the walkshed (purely descriptive). */
  centerStationGroupId: string;
  /** Human-readable station group name at proposal time, for the deal card. */
  centerStationGroupName: string;
  /** Center used for walkshed weighting at apply time. */
  centerLngLat: LngLat;
  /** Walkshed radius in meters. Same value the scoring layer used. */
  radiusMeters: number;
  /** What we plan to add over the deal's lifetime. */
  totalDensity: DealTotalDensity;
  /** Player paid this much upfront on confirmation. */
  totalCost: number;
  /** Game day when the deal was confirmed. */
  startDay: number;
  /** Number of game days the deal stretches over. */
  durationDays: number;
  /** Lifecycle state. */
  state: DealState;
  /**
   * Cumulative applied density across all daily ticks. Lets the daily
   * tick recover from missed days (catches up to the linear schedule)
   * and lets the UI show a progress bar.
   */
  appliedSoFar: DealTotalDensity;
  /**
   * Fractional density not yet large enough to materialize as a
   * chunkSize-multiple. Persists across ticks so small daily slivers
   * accumulate into chunks. Default chunkSize = 200 (matches game pop
   * granularity). E.g. a 500-res deal over 5 days adds 100/day to
   * pending.residents; on day 2, pending crosses 200 and we
   * materialize a +200 chunk at one walkshed point.
   */
  pending: DealTotalDensity;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ProposalRejectReason =
  | 'no-eligible-residential-points'
  | 'no-eligible-commercial-points'
  | 'walkshed-empty'
  | 'insufficient-funds'
  | 'invalid-tier';

export interface ProposalEligiblePoint {
  point: DemandPoint;
  weight: number;
  /** True if this point can absorb residents from this proposal. */
  residentsEligible: boolean;
  /** True if this point can absorb jobs. */
  jobsEligible: boolean;
}

export interface ValidProposal {
  ok: true;
  kind: DealKind;
  tier: DealTier;
  totalDensity: DealTotalDensity;
  totalCost: number;
  durationDays: number;
  /** Per-point breakdown the proposal modal shows the player. */
  eligiblePoints: ProposalEligiblePoint[];
  /** Pre-computed total weight for the residents distribution. */
  totalResidentsWeight: number;
  /** Pre-computed total weight for the jobs distribution. */
  totalJobsWeight: number;
}

export interface InvalidProposal {
  ok: false;
  reason: ProposalRejectReason;
  message: string;
}

export type ProposalResult = ValidProposal | InvalidProposal;

export interface ProposalInput {
  kind: DealKind;
  tier: DealTier;
  centerLngLat: LngLat;
  radiusMeters: number;
  walkshedPoints: Iterable<DemandPoint>;
  /** Player's current budget. */
  budget: number;
  /**
   * Threshold below which a point can't absorb residents (residential or
   * mixed deals). Default 0 — any baseline > 0 is eligible. Match the
   * mutator's ghostTownThreshold to avoid late-stage rejections.
   */
  residentsEligibilityThreshold?: number;
  jobsEligibilityThreshold?: number;
  /** Override default tier table (for tests / future tuning). */
  tierTable?: typeof DEFAULT_TIER_TABLE;
  /**
   * Override the tier's default duration. Cost and density stay tied
   * to the tier; only pacing changes. Useful when the player wants a
   * fast pop or a slow phased build for the same total density.
   */
  durationOverride?: number;
  /**
   * Multiplier applied to the tier's base cost. Defaults to 1.0
   * (no change). The panel passes DEAL_COST_MULTIPLIER so display and
   * validation stay in sync during balance passes.
   */
  costMultiplier?: number;
}

export function validateProposal(input: ProposalInput): ProposalResult {
  const tierTable = input.tierTable ?? DEFAULT_TIER_TABLE;
  const tierConfig = tierTable[input.kind]?.[input.tier];
  if (!tierConfig) {
    return {
      ok: false,
      reason: 'invalid-tier',
      message: `unknown tier ${input.kind}/${input.tier}`,
    };
  }

  const effectiveCost = Math.round(tierConfig.cost * (input.costMultiplier ?? 1));
  if (input.budget < effectiveCost) {
    return {
      ok: false,
      reason: 'insufficient-funds',
      message: `deal costs $${effectiveCost.toLocaleString()}; budget is $${input.budget.toLocaleString()}`,
    };
  }

  const hits: WalkshedHit[] = findWalkshed(
    [input.centerLngLat[0], input.centerLngLat[1]],
    input.walkshedPoints,
    {
      radiusMeters: input.radiusMeters,
    }
  );
  if (hits.length === 0) {
    return {
      ok: false,
      reason: 'walkshed-empty',
      message: `no DemandPoints within ${input.radiusMeters}m of center`,
    };
  }

  const resThreshold = input.residentsEligibilityThreshold ?? 0;
  const jobThreshold = input.jobsEligibilityThreshold ?? 0;
  const wantsResidents = tierConfig.totalDensity.residents > 0;
  const wantsJobs = tierConfig.totalDensity.jobs > 0;

  const eligible: ProposalEligiblePoint[] = [];
  let totalResidentsWeight = 0;
  let totalJobsWeight = 0;
  for (const hit of hits) {
    const residentsEligible = hit.point.residents > resThreshold;
    const jobsEligible = hit.point.jobs > jobThreshold;
    if (residentsEligible) totalResidentsWeight += hit.weight;
    if (jobsEligible) totalJobsWeight += hit.weight;
    eligible.push({
      point: hit.point,
      weight: hit.weight,
      residentsEligible,
      jobsEligible,
    });
  }

  if (wantsResidents && totalResidentsWeight === 0) {
    return {
      ok: false,
      reason: 'no-eligible-residential-points',
      message: `no walkshed point has residents > ${resThreshold} — proportional scaling can't bootstrap density from zero`,
    };
  }
  if (wantsJobs && totalJobsWeight === 0) {
    return {
      ok: false,
      reason: 'no-eligible-commercial-points',
      message: `no walkshed point has jobs > ${jobThreshold}`,
    };
  }

  const durationDays =
    input.durationOverride && input.durationOverride > 0
      ? Math.round(input.durationOverride)
      : tierConfig.duration;

  return {
    ok: true,
    kind: input.kind,
    tier: input.tier,
    totalDensity: tierConfig.totalDensity,
    totalCost: effectiveCost,
    durationDays,
    eligiblePoints: eligible,
    totalResidentsWeight,
    totalJobsWeight,
  };
}

// ---------------------------------------------------------------------------
// Confirm a proposal → Deal
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextDealId(): string {
  _idCounter++;
  return `deal-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

export interface ConfirmProposalInput {
  proposal: ValidProposal;
  startDay: number;
  centerStationGroupId: string;
  centerStationGroupName: string;
  centerLngLat: LngLat;
  radiusMeters: number;
  /** Override ID generator for tests / determinism. */
  idGenerator?: () => string;
}

export function confirmProposal(input: ConfirmProposalInput): Deal {
  return {
    id: (input.idGenerator ?? nextDealId)(),
    kind: input.proposal.kind,
    tier: input.proposal.tier,
    centerStationGroupId: input.centerStationGroupId,
    centerStationGroupName: input.centerStationGroupName,
    centerLngLat: input.centerLngLat,
    radiusMeters: input.radiusMeters,
    totalDensity: input.proposal.totalDensity,
    totalCost: input.proposal.totalCost,
    startDay: input.startDay,
    durationDays: input.proposal.durationDays,
    state: 'active',
    appliedSoFar: { residents: 0, jobs: 0 },
    pending: { residents: 0, jobs: 0 },
  };
}

// ---------------------------------------------------------------------------
// Daily tick — distribute today's portion across walkshed points
// ---------------------------------------------------------------------------

export interface DailyApplyTarget {
  pointId: string;
  delta: { jobs?: number; residents?: number };
}

export interface DailyApplyPlan {
  /** Per-point deltas to feed into mutator.applyDensityDelta. */
  targets: DailyApplyTarget[];
  /**
   * What we'll record on the deal as `appliedSoFar` increment, in
   * aggregate. This is the SUM of the per-point deltas — used to keep
   * the deal's progress tracker honest even when distribution rounds.
   */
  aggregateDelta: DealTotalDensity;
  /** True if this tick completes the deal (no further apply needed). */
  marksCompletion: boolean;
  /**
   * The deal's new pending values after this tick. Caller updates
   * `deal.pending` with this so chunks accumulate across ticks.
   */
  newPending: DealTotalDensity;
}

export interface ComputeDailyApplyInput {
  deal: Deal;
  currentDay: number;
  /** Live DemandPoints in the deal's walkshed (for re-deriving weights). */
  walkshedPoints: Iterable<DemandPoint>;
  residentsEligibilityThreshold?: number;
  jobsEligibilityThreshold?: number;
  /**
   * Granularity at which to materialize density into the simulation.
   * Default 200 to match the game's pop unit size, so each chunk
   * shows up as exactly one new pop.
   */
  chunkSize?: number;
}

function apportionLargestRemainderLocal(
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

/**
 * Compute today's per-point chunk deltas for an active deal.
 *
 * Schedule semantics: the deal commits `totalDensity` over `durationDays`.
 * On any given day N relative to start, the *expected delivered* is
 * `(N / durationDays) × totalDensity` (linear ramp). Today's delta is
 * `expected - appliedSoFar - pending` — what new fractional density we
 * accrue this tick.
 *
 * Chunking: today's accrual is added to `deal.pending`. We then
 * materialize as many `chunkSize`-multiples as fit, with the remainder
 * carried over to the next tick. Without chunking, small daily slivers
 * spread across many walkshed points never reach the per-point boundary
 * the mutator needs to actually create a new pop.
 *
 * Distribution: chunks-to-place are apportioned across eligible
 * walkshed points by largest-fractional-remainder weighted by walkshed
 * weight. Each point gets some integer number of chunks; the per-point
 * delta is `chunks × chunkSize`.
 *
 * Final-day kicker: on the deal's last day, we round the residual
 * (pending after the final tick) up to the nearest chunk so the player
 * gets *at least* what they paid for. Slight overshoot beats stingy
 * undershoot for a finite-duration commitment.
 */
export function computeDailyApply(input: ComputeDailyApplyInput): DailyApplyPlan {
  const { deal, currentDay } = input;
  const chunkSize = input.chunkSize ?? 200;
  const daysActive = Math.max(0, Math.min(deal.durationDays, currentDay - deal.startDay + 1));
  const fractionDelivered = daysActive / deal.durationDays;

  const expectedResidents = deal.totalDensity.residents * fractionDelivered;
  const expectedJobs = deal.totalDensity.jobs * fractionDelivered;
  // What we'd LIKE to have applied + held by end of today.
  // Subtract what's already applied AND what's already pending — both
  // are accounted for in the "we've accrued this much" balance.
  const todayAccrueResidents = Math.max(
    0,
    expectedResidents - deal.appliedSoFar.residents - deal.pending.residents
  );
  const todayAccrueJobs = Math.max(
    0,
    expectedJobs - deal.appliedSoFar.jobs - deal.pending.jobs
  );

  // Add to running pending balance.
  let pendingR = deal.pending.residents + todayAccrueResidents;
  let pendingJ = deal.pending.jobs + todayAccrueJobs;

  const marksCompletion = currentDay >= deal.startDay + deal.durationDays - 1;

  // Re-derive walkshed weights against current live demand. Eligibility
  // can shift over the deal's lifetime as density grows; we honor that
  // (a point that becomes eligible mid-deal joins the distribution).
  const hits = findWalkshed(
    [deal.centerLngLat[0], deal.centerLngLat[1]],
    input.walkshedPoints,
    { radiusMeters: deal.radiusMeters }
  );
  const resThreshold = input.residentsEligibilityThreshold ?? 0;
  const jobThreshold = input.jobsEligibilityThreshold ?? 0;
  const resEligible = hits.filter((h) => h.point.residents > resThreshold);
  const jobsEligible = hits.filter((h) => h.point.jobs > jobThreshold);

  // Number of chunks to materialize this tick. On non-final days, floor
  // (carry the remainder). On the final day, ceil the remainder so the
  // player gets at least what they paid for.
  const chunksRoundFn = marksCompletion ? Math.ceil : Math.floor;
  const chunksR =
    deal.totalDensity.residents > 0 ? Math.max(0, chunksRoundFn(pendingR / chunkSize)) : 0;
  const chunksJ =
    deal.totalDensity.jobs > 0 ? Math.max(0, chunksRoundFn(pendingJ / chunkSize)) : 0;

  const apportionedR =
    chunksR > 0 && resEligible.length > 0
      ? apportionLargestRemainderLocal(
          resEligible.map((h) => ({ id: h.point.id, weight: h.weight })),
          chunksR
        )
      : new Map<string, number>();
  const apportionedJ =
    chunksJ > 0 && jobsEligible.length > 0
      ? apportionLargestRemainderLocal(
          jobsEligible.map((h) => ({ id: h.point.id, weight: h.weight })),
          chunksJ
        )
      : new Map<string, number>();

  // Subtract what we materialized from pending. (May go negative on the
  // final-day kicker; that's fine, it just signals "fully delivered.")
  pendingR -= chunksR * chunkSize;
  pendingJ -= chunksJ * chunkSize;

  // Build per-point targets, merging residence and jobs chunks for the
  // same point into a single mutator call.
  const perPoint = new Map<string, { jobs: number; residents: number }>();
  for (const [id, count] of apportionedR) {
    if (count <= 0) continue;
    const slot = perPoint.get(id) ?? { jobs: 0, residents: 0 };
    slot.residents += count * chunkSize;
    perPoint.set(id, slot);
  }
  for (const [id, count] of apportionedJ) {
    if (count <= 0) continue;
    const slot = perPoint.get(id) ?? { jobs: 0, residents: 0 };
    slot.jobs += count * chunkSize;
    perPoint.set(id, slot);
  }

  const targets: DailyApplyTarget[] = [];
  let aggR = 0;
  let aggJ = 0;
  for (const [pointId, d] of perPoint) {
    const delta: { jobs?: number; residents?: number } = {};
    if (d.residents !== 0) {
      delta.residents = d.residents;
      aggR += d.residents;
    }
    if (d.jobs !== 0) {
      delta.jobs = d.jobs;
      aggJ += d.jobs;
    }
    if (delta.residents !== undefined || delta.jobs !== undefined) {
      targets.push({ pointId, delta });
    }
  }

  return {
    targets,
    aggregateDelta: { residents: aggR, jobs: aggJ },
    marksCompletion,
    newPending: { residents: pendingR, jobs: pendingJ },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Days elapsed (1-indexed) since deal start, capped at duration. */
export function dealProgressDays(deal: Deal, currentDay: number): number {
  return Math.max(0, Math.min(deal.durationDays, currentDay - deal.startDay + 1));
}

/** Fractional progress in [0, 1] as a function of game days elapsed. */
export function dealProgressFraction(deal: Deal, currentDay: number): number {
  return dealProgressDays(deal, currentDay) / deal.durationDays;
}

export function isDealActive(deal: Deal): boolean {
  return deal.state === 'active';
}
