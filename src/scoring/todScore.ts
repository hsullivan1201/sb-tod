/**
 * TOD scoring — composite per-station scores.
 *
 * Two scores per station, deliberately separate so they're inspectable:
 *
 *   potential  — "this is a good place to ADD density."
 *                High when the station already moves people (high
 *                ridership relative to its current walkshed) and there's
 *                room in the walkshed to grow (low absolute walkshed
 *                density). The product captures the urbanist intuition:
 *                upzoning works best where transit is good AND land is
 *                under-used. Upzoning a high-ridership station with
 *                already-saturated walkshed yields little; upzoning a
 *                low-ridership station with empty walkshed yields
 *                little either.
 *
 *   risk       — "this station is being failed by its land use."
 *                High when the walkshed has lots of jobs/residents but
 *                the station captures few of them (low ridership per
 *                unit of walkshed supply). Risk-high stations are
 *                candidates for service investigation, route changes,
 *                or — eventually — organic-decay modelling if the area
 *                stays under-served.
 *
 *   capturedValue — "this station is winning where it sits."
 *                The mirror image of risk: high when both walkshed
 *                density AND capture rate are high. By construction
 *                `capturedValue + risk ≤ densityPressure` — together
 *                they partition the "stuff happening at dense walksheds"
 *                signal into "well-served" vs "underserved."
 *
 * All three scores are in *unitless* terms scaled to roughly [0, 1] within
 * a single map. They're for ranking, not absolute interpretation. Tunable
 * constants are exposed so the user can adjust them in settings without
 * a recompile.
 */

import type { WalkshedTotals } from './walkshed';

export interface ScoreInputs {
  /** Sum of weighted (jobs + residents) within the walkshed. */
  walkshedSupply: number;
  /** Total ridership at this station for the measurement window. */
  ridership: number;
}

export interface ScoreOptions {
  /**
   * Walkshed supply at which "density pressure" saturates — adding more
   * density beyond this point yields diminishing TOD upside.
   *
   * Default 30k matches a dense urban walkshed (jobs + residents within
   * 500m). Tune for the city.
   */
  supplySaturation?: number;
  /**
   * Ridership scale: ridership at which the station "demonstrates
   * success." Used as the normaliser for capture rate. Default 500 is
   * a placeholder; expose to settings once we see real distributions.
   */
  ridershipScale?: number;
}

export interface StationScore {
  potential: number;
  risk: number;
  capturedValue: number;
  capture: number;
  walkshedSupply: number;
  ridership: number;
}

const DEFAULT_SUPPLY_SATURATION = 30_000;
const DEFAULT_RIDERSHIP_SCALE = 500;

export function scoreStation(
  inputs: ScoreInputs,
  options: ScoreOptions = {}
): StationScore {
  const supplySat = options.supplySaturation ?? DEFAULT_SUPPLY_SATURATION;
  const ridershipScale = options.ridershipScale ?? DEFAULT_RIDERSHIP_SCALE;

  const supply = Math.max(0, inputs.walkshedSupply);
  const riders = Math.max(0, inputs.ridership);

  // Density pressure: 0 = empty walkshed (lots of room), 1 = saturated.
  const densityPressure = clamp01(supply / supplySat);
  const headroom = 1 - densityPressure;

  // Ridership signal: 0 = nobody rides, asymptotically 1 = busy station.
  // Bounded transform so a runaway hub doesn't dominate the ranking.
  const ridershipSignal = riders / (riders + ridershipScale);

  // Capture rate: ridership per unit of walkshed supply, normalised so
  // an "average" capture (1 rider per supplyScale of supply) ≈ 0.5.
  const capture = supply > 0
    ? riders / (riders + supply / 100)
    : 0;

  const potential = ridershipSignal * headroom;
  const risk = densityPressure * (1 - capture);
  const capturedValue = densityPressure * capture;

  return {
    potential,
    risk,
    capturedValue,
    capture,
    walkshedSupply: supply,
    ridership: riders,
  };
}

export function scoreFromWalkshed(
  totals: WalkshedTotals,
  ridership: number,
  options: ScoreOptions = {}
): StationScore {
  return scoreStation(
    { walkshedSupply: totals.jobs + totals.residents, ridership },
    options
  );
}

/**
 * Per-walkshed TOD opportunity scores split by use type.
 *
 * Two SEPARATE scores deliberately — averaging them would lose the
 * distinction that "developer deals" care about ("upzone housing here"
 * vs "upzone offices here").
 *
 *   residential = bounded(transit-using residents in walkshed)
 *                 × (1 - residentDensityPressure)
 *
 *     "lots of residents nearby use transit AND there's room to add
 *      more housing in this walkshed."
 *
 *   commercial  = bounded(transit-using workers in walkshed)
 *                 × (1 - jobDensityPressure)
 *
 *     "lots of workers here arrive by transit AND there's room to add
 *      more jobs in this walkshed."
 *
 * Both are bounded via the same x/(x+scale) saturation as the legacy
 * `scoreStation`. Scales are auto-calibrated per map to spread scores
 * across [0,1] — see `scoreAllStationsDetailed` in scoring/index.ts.
 *
 * Caveat to bake into reader's mental model: `residentModeShare.transit`
 * is "residents here whose ASSIGNED jobs are transit-reachable." It's
 * a fit metric, not a generic accessibility number. Same for workers.
 * Documented further in walkshed.ts.
 */
export interface AccessScoreOptions {
  /** Residential density at which "no room to add housing." */
  residentSaturation?: number;
  /** Job density at which "no room to add jobs." */
  jobSaturation?: number;
  /** Scale for the bounded transform on residential transit users. */
  residentTransitScale?: number;
  /** Scale for the bounded transform on commercial transit users. */
  workerTransitScale?: number;
}

export interface AccessScore {
  residential: number;
  commercial: number;
  /** max(residential, commercial) — "best use" combined ranking. */
  combined: number;
  residentTransit: number;
  workerTransit: number;
}

const DEFAULT_RESIDENT_SAT = 5_000;
const DEFAULT_JOB_SAT = 10_000;
const DEFAULT_RESIDENT_TRANSIT_SCALE = 200;
const DEFAULT_WORKER_TRANSIT_SCALE = 500;

export function scoreAccess(
  totals: WalkshedTotals,
  options: AccessScoreOptions = {}
): AccessScore {
  const residentSat = options.residentSaturation ?? DEFAULT_RESIDENT_SAT;
  const jobSat = options.jobSaturation ?? DEFAULT_JOB_SAT;
  const rScale = options.residentTransitScale ?? DEFAULT_RESIDENT_TRANSIT_SCALE;
  const wScale = options.workerTransitScale ?? DEFAULT_WORKER_TRANSIT_SCALE;

  const rt = Math.max(0, totals.residentTransit);
  const wt = Math.max(0, totals.workerTransit);

  const residentHeadroom = 1 - clamp01(totals.residents / residentSat);
  const jobHeadroom = 1 - clamp01(totals.jobs / jobSat);

  const residentSignal = rt / (rt + rScale);
  const workerSignal = wt / (wt + wScale);

  const residential = residentSignal * residentHeadroom;
  const commercial = workerSignal * jobHeadroom;

  return {
    residential,
    commercial,
    combined: Math.max(residential, commercial),
    residentTransit: rt,
    workerTransit: wt,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
