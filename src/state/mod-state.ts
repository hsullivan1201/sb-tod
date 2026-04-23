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

import { gameState } from '../api';
import type { DemandData, DemandPoint, PointDelta } from '../types';
import {
  createMutator,
  type DemandMutator,
  type DeltaSourceKind,
  type DemandDelta,
  type ApplyResult,
  type MutatorOptions,
} from '../sim/mutate';
import {
  computeDailyApply,
  type Deal,
} from '../sim/deals';
import {
  createAdaptiveStorage,
  type AdaptiveStorage,
  type StorageBackendKind,
} from './storage-adapter';

const STORAGE_KEY_PREFIX = 'sb-tod:state:v1:';
const LEGACY_UNSEGMENTED_KEY = 'sb-tod:state:v1'; // pre-per-save key, cleaned up on init
const UNSAVED_SLOT = '_unsaved';
const APPROX_TOLERANCE = 1.0;

function makeStorageKey(saveName: string | null): string {
  return STORAGE_KEY_PREFIX + (saveName ?? UNSAVED_SLOT);
}

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
  /**
   * originalPopId → list of split child pop IDs. Present only when
   * splits were created during the persisted session. Absent / empty
   * arrays are equivalent to "no splits for that pop".
   */
  splitChildren?: Array<[string, string[]]>;
  /** Active + completed deals. Absent on first save (no deals yet). */
  deals?: Deal[];
}

export interface DealTickReport {
  dealId: string;
  applied: { jobs: number; residents: number };
  pointsAffected: number;
  rejections: number;
  marksCompletion: boolean;
}

export interface ModStateStats {
  initialized: boolean;
  demandChangeEvents: number;
  dayTicks: number;
  lastDay: number | null;
  /** Counts derived from current deals list. */
  activeDeals: number;
  completedDeals: number;
  cancelledDeals: number;
  /** Last day's deal application reports — most recent first. */
  lastTickReports: DealTickReport[];
  /** Current save name (null = no save loaded yet, defaults to `_unsaved` slot). */
  currentSaveName: string | null;
  /** The actual storage key in use right now — handy for debugging cross-save bleed. */
  currentStorageKey: string;
  /** true if set() resolved AND the immediate readback matched. */
  lastPersistOk: boolean | null;
  lastPersistAt: number | null;
  /**
   * Explicit round-trip detection — `null` until the first persist attempt,
   * then `true` if `get()` returned the exact payload we just wrote,
   * `false` if set() silently dropped (the probe-1 flake).
   */
  storageRoundTripOk: boolean | null;
  /** Which backend (api / local / none) the last successful persist used. */
  storageBackend: StorageBackendKind;
  /** Snapshot of what the storage backend showed at init time. */
  initProbe: InitProbe | null;
  pointsTracked: number;
  popsTracked: number;
  pointsWithDeltas: number;
  lastHydrate: HydrateReport | null;
}

export interface InitProbe {
  at: number;
  /** Save name used to compute the key for THIS init. */
  saveName: string | null;
  /** The exact key we looked for. */
  storageKey: string;
  apiKeysAtInit: string[];
  apiHasOurKey: boolean;
  apiOurKeyShape: string;
  localStorageAvailable: boolean;
  localStorageKeysAtInit: string[];
  localStorageHasOurKey: boolean;
  localStorageOurKeyShape: string;
  /** All keys (api + local) starting with our prefix — surfaces other saves. */
  otherSaveKeys: string[];
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= APPROX_TOLERANCE;
}

