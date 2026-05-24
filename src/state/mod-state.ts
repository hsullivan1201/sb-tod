/**
 * SB TOD — mod state
 *
 * The singleton holding the `DemandMutator` and everything that needs
 * to survive across save/load. In-memory is the source of truth while the
 * game is running; verified `api.storage` is the only release persistence
 * path for player-funded deals.
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

import { gameState, ui as uiApi, actions as actionsApi } from '../api';
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
  developmentIdentityKey,
  findDuplicateDevelopment,
  type Deal,
} from '../sim/deals';
import { createWalkshedIndex, findWalkshed } from '../scoring/walkshed';
import {
  createAdaptiveStorage,
  type AdaptiveStorage,
  type StorageBackendKind,
} from './storage-adapter';
import {
  isFlightRecorderEnabled,
  recordFlightEvent,
  recordFlightEventLazy,
} from '../diagnostics/flightRecorder';

const STORAGE_KEY_PREFIX = 'sb-tod:state:v1:';
const LEGACY_UNSEGMENTED_KEY = 'sb-tod:state:v1'; // pre-per-save key, cleaned up on init
const UNSAVED_SLOT = '_unsaved';
const APPROX_TOLERANCE = 1.0;
const RECENT_DEAL_ONLY_BOOTSTRAP_MS = 48 * 60 * 60 * 1000;

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
  splitChildrenRemoved: number;
  originalPopsReset: number;
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
  /** Dirty in-memory state waiting for the next game-save/end persist. */
  dirty: boolean;
  /** Last day's deal application reports — most recent first. */
  lastTickReports: DealTickReport[];
  /** Current day-tick phase, for diagnosing freezes around day changes. */
  dayTickPhase: 'idle' | 'init' | 'refresh-demand' | 'apply-deals';
  lastTickStartedAt: number | null;
  lastTickCompletedAt: number | null;
  lastTickActiveDealId: string | null;
  lastTickError: string | null;
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
  /** Which backend (api / electron / local / none) the last successful persist used. */
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

function formatDeliverySummary(deal: Deal): string {
  const parts: string[] = [];
  if (deal.totalDensity.residents > 0) {
    parts.push(`${Math.round(deal.appliedSoFar.residents).toLocaleString()} residents`);
  }
  if (deal.totalDensity.jobs > 0) {
    parts.push(`${Math.round(deal.appliedSoFar.jobs).toLocaleString()} jobs`);
  }
  return parts.join(' + ') || '0';
}

