/**
 * SB TOD — mod state
 *
 * The singleton holding the `DemandMutator` and everything that needs
 * to survive across save/load. In-memory is the source of truth (probe 1
 * found storage round-trips unreliable — `set().then(get())` returned
 * undefined in one instance), so `api.storage` is persistence, not state.
 *
 * Save/load replay strategy
 * -------------------------
 * Decision 2 in ARCHITECTURE.md says we store *deltas from baseline*,
 * not absolutes, precisely because we don't know whether the game
 * serializes our mutations through save/load (probe 2 open question #4).
 * On load we handle both cases per-point without needing to know which
 * one is true globally:
 *
 *   - Live demand ≈ baseline + cumulative delta → game preserved our
 *     writes. Just rehydrate tracking state (no re-mutation).
 *   - Live demand ≈ baseline → game reset our writes. Replay deltas
 *     via the mutator so point aggregates and pop sizes get restored.
 *   - Neither matches → a baseline shift (new game, edited save, patch
 *     update). Drop the stale delta for that point; log and move on.
 *
 * A ~1-unit tolerance on the compare handles floating-point round-trip
 * through JSON.
 */

import { gameState, storage } from '../api';
import type { DemandData, DemandPoint, PointDelta } from '../types';
import {
  createMutator,
  type DemandMutator,
  type DeltaSourceKind,
  type DemandDelta,
  type ApplyResult,
} from '../sim/mutate';

const STORAGE_KEY = 'sb-tod:state:v1';
const APPROX_TOLERANCE = 1.0;

export type HydrateOutcome = 'preserved' | 'replayed' | 'baseline-shift' | 'missing-point';

export interface HydrateReport {
  perPoint: Map<string, HydrateOutcome>;
  preserved: number;
  replayed: number;
  baselineShift: number;
  missingPoint: number;
  fromStorage: boolean;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  baselineDemand: Array<[string, { jobs: number; residents: number }]>;
  baselinePopSizes: Array<[string, number]>;
  cumulativeDeltas: Array<[string, PointDelta]>;
}

export interface ModStateStats {
  initialized: boolean;
  demandChangeEvents: number;
  dayTicks: number;
  lastDay: number | null;
  /** true if set() resolved AND the immediate readback matched. */
  lastPersistOk: boolean | null;
  lastPersistAt: number | null;
  /**
   * Explicit round-trip detection — `null` until the first persist attempt,
   * then `true` if `get()` returned the exact payload we just wrote,
   * `false` if set() silently dropped (the probe-1 flake).
   */
  storageRoundTripOk: boolean | null;
  pointsTracked: number;
  popsTracked: number;
  pointsWithDeltas: number;
  lastHydrate: HydrateReport | null;
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= APPROX_TOLERANCE;
}

function totalDelta(d: PointDelta): { jobs: number; residents: number } {
  return {
    jobs: d.jobs.fromDeals + d.jobs.fromOrganic,
    residents: d.residents.fromDeals + d.residents.fromOrganic,
  };
}

export interface ModState {
  ensureInit(demand?: DemandData): Promise<boolean>;
  isReady(): boolean;
  mutator(): DemandMutator;
  applyDensityDelta(pointId: string, delta: DemandDelta, source: DeltaSourceKind): ApplyResult;
  markDirty(): void;
  persist(): Promise<boolean>;
  onDayTick(day: number): void;
  onDemandChangeFired(): void;
  onGameSavedFired(): void;
  onGameLoadedFired(): void;
  stats(): ModStateStats;
  /** For tests — override the storage backend. */
  _setStorage(s: StorageLike): void;
}

export interface StorageLike {
  set(key: string, value: unknown): Promise<void>;
  get<T>(key: string, defaultValue: T): Promise<T>;
  delete(key: string): Promise<void>;
}

export interface CreateModStateOptions {
  /** Override storage for tests. Defaults to api.storage. */
  storage?: StorageLike;
  /** Override demand accessor for tests. Defaults to gameState.getDemandData. */
  getDemand?: () => DemandData | null;
  /** Persist every N day ticks. Default 1 (every day). */
  persistEveryNDays?: number;
}