async function captureInitProbe(saveName: string | null, storageKey: string): Promise<InitProbe> {
  const probe: InitProbe = {
    at: Date.now(),
    saveName,
    storageKey,
    apiKeysAtInit: [],
    apiHasOurKey: false,
    apiOurKeyShape: 'null',
    localStorageAvailable: false,
    localStorageKeysAtInit: [],
    localStorageHasOurKey: false,
    localStorageOurKeyShape: 'null',
    otherSaveKeys: [],
  };
  const otherKeys = new Set<string>();
  // Lazy import to avoid pulling api at module-load time outside game.
  try {
    const apiMod = await import('../api');
    probe.apiKeysAtInit = await apiMod.storage.keys().catch(() => []);
    for (const k of probe.apiKeysAtInit) {
      if (k.startsWith(STORAGE_KEY_PREFIX) && k !== storageKey) otherKeys.add(`api:${k}`);
    }
    const apiVal = await apiMod.storage.get<unknown>(storageKey, null).catch(() => null);
    probe.apiHasOurKey = apiVal != null;
    probe.apiOurKeyShape = describeShape(apiVal);
  } catch {
    /* ignore — probe still useful */
  }
  if (typeof localStorage !== 'undefined') {
    probe.localStorageAvailable = true;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k != null) {
          probe.localStorageKeysAtInit.push(k);
          if (k.startsWith(STORAGE_KEY_PREFIX) && k !== storageKey) otherKeys.add(`local:${k}`);
        }
      }
      const lsRaw = localStorage.getItem(storageKey);
      probe.localStorageHasOurKey = lsRaw != null;
      if (lsRaw != null) {
        try {
          probe.localStorageOurKeyShape = describeShape(JSON.parse(lsRaw));
        } catch {
          probe.localStorageOurKeyShape = `<unparseable, ${lsRaw.length} chars>`;
        }
      }
    } catch {
      /* ignore */
    }
  }
  probe.otherSaveKeys = [...otherKeys];
  return probe;
}

function describeShape(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v !== 'object') return String(v);
  const o = v as any;
  return `{ version: ${o.version}, savedAt: ${o.savedAt}, points: ${o.baselineDemand?.length ?? '?'}, pops: ${o.baselinePopSizes?.length ?? '?'}, deltas: ${o.cumulativeDeltas?.length ?? '?'} }`;
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
  /** Read-only deals list (active + completed + cancelled, in insertion order). */
  getDeals(): readonly Deal[];
  /**
   * Add a new deal to mod state. Caller is responsible for charging the
   * player via `api.actions.subtractMoney`.
   */
  addDeal(deal: Deal): void;
  /** Cancel an active deal. (No refund logic in v1; future enhancement.) */
  cancelDeal(dealId: string): boolean;
  /**
   * Switch the active save slot. If the current state is dirty, persist
   * it under the OLD save name first (to not silently drop unsaved
   * mutations), then drop in-memory state and re-init under the new name
   * — which hydrates from the new save's persisted state if any exists.
   * No-op if the name is unchanged.
   */
  setCurrentSaveName(name: string | null): Promise<void>;
  getCurrentSaveName(): string | null;
  onDayTick(day: number): void;
  onDemandChangeFired(): void;
  onGameSavedFired(saveName?: string): void;
  onGameLoadedFired(saveName?: string): void;
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
  /** Initial save name. Default null (uses the `_unsaved` slot). */
  initialSaveName?: string | null;
  /**
   * Options forwarded to the underlying mutator. Default
   * `{ strictUnitSize: 200 }` — every pop produced is exactly 200 to
   * match the game's natural pop granularity. Tests that need
   * fractional behavior pass `{}` to opt out.
   */
  mutatorOptions?: MutatorOptions;
}