function describeShape(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v !== 'object') return String(v);
  const o = v as any;
  const dealsTotal = Array.isArray(o.deals) ? o.deals.length : 0;
  const dealsActive = Array.isArray(o.deals)
    ? o.deals.filter((d: any) => d?.state === 'active').length
    : 0;
  return `{ version: ${o.version}, savedAt: ${o.savedAt}, points: ${o.baselineDemand?.length ?? '?'}, pops: ${o.baselinePopSizes?.length ?? '?'}, deltas: ${o.cumulativeDeltas?.length ?? '?'}, deals: ${dealsTotal} (${dealsActive} active) }`;
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
  addDeal(deal: Deal): Promise<boolean>;
  /** Cancel an active deal. (No refund logic in v1; future enhancement.) */
  cancelDeal(dealId: string): boolean;
  /**
   * Debug: apply all remaining density of an active deal in one shot
   * and mark it completed. Bypasses the daily schedule. Useful for
   * verifying the mutation path end-to-end without waiting for game
   * time. Returns false if the deal isn't found or isn't active.
   */
  debugCompleteDeal(dealId: string): boolean;
  /**
   * Debug: walk every persisted-delta point and force-reconcile its
   * pop state against tracked baseline + cumulative. Recreates split
   * children that the game dropped during save/load (or that hydrate's
   * baseline-shift detection caused us to skip). Returns the count of
   * points reconciled and total children created.
   */
  debugReconcileAll(): { points: number; created: number; removed: number };
  /**
   * Wipe ALL TOD state for the current save: revert any tracked
   * mutations to baseline, delete every split child, drop the entire
   * deals history, persist the empty state. Recovers from corruption
   * (e.g. the snapshot-aliasing bug that wiped split children silently
   * across many sessions). Money already spent is NOT refunded.
   */
  debugResetCurrentSave(): { dealsCleared: number; pointsReverted: number };
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
  onGameEndFired(): void;
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
  /** Override budget accessor for tests. Defaults to gameState.getBudget. */
  getBudget?: () => number;
  /** Override budget refund action for tests. Defaults to actions.addMoney. */
  addMoney?: (amount: number, category?: string) => void;
  /** Initial save name. Default null (uses the `_unsaved` slot). */
  initialSaveName?: string | null;
  /** Current save-name accessor. Defaults to gameState.getSaveName(). */
  getSaveName?: () => string | null;
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
  const getSaveName = options.getSaveName ?? (() => gameState.getSaveName());
  const getBudget = options.getBudget ?? (() => gameState.getBudget());
  const addMoney = options.addMoney ?? ((amount: number, category?: string) => actionsApi.addMoney(amount, category));
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
  let dayTickPhase: ModStateStats['dayTickPhase'] = 'idle';
  let lastTickStartedAt: number | null = null;
  let lastTickCompletedAt: number | null = null;
  let lastTickActiveDealId: string | null = null;
  let lastTickError: string | null = null;
  let slotBootstrap: { storageKey: string; payload: PersistedState; reason: string } | null = null;
  let saveNameSyncPromise: Promise<void> | null = null;
  let saveNameSwitchDepth = 0;

  function isZeroDensity(total: { jobs?: number; residents?: number } | undefined): boolean {
    return (total?.jobs ?? 0) === 0 && (total?.residents ?? 0) === 0;
  }

  function isUnappliedActiveDeal(deal: Deal): boolean {
    return deal.state === 'active' && isZeroDensity(deal.appliedSoFar) && isZeroDensity(deal.pending);
  }

  function cloneDeal(d: Deal): Deal {
    return {
      ...d,
      totalDensity: {
        residents: d.totalDensity?.residents ?? 0,
        jobs: d.totalDensity?.jobs ?? 0,
      },
      appliedSoFar: {
        residents: d.appliedSoFar?.residents ?? 0,
        jobs: d.appliedSoFar?.jobs ?? 0,
      },
      pending: {
        residents: d.pending?.residents ?? 0,
        jobs: d.pending?.jobs ?? 0,
      },
      chargeAudit: d.chargeAudit
        ? {
            budgetBefore: d.chargeAudit.budgetBefore,
            expectedBudgetAfter: d.chargeAudit.expectedBudgetAfter,
            budgetAfter: d.chargeAudit.budgetAfter,
            traceId: d.chargeAudit.traceId,
            chargedAt: d.chargeAudit.chargedAt,
          }
        : undefined,
    };
  }

  function persistedCounts(persisted: PersistedState | null): {
    baselines: number;
    popBaselines: number;
    deltas: number;
    splitChildren: number;
    deals: number;
  } {
    return {
      baselines: persisted?.baselineDemand.length ?? 0,
      popBaselines: persisted?.baselinePopSizes.length ?? 0,
      deltas: persisted?.cumulativeDeltas.length ?? 0,
      splitChildren: persisted?.splitChildren?.length ?? 0,
      deals: persisted?.deals?.length ?? 0,
    };
  }

  function shouldBootstrapNamedSlot(
    previous: PersistedState | null,
    target: PersistedState | null
  ): boolean {
    if (!previous) return false;
    const prev = persistedCounts(previous);
    const next = persistedCounts(target);
    if (!target) return prev.deltas > 0 || prev.deals > 0 || prev.baselines > 0;
    if (prev.deltas > 0 && next.deltas === 0) return true;
    if (prev.baselines > 0 && next.baselines === 0 && (prev.deltas > 0 || prev.deals > next.deals)) {
      return true;
    }
    return false;
  }

  function dealMatchesLiveDemand(deal: Deal, liveDemand: DemandData): boolean {
    if (!isUnappliedActiveDeal(deal)) return false;
    const [lng, lat] = deal.centerLngLat ?? [];
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(deal.radiusMeters) ||
      deal.radiusMeters <= 0
    ) {
      return false;
    }
    const hits = findWalkshed([lng, lat], liveDemand.points.values(), {
      radiusMeters: deal.radiusMeters,
    });
    if (hits.length === 0) return false;
    const wantsResidents = (deal.totalDensity?.residents ?? 0) > 0;
    const wantsJobs = (deal.totalDensity?.jobs ?? 0) > 0;
    return (
      (!wantsResidents || hits.some((h) => h.point.residents > 0)) &&
      (!wantsJobs || hits.some((h) => h.point.jobs > 0))
    );
  }

  function hasRecentChargedUnappliedDealOnlyPayload(persisted: PersistedState): boolean {
    const counts = persistedCounts(persisted);
    if (counts.deltas > 0 || counts.deals <= 0) return false;
    const now = Date.now();
    return (persisted.deals ?? []).some((deal) => {
      if (!isUnappliedActiveDeal(deal)) return false;
      const chargedAt = deal.chargeAudit?.chargedAt;
      return (
        typeof chargedAt === 'number' &&
        Number.isFinite(chargedAt) &&
        chargedAt <= now &&
        now - chargedAt <= RECENT_DEAL_ONLY_BOOTSTRAP_MS
      );
    });
  }

  function isPersistedState(value: unknown): value is PersistedState {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<PersistedState>;
    return (
      v.version === 1 &&
      typeof v.savedAt === 'number' &&
      Array.isArray(v.baselineDemand) &&
      Array.isArray(v.baselinePopSizes) &&
      Array.isArray(v.cumulativeDeltas)
    );
  }

  function normalizeStateStorageKey(key: string): string | null {
    const raw =
      key.startsWith('local:') || key.startsWith('api:') || key.startsWith('electron:')
        ? key.slice(key.indexOf(':') + 1)
        : key;
    return raw.startsWith(STORAGE_KEY_PREFIX) ? raw : null;
  }

  async function listKnownStateStorageKeys(): Promise<string[]> {
    const keys = new Set<string>();
    try {
      const listed = await (
        (backend as StorageLike & { keys?: () => Promise<string[]> }).keys?.() ??
        Promise.resolve([])
      );
      for (const key of listed) {
        const normalized = normalizeStateStorageKey(key);
        if (normalized) keys.add(normalized);
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.add(key);
        }
      }
    } catch {
      /* ignore */
    }
    return [...keys];
  }

  async function readPersistedAtStorageKey(storageKey: string): Promise<PersistedState | null> {
    try {
      const viaBackend = await backend.get<unknown>(storageKey, null);
      if (isPersistedState(viaBackend)) return viaBackend;
    } catch {
      /* fall through to direct local probe */
    }
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(storageKey);
        if (raw != null) {
          const parsed = JSON.parse(raw) as unknown;
          if (isPersistedState(parsed)) return parsed;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function scoreBootstrapCompatibility(persisted: PersistedState, liveDemand: DemandData): {
    deltaCount: number;
    matchedDeltas: number;
    preserved: number;
    reset: number;
    missing: number;
    baselineShift: number;
    dealCount: number;
    unappliedActiveDeals: number;
    liveCompatibleUnappliedActiveDeals: number;
    splitChildren: number;
    rank: number;
  } {
    const baselines = new Map(persisted.baselineDemand);
    let preserved = 0;
    let reset = 0;
    let missing = 0;
    let baselineShift = 0;
    for (const [pointId, delta] of persisted.cumulativeDeltas) {
      const point = liveDemand.points.get(pointId);
      const baseline = baselines.get(pointId);
      if (!point || !baseline) {
        missing++;
        continue;
      }
      const total = totalDelta(delta);
      const matchesPreserved =
        approxEq(point.jobs, baseline.jobs + total.jobs) &&
        approxEq(point.residents, baseline.residents + total.residents);
      const matchesReset =
        approxEq(point.jobs, baseline.jobs) && approxEq(point.residents, baseline.residents);
      if (matchesPreserved) preserved++;
      else if (matchesReset) reset++;
      else baselineShift++;
    }
    const deltaCount = persisted.cumulativeDeltas.length;
    const matchedDeltas = preserved + reset;
    const dealCount = persisted.deals?.length ?? 0;
    let unappliedActiveDeals = 0;
    let liveCompatibleUnappliedActiveDeals = 0;
    for (const deal of persisted.deals ?? []) {
      if (!isUnappliedActiveDeal(deal)) continue;
      unappliedActiveDeals++;
      if (dealMatchesLiveDemand(deal, liveDemand)) liveCompatibleUnappliedActiveDeals++;
    }
    const splitChildren = persisted.splitChildren?.length ?? 0;
    return {
      deltaCount,
      matchedDeltas,
      preserved,
      reset,
      missing,
      baselineShift,
      dealCount,
      unappliedActiveDeals,
      liveCompatibleUnappliedActiveDeals,
      splitChildren,
      rank:
        matchedDeltas * 1_000_000 +
        deltaCount * 10_000 +
        liveCompatibleUnappliedActiveDeals * 1_000 +
        dealCount * 100 +
        splitChildren,
    };
  }

  function bootstrapScoreIsCompatible(
    score: ReturnType<typeof scoreBootstrapCompatibility>,
    options: { allowDealOnly?: boolean } = {}
  ): boolean {
    if (score.deltaCount <= 0 || score.matchedDeltas <= 0) {
      return (
        options.allowDealOnly === true &&
        score.deltaCount === 0 &&
        score.unappliedActiveDeals > 0 &&
        score.liveCompatibleUnappliedActiveDeals === score.unappliedActiveDeals
      );
    }
    const requiredMatches = Math.max(1, Math.ceil(score.deltaCount * 0.5));
    return score.matchedDeltas >= requiredMatches && score.baselineShift <= Math.max(2, score.matchedDeltas);
  }

  async function selectBootstrapForNamedSlot(
    targetSaveName: string | null,
    targetStorageKey: string,
    targetPayload: PersistedState | null,
    previousPayload: PersistedState | null,
    previousSource: string | null,
    options: { allowPreviousDealOnly?: boolean; allowRecentUnsavedDealOnly?: boolean } = {}
  ): Promise<
    | {
        payload: PersistedState;
        source: string;
        score: ReturnType<typeof scoreBootstrapCompatibility>;
      }
    | null
  > {
    if (targetSaveName == null) return null;
    const targetCounts = persistedCounts(targetPayload);
    if (targetCounts.deltas > 0) return null;
    const liveDemand = getDemand() ?? demand;
    if (!liveDemand?.points) return null;

    const candidates: Array<{
      payload: PersistedState;
      source: string;
      score: ReturnType<typeof scoreBootstrapCompatibility>;
    }> = [];
    const seenSources = new Set<string>();
    const addCandidate = (source: string, payload: PersistedState | null) => {
      if (!payload || seenSources.has(source)) return;
      seenSources.add(source);
      if (!shouldBootstrapNamedSlot(payload, targetPayload)) return;
      const score = scoreBootstrapCompatibility(payload, liveDemand);
      const allowDealOnly =
        (options.allowPreviousDealOnly === true && source === previousSource) ||
        (options.allowRecentUnsavedDealOnly === true &&
          source === makeStorageKey(null) &&
          hasRecentChargedUnappliedDealOnlyPayload(payload));
      recordFlightEvent('mod-state.save-slot.bootstrap-candidate', {
        targetStorageKey,
        source,
        shape: describeShape(payload),
        score,
        allowDealOnly,
      });
      if (!bootstrapScoreIsCompatible(score, { allowDealOnly })) return;
      candidates.push({ payload, source, score });
    };

    if (previousPayload && previousSource) {
      addCandidate(previousSource, previousPayload);
    }

    const keys = await listKnownStateStorageKeys();
    for (const key of keys) {
      if (key === targetStorageKey || key === LEGACY_UNSEGMENTED_KEY) continue;
      addCandidate(key, await readPersistedAtStorageKey(key));
    }

    candidates.sort((a, b) => {
      if (b.score.rank !== a.score.rank) return b.score.rank - a.score.rank;
      return (b.payload.savedAt ?? 0) - (a.payload.savedAt ?? 0);
    });
    const best = candidates[0];
    if (!best) return null;
    return {
      source: best.source,
      score: best.score,
      payload: mergePersistedPayloads(best.payload, targetPayload, Date.now()),
    };
  }

  function mergePersistedPayloads(
    primary: PersistedState,
    secondary: PersistedState | null,
    savedAt: number
  ): PersistedState {
    const mergedDeals = (primary.deals ?? []).map(cloneDeal);
    const seenDealIds = new Set(mergedDeals.map((deal) => deal.id));
    for (const deal of secondary?.deals ?? []) {
      if (seenDealIds.has(deal.id)) continue;
      const cloned = cloneDeal(deal);
      if (findDuplicateDevelopment(mergedDeals, cloned)) continue;
      mergedDeals.push(cloned);
      seenDealIds.add(cloned.id);
    }
    return {
      version: 1,
      savedAt,
      baselineDemand: primary.baselineDemand.map(([id, baseline]) => [
        id,
        { jobs: baseline.jobs, residents: baseline.residents },
      ]),
      baselinePopSizes: primary.baselinePopSizes.map(([id, size]) => [id, size]),
      cumulativeDeltas: primary.cumulativeDeltas.map(([id, delta]) => [
        id,
        {
          jobs: {
            fromDeals: delta.jobs.fromDeals,
            fromOrganic: delta.jobs.fromOrganic,
          },
          residents: {
            fromDeals: delta.residents.fromDeals,
            fromOrganic: delta.residents.fromOrganic,
          },
        },
      ]),
      splitChildren: primary.splitChildren?.map(([id, children]) => [id, [...children]]),
      deals: mergedDeals,
    };
  }

  function refundDealMoney(amount: number, category: string): boolean {
    if (amount <= 0) return true;
    try {
      addMoney(amount, category);
      return true;
    } catch (e) {
      console.warn('[sb-tod] refund addMoney failed:', e);
      return false;
    }
  }

  function rescueNegativeBudgetFromUnappliedDeal(): boolean {
    let budget: number | null = null;
    try {
      const b = getBudget();
      budget = Number.isFinite(b) ? b : null;
    } catch {
      return false;
    }
    if (budget == null || budget >= 0) return false;

    const candidate = [...deals].reverse().find(
      (d) =>
        d.state === 'active' &&
        d.totalCost > 0 &&
        isZeroDensity(d.appliedSoFar) &&
        isZeroDensity(d.pending)
    );
    if (!candidate) return false;

    candidate.state = 'cancelled';
    dirty = true;
    refundDealMoney(candidate.totalCost, 'TOD Deal rescue refund');
    console.warn(
      `[sb-tod] negative budget rescue: cancelled zero-progress deal ${candidate.id} and refunded $${candidate.totalCost.toLocaleString()} (budget before refund ${budget.toLocaleString()}).`
    );
    try {
      uiApi.showNotification(
        `Recovered a stuck TOD deal at ${candidate.centerStationGroupName}. Refunded $${candidate.totalCost.toLocaleString()} and cancelled the zero-progress build.`,
        'warning'
      );
    } catch (e) {
      console.warn('[sb-tod] rescue notification failed:', e);
    }
    return true;
  }

  function readLiveSaveName(): string | null {
    try {
      const name = getSaveName();
      return typeof name === 'string' && name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  function liveSaveNameNeedingSync(): string | null {
    const liveName = readLiveSaveName();
    return liveName != null && liveName !== currentSaveName ? liveName : null;
  }

  async function syncLiveSaveName(reason: string): Promise<boolean> {
    if (saveNameSwitchDepth > 0) return false;
    const liveName = liveSaveNameNeedingSync();
    if (liveName == null) return false;
    if (!saveNameSyncPromise) {
      recordFlightEvent('mod-state.save-slot.live-sync.start', {
        reason,
        from: currentSaveName,
        to: liveName,
        initialized,
        dirty,
      });
      saveNameSyncPromise = setCurrentSaveName(liveName, { allowPreviousDealOnly: true })
        .then(() => {
          recordFlightEvent('mod-state.save-slot.live-sync.end', {
            reason,
            currentSaveName,
            initialized,
            dirty,
          });
        })
        .finally(() => {
          saveNameSyncPromise = null;
        });
    }
    await saveNameSyncPromise;
    return true;
  }

  async function settleLiveSaveNameSync(reason: string): Promise<boolean> {
    if (saveNameSyncPromise) {
      await saveNameSyncPromise;
      return true;
    }
    return syncLiveSaveName(reason);
  }

  function syncLiveSaveNameSoon(reason: string): boolean {
    if (saveNameSwitchDepth > 0) return true;
    if (saveNameSyncPromise) return true;
    const liveName = liveSaveNameNeedingSync();
    if (liveName == null) return false;
    void syncLiveSaveName(reason).catch((e) =>
      console.warn('[sb-tod] live save-name sync failed:', e)
    );
    return true;
  }

  async function doInit(providedDemand?: DemandData): Promise<boolean> {
    if (currentSaveName == null) {
      currentSaveName = readLiveSaveName();
    }
    recordFlightEvent('mod-state.init.start', {
      saveName: currentSaveName,
      providedDemand: !!providedDemand,
    });
    const d = providedDemand ?? getDemand();
    if (!d || !d.points || !d.popsMap) {
      recordFlightEvent('mod-state.init.no-demand', {
        saveName: currentSaveName,
        hasDemand: !!d,
      });
      return false;
    }
    demand = d;
    mutator = createMutator(d, mutatorOptions);

    const storageKey = makeStorageKey(currentSaveName);

    // Snapshot raw state of BOTH possible backends at init time so the
    // panel can show exactly what we saw, regardless of what the
    // adapter chose to surface. Crucial for diagnosing post-restart
    // "where did my data go?" cases — and for spotting cross-save bleed.
    recordFlightEvent('mod-state.init.probe.start', { storageKey });
    initProbe = await captureInitProbe(currentSaveName, storageKey);
    recordFlightEvent('mod-state.init.probe.end', {
      storageKey,
      apiKeys: initProbe.apiKeysAtInit.length,
      localStorageKeys: initProbe.localStorageKeysAtInit.length,
      apiHasOurKey: initProbe.apiHasOurKey,
      localStorageHasOurKey: initProbe.localStorageHasOurKey,
      otherSaveKeys: initProbe.otherSaveKeys.length,
    });
    if (isFlightRecorderEnabled()) {
      console.log('[sb-tod] init probe:', initProbe);
    }

    let persisted: PersistedState | null = null;
    let storageKeys: string[] = [];
    try {
      recordFlightEvent('mod-state.init.storage-get.start', { storageKey });
      persisted = await backend.get<PersistedState | null>(storageKey, null);
      recordFlightEvent('mod-state.init.storage-get.end', {
        storageKey,
        hasPersisted: !!persisted,
        shape: describeShape(persisted),
      });
    } catch (err) {
      console.warn('[sb-tod] storage.get threw during init:', err);
      recordFlightEvent('mod-state.init.storage-get.throw', {
        storageKey,
        error: String(err),
      });
      persisted = null;
    }
    if (slotBootstrap?.storageKey === storageKey) {
      recordFlightEvent('mod-state.init.slot-bootstrap', {
        storageKey,
        reason: slotBootstrap.reason,
        targetShape: describeShape(persisted),
        bootstrapShape: describeShape(slotBootstrap.payload),
      });
      persisted = slotBootstrap.payload;
      slotBootstrap = null;
    } else if (currentSaveName != null) {
      const selected = await selectBootstrapForNamedSlot(
        currentSaveName,
        storageKey,
        persisted,
        null,
        null,
        { allowRecentUnsavedDealOnly: true }
      );
      if (selected) {
        recordFlightEvent('mod-state.init.named-slot-bootstrap-selected', {
          storageKey,
          source: selected.source,
          targetShape: describeShape(persisted),
          bootstrapShape: describeShape(selected.payload),
          score: selected.score,
        });
        persisted = selected.payload;
        dirty = true;
      }
    }
    try {
      storageKeys = await ((backend as StorageLike & { keys?: () => Promise<string[]> }).keys?.() ?? Promise.resolve([]));
    } catch {
      storageKeys = [];
    }

    if (persisted && persisted.version === 1) {
      recordFlightEvent('mod-state.init.hydrate.start', {
        storageKey,
        baselineDemand: persisted.baselineDemand.length,
        baselinePopSizes: persisted.baselinePopSizes.length,
        cumulativeDeltas: persisted.cumulativeDeltas.length,
        deals: persisted.deals?.length ?? 0,
      });
      lastHydrate = applyPersisted(mutator, d, persisted);
      deals = persisted.deals ? persisted.deals.map(cloneDeal) : [];
      recordFlightEvent('mod-state.init.hydrate.end', {
        storageKey,
        preserved: lastHydrate.preserved,
        replayed: lastHydrate.replayed,
        baselineShift: lastHydrate.baselineShift,
        missingPoint: lastHydrate.missingPoint,
        splitChildrenRemoved: lastHydrate.splitChildrenRemoved,
        originalPopsReset: lastHydrate.originalPopsReset,
        deals: deals.length,
      });
      if (isFlightRecorderEnabled()) {
        console.log(
          `[sb-tod] Hydrated "${storageKey}" (saved ${new Date(persisted.savedAt).toISOString()}): preserved=${lastHydrate.preserved}, replayed=${lastHydrate.replayed}, baselineShift=${lastHydrate.baselineShift}, missingPoint=${lastHydrate.missingPoint}, deals=${deals.length}. Storage keys: [${storageKeys.join(', ')}]`
        );
      }
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
        splitChildrenRemoved: 0,
        originalPopsReset: 0,
        fromStorage: false,
      };
      deals = [];
      const counts = mutator.trackingCounts();
      recordFlightEvent('mod-state.init.fresh-baseline', {
        storageKey,
        baselineDemand: counts.baselineDemand,
        baselinePopSizes: counts.baselinePopSizes,
        storageKeys: storageKeys.length,
      });
      if (isFlightRecorderEnabled()) {
        console.log(
          `[sb-tod] No persisted state found at "${storageKey}". Captured ${counts.baselineDemand} fresh baselines from live demand. Storage keys present: [${storageKeys.join(', ')}] (empty=backend not working, non-empty=just a fresh install or different save slot).`
        );
      }
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
    recordFlightEvent('mod-state.init.ready', {
      saveName: currentSaveName,
      storageKey,
      deals: deals.length,
      tracked: mutator.trackingCounts(),
    });
    if (rescueNegativeBudgetFromUnappliedDeal()) {
      await persist();
    }
    return true;
  }

  async function ensureInit(providedDemand?: DemandData): Promise<boolean> {
    if (initialized) {
      await syncLiveSaveName('ensure-init');
      return true;
    }
    if (!initPromise) {
      initPromise = doInit(providedDemand).finally(() => {
        if (!initialized) initPromise = null;
      });
    }
    const ok = await initPromise;
    if (ok) await syncLiveSaveName('ensure-init-after-init');
    return ok;
  }

  function isReady(): boolean {
    return initialized && mutator !== null;
  }

  function requireMutator(): DemandMutator {
    if (!mutator) throw new Error('[sb-tod] mod state not initialized');
    return mutator;
  }

  function buildPersistedPayload(savedAt: number): PersistedState | null {
    if (!mutator) return null;
    const snap = mutator.compactSnapshot();
    return {
      version: 1,
      savedAt,
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
      deals: deals.map(cloneDeal),
    };
  }

  function refreshDemandBinding(options: { allowLiveSaveSync?: boolean } = {}): boolean {
    if (options.allowLiveSaveSync !== false && syncLiveSaveNameSoon('refresh-demand')) {
      recordFlightEventLazy('mod-state.refresh-demand.defer-live-save-sync', () => ({
        currentSaveName,
        liveName: readLiveSaveName(),
      }));
      return false;
    }
    if (!initialized || !mutator) return demand !== null;
    recordFlightEventLazy('mod-state.refresh-demand.start', () => ({
      hasDemand: demand !== null,
    }));
    const live = getDemand();
    if (!live || !live.points || !live.popsMap) {
      recordFlightEventLazy('mod-state.refresh-demand.no-live-demand', () => ({ hasLive: !!live }));
      return false;
    }
    if (live === demand) {
      recordFlightEventLazy('mod-state.refresh-demand.same-object', () => ({
        points: live.points.size,
        pops: live.popsMap.size,
      }));
      return true;
    }

    const persisted = buildPersistedPayload(Date.now());
    recordFlightEventLazy('mod-state.refresh-demand.rebind.start', () => ({
      points: live.points.size,
      pops: live.popsMap.size,
      hadPersistedPayload: !!persisted,
    }));
    demand = live;
    mutator = createMutator(live, mutatorOptions);
    const reboundMutator = mutator;
    if (persisted) {
      const hydrate = applyPersisted(reboundMutator, live, persisted, {
        canonicalizeSplits: false,
      });
      lastHydrate = hydrate;
      if (isFlightRecorderEnabled()) {
        console.log(
          `[sb-tod] Rebound mutator to refreshed DemandData: preserved=${hydrate.preserved}, replayed=${hydrate.replayed}, baselineShift=${hydrate.baselineShift}, missingPoint=${hydrate.missingPoint}`
        );
      }
      recordFlightEventLazy('mod-state.refresh-demand.rebind.end', () => ({
        preserved: hydrate.preserved,
        replayed: hydrate.replayed,
        baselineShift: hydrate.baselineShift,
        missingPoint: hydrate.missingPoint,
      }));
    } else {
      reboundMutator.captureBaselines();
      recordFlightEventLazy('mod-state.refresh-demand.rebind.fresh-baseline', () => ({
        tracked: reboundMutator.trackingCounts(),
      }));
    }
    return true;
  }

  async function persist(options: { allowLiveSaveSync?: boolean } = {}): Promise<boolean> {
    recordFlightEvent('mod-state.persist.start', {
      saveName: currentSaveName,
      dirty,
      hasMutator: !!mutator,
    });
    if (!mutator) {
      lastPersistOk = false;
      recordFlightEvent('mod-state.persist.no-mutator');
      return false;
    }
    let bound = false;
    try {
      bound = refreshDemandBinding({ allowLiveSaveSync: options.allowLiveSaveSync });
    } catch (err) {
      console.warn('[sb-tod] refreshDemandBinding failed during persist:', err);
      lastPersistOk = false;
      recordFlightEvent('mod-state.persist.refresh-demand.throw', { error: String(err) });
      return false;
    }
    if (!bound) {
      lastPersistOk = false;
      recordFlightEvent('mod-state.persist.refresh-demand.failed');
      return false;
    }
    let payload: PersistedState | null = null;
    try {
      payload = buildPersistedPayload(Date.now());
    } catch (err) {
      console.warn('[sb-tod] buildPersistedPayload failed during persist:', err);
      lastPersistOk = false;
      recordFlightEvent('mod-state.persist.payload.throw', { error: String(err) });
      return false;
    }
    if (!payload) {
      lastPersistOk = false;
      recordFlightEvent('mod-state.persist.payload.null');
      return false;
    }
    const storageKey = makeStorageKey(currentSaveName);
    recordFlightEvent('mod-state.persist.payload.ready', {
      storageKey,
      baselineDemand: payload.baselineDemand.length,
      baselinePopSizes: payload.baselinePopSizes.length,
      cumulativeDeltas: payload.cumulativeDeltas.length,
      splitChildren: payload.splitChildren?.length ?? 0,
      deals: payload.deals?.length ?? 0,
    });
    try {
      recordFlightEvent('mod-state.persist.set.start', { storageKey });
      await backend.set(storageKey, payload);
      recordFlightEvent('mod-state.persist.set.end', { storageKey });
      // Immediate round-trip verify. Probe 1 caught a case where set()
      // resolved but get() returned undefined — silent drop. If that's
      // happening here, surface it loudly; persistence is effectively
      // broken and we need to know before the user counts on a reload.
      let readback: PersistedState | null = null;
      try {
        recordFlightEvent('mod-state.persist.readback.start', { storageKey });
        readback = await backend.get<PersistedState | null>(storageKey, null);
        recordFlightEvent('mod-state.persist.readback.end', {
          storageKey,
          hasReadback: !!readback,
          savedAt: readback?.savedAt ?? null,
        });
      } catch (e) {
        console.warn('[sb-tod] readback during persist verify threw:', e);
        recordFlightEvent('mod-state.persist.readback.throw', {
          storageKey,
          error: String(e),
        });
      }
      const matches = !!readback && readback.savedAt === payload.savedAt;
      storageRoundTripOk = matches;
      if (!matches) {
        console.warn(
          `[sb-tod] storage round-trip MISMATCH after set("${storageKey}"): wrote savedAt=${payload.savedAt} but readback=${readback ? `savedAt=${readback.savedAt}` : 'null'}. Data will not survive restart. (Browser mode? Known game flake? Check Electron / api.storage.)`
        );
        lastPersistOk = false;
        recordFlightEvent('mod-state.persist.roundtrip.mismatch', {
          storageKey,
          wroteSavedAt: payload.savedAt,
          readbackSavedAt: readback?.savedAt ?? null,
        });
        return false;
      }
      lastPersistOk = true;
      lastPersistAt = payload.savedAt;
      dirty = false;
      recordFlightEvent('mod-state.persist.ok', {
        storageKey,
        savedAt: payload.savedAt,
      });
      return true;
    } catch (err) {
      console.warn('[sb-tod] storage.set failed:', err);
      lastPersistOk = false;
      storageRoundTripOk = false;
      recordFlightEvent('mod-state.persist.throw', {
        storageKey,
        error: String(err),
      });
      return false;
    }
  }

  function onDayTick(day: number): void {
    if (liveSaveNameNeedingSync() != null) {
      recordFlightEventLazy('mod-state.day-tick.defer-live-save-sync', () => ({
        day,
        currentSaveName,
        liveName: readLiveSaveName(),
      }));
      void syncLiveSaveName('day-tick')
        .then(() => onDayTick(day))
        .catch((e) => console.warn('[sb-tod] live save-name sync on day tick failed:', e));
      return;
    }
    dayTicks++;
    lastDay = day;
    lastTickStartedAt = Date.now();
    lastTickCompletedAt = null;
    lastTickError = null;
    recordFlightEventLazy('mod-state.day-tick.enter', () => ({
      day,
      dayTicks,
      initialized,
      activeDeals: deals.filter((deal) => deal.state === 'active').length,
      dirty,
    }));
    if (!initialized) {
      // Try to init opportunistically — demand is almost certainly available
      // by the first day tick.
      dayTickPhase = 'init';
      recordFlightEventLazy('mod-state.day-tick.init.start', () => ({ day }));
      ensureInit().catch((e) => console.warn('[sb-tod] ensureInit on day tick failed:', e));
      return;
    }

    try {
      dayTickPhase = 'refresh-demand';
      if (!refreshDemandBinding()) {
        recordFlightEventLazy('mod-state.day-tick.refresh-demand.failed', () => ({ day }));
        return;
      }

      // Apply each active deal's daily delta. Done before the persist below
      // so the saved state reflects today's progress.
      dayTickPhase = 'apply-deals';
      recordFlightEventLazy('mod-state.day-tick.apply-deals.start', () => ({ day }));
      lastTickReports = applyActiveDealsForDay(day);
      recordFlightEventLazy('mod-state.day-tick.apply-deals.end', () => ({
        day,
        reports: lastTickReports,
        dirty,
      }));

      // Storage writes are intentionally save-hook driven. Persisting
      // automatically from the sim/day/build paths has repeatedly lined
      // up with player-visible freezes on large saves.
    } catch (err) {
      lastTickError = err instanceof Error ? err.message : String(err);
      console.warn('[sb-tod] day tick failed:', err);
      recordFlightEventLazy('mod-state.day-tick.throw', () => ({
        day,
        phase: dayTickPhase,
        activeDealId: lastTickActiveDealId,
        error: String(err),
      }));
      try {
        uiApi.showNotification(`TOD day tick failed: ${lastTickError}`, 'error');
      } catch {
        /* ignore */
      }
    } finally {
      lastTickActiveDealId = null;
      lastTickCompletedAt = Date.now();
      dayTickPhase = 'idle';
      recordFlightEventLazy('mod-state.day-tick.exit', () => ({
        day,
        durationMs:
          lastTickStartedAt != null && lastTickCompletedAt != null
            ? lastTickCompletedAt - lastTickStartedAt
            : null,
        error: lastTickError,
      }));
    }
  }

  function applyActiveDealsForDay(day: number): DealTickReport[] {
    if (!mutator || !demand) return [];
    const currentMutator = mutator;
    const currentDemand = demand;
    const reports: DealTickReport[] = [];
    const suppressedDuplicates = suppressDuplicateActiveDeals();
    const activeDeals = deals.filter((deal) => deal.state === 'active');
    recordFlightEventLazy('mod-state.deals.apply-all.start', () => ({
      day,
      activeDeals: activeDeals.length,
      suppressedDuplicates,
      points: currentDemand.points.size,
      pops: currentDemand.popsMap.size,
    }));
    const walkshedIndex =
      activeDeals.length > 0 ? createWalkshedIndex(currentDemand.points.values()) : null;
    for (const deal of activeDeals) {
      lastTickActiveDealId = deal.id;
      // Don't tick on a day before the deal started (defensive against
      // weird load ordering — shouldn't normally happen).
      if (day < deal.startDay) continue;
      const plan = computeDailyApply({
        deal,
        currentDay: day,
        walkshedPoints: currentDemand.points.values(),
        walkshedIndex: walkshedIndex ?? undefined,
      });
      recordFlightEventLazy('mod-state.deal.plan', () => ({
        day,
        dealId: deal.id,
        kind: deal.kind,
        tier: deal.tier,
        targets: plan.targets.length,
        marksCompletion: plan.marksCompletion,
        newPending: plan.newPending,
      }));
      let applied = { jobs: 0, residents: 0 };
      let pointsAffected = 0;
      let rejections = 0;
      recordFlightEventLazy('mod-state.deal.mutate.start', () => ({
        day,
        dealId: deal.id,
        targets: plan.targets.length,
      }));
      const results =
        plan.targets.length > 0 ? currentMutator.applyDensityDeltas(plan.targets, 'deals') : [];
      recordFlightEventLazy('mod-state.deal.mutate.end', () => ({
        day,
        dealId: deal.id,
        targets: plan.targets.length,
        results: results.length,
      }));
      for (let i = 0; i < plan.targets.length; i++) {
        const target = plan.targets[i];
        const r = results[i];
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
      recordFlightEventLazy('mod-state.deal.results-processed', () => ({
        day,
        dealId: deal.id,
        applied,
        pointsAffected,
        rejections,
      }));
      deal.appliedSoFar.residents += applied.residents;
      deal.appliedSoFar.jobs += applied.jobs;
      deal.pending = plan.newPending;
      if (plan.marksCompletion) {
        deal.state = 'completed';
        dirty = true;
        if (isFlightRecorderEnabled()) {
          console.log(
            `[sb-tod] deal ${deal.id} (${deal.kind}/${deal.tier}) completed on day ${day}: delivered ${deal.appliedSoFar.residents.toFixed(0)}r / ${deal.appliedSoFar.jobs.toFixed(0)}j of ${deal.totalDensity.residents}r / ${deal.totalDensity.jobs}j planned.`
          );
        }
        try {
          const summary = formatDeliverySummary(deal);
          uiApi.showNotification(
            `TOD deal complete: ${deal.kind}/${deal.tier} at ${deal.centerStationGroupName} delivered ${summary}.`,
            'success'
          );
        } catch (e) {
          // showNotification can throw if the UI isn't ready; non-fatal.
          console.warn('[sb-tod] completion notification failed:', e);
        }
      }
      reports.push({
        dealId: deal.id,
        applied,
        pointsAffected,
        rejections,
        marksCompletion: plan.marksCompletion,
      });
    }
    recordFlightEventLazy('mod-state.deals.apply-all.end', () => ({
      day,
      reports,
      dirty,
    }));
    return reports;
  }

  function suppressDuplicateActiveDeals(): number {
    const seen = new Map<string, Deal>();
    let suppressed = 0;
    for (const deal of deals) {
      if (deal.state !== 'active') continue;
      const key = developmentIdentityKey(deal);
      const original = seen.get(key);
      if (!original) {
        seen.set(key, deal);
        continue;
      }

      const hasProgress =
        Math.abs(deal.appliedSoFar.residents) > 1e-6 ||
        Math.abs(deal.appliedSoFar.jobs) > 1e-6;
      recordFlightEventLazy('mod-state.duplicate-active-deal', () => ({
        duplicateDealId: deal.id,
        originalDealId: original.id,
        hasProgress,
        totalCost: deal.totalCost,
      }));
      if (!hasProgress) {
        deal.state = 'cancelled';
        dirty = true;
        suppressed++;
        if (deal.totalCost > 0) {
          refundDealMoney(deal.totalCost, 'TOD Deal refund');
        }
        try {
          uiApi.showNotification(
            `Cancelled duplicate TOD deal at ${deal.centerStationGroupName}. Refunded $${deal.totalCost.toLocaleString()}.`,
            'warning'
          );
        } catch {
          /* ignore */
        }
      }
    }
    return suppressed;
  }

  function onDemandChangeFired(): void {
    demandChangeEvents++;
    // observability only — NEVER mutate from here (feedback-loop hazard)
  }

  function onGameSavedFired(saveName?: string): void {
    // If the player did "save as" with a new name, the in-memory state
    // applies to the NEW save (it's what they were just playing). Switch
    // the key without dropping in-memory; persist immediately.
    const nextName = typeof saveName === 'string' && saveName.length > 0 ? saveName : readLiveSaveName();
    const nameChanged = nextName !== null && nextName !== currentSaveName;
    recordFlightEvent('mod-state.game-saved', {
      saveName,
      nextName,
      currentSaveName,
      nameChanged,
      initialized,
      dirty,
    });
    if (nameChanged) {
      currentSaveName = nextName;
    }
    if (initialized && (dirty || nameChanged)) void persist();
  }

  function onGameLoadedFired(saveName?: string): void {
    const nextName = typeof saveName === 'string' && saveName.length > 0 ? saveName : readLiveSaveName();
    recordFlightEvent('mod-state.game-loaded', {
      saveName,
      nextName,
      currentSaveName,
      initialized,
      dirty,
    });
    // Loading a different save means switching slots: dump in-memory and
    // hydrate from the new save's storage. setCurrentSaveName persists
    // any unsaved deltas under the OLD name first, so nothing is lost.
    if (nextName !== currentSaveName) {
      void setCurrentSaveName(nextName).catch((e) =>
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

  function onGameEndFired(): void {
    recordFlightEvent('mod-state.game-end', { initialized, dirty, currentSaveName });
    if (initialized && dirty) void persist();
  }

  async function setCurrentSaveName(
    name: string | null,
    options: { allowPreviousDealOnly?: boolean } = {}
  ): Promise<void> {
    if (name === currentSaveName) return;
    const previousSaveName = currentSaveName;
    const previousPayload = initialized ? buildPersistedPayload(Date.now()) : null;
    recordFlightEvent('mod-state.save-slot.switch.start', {
      from: previousSaveName,
      to: name,
      initialized,
      dirty,
      previousShape: describeShape(previousPayload),
    });
    saveNameSwitchDepth++;
    try {
      // Persist current state under the OLD name before switching, so any
      // unsaved deltas don't vanish on cross-save load. Suppress live-name
      // sync while doing this: the whole point of this call is to leave the
      // old slot clean before adopting the already-known new name.
      if (initialized && dirty) {
        await persist({ allowLiveSaveSync: false }).catch((e) =>
          console.warn('[sb-tod] persist before save-switch failed:', e)
        );
      }

      let preparedBootstrapForSwitch = false;
      if (name != null) {
        const targetStorageKey = makeStorageKey(name);
        let targetPayload: PersistedState | null = null;
        try {
          targetPayload = await backend.get<PersistedState | null>(targetStorageKey, null);
        } catch (e) {
          recordFlightEvent('mod-state.save-slot.target-get.throw', {
            targetStorageKey,
            error: String(e),
          });
        }
        const selected = await selectBootstrapForNamedSlot(
          name,
          targetStorageKey,
          targetPayload,
          previousPayload,
          previousSaveName == null ? makeStorageKey(null) : makeStorageKey(previousSaveName),
          options
        );
        if (selected) {
          slotBootstrap = {
            storageKey: targetStorageKey,
            payload: selected.payload,
            reason: 'compatible-existing-save-richer-than-named-slot',
          };
          preparedBootstrapForSwitch = true;
          recordFlightEvent('mod-state.save-slot.bootstrap-prepared', {
            targetStorageKey,
            source: selected.source,
            score: selected.score,
            previousShape: describeShape(previousPayload),
            targetShape: describeShape(targetPayload),
            bootstrapShape: describeShape(slotBootstrap.payload),
          });
        }
      }

      currentSaveName = name;
      initialized = false;
      initPromise = null;
      mutator = null;
      demand = null;
      await ensureInit().catch((e) => console.warn('[sb-tod] re-init after save-switch failed:', e));
      if (preparedBootstrapForSwitch) dirty = true;
      recordFlightEvent('mod-state.save-slot.switch.end', {
        currentSaveName,
        initialized,
        dirty,
      });
    } finally {
      saveNameSwitchDepth--;
    }
  }

  return {
    ensureInit,
    isReady,
    mutator: requireMutator,
    applyDensityDelta(pointId, delta, source) {
      refreshDemandBinding();
      const r = requireMutator().applyDensityDelta(pointId, delta, source);
      if (r.ok) dirty = true;
      return r;
    },
    markDirty() {
      dirty = true;
    },
    persist,
    getDeals: () => {
      syncLiveSaveNameSoon('get-deals');
      return deals;
    },
    async addDeal(deal) {
      await settleLiveSaveNameSync('add-deal');
      recordFlightEvent('mod-state.add-deal', {
        dealId: deal.id,
        kind: deal.kind,
        tier: deal.tier,
        startDay: deal.startDay,
        totalDensity: deal.totalDensity,
        totalCost: deal.totalCost,
        dealsBefore: deals.length,
      });
      const duplicate = findDuplicateDevelopment(deals, deal);
      if (duplicate) {
        recordFlightEvent('mod-state.add-deal.duplicate', {
          dealId: deal.id,
          duplicateDealId: duplicate.id,
          duplicateState: duplicate.state,
        });
        return false;
      }
      deals.push(deal);
      dirty = true;
      // Accept the deal into in-memory state immediately. Durability is
      // provided by the game save/end hooks; writing storage on a build
      // timer has lined up with the remaining freeze reports.
      return true;
    },
    cancelDeal(dealId) {
      const d = deals.find((dd) => dd.id === dealId);
      if (!d || d.state !== 'active') {
        recordFlightEvent('mod-state.cancel-deal.rejected', {
          dealId,
          found: !!d,
          state: d?.state ?? null,
        });
        return false;
      }
      // Refund the unspent fraction. We use the average delivered
      // fraction across active dimensions (residents + jobs that this
      // deal targets) — same calc the UI progress bar uses.
      const fractions: number[] = [];
      if (d.totalDensity.residents > 0) {
        fractions.push(Math.min(1, d.appliedSoFar.residents / d.totalDensity.residents));
      }
      if (d.totalDensity.jobs > 0) {
        fractions.push(Math.min(1, d.appliedSoFar.jobs / d.totalDensity.jobs));
      }
      const deliveredFraction =
        fractions.length > 0 ? fractions.reduce((s, f) => s + f, 0) / fractions.length : 0;
      const refund = Math.round(d.totalCost * (1 - deliveredFraction));
      recordFlightEvent('mod-state.cancel-deal.accepted', {
        dealId,
        deliveredFraction,
        refund,
      });
      if (refund > 0) {
        refundDealMoney(refund, 'TOD Deal refund');
      }
      d.state = 'cancelled';
      dirty = true;
      try {
        uiApi.showNotification(
          `Cancelled ${d.kind}/${d.tier} at ${d.centerStationGroupName}. Refunded $${refund.toLocaleString()} (${Math.round((1 - deliveredFraction) * 100)}% unspent).`,
          'info'
        );
      } catch (e) {
        console.warn('[sb-tod] cancel notification failed:', e);
      }
      return true;
    },
    debugResetCurrentSave() {
      if (!mutator) return { dealsCleared: 0, pointsReverted: 0 };
      const dealsCleared = deals.length;
      const pointsReverted = mutator.trackingCounts().baselineDemand;
      mutator.revertAll();
      deals = [];
      lastTickReports = [];
      dirty = true;
      void persist();
      return { dealsCleared, pointsReverted };
    },
    debugReconcileAll() {
      refreshDemandBinding();
      if (!mutator) return { points: 0, created: 0, removed: 0 };
      const snap = mutator.snapshot();
      let points = 0;
      let created = 0;
      let removed = 0;
      for (const pointId of snap.cumulativeDeltas.keys()) {
        const r = mutator.reconcilePoint(pointId);
        points++;
        created += r.created;
        removed += r.removed;
      }
      if (created > 0 || removed > 0) dirty = true;
      return { points, created, removed };
    },
    debugCompleteDeal(dealId) {
      refreshDemandBinding();
      if (!mutator || !demand) return false;
      const d = deals.find((dd) => dd.id === dealId);
      if (!d || d.state !== 'active') return false;
      // Force the schedule to "last day" so the catch-up math returns
      // the entire remaining density.
      const plan = computeDailyApply({
        deal: d,
        currentDay: d.startDay + d.durationDays - 1,
        walkshedPoints: demand.points.values(),
      });
      const results = plan.targets.length > 0 ? mutator.applyDensityDeltas(plan.targets, 'deals') : [];
      for (let i = 0; i < plan.targets.length; i++) {
        const target = plan.targets[i];
        const r = results[i];
        if (r.ok) {
          d.appliedSoFar.residents += target.delta.residents ?? 0;
          d.appliedSoFar.jobs += target.delta.jobs ?? 0;
        } else {
          console.warn(
            `[sb-tod] debugCompleteDeal ${d.id} apply rejected on point ${target.pointId}: ${r.reason} — ${r.message}`
          );
        }
      }
      d.pending = plan.newPending;
      d.state = 'completed';
      dirty = true;
      return true;
    },
    setCurrentSaveName,
    getCurrentSaveName: () => {
      syncLiveSaveNameSoon('get-current-save-name');
      return currentSaveName;
    },
    onDayTick,
    onDemandChangeFired,
    onGameSavedFired,
    onGameLoadedFired,
    onGameEndFired,
    stats() {
      syncLiveSaveNameSoon('stats');
      const counts = mutator?.trackingCounts();
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
        dirty,
        lastPersistOk,
        lastPersistAt,
        storageRoundTripOk,
        storageBackend,
        initProbe,
        pointsTracked: counts?.baselineDemand ?? 0,
        popsTracked: counts?.baselinePopSizes ?? 0,
        pointsWithDeltas: counts?.cumulativeDeltas ?? 0,
        lastHydrate,
        activeDeals: activeDealsCount,
        completedDeals: completedDealsCount,
        cancelledDeals: cancelledDealsCount,
        lastTickReports,
        dayTickPhase,
        lastTickStartedAt,
        lastTickCompletedAt,
        lastTickActiveDealId,
        lastTickError,
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
  persisted: PersistedState,
  options: { canonicalizeSplits?: boolean } = {}
): HydrateReport {
  const report: HydrateReport = {
    perPoint: new Map(),
    preserved: 0,
    replayed: 0,
    baselineShift: 0,
    missingPoint: 0,
    splitChildrenRemoved: 0,
    originalPopsReset: 0,
    fromStorage: true,
  };

  // Seed mutator with persisted baselines and deltas so the mutator's
  // internal math uses the TRUE baselines (not live-possibly-mutated
  // values). We'll selectively re-apply via applyDensityDelta below
  // where the game-preserved path doesn't hold.
  mutator.hydrateTracking(persisted);

  // Runtime split children are synthetic, and older builds may have
  // left stale/orphaned children in the game save. Rebuild them from
  // baseline + cumulative deltas instead of trusting preserved child
  // objects. DemandPoint aggregates are left untouched for the
  // preserved/reset checks below.
  if (options.canonicalizeSplits !== false) {
    const canonical = mutator.canonicalizeSplits();
    report.splitChildrenRemoved = canonical.removed;
    report.originalPopsReset = canonical.originalsReset;
  }

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
      if (options.canonicalizeSplits !== false) {
        // Initial load can repair old/corrupt save data by rebuilding split
        // children. Routine live DemandData rebinds run with canonicalization
        // disabled, so they trust preserved aggregates and avoid rewriting
        // hundreds of already-authored split pops during the hot day tick.
        replayPersistedDelta(mutator, pointId, delta);
      }
    } else if (matchesReset) {
      // Game reset our mutations. Replay per-source so the delta
      // buckets remain correctly attributed. We must clear the seeded
      // cumulative first or applyDensityDelta will double it.
      replayPersistedDelta(mutator, pointId, delta);
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

  // Compact persisted state stores only changed points. Capture live
  // point aggregate baselines in one linear pass; pop baselines remain
  // lazy and are captured only for points we actually mutate.
  mutator.capturePointBaselines(demand.points.values());

  return report;
}

function replayPersistedDelta(
  mutator: DemandMutator,
  pointId: string,
  delta: PointDelta
): void {
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