export function createModState(options: CreateModStateOptions = {}): ModState {
  let backend: StorageLike = options.storage ?? storage;
  const getDemand = options.getDemand ?? (() => gameState.getDemandData() as DemandData | null);
  const persistEveryNDays = options.persistEveryNDays ?? 1;

  let mutator: DemandMutator | null = null;
  let demand: DemandData | null = null;
  let initialized = false;
  let dirty = false;
  let demandChangeEvents = 0;
  let dayTicks = 0;
  let lastDay: number | null = null;
  let lastPersistOk: boolean | null = null;
  let lastPersistAt: number | null = null;
  let storageRoundTripOk: boolean | null = null;
  let lastHydrate: HydrateReport | null = null;
  let initPromise: Promise<boolean> | null = null;

  async function doInit(providedDemand?: DemandData): Promise<boolean> {
    const d = providedDemand ?? getDemand();
    if (!d || !d.points || !d.popsMap) {
      return false;
    }
    demand = d;
    mutator = createMutator(d);

    let persisted: PersistedState | null = null;
    let storageKeys: string[] = [];
    try {
      persisted = await backend.get<PersistedState | null>(STORAGE_KEY, null);
    } catch (err) {
      console.warn('[sb-tod] storage.get threw during init:', err);
      persisted = null;
    }
    try {
      storageKeys = await ((backend as StorageLike & { keys?: () => Promise<string[]> }).keys?.() ?? Promise.resolve([]));
    } catch {
      storageKeys = [];
    }

    if (persisted && persisted.version === 1) {
      lastHydrate = applyPersisted(mutator, d, persisted);
      console.log(
        `[sb-tod] Hydrated from storage (saved ${new Date(persisted.savedAt).toISOString()}): preserved=${lastHydrate.preserved}, replayed=${lastHydrate.replayed}, baselineShift=${lastHydrate.baselineShift}, missingPoint=${lastHydrate.missingPoint}. Storage keys: [${storageKeys.join(', ')}]`
      );
    } else {
      // Fresh game (or first run, or persisted state was dropped). Capture
      // baselines from live demand. Record the reason so the panel can
      // show it explicitly rather than just silently showing zero deltas.
      mutator.captureBaselines();
      lastHydrate = {
        perPoint: new Map(),
        preserved: 0,
        replayed: 0,
        baselineShift: 0,
        missingPoint: 0,
        fromStorage: false,
      };
      console.log(
        `[sb-tod] No persisted state found at "${STORAGE_KEY}". Captured ${mutator.snapshot().baselineDemand.size} fresh baselines from live demand. Storage keys present: [${storageKeys.join(', ')}] (empty=backend not working, non-empty=just a fresh install).`
      );
    }

    initialized = true;
    return true;
  }

  async function ensureInit(providedDemand?: DemandData): Promise<boolean> {
    if (initialized) return true;
    if (!initPromise) {
      initPromise = doInit(providedDemand).finally(() => {
        if (!initialized) initPromise = null;
      });
    }
    return initPromise;
  }

  function isReady(): boolean {
    return initialized && mutator !== null;
  }

  function requireMutator(): DemandMutator {
    if (!mutator) throw new Error('[sb-tod] mod state not initialized');
    return mutator;
  }

  async function persist(): Promise<boolean> {
    if (!mutator) {
      lastPersistOk = false;
      return false;
    }
    const snap = mutator.snapshot();
    const payload: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [...snap.baselineDemand.entries()].map(([id, b]) => [
        id,
        { jobs: b.jobs, residents: b.residents },
      ]),
      baselinePopSizes: [...snap.baselinePopSizes.entries()],
      cumulativeDeltas: [...snap.cumulativeDeltas.entries()].map(([id, d]) => [
        id,
        {
          jobs: { fromDeals: d.jobs.fromDeals, fromOrganic: d.jobs.fromOrganic },
          residents: {
            fromDeals: d.residents.fromDeals,
            fromOrganic: d.residents.fromOrganic,
          },
        },
      ]),
    };
    try {
      await backend.set(STORAGE_KEY, payload);
      // Immediate round-trip verify. Probe 1 caught a case where set()
      // resolved but get() returned undefined — silent drop. If that's
      // happening here, surface it loudly; persistence is effectively
      // broken and we need to know before the user counts on a reload.
      let readback: PersistedState | null = null;
      try {
        readback = await backend.get<PersistedState | null>(STORAGE_KEY, null);
      } catch (e) {
        console.warn('[sb-tod] readback during persist verify threw:', e);
      }
      const matches = !!readback && readback.savedAt === payload.savedAt;
      storageRoundTripOk = matches;
      if (!matches) {
        console.warn(
          `[sb-tod] storage round-trip MISMATCH after set("${STORAGE_KEY}"): wrote savedAt=${payload.savedAt} but readback=${readback ? `savedAt=${readback.savedAt}` : 'null'}. Data will not survive restart. (Browser mode? Known game flake? Check Electron / api.storage.)`
        );
        lastPersistOk = false;
        return false;
      }
      lastPersistOk = true;
      lastPersistAt = payload.savedAt;
      dirty = false;
      return true;
    } catch (err) {
      console.warn('[sb-tod] storage.set failed:', err);
      lastPersistOk = false;
      storageRoundTripOk = false;
      return false;
    }
  }

  function onDayTick(day: number): void {
    dayTicks++;
    lastDay = day;
    if (!initialized) {
      // Try to init opportunistically — demand is almost certainly available
      // by the first day tick.
      ensureInit().catch((e) => console.warn('[sb-tod] ensureInit on day tick failed:', e));
      return;
    }
    if (dirty && dayTicks % persistEveryNDays === 0) {
      void persist();
    }
  }

  function onDemandChangeFired(): void {
    demandChangeEvents++;
    // observability only — NEVER mutate from here (feedback-loop hazard)
  }

  function onGameSavedFired(): void {
    if (initialized && dirty) void persist();
  }

  function onGameLoadedFired(): void {
    // Reset so init can re-hydrate from storage against the new demand.
    initialized = false;
    initPromise = null;
    mutator = null;
    demand = null;
    ensureInit().catch((e) => console.warn('[sb-tod] re-init after load failed:', e));
  }

  return {
    ensureInit,
    isReady,
    mutator: requireMutator,
    applyDensityDelta(pointId, delta, source) {
      const r = requireMutator().applyDensityDelta(pointId, delta, source);
      if (r.ok) dirty = true;
      return r;
    },
    markDirty() {
      dirty = true;
    },
    persist,
    onDayTick,
    onDemandChangeFired,
    onGameSavedFired,
    onGameLoadedFired,
    stats() {
      const snap = mutator?.snapshot();
      return {
        initialized,
        demandChangeEvents,
        dayTicks,
        lastDay,
        lastPersistOk,
        lastPersistAt,
        storageRoundTripOk,
        pointsTracked: snap?.baselineDemand.size ?? 0,
        popsTracked: snap?.baselinePopSizes.size ?? 0,
        pointsWithDeltas: snap?.cumulativeDeltas.size ?? 0,
        lastHydrate,
      };
    },
    _setStorage(s) {
      backend = s;
    },
  };
}