export function createModState(options: CreateModStateOptions = {}): ModState {
  let backend: StorageLike = options.storage ?? createAdaptiveStorage();
  const getDemand = options.getDemand ?? (() => gameState.getDemandData() as DemandData | null);
  const persistEveryNDays = options.persistEveryNDays ?? 1;
  // Strict 200-sized pops by default: matches the game's natural Pop
  // granularity (every game-authored Pop has size 200). Keeps split
  // children indistinguishable from natural pops to the rest of the
  // simulation and avoids fractional sizes (which the game's
  // atomic-boarding model can't handle cleanly).
  const mutatorOptions: MutatorOptions = options.mutatorOptions ?? { strictUnitSize: 200 };

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
  let initProbe: InitProbe | null = null;
  let currentSaveName: string | null = options.initialSaveName ?? null;
  let deals: Deal[] = [];
  let lastTickReports: DealTickReport[] = [];
  let initPromise: Promise<boolean> | null = null;

  async function doInit(providedDemand?: DemandData): Promise<boolean> {
    const d = providedDemand ?? getDemand();
    if (!d || !d.points || !d.popsMap) {
      return false;
    }
    demand = d;
    mutator = createMutator(d, mutatorOptions);

    const storageKey = makeStorageKey(currentSaveName);

    // Snapshot raw state of BOTH possible backends at init time so the
    // panel can show exactly what we saw, regardless of what the
    // adapter chose to surface. Crucial for diagnosing post-restart
    // "where did my data go?" cases — and for spotting cross-save bleed.
    initProbe = await captureInitProbe(currentSaveName, storageKey);
    console.log('[sb-tod] init probe:', initProbe);

    let persisted: PersistedState | null = null;
    let storageKeys: string[] = [];
    try {
      persisted = await backend.get<PersistedState | null>(storageKey, null);
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
      deals = persisted.deals ? persisted.deals.map((dd) => ({ ...dd })) : [];
      console.log(
        `[sb-tod] Hydrated "${storageKey}" (saved ${new Date(persisted.savedAt).toISOString()}): preserved=${lastHydrate.preserved}, replayed=${lastHydrate.replayed}, baselineShift=${lastHydrate.baselineShift}, missingPoint=${lastHydrate.missingPoint}, deals=${deals.length}. Storage keys: [${storageKeys.join(', ')}]`
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
      deals = [];
      console.log(
        `[sb-tod] No persisted state found at "${storageKey}". Captured ${mutator.snapshot().baselineDemand.size} fresh baselines from live demand. Storage keys present: [${storageKeys.join(', ')}] (empty=backend not working, non-empty=just a fresh install or different save slot).`
      );
    }

    // One-shot cleanup: the pre-namespacing key sb-tod:state:v1 (no slot
    // suffix) is orphan data that won't ever be read again. Best-effort
    // delete from both backends; harmless to fail.
    try {
      await backend.delete(LEGACY_UNSEGMENTED_KEY).catch(() => {});
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(LEGACY_UNSEGMENTED_KEY);
      }
    } catch {
      /* ignore */
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
      splitChildren: [...snap.splitChildren.entries()].map(([id, children]) => [
        id,
        [...children],
      ]),
      deals: deals.map((dd) => ({ ...dd, appliedSoFar: { ...dd.appliedSoFar } })),
    };
    const storageKey = makeStorageKey(currentSaveName);
    try {
      await backend.set(storageKey, payload);
      // Immediate round-trip verify. Probe 1 caught a case where set()
      // resolved but get() returned undefined — silent drop. If that's
      // happening here, surface it loudly; persistence is effectively
      // broken and we need to know before the user counts on a reload.
      let readback: PersistedState | null = null;
      try {
        readback = await backend.get<PersistedState | null>(storageKey, null);
      } catch (e) {
        console.warn('[sb-tod] readback during persist verify threw:', e);
      }
      const matches = !!readback && readback.savedAt === payload.savedAt;
      storageRoundTripOk = matches;
      if (!matches) {
        console.warn(
          `[sb-tod] storage round-trip MISMATCH after set("${storageKey}"): wrote savedAt=${payload.savedAt} but readback=${readback ? `savedAt=${readback.savedAt}` : 'null'}. Data will not survive restart. (Browser mode? Known game flake? Check Electron / api.storage.)`
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

    // Apply each active deal's daily delta. Done before the persist below
    // so the saved state reflects today's progress.
    lastTickReports = applyActiveDealsForDay(day);

    if (dirty && dayTicks % persistEveryNDays === 0) {
      void persist();
    }
  }

  function applyActiveDealsForDay(day: number): DealTickReport[] {
    if (!mutator || !demand) return [];
    const reports: DealTickReport[] = [];
    for (const deal of deals) {
      if (deal.state !== 'active') continue;
      // Don't tick on a day before the deal started (defensive against
      // weird load ordering — shouldn't normally happen).
      if (day < deal.startDay) continue;
      const plan = computeDailyApply({
        deal,
        currentDay: day,
        walkshedPoints: demand.points.values(),
      });
      let applied = { jobs: 0, residents: 0 };
      let pointsAffected = 0;
      let rejections = 0;
      for (const target of plan.targets) {
        const r = mutator.applyDensityDelta(target.pointId, target.delta, 'deals');
        if (r.ok) {
          applied.jobs += target.delta.jobs ?? 0;
          applied.residents += target.delta.residents ?? 0;
          pointsAffected++;
          dirty = true;
        } else {
          rejections++;
          // A rejection here is usually ghost-town (a point was eligible at
          // proposal time but residents/jobs hit zero mid-deal). Log but
          // don't abort the deal — distribution self-heals next tick.
          console.warn(
            `[sb-tod] deal ${deal.id} apply rejected on point ${target.pointId}: ${r.reason} — ${r.message}`
          );
        }
      }
      deal.appliedSoFar.residents += applied.residents;
      deal.appliedSoFar.jobs += applied.jobs;
      if (plan.marksCompletion) {
        deal.state = 'completed';
        dirty = true;
        console.log(
          `[sb-tod] deal ${deal.id} (${deal.kind}/${deal.tier}) completed on day ${day}: delivered ${deal.appliedSoFar.residents.toFixed(0)}r / ${deal.appliedSoFar.jobs.toFixed(0)}j of ${deal.totalDensity.residents}r / ${deal.totalDensity.jobs}j planned.`
        );
      }
      reports.push({
        dealId: deal.id,
        applied,
        pointsAffected,
        rejections,
        marksCompletion: plan.marksCompletion,
      });
    }
    return reports;
  }

  function onDemandChangeFired(): void {
    demandChangeEvents++;
    // observability only — NEVER mutate from here (feedback-loop hazard)
  }

  function onGameSavedFired(saveName?: string): void {
    // If the player did "save as" with a new name, the in-memory state
    // applies to the NEW save (it's what they were just playing). Switch
    // the key without dropping in-memory; persist immediately.
    if (saveName && saveName !== currentSaveName) {
      currentSaveName = saveName;
    }
    if (initialized && dirty) void persist();
  }

  function onGameLoadedFired(saveName?: string): void {
    // Loading a different save means switching slots: dump in-memory and
    // hydrate from the new save's storage. setCurrentSaveName persists
    // any unsaved deltas under the OLD name first, so nothing is lost.
    if (saveName !== undefined && saveName !== currentSaveName) {
      void setCurrentSaveName(saveName).catch((e) =>
        console.warn('[sb-tod] setCurrentSaveName on game-load failed:', e)
      );
      return;
    }
    // Same save name (or undefined — game didn't tell us): just re-init
    // to pick up whatever the game put in live demand.
    initialized = false;
    initPromise = null;
    mutator = null;
    demand = null;
    ensureInit().catch((e) => console.warn('[sb-tod] re-init after load failed:', e));
  }

  async function setCurrentSaveName(name: string | null): Promise<void> {
    if (name === currentSaveName) return;
    // Persist current state under the OLD name before switching, so any
    // unsaved deltas don't vanish on cross-save load.
    if (initialized && dirty) {
      await persist().catch((e) => console.warn('[sb-tod] persist before save-switch failed:', e));
    }
    currentSaveName = name;
    initialized = false;
    initPromise = null;
    mutator = null;
    demand = null;
    await ensureInit().catch((e) => console.warn('[sb-tod] re-init after save-switch failed:', e));
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
    getDeals: () => deals,
    addDeal(deal) {
      deals.push(deal);
      dirty = true;
    },
    cancelDeal(dealId) {
      const d = deals.find((dd) => dd.id === dealId);
      if (!d || d.state !== 'active') return false;
      d.state = 'cancelled';
      dirty = true;
      return true;
    },
    setCurrentSaveName,
    getCurrentSaveName: () => currentSaveName,
    onDayTick,
    onDemandChangeFired,
    onGameSavedFired,
    onGameLoadedFired,
    stats() {
      const snap = mutator?.snapshot();
      const storageBackend: StorageBackendKind =
        (backend as Partial<AdaptiveStorage>).lastBackend?.() ?? 'api';
      let activeDealsCount = 0;
      let completedDealsCount = 0;
      let cancelledDealsCount = 0;
      for (const d of deals) {
        if (d.state === 'active') activeDealsCount++;
        else if (d.state === 'completed') completedDealsCount++;
        else if (d.state === 'cancelled') cancelledDealsCount++;
      }
      return {
        initialized,
        demandChangeEvents,
        dayTicks,
        lastDay,
        currentSaveName,
        currentStorageKey: makeStorageKey(currentSaveName),
        lastPersistOk,
        lastPersistAt,
        storageRoundTripOk,
        storageBackend,
        initProbe,
        pointsTracked: snap?.baselineDemand.size ?? 0,
        popsTracked: snap?.baselinePopSizes.size ?? 0,
        pointsWithDeltas: snap?.cumulativeDeltas.size ?? 0,
        lastHydrate,
        activeDeals: activeDealsCount,
        completedDeals: completedDealsCount,
        cancelledDeals: cancelledDealsCount,
        lastTickReports,
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
    splitChildren: snap.splitChildren,
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
    splitChildren: snap.splitChildren,
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