/**
 * Reconcile persisted state against live demand. For each persisted
 * point we decide per-point whether the game preserved our mutation or
 * reset it, and act accordingly. Pops get their baseline sizes seeded
 * from persisted so future rescales anchor correctly regardless of the
 * per-point outcome.
 */
function applyPersisted(
  mutator: DemandMutator,
  demand: DemandData,
  persisted: PersistedState
): HydrateReport {
  const report: HydrateReport = {
    perPoint: new Map(),
    preserved: 0,
    replayed: 0,
    baselineShift: 0,
    missingPoint: 0,
    fromStorage: true,
  };

  // Seed mutator with persisted baselines and deltas so the mutator's
  // internal math uses the TRUE baselines (not live-possibly-mutated
  // values). We'll selectively re-apply via applyDensityDelta below
  // where the game-preserved path doesn't hold.
  mutator.hydrateTracking(persisted);

  // Now walk each persisted point and decide.
  for (const [pointId, delta] of persisted.cumulativeDeltas) {
    const point = demand.points.get(pointId);
    if (!point) {
      report.missingPoint++;
      report.perPoint.set(pointId, 'missing-point');
      continue;
    }
    const baseline = mutator.getBaseline(pointId);
    if (!baseline) {
      // Shouldn't happen — hydrateTracking just seeded it.
      report.missingPoint++;
      report.perPoint.set(pointId, 'missing-point');
      continue;
    }
    const total = totalDelta(delta);
    const matchesPreserved =
      approxEq(point.jobs, baseline.jobs + total.jobs) &&
      approxEq(point.residents, baseline.residents + total.residents);
    const matchesReset =
      approxEq(point.jobs, baseline.jobs) &&
      approxEq(point.residents, baseline.residents);

    if (matchesPreserved) {
      report.preserved++;
      report.perPoint.set(pointId, 'preserved');
      // tracking already seeded, nothing else to do
    } else if (matchesReset) {
      // Game reset our mutations. Replay per-source so the delta
      // buckets remain correctly attributed. We must clear the seeded
      // cumulative first or applyDensityDelta will double it.
      resetCumulativeFor(mutator, pointId);
      const sources: Array<[DeltaSourceKind, DemandDelta]> = [
        ['deals', { jobs: delta.jobs.fromDeals, residents: delta.residents.fromDeals }],
        ['organic', { jobs: delta.jobs.fromOrganic, residents: delta.residents.fromOrganic }],
      ];
      for (const [source, d] of sources) {
        if ((d.jobs ?? 0) === 0 && (d.residents ?? 0) === 0) continue;
        const r = mutator.applyDensityDelta(pointId, d, source);
        if (!r.ok) {
          console.warn(
            `[sb-tod] replay of persisted delta on point "${pointId}" failed (${source}): ${r.reason}`
          );
        }
      }
      report.replayed++;
      report.perPoint.set(pointId, 'replayed');
    } else {
      // Baseline shift: live doesn't match either. Drop this point's
      // persisted delta and treat the live value as the new baseline.
      resetCumulativeFor(mutator, pointId);
      rebaselineTo(mutator, point);
      report.baselineShift++;
      report.perPoint.set(pointId, 'baseline-shift');
      console.warn(
        `[sb-tod] point "${pointId}" baseline shift on load: live ${point.jobs}j/${point.residents}r ≠ baseline ${baseline.jobs}j/${baseline.residents}r + delta ${total.jobs}j/${total.residents}r; dropping stale delta`
      );
    }
  }

  // Also capture baselines for any currently-live point we didn't
  // persist (new points in the city data since last save).
  for (const point of demand.points.values()) {
    if (!mutator.getBaseline(point.id)) {
      rebaselineTo(mutator, point);
    }
  }

  return report;
}

function resetCumulativeFor(mutator: DemandMutator, pointId: string): void {
  const snap = mutator.snapshot();
  const nextDeltas = new Map(snap.cumulativeDeltas);
  nextDeltas.delete(pointId);
  mutator.hydrateTracking({
    baselineDemand: snap.baselineDemand,
    baselinePopSizes: snap.baselinePopSizes,
    cumulativeDeltas: nextDeltas,
  });
}

function rebaselineTo(mutator: DemandMutator, point: DemandPoint): void {
  const snap = mutator.snapshot();
  const nextBaselines = new Map(snap.baselineDemand);
  nextBaselines.set(point.id, { jobs: point.jobs, residents: point.residents });
  const nextDeltas = new Map(snap.cumulativeDeltas);
  nextDeltas.delete(point.id);
  mutator.hydrateTracking({
    baselineDemand: nextBaselines,
    baselinePopSizes: snap.baselinePopSizes,
    cumulativeDeltas: nextDeltas,
  });
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let instance: ModState | null = null;

export function getModState(): ModState {
  if (!instance) instance = createModState();
  return instance;
}

/** For tests — reset the singleton. */
export function _resetModState(): void {
  instance = null;
}
