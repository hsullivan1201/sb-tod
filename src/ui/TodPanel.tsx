/**
 * TOD dashboard panel.
 *
 * The scoring model lives under `src/scoring/`; this file is only the
 * in-game presentation layer: compact rankings, day-aware refresh, and
 * contextual map pins.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actions, gameState, getMap, hooks, ui, utils } from '../api';
import {
  ensureRuntimeTraceSampler,
  runtimeTraceSnapshot,
  sampleRuntimeTrace,
} from '../diagnostics/runtimeTrace';
import {
  clearFlightRecorder,
  flightRecorderSnapshot,
  isFlightRecorderEnabled,
  recordFlightEvent,
  setFlightRecorderEnabled,
} from '../diagnostics/flightRecorder';
import {
  confirmProposal,
  DEFAULT_TIER_TABLE,
  DEAL_COST_MULTIPLIER,
  dealProgressFraction,
  findDuplicateDevelopment,
  validateProposal,
  type Deal,
  type DealChargeAudit,
  type DealKind,
  type ProposalResult,
  type DealTier,
} from '../sim/deals';
import { SPLIT_POP_PREFIX } from '../sim/mutate';
import {
  scoreAllStationsDetailed,
  type CalibrationInfo,
  type ScoredStation,
} from '../scoring';
import { haversineMeters } from '../scoring/walkshed';
import { getModState } from '../state/mod-state';
import { clearHighlight, setHighlight } from './mapHighlight';

const HIGHLIGHT_RADIUS_M = 500;
const MAP_CLICK_STATION_RADIUS_M = 200;
const TOP_N = 5;

const { Button } = utils.components as Record<string, React.ComponentType<any>>;

type SectionKind = 'residential' | 'commercial' | 'captured' | 'risk';

interface HighlightState {
  id: string;
  kind: SectionKind;
}

interface BuildAction {
  kind: DealKind;
  label: string;
}

interface Snapshot {
  stations: number;
  demandPoints: number;
  pops: number;
  currentDay: number;
  scored: ScoredStation[];
  calibration: CalibrationInfo;
}

interface SectionMeta {
  title: string;
  signal: string;
  color: string;
  softColor: string;
  empty: string;
}

const SECTION_META: Record<SectionKind, SectionMeta> = {
  residential: {
    title: 'Housing Growth',
    signal: 'Transit riders nearby, room for homes',
    color: '#38bdf8',
    softColor: 'rgba(56,189,248,0.16)',
    empty: 'No housing candidates yet.',
  },
  commercial: {
    title: 'Job Growth',
    signal: 'Transit arrivals nearby, room for jobs',
    color: '#34d399',
    softColor: 'rgba(52,211,153,0.16)',
    empty: 'No job-growth candidates yet.',
  },
  captured: {
    title: 'Captured Value',
    signal: 'Dense areas already working with transit',
    color: '#fbbf24',
    softColor: 'rgba(251,191,36,0.18)',
    empty: 'No captured-value stations yet.',
  },
  risk: {
    title: 'TOD Risk',
    signal: 'Dense areas with weak transit capture',
    color: '#fb7185',
    softColor: 'rgba(251,113,133,0.16)',
    empty: 'No risk candidates yet.',
  },
};

const BUILD_ACTIONS: Partial<Record<SectionKind, BuildAction>> = {
  residential: { kind: 'housing', label: 'Build homes' },
  commercial: { kind: 'commercial', label: 'Build jobs' },
  captured: { kind: 'mixed', label: 'Build mixed' },
  risk: { kind: 'mixed', label: 'Build mixed' },
};

const DEAL_KIND_OPTIONS: DealKind[] = ['housing', 'commercial', 'mixed'];
const DEAL_TIER_OPTIONS: DealTier[] = ['S', 'M', 'L'];

const FALLBACK_CALIBRATION: CalibrationInfo = {
  ridershipScale: 500,
  supplySaturation: 30_000,
  residentSaturation: 5_000,
  jobSaturation: 10_000,
  residentTransitScale: 200,
  workerTransitScale: 500,
  source: 'default',
};

const dayListeners = new Set<(day: number) => void>();
let dayHookRegistered = false;
const BUILD_LOCK_WINDOW_MS = 10000;
const BUDGET_SAMPLE_DELAYS_MS = [0, 250, 1000];
const MONEY_TRACE_LIMIT = 512;
const MONEY_EVENT_SAMPLE_MS = 500;

interface BuildLockState {
  inFlight: boolean;
  recent: Map<string, number>;
}

function getBuildLockState(): BuildLockState {
  const root = globalThis as typeof globalThis & {
    __sbTodBuildLockState?: BuildLockState;
  };
  if (!root.__sbTodBuildLockState) {
    root.__sbTodBuildLockState = { inFlight: false, recent: new Map() };
  }
  return root.__sbTodBuildLockState;
}

function buildLockToken(row: ScoredStation, kind: DealKind, tier: DealTier): string {
  return `${row.id}:${kind}:${tier}:day-${safeCurrentDay()}`;
}

function buildLockStorageKey(token: string): string {
  return `sb-tod:build-lock:${token}`;
}

function readStoredBuildLock(token: string, now: number): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(buildLockStorageKey(token));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { expiresAt?: unknown };
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0;
    if (expiresAt > now) return true;
    localStorage.removeItem(buildLockStorageKey(token));
    return false;
  } catch {
    return false;
  }
}

function writeStoredBuildLock(token: string, expiresAt: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(buildLockStorageKey(token), JSON.stringify({ expiresAt }));
  } catch {
    /* best effort only */
  }
}

function clearStoredBuildLock(token: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(buildLockStorageKey(token));
  } catch {
    /* best effort only */
  }
}

function acquireBuildLock(token: string): boolean {
  const locks = getBuildLockState();
  const now = Date.now();
  for (const [key, expiresAt] of locks.recent) {
    if (expiresAt <= now) locks.recent.delete(key);
  }
  if (locks.inFlight || locks.recent.has(token) || readStoredBuildLock(token, now)) return false;
  locks.inFlight = true;
  const expiresAt = now + BUILD_LOCK_WINDOW_MS;
  locks.recent.set(token, expiresAt);
  writeStoredBuildLock(token, expiresAt);
  return true;
}

function releaseBuildLock(token: string, keepCooldown: boolean): void {
  const locks = getBuildLockState();
  locks.inFlight = false;
  if (keepCooldown) {
    const expiresAt = Date.now() + BUILD_LOCK_WINDOW_MS;
    locks.recent.set(token, expiresAt);
    writeStoredBuildLock(token, expiresAt);
  } else {
    locks.recent.delete(token);
    clearStoredBuildLock(token);
  }
}

type MoneyTraceEntry =
  | {
      type:
        | 'build-enter'
        | 'subtract-before'
        | 'subtract-after'
        | 'charge-correction'
        | 'build-rejected'
        | 'build-stored'
        | 'build-failed';
      at: number;
      traceId: string;
      budget: number;
      detail?: Record<string, unknown>;
    }
  | {
      type: 'budget-sample';
      at: number;
      traceId: string;
      budget: number;
      delayMs: number;
    }
  | {
      type: 'money-event';
      at: number;
      newBalance: number;
      change: number;
      moneyType: 'revenue' | 'expense';
      category?: string;
      skipped?: number;
    };

interface MoneyTraceState {
  entries: MoneyTraceEntry[];
  nextId: number;
  hookRegistered: boolean;
  lastMoneyEventTraceAt: number | null;
  skippedMoneyEvents: number;
}

function getMoneyTraceState(): MoneyTraceState {
  const root = globalThis as typeof globalThis & {
    __sbTodMoneyTrace?: MoneyTraceState;
  };
  if (!root.__sbTodMoneyTrace) {
    root.__sbTodMoneyTrace = {
      entries: [],
      nextId: 1,
      hookRegistered: false,
      lastMoneyEventTraceAt: null,
      skippedMoneyEvents: 0,
    };
  } else {
    root.__sbTodMoneyTrace.lastMoneyEventTraceAt ??= null;
    root.__sbTodMoneyTrace.skippedMoneyEvents ??= 0;
  }
  return root.__sbTodMoneyTrace;
}

function pushMoneyTrace(entry: MoneyTraceEntry): void {
  const state = getMoneyTraceState();
  state.entries.push(entry);
  if (state.entries.length > MONEY_TRACE_LIMIT) {
    state.entries.splice(0, state.entries.length - MONEY_TRACE_LIMIT);
  }
}

function nextMoneyTraceId(): string {
  const state = getMoneyTraceState();
  const id = state.nextId++;
  return `money-${Date.now().toString(36)}-${id.toString(36)}`;
}

function ensureMoneyTraceHook(): void {
  const state = getMoneyTraceState();
  if (state.hookRegistered) return;
  state.hookRegistered = true;
  try {
    hooks.onMoneyChanged((newBalance, change, moneyType, category) => {
      const now = Date.now();
      const verboseTrace = isFlightRecorderEnabled();
      const important =
        category === 'TOD Deal' ||
        category === 'TOD Deal refund' ||
        category === 'mod-setMoney' ||
        (verboseTrace && category === 'other');
      if (!important && !verboseTrace) return;
      if (
        !important &&
        state.lastMoneyEventTraceAt != null &&
        now - state.lastMoneyEventTraceAt < MONEY_EVENT_SAMPLE_MS
      ) {
        state.skippedMoneyEvents++;
        return;
      }
      const skipped = state.skippedMoneyEvents > 0 ? state.skippedMoneyEvents : undefined;
      state.skippedMoneyEvents = 0;
      state.lastMoneyEventTraceAt = now;
      pushMoneyTrace({
        type: 'money-event',
        at: now,
        newBalance,
        change,
        moneyType,
        category,
        skipped,
      });
    });
  } catch (err) {
    console.warn('[sb-tod] money trace hook registration failed:', err);
  }
}

function moneyTraceSnapshot(): MoneyTraceEntry[] {
  return [...getMoneyTraceState().entries];
}

function recordBuildTrace(
  type: Extract<
    MoneyTraceEntry['type'],
    | 'build-enter'
    | 'subtract-before'
    | 'subtract-after'
    | 'charge-correction'
    | 'build-rejected'
    | 'build-stored'
    | 'build-failed'
  >,
  traceId: string,
  detail?: Record<string, unknown>
): void {
  const entry: MoneyTraceEntry = {
    type,
    at: Date.now(),
    traceId,
    budget: safeBudget(),
    detail,
  };
  pushMoneyTrace(entry);
  recordFlightEvent(`ui.${type}`, detail ? { traceId, ...detail } : { traceId });
}

function scheduleBudgetSamples(traceId: string): void {
  for (const delayMs of BUDGET_SAMPLE_DELAYS_MS) {
    window.setTimeout(() => {
      const entry: MoneyTraceEntry = {
        type: 'budget-sample',
        at: Date.now(),
        traceId,
        delayMs,
        budget: safeBudget(),
      };
      pushMoneyTrace(entry);
    }, delayMs);
  }
}

async function setBudgetExactly(
  targetBudget: number,
  traceId: string,
  detail: Record<string, unknown>
): Promise<number> {
  const beforeCorrection = safeBudget();
  try {
    actions.setMoney(targetBudget);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  } catch (err) {
    console.warn('[sb-tod] setMoney budget correction failed:', err);
    recordBuildTrace('build-failed', traceId, {
      ...detail,
      targetBudget,
      beforeCorrection,
      correctionError: String(err),
    });
  }
  const afterCorrection = safeBudget();
  recordBuildTrace('charge-correction', traceId, {
    ...detail,
    targetBudget,
    beforeCorrection,
    afterCorrection,
    correctedBy: afterCorrection - beforeCorrection,
  });
  return afterCorrection;
}

function subscribeDayChange(listener: (day: number) => void): () => void {
  if (!dayHookRegistered) {
    dayHookRegistered = true;
    hooks.onDayChange((day) => {
      for (const cb of Array.from(dayListeners)) {
        cb(day);
      }
    });
  }
  dayListeners.add(listener);
  return () => {
    dayListeners.delete(listener);
  };
}

function readSnapshot(): Snapshot {
  try {
    const stations = gameState.getStations();
    const demand = gameState.getDemandData();
    const { scored, calibration } = scoreAllStationsDetailed();
    return {
      stations: stations?.length ?? 0,
      demandPoints: demand.points?.size ?? 0,
      pops: demand.popsMap?.size ?? 0,
      currentDay: safeCurrentDay(),
      scored,
      calibration,
    };
  } catch (err) {
    console.error('[sb-tod] readSnapshot failed:', err);
    return {
      stations: 0,
      demandPoints: 0,
      pops: 0,
      currentDay: 0,
      scored: [],
      calibration: FALLBACK_CALIBRATION,
    };
  }
}

function safeCurrentDay(): number {
  try {
    return gameState.getCurrentDay();
  } catch {
    return 0;
  }
}

function safeBudget(): number {
  try {
    const budget = gameState.getBudget();
    return Number.isFinite(budget) ? budget : 0;
  } catch {
    return 0;
  }
}

async function chargeDealCost(cost: number): Promise<
  | { ok: true; audit: DealChargeAudit }
  | { ok: false; message: string }
> {
  const traceId = nextMoneyTraceId();
  const before = safeBudget();
  const expectedAfter = before - cost;
  recordBuildTrace('subtract-before', traceId, { cost, method: 'setMoney', expectedAfter });
  if (before < cost) {
    return {
      ok: false,
      message: `deal costs ${fmtMoney(cost)}; budget is ${fmtMoney(before)}`,
    };
  }

  try {
    // In some game builds subtractMoney emits the requested category debit
    // and then a second generic "other" debit. Set the exact target balance
    // instead so TOD never briefly drives the player negative or needs a
    // corrective money mutation in the middle of a sim tick.
    actions.setMoney(expectedAfter);
    scheduleBudgetSamples(traceId);
  } catch (err) {
    console.warn('[sb-tod] setMoney charge failed:', err);
    recordBuildTrace('build-failed', traceId, { cost, reason: 'setMoney charge threw', error: String(err) });
    return { ok: false, message: 'Could not charge the TOD deal cost.' };
  }

  await new Promise((resolve) => window.setTimeout(resolve, 0));
  let after = safeBudget();
  const observedDelta = before - after;
  recordBuildTrace('subtract-after', traceId, { cost, method: 'setMoney', expectedAfter, observedDelta });

  if (Math.abs(after - expectedAfter) > 1) {
    after = await setBudgetExactly(expectedAfter, traceId, {
      cost,
      reason: 'observed charge did not match expected deal cost',
      expectedAfter,
      observedAfter: after,
      observedDelta,
    });
  }

  if (Math.abs(after - expectedAfter) > 1) {
    const restored = await setBudgetExactly(before, traceId, {
      cost,
      reason: 'charge correction failed; restoring pre-charge budget',
      expectedAfter,
      observedAfter: after,
    });
    return {
      ok: false,
      message:
        Math.abs(restored - before) <= 1
          ? 'TOD charge could not be verified. The budget was restored; try again.'
          : 'TOD charge could not be verified and automatic budget recovery failed.',
    };
  }

  if (after < 0) {
    recordBuildTrace('build-failed', traceId, { cost, reason: 'negative budget after charge', expectedAfter });
    try {
      actions.addMoney(cost, 'TOD Deal refund');
    } catch (err) {
      console.warn('[sb-tod] refund after negative budget failed:', err);
    }
    return {
      ok: false,
      message: 'TOD deal charge would put the budget below zero. The cost was refunded.',
    };
  }

  return {
    ok: true,
    audit: {
      budgetBefore: before,
      expectedBudgetAfter: expectedAfter,
      budgetAfter: after,
      traceId,
      chargedAt: Date.now(),
    },
  };
}

function refundChargedDeal(
  cost: number,
  category: string,
  traceId: string,
  detail?: Record<string, unknown>
): boolean {
  if (cost <= 0) return true;
  try {
    actions.addMoney(cost, category);
    recordBuildTrace('build-failed', traceId, {
      cost,
      refunded: true,
      ...detail,
    });
    return true;
  } catch (err) {
    console.warn('[sb-tod] refund after charged deal failed:', err);
    recordBuildTrace('build-failed', traceId, {
      cost,
      refunded: false,
      refundError: String(err),
      ...detail,
    });
    return false;
  }
}

export function TodPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot());
  const [highlighted, setHighlighted] = useState<HighlightState | null>(null);
  const [proposalKind, setProposalKind] = useState<DealKind>('housing');
  const [proposalTier, setProposalTier] = useState<DealTier>('S');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [flightRecorderArmed, setFlightRecorderArmed] = useState(() =>
    isFlightRecorderEnabled()
  );
  const [dealVersion, setDealVersion] = useState(0);
  const [buildPending, setBuildPending] = useState(false);
  const [themeStyle, setThemeStyle] = useState<TodThemeStyle>(() => readTodThemeStyle());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buildInFlightRef = useRef(false);

  useEffect(() => {
    if (!isFlightRecorderEnabled()) return;
    ensureRuntimeTraceSampler();
    sampleRuntimeTrace('panel-open');
  }, []);

  const toggleFlightRecorder = useCallback((enabled: boolean) => {
    setFlightRecorderEnabled(enabled);
    setFlightRecorderArmed(enabled);
    if (enabled) {
      ensureRuntimeTraceSampler();
      sampleRuntimeTrace('flight-recorder-enabled');
    }
  }, []);

  const clearFlightRecorderEntries = useCallback(() => {
    clearFlightRecorder();
    recordFlightEvent('flight-recorder.cleared', undefined, { includeGame: true });
    setDealVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    const syncTheme = () => {
      if (!disposed) setThemeStyle(readTodThemeStyle(panelRef.current));
    };
    syncTheme();

    const doc = panelRef.current?.ownerDocument;
    const observer =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(syncTheme) : null;
    const observeOptions: MutationObserverInit = {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'],
    };
    const observed = [
      doc?.documentElement,
      doc?.body,
      panelRef.current?.parentElement,
      panelRef.current?.parentElement?.parentElement,
    ].filter((node): node is HTMLElement => !!node);

    for (const node of observed) observer?.observe(node, observeOptions);

    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    media?.addEventListener?.('change', syncTheme);
    const retry = window.setTimeout(syncTheme, 50);

    return () => {
      disposed = true;
      observer?.disconnect();
      media?.removeEventListener?.('change', syncTheme);
      window.clearTimeout(retry);
    };
  }, []);

  const selectedStation = useMemo(
    () => (highlighted ? snapshot.scored.find((row) => row.id === highlighted.id) ?? null : null),
    [highlighted, snapshot.scored]
  );

  const refresh = useCallback(() => {
    setSnapshot(readSnapshot());
    setDealVersion((v) => v + 1);
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.setTimeout(refresh, 0);
      return;
    }
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const clearSelection = useCallback(() => {
    clearHighlight();
    setHighlighted(null);
  }, []);

  const selectStation = useCallback(
    (row: ScoredStation, kind: SectionKind, options: { easeCamera?: boolean } = {}) => {
      const meta = SECTION_META[kind];
      setHighlight(row.center, HIGHLIGHT_RADIUS_M, {
        color: meta.color,
        easeCamera: options.easeCamera,
      });
      setHighlighted({ id: row.id, kind });
    },
    []
  );

  const onRowClick = useCallback(
    (row: ScoredStation, kind: SectionKind) => {
      if (highlighted?.id === row.id && highlighted.kind === kind) {
        clearSelection();
        return;
      }
      const action = BUILD_ACTIONS[kind];
      if (action) setProposalKind(action.kind);
      selectStation(row, kind);
    },
    [clearSelection, highlighted, selectStation]
  );

  const onPrepareBuild = useCallback(
    (row: ScoredStation, sectionKind: SectionKind, action: BuildAction) => {
      setProposalKind(action.kind);
      selectStation(row, sectionKind);
    },
    [selectStation]
  );

  const onConfirmDeal = useCallback(
    async (row: ScoredStation, kind: DealKind, tier: DealTier) => {
      const lockToken = buildLockToken(row, kind, tier);
      const enterTraceId = nextMoneyTraceId();
      recordFlightEvent('build.confirm.enter', {
        traceId: enterTraceId,
        lockToken,
        stationId: row.id,
        stationName: row.name,
        kind,
        tier,
      });
      if (buildInFlightRef.current) {
        recordBuildTrace('build-rejected', enterTraceId, {
          lockToken,
          stationId: row.id,
          stationName: row.name,
          kind,
          tier,
          reason: 'component in-flight',
        });
        ui.showNotification('A TOD build is already being processed. Try again in a moment.', 'info');
        return;
      }
      if (!acquireBuildLock(lockToken)) {
        recordBuildTrace('build-rejected', enterTraceId, {
          lockToken,
          stationId: row.id,
          stationName: row.name,
          kind,
          tier,
          reason: 'transaction lock held',
        });
        ui.showNotification('A TOD build is already being processed. Try again in a moment.', 'info');
        return;
      }
      buildInFlightRef.current = true;
      setBuildPending(true);
      let started = false;
      let charged = false;
      recordFlightEvent('build.lock.acquired', { traceId: enterTraceId, lockToken });
      recordBuildTrace('build-enter', enterTraceId, {
        lockToken,
        stationId: row.id,
        stationName: row.name,
        kind,
        tier,
        day: safeCurrentDay(),
      });
      try {
        recordFlightEvent('build.demand-read.start', { traceId: enterTraceId });
        const demand = gameState.getDemandData();
        recordFlightEvent('build.demand-read.end', {
          traceId: enterTraceId,
          points: demand.points?.size ?? null,
          pops: demand.popsMap?.size ?? null,
        });
        const state = getModState();
        recordFlightEvent('build.ensure-init.start', {
          traceId: enterTraceId,
          alreadyReady: state.isReady(),
        });
        const ready = await state.ensureInit(demand);
        recordFlightEvent('build.ensure-init.end', { traceId: enterTraceId, ready });

        if (!ready) {
          ui.showNotification('TOD state is not ready yet. Try again after the next game day tick.', 'warning');
          return;
        }

        recordFlightEvent('build.validate.start', {
          traceId: enterTraceId,
          budget: safeBudget(),
          radiusMeters: HIGHLIGHT_RADIUS_M,
        });
        const proposal = validateProposal({
          kind,
          tier,
          centerLngLat: row.center,
          radiusMeters: HIGHLIGHT_RADIUS_M,
          walkshedPoints: demand.points.values(),
          budget: safeBudget(),
          costMultiplier: DEAL_COST_MULTIPLIER,
        });
        recordFlightEvent('build.validate.end', {
          traceId: enterTraceId,
          ok: proposal.ok,
          reason: proposal.ok ? null : proposal.reason,
          eligiblePoints: proposal.ok ? proposal.eligiblePoints.length : 0,
          totalCost: proposal.ok ? proposal.totalCost : null,
        });
        if (!proposal.ok) {
          ui.showNotification(`Cannot build at ${displayName(row.name, row.id)}: ${proposal.message}`, 'warning');
          return;
        }

        const deal = confirmProposal({
          proposal,
          startDay: safeCurrentDay(),
          centerStationGroupId: row.id,
          centerStationGroupName: row.name,
          centerLngLat: row.center,
          radiusMeters: HIGHLIGHT_RADIUS_M,
        });
        const duplicateDeal = findDuplicateDevelopment(state.getDeals(), deal);
        if (duplicateDeal) {
          recordFlightEvent('build.duplicate.rejected', {
            traceId: enterTraceId,
            dealId: deal.id,
            duplicateDealId: duplicateDeal.id,
            duplicateState: duplicateDeal.state,
          });
          ui.showNotification(
            `TOD development already funded at ${displayName(row.name, row.id)} for day ${deal.startDay}.`,
            'info'
          );
          return;
        }

        recordFlightEvent('build.charge.start', {
          traceId: enterTraceId,
          dealId: deal.id,
          cost: deal.totalCost,
        });
        const charge = await chargeDealCost(deal.totalCost);
        recordFlightEvent('build.charge.end', {
          traceId: enterTraceId,
          dealId: deal.id,
          ok: charge.ok,
          chargeTraceId: charge.ok ? charge.audit.traceId : null,
        });
        if (!charge.ok) {
          ui.showNotification(`Cannot build at ${displayName(row.name, row.id)}: ${charge.message}`, 'warning');
          return;
        }
        charged = true;
        deal.chargeAudit = charge.audit;

        let stored = false;
        try {
          recordFlightEvent('build.add-deal.start', {
            traceId: charge.audit.traceId ?? enterTraceId,
            dealId: deal.id,
          });
          stored = await state.addDeal(deal);
          recordFlightEvent('build.add-deal.end', {
            traceId: charge.audit.traceId ?? enterTraceId,
            dealId: deal.id,
            stored,
          });
        } catch (err) {
          console.warn('[sb-tod] addDeal threw after charging:', err);
          recordFlightEvent('build.add-deal.throw', {
            traceId: charge.audit.traceId ?? enterTraceId,
            dealId: deal.id,
            error: String(err),
          });
          recordBuildTrace('build-failed', charge.audit.traceId ?? nextMoneyTraceId(), {
            dealId: deal.id,
            cost: deal.totalCost,
            reason: 'addDeal threw after charge',
            error: String(err),
          });
        }
        if (!stored) {
          refundChargedDeal(deal.totalCost, 'TOD Deal refund', charge.audit.traceId ?? nextMoneyTraceId(), {
            dealId: deal.id,
            reason: 'deal not stored after charge',
          });
          setDealVersion((v) => v + 1);
          ui.showNotification(
            'TOD deal could not be saved after charging. The cost was refunded and the deal was not started.',
            'error'
          );
          return;
        }
        started = true;
        recordBuildTrace('build-stored', charge.audit.traceId ?? nextMoneyTraceId(), {
          dealId: deal.id,
          cost: deal.totalCost,
        });
        setDealVersion((v) => v + 1);
      } finally {
        buildInFlightRef.current = false;
        releaseBuildLock(lockToken, charged && !started);
        setBuildPending(false);
        recordFlightEvent('build.confirm.finally', {
          traceId: enterTraceId,
          lockToken,
          started,
          charged,
        });
      }
    },
    []
  );

  // ESC clears a selected pin before the game handles the key for panel chrome.
  useEffect(() => {
    ensureMoneyTraceHook();
  }, []);

  useEffect(() => {
    if (!highlighted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      clearSelection();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clearSelection, highlighted]);

  // Station markers are DOM elements that call e.stopPropagation() in their
  // own click handler, so MapLibre's 'click' event never fires for them. A
  // capture-phase listener on the map container runs before the marker handles
  // the click, so we still catch station clicks and mirror the selection into
  // the dashboard. We unproject the click point to lng/lat and match the
  // nearest scored station.
  useEffect(() => {
    const m = getMap();
    if (!m || typeof m.getContainer !== 'function' || typeof m.unproject !== 'function') {
      return undefined;
    }
    const container = m.getContainer() as HTMLElement | null;
    if (!container) return undefined;
    const onContainerClick = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      let lngLat;
      try {
        lngLat = m.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      } catch {
        return;
      }
      const lng = lngLat?.lng;
      const lat = lngLat?.lat;
      if (typeof lng !== 'number' || typeof lat !== 'number') return;
      const nearest = nearestStation(snapshot.scored, [lng, lat], MAP_CLICK_STATION_RADIUS_M);
      if (!nearest) return;
      selectStation(nearest.row, sectionKindForDeal(proposalKind), { easeCamera: false });
    };
    container.addEventListener('click', onContainerClick, true);
    return () => container.removeEventListener('click', onContainerClick, true);
  }, [proposalKind, selectStation, snapshot.scored]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    return subscribeDayChange(scheduleRefresh);
  }, [autoRefresh, scheduleRefresh]);

  const topResidential = useMemo(
    () =>
      [...snapshot.scored]
        .sort((a, b) => b.access.residential - a.access.residential)
        .slice(0, TOP_N),
    [snapshot]
  );
  const topCommercial = useMemo(
    () =>
      [...snapshot.scored]
        .sort((a, b) => b.access.commercial - a.access.commercial)
        .slice(0, TOP_N),
    [snapshot]
  );
  const riskCandidates = useMemo(
    () => snapshot.scored.filter((s) => s.score.ridership > 0),
    [snapshot]
  );
  const topRisk = useMemo(
    () => [...riskCandidates].sort((a, b) => b.score.risk - a.score.risk).slice(0, TOP_N),
    [riskCandidates]
  );
  const topCaptured = useMemo(
    () =>
      [...snapshot.scored]
        .sort((a, b) => b.score.capturedValue - a.score.capturedValue)
        .slice(0, TOP_N),
    [snapshot]
  );
  const totalRiders = useMemo(
    () => snapshot.scored.reduce((sum, s) => sum + s.score.ridership, 0),
    [snapshot]
  );

  const riskExcluded = snapshot.scored.length - riskCandidates.length;
  const deals = useMemo(() => [...getModState().getDeals()], [snapshot, dealVersion]);
  const dealStats = useMemo(() => summarizeDeals(deals), [deals]);
  const stateStats = useMemo(() => getModState().stats(), [snapshot, dealVersion]);
  const persistenceBlocked = stateStats.storageRoundTripOk === false;
  const buildDay = Math.max(snapshot.currentDay, safeCurrentDay());
  const proposalPreview = useMemo(
    () => (selectedStation ? readProposalPreview(selectedStation, proposalKind, proposalTier) : null),
    [selectedStation, proposalKind, proposalTier, snapshot, dealVersion]
  );
  const duplicateDevelopment = useMemo(() => {
    if (!selectedStation || proposalPreview?.ok !== true) return null;
    return findDuplicateDevelopment(getModState().getDeals(), {
      kind: proposalKind,
      tier: proposalTier,
      centerStationGroupId: selectedStation.id,
      startDay: buildDay,
      durationDays: proposalPreview.durationDays,
      totalDensity: proposalPreview.totalDensity,
      totalCost: proposalPreview.totalCost,
    });
  }, [selectedStation, proposalKind, proposalTier, proposalPreview, buildDay, dealVersion]);

  return (
    <div ref={panelRef} className="text-sm" style={{ ...panelStyle, ...themeStyle }}>
      <header style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrowStyle}>Transit-Oriented Development</div>
          <h2 style={titleStyle}>TOD Dashboard</h2>
          <div style={statusLineStyle}>
            Day {snapshot.currentDay.toLocaleString()} · {autoRefresh ? 'auto-refresh on' : 'manual refresh'}
          </div>
        </div>
        <div style={headerActionsStyle}>
          <Button onClick={refresh}>Refresh</Button>
          {highlighted && (
            <Button
              variant="secondary"
              onClick={clearSelection}
            >
              Clear pin
            </Button>
          )}
        </div>
      </header>

      <div style={statGridStyle}>
        <Stat label="Station areas" value={snapshot.scored.length.toLocaleString()} />
        <Stat label="Platforms" value={snapshot.stations.toLocaleString()} />
        <Stat label="Riders / 15 min" value={Math.round(totalRiders).toLocaleString()} />
        <Stat label="Demand points" value={snapshot.demandPoints.toLocaleString()} />
        <Stat label="Pops" value={snapshot.pops.toLocaleString()} />
        <Stat label="Active deals" value={dealStats.active.toLocaleString()} />
      </div>

      <BuildSection
        station={selectedStation}
        proposalKind={proposalKind}
        proposalTier={proposalTier}
        proposalPreview={proposalPreview}
        duplicateDevelopment={duplicateDevelopment}
        buildDay={buildDay}
        persistenceBlocked={persistenceBlocked}
        buildPending={buildPending}
        onKindChange={setProposalKind}
        onTierChange={setProposalTier}
        onConfirm={() => {
          if (!selectedStation) return;
          void onConfirmDeal(selectedStation, proposalKind, proposalTier);
        }}
      />

      <StationSection
        kind="residential"
        rows={topResidential}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.access.residential,
          detail: `${fmt(row.access.residentTransit)} transit / ${fmt(row.totals.residents)} residents`,
        })}
      />

      <StationSection
        kind="commercial"
        rows={topCommercial}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.access.commercial,
          detail: `${fmt(row.access.workerTransit)} transit / ${fmt(row.totals.jobs)} jobs`,
        })}
      />

      <StationSection
        kind="captured"
        rows={topCaptured}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.score.capturedValue,
          detail: `${fmt(row.score.ridership)} riders / ${fmt(row.score.walkshedSupply)} nearby`,
        })}
      />

      <StationSection
        kind="risk"
        rows={topRisk}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.score.risk,
          detail: `${fmt(row.score.ridership)} riders / ${fmt(row.score.walkshedSupply)} nearby`,
        })}
        footnote={
          riskExcluded > 0
            ? `${riskExcluded} station area${riskExcluded === 1 ? '' : 's'} hidden with no recorded ridership`
            : undefined
        }
      />

      <DealsSection
        deals={deals}
        currentDay={snapshot.currentDay}
        onLocate={(deal) => {
          setHighlight(deal.centerLngLat, deal.radiusMeters, { color: dealColor(deal.kind) });
          setProposalKind(deal.kind);
          setProposalTier(deal.tier);
          setHighlighted({ id: deal.centerStationGroupId, kind: sectionKindForDeal(deal.kind) });
        }}
        onCancel={(deal) => {
          if (!getModState().cancelDeal(deal.id)) return;
          setDealVersion((v) => v + 1);
          scheduleRefresh();
        }}
      />

      <details style={diagnosticsStyle}>
        <summary style={summaryStyle}>Diagnostics</summary>
        <div style={diagnosticsBodyStyle}>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
            />
            Auto-refresh each day
          </label>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={flightRecorderArmed}
              onChange={(e) => toggleFlightRecorder(e.currentTarget.checked)}
            />
            Freeze trace
          </label>
          <CalibrationSummary calibration={snapshot.calibration} />
          <StateSummary />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => downloadDebug(snapshot)}>
              Debug DL
            </Button>
            <Button variant="secondary" onClick={clearFlightRecorderEntries}>
              Clear trace
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

function BuildSection({
  station,
  proposalKind,
  proposalTier,
  proposalPreview,
  duplicateDevelopment,
  buildDay,
  persistenceBlocked,
  buildPending,
  onKindChange,
  onTierChange,
  onConfirm,
}: {
  station: ScoredStation | null;
  proposalKind: DealKind;
  proposalTier: DealTier;
  proposalPreview: ProposalResult | null;
  duplicateDevelopment: Deal | null;
  buildDay: number;
  persistenceBlocked: boolean;
  buildPending: boolean;
  onKindChange: (kind: DealKind) => void;
  onTierChange: (tier: DealTier) => void;
  onConfirm: () => void;
}) {
  const color = dealColor(proposalKind);
  const tierConfig = DEFAULT_TIER_TABLE[proposalKind][proposalTier];
  const previewOk = proposalPreview?.ok === true;
  const previewText =
    persistenceBlocked
      ? 'Persistence unavailable; new deals are disabled.'
      : duplicateDevelopment
      ? `Already funded on day ${buildDay} (${duplicateDevelopment.state}).`
      : proposalPreview == null
      ? `${fmtMoney(Math.round(tierConfig.cost * DEAL_COST_MULTIPLIER))} · ${densitySummary(tierConfig.totalDensity)} · ${tierConfig.duration} days`
      : proposalPreview.ok
        ? `${fmtMoney(proposalPreview.totalCost)} · ${densitySummary(proposalPreview.totalDensity)} · ${proposalPreview.durationDays} days · ${proposalPreview.eligiblePoints.length} points`
        : proposalPreview.message;
  const buildDisabled = buildPending || !station || !previewOk || persistenceBlocked || !!duplicateDevelopment;

  return (
    <section style={{ ...buildPanelStyle, borderColor: `${color}55` }}>
      <div style={sectionHeaderStyle}>
        <span style={{ ...sectionStripeStyle, backgroundColor: color }} />
        <div style={{ minWidth: 0 }}>
          <h3 style={sectionTitleStyle}>New Development</h3>
          <p style={sectionSignalStyle}>
            {station ? displayName(station.name, station.id) : 'No station selected'}
          </p>
        </div>
      </div>

      <div style={builderControlsStyle}>
        <SegmentedControl
          options={DEAL_KIND_OPTIONS}
          value={proposalKind}
          color={color}
          getLabel={dealKindLabel}
          onChange={onKindChange}
        />
        <SegmentedControl
          options={DEAL_TIER_OPTIONS}
          value={proposalTier}
          color={color}
          getLabel={(tier) => tier}
          onChange={onTierChange}
        />
      </div>

      <div style={builderFooterStyle}>
        <span style={{ ...proposalStatusStyle, color: persistenceBlocked || (proposalPreview && !previewOk) ? SECTION_META.risk.color : MUTED_COLOR }}>
          {previewText}
        </span>
        <button
          type="button"
          disabled={buildDisabled}
          style={{
            ...confirmButtonStyle,
            borderColor: color,
            color: buildDisabled ? FAINT_COLOR : color,
            cursor: buildDisabled ? 'not-allowed' : 'pointer',
            opacity: buildDisabled ? 0.62 : 1,
          }}
          onClick={onConfirm}
        >
          {buildPending ? 'Building' : 'Build'}
        </button>
      </div>
    </section>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  color,
  getLabel,
  onChange,
}: {
  options: T[];
  value: T;
  color: string;
  getLabel: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div style={segmentedStyle}>
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            style={{
              ...segmentButtonStyle,
              borderColor: active ? color : 'transparent',
              backgroundColor: active ? `${color}24` : 'transparent',
              color: active ? TEXT_COLOR : MUTED_COLOR,
            }}
            onClick={() => onChange(option)}
          >
            {getLabel(option)}
          </button>
        );
      })}
    </div>
  );
}

function DealsSection({
  deals,
  currentDay,
  onLocate,
  onCancel,
}: {
  deals: Deal[];
  currentDay: number;
  onLocate: (deal: Deal) => void;
  onCancel: (deal: Deal) => void;
}) {
  const active = deals.filter((deal) => deal.state === 'active');
  const completed = deals.filter((deal) => deal.state === 'completed');
  const cancelled = deals.filter((deal) => deal.state === 'cancelled');
  const visible = [...active, ...completed].slice(0, 4);

  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <span style={{ ...sectionStripeStyle, backgroundColor: '#a78bfa' }} />
        <div style={{ minWidth: 0 }}>
          <h3 style={sectionTitleStyle}>Deals</h3>
          <p style={sectionSignalStyle}>
            {active.length} active · {completed.length} complete · {cancelled.length} cancelled
          </p>
        </div>
      </div>

      {visible.length === 0 ? (
        <p style={emptyStyle}>New development deals will appear here.</p>
      ) : (
        <div style={listStyle}>
          {visible.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              currentDay={currentDay}
              onLocate={onLocate}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DealRow({
  deal,
  currentDay,
  onLocate,
  onCancel,
}: {
  deal: Deal;
  currentDay: number;
  onLocate: (deal: Deal) => void;
  onCancel: (deal: Deal) => void;
}) {
  const color = dealColor(deal.kind);
  const progress = deal.state === 'active' ? dealProgressFraction(deal, currentDay) : 1;
  const delivered = dealDeliveryFraction(deal);
  const fraction = clamp01(Math.max(progress, delivered));

  return (
    <div style={{ ...rowButtonStyle, cursor: 'default', borderColor: `${color}66` }}>
      <div style={rowTopStyle}>
        <span style={stationNameStyle}>
          {dealKindLabel(deal.kind)}/{deal.tier}
          <span style={transferBadgeStyle}>
            {deal.state === 'active' ? `day ${Math.max(1, currentDay - deal.startDay + 1)}/${deal.durationDays}` : deal.state}
          </span>
        </span>
        <span style={rowActionStyle}>
          <button
            type="button"
            style={{ ...buildButtonStyle, borderColor: color, color }}
            onClick={() => onLocate(deal)}
          >
            Locate
          </button>
          {deal.state === 'active' && (
            <>
              <button
                type="button"
                style={{ ...buildButtonStyle, borderColor: FAINT_COLOR, color: MUTED_COLOR }}
                onClick={() => onCancel(deal)}
              >
                Cancel
              </button>
            </>
          )}
        </span>
      </div>
      <div style={rowBottomStyle}>
        <ScoreBar score={fraction} color={color} />
        <span style={detailStyle}>
          {displayName(deal.centerStationGroupName, deal.centerStationGroupId)} · {dealSummary(deal)} · {fmtMoney(deal.totalCost)}
        </span>
      </div>
    </div>
  );
}

function StationSection({
  kind,
  rows,
  highlighted,
  onRowClick,
  onBuild,
  getMetric,
  footnote,
}: {
  kind: SectionKind;
  rows: ScoredStation[];
  highlighted: HighlightState | null;
  onRowClick: (row: ScoredStation, kind: SectionKind) => void;
  onBuild: (row: ScoredStation, sectionKind: SectionKind, action: BuildAction) => void;
  getMetric: (row: ScoredStation) => { score: number; detail: string };
  footnote?: string;
}) {
  const meta = SECTION_META[kind];
  const buildAction = BUILD_ACTIONS[kind];
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <span style={{ ...sectionStripeStyle, backgroundColor: meta.color }} />
        <div style={{ minWidth: 0 }}>
          <h3 style={sectionTitleStyle}>{meta.title}</h3>
          <p style={sectionSignalStyle}>{meta.signal}</p>
        </div>
      </div>

      <div style={listStyle}>
        {rows.length === 0 ? (
          <p style={emptyStyle}>{meta.empty}</p>
        ) : (
          rows.map((row) => {
            const metric = getMetric(row);
            return (
              <ScoreRow
                key={`${kind}-${row.id}`}
                row={row}
                kind={kind}
                metric={metric}
                buildAction={buildAction}
                isHighlighted={highlighted?.id === row.id && highlighted.kind === kind}
                onClick={onRowClick}
                onBuild={onBuild}
              />
            );
          })
        )}
      </div>

      {footnote && <p style={footnoteStyle}>{footnote}</p>}
    </section>
  );
}

function ScoreRow({
  row,
  kind,
  metric,
  buildAction,
  isHighlighted,
  onClick,
  onBuild,
}: {
  row: ScoredStation;
  kind: SectionKind;
  metric: { score: number; detail: string };
  buildAction?: BuildAction;
  isHighlighted: boolean;
  onClick: (row: ScoredStation, kind: SectionKind) => void;
  onBuild: (row: ScoredStation, sectionKind: SectionKind, action: BuildAction) => void;
}) {
  const meta = SECTION_META[kind];
  const score = clamp01(metric.score);
  const backgroundColor = isHighlighted ? meta.softColor : ROW_BG_COLOR;
  const borderColor = isHighlighted ? meta.color : BORDER_COLOR;

  return (
    <div
      role="button"
      tabIndex={0}
      style={{
        ...rowButtonStyle,
        backgroundColor,
        borderColor,
        boxShadow: isHighlighted ? `inset 2px 0 0 0 ${meta.color}` : undefined,
      }}
      title={`${row.name}\n${row.memberCount} platform${row.memberCount === 1 ? '' : 's'}\n${HIGHLIGHT_RADIUS_M}m walkshed`}
      onClick={() => onClick(row, kind)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClick(row, kind);
      }}
      onMouseEnter={(e) => {
        if (!isHighlighted) {
          (e.currentTarget as HTMLDivElement).style.setProperty('background-color', ROW_HOVER_BG_COLOR);
        }
      }}
      onMouseLeave={(e) => {
        if (!isHighlighted) {
          (e.currentTarget as HTMLDivElement).style.setProperty('background-color', ROW_BG_COLOR);
        }
      }}
    >
      <div style={rowTopStyle}>
        <span style={stationNameStyle}>
          {displayName(row.name, row.id)}
          {row.memberCount > 1 && (
            <span style={transferBadgeStyle}>x{row.memberCount}</span>
          )}
        </span>
        <span style={rowActionStyle}>
          {buildAction ? (
            <button
              type="button"
              style={{ ...buildButtonStyle, borderColor: meta.color, color: meta.color }}
              onClick={(e) => {
                e.stopPropagation();
                onBuild(row, kind, buildAction);
              }}
            >
              {buildAction.label}
            </button>
          ) : (
            <span style={noBuildStyle}>Fix service first</span>
          )}
          <span style={{ ...scorePillStyle, color: meta.color }}>
            {score.toFixed(2)}
          </span>
        </span>
      </div>
      <div style={rowBottomStyle}>
        <ScoreBar score={score} color={meta.color} />
        <span style={detailStyle}>{metric.detail}</span>
      </div>
    </div>
  );
}

function ScoreBar({ score, color }: { score: number; color: string }) {
  const pct = `${Math.round(clamp01(score) * 100)}%`;
  return (
    <span style={barTrackStyle}>
      <span style={{ ...barFillStyle, width: pct, backgroundColor: color }} />
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <span style={statLabelStyle}>{label}</span>
      <span style={statValueStyle}>{value}</span>
    </div>
  );
}

function CalibrationSummary({ calibration }: { calibration: CalibrationInfo }) {
  return (
    <div style={calibrationGridStyle}>
      <DiagnosticRow
        label="Housing scale"
        value={`${fmt(calibration.residentTransitScale)} transit / ${fmt(calibration.residentSaturation)} residents`}
      />
      <DiagnosticRow
        label="Jobs scale"
        value={`${fmt(calibration.workerTransitScale)} transit / ${fmt(calibration.jobSaturation)} jobs`}
      />
      <DiagnosticRow
        label="Risk scale"
        value={`${fmt(calibration.ridershipScale)} riders / ${fmt(calibration.supplySaturation)} supply`}
      />
      <DiagnosticRow label="Calibration" value={calibration.source} />
    </div>
  );
}

function StateSummary() {
  let stats;
  try {
    stats = getModState().stats();
  } catch {
    stats = null;
  }
  if (!stats) return null;
  const hydrate = stats.lastHydrate?.fromStorage
    ? `stored · kept ${stats.lastHydrate.preserved} · replayed ${stats.lastHydrate.replayed} · shifted ${stats.lastHydrate.baselineShift}`
    : 'fresh';
  const trace = runtimeTraceSnapshot();
  const flight = flightRecorderSnapshot();
  const lastTrace = trace[trace.length - 1];
  const traceGameTime =
    lastTrace?.game.currentHour == null
      ? ''
      : ` · h${Math.floor(lastTrace.game.currentHour).toString().padStart(2, '0')}`;

  return (
    <div style={calibrationGridStyle}>
      <DiagnosticRow label="Save slot" value={stats.currentSaveName ?? '_unsaved'} />
      <DiagnosticRow
        label="Tracked"
        value={`${stats.pointsTracked.toLocaleString()} points / ${stats.popsTracked.toLocaleString()} pops`}
      />
      <DiagnosticRow
        label="Deltas"
        value={`${stats.pointsWithDeltas.toLocaleString()} points · ${stats.storageBackend}`}
      />
      <DiagnosticRow label="Hydrate" value={hydrate} />
      <DiagnosticRow
        label="Persist"
        value={stats.lastPersistOk == null ? 'not yet' : stats.lastPersistOk ? 'ok' : 'failed'}
      />
      <DiagnosticRow
        label="Trace"
        value={`${trace.length.toLocaleString()} samples${traceGameTime}`}
      />
      <DiagnosticRow
        label="Freeze trace"
        value={`${flight.enabled ? 'armed' : 'off'} · ${flight.count.toLocaleString()} events`}
      />
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={diagnosticRowStyle}>
      <span style={diagnosticLabelStyle}>{label}</span>
      <span style={diagnosticValueStyle}>{value}</span>
    </div>
  );
}

function readProposalPreview(
  row: ScoredStation,
  kind: DealKind,
  tier: DealTier
): ProposalResult | null {
  try {
    const demand = gameState.getDemandData();
    return validateProposal({
      kind,
      tier,
      centerLngLat: row.center,
      radiusMeters: HIGHLIGHT_RADIUS_M,
      walkshedPoints: demand.points.values(),
      budget: safeBudget(),
      costMultiplier: DEAL_COST_MULTIPLIER,
    });
  } catch {
    return null;
  }
}

function nearestStation(
  rows: ScoredStation[],
  click: [number, number],
  maxMeters: number
): { row: ScoredStation; distanceMeters: number } | null {
  let best: { row: ScoredStation; distanceMeters: number } | null = null;
  for (const row of rows) {
    const distanceMeters = haversineMeters(click, [row.center[0], row.center[1]]);
    if (distanceMeters > maxMeters) continue;
    if (!best || distanceMeters < best.distanceMeters) {
      best = { row, distanceMeters };
    }
  }
  return best;
}

function summarizeDeals(deals: Deal[]): { active: number; completed: number; cancelled: number } {
  let active = 0;
  let completed = 0;
  let cancelled = 0;
  for (const deal of deals) {
    if (deal.state === 'active') active++;
    else if (deal.state === 'completed') completed++;
    else if (deal.state === 'cancelled') cancelled++;
  }
  return { active, completed, cancelled };
}

function sectionKindForDeal(kind: DealKind): SectionKind {
  if (kind === 'housing') return 'residential';
  if (kind === 'commercial') return 'commercial';
  return 'captured';
}

function dealColor(kind: DealKind): string {
  return SECTION_META[sectionKindForDeal(kind)].color;
}

function dealKindLabel(kind: DealKind): string {
  if (kind === 'housing') return 'Housing';
  if (kind === 'commercial') return 'Jobs';
  return 'Mixed';
}

function dealSummary(deal: Deal): string {
  return densitySummary(deal.totalDensity);
}

function densitySummary(totalDensity: { residents: number; jobs: number }): string {
  const parts: string[] = [];
  if (totalDensity.residents > 0) {
    parts.push(`+${fmt(totalDensity.residents)} residents`);
  }
  if (totalDensity.jobs > 0) {
    parts.push(`+${fmt(totalDensity.jobs)} jobs`);
  }
  return parts.join(' / ') || '+0';
}

function dealDeliveryFraction(deal: Deal): number {
  const parts: number[] = [];
  if (deal.totalDensity.residents > 0) {
    parts.push(deal.appliedSoFar.residents / deal.totalDensity.residents);
  }
  if (deal.totalDensity.jobs > 0) {
    parts.push(deal.appliedSoFar.jobs / deal.totalDensity.jobs);
  }
  if (parts.length === 0) return 0;
  return parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

function displayName(name: string | undefined, id: string): string {
  if (!name || name === id) return `#${id.slice(0, 6)}`;
  if (name.length >= 32 && name.includes('-')) return `#${id.slice(0, 6)}`;
  if (name.length > 20) return name.slice(0, 19) + '...';
  return name;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return Math.round(n).toLocaleString();
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${Math.round(n / 100_000_000) / 10}b`;
  if (n >= 1_000_000) return `$${Math.round(n / 100_000) / 10}m`;
  if (n >= 1000) return `$${Math.round(n / 100) / 10}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

type TodThemeStyle = React.CSSProperties & Record<`--sb-tod-${string}`, string>;

const DARK_THEME_STYLE: TodThemeStyle = {
  '--sb-tod-text': 'rgba(255,255,255,0.92)',
  '--sb-tod-muted': 'rgba(255,255,255,0.58)',
  '--sb-tod-faint': 'rgba(255,255,255,0.38)',
  '--sb-tod-border': 'rgba(255,255,255,0.07)',
  '--sb-tod-border-strong': 'rgba(255,255,255,0.08)',
  '--sb-tod-surface': 'rgba(255,255,255,0.03)',
  '--sb-tod-surface-strong': 'rgba(255,255,255,0.035)',
  '--sb-tod-control': 'rgba(0,0,0,0.18)',
  '--sb-tod-control-strong': 'rgba(0,0,0,0.2)',
  '--sb-tod-row-bg': 'rgba(255,255,255,0.025)',
  '--sb-tod-row-hover-bg': 'rgba(255,255,255,0.05)',
  '--sb-tod-bar-track': 'rgba(255,255,255,0.11)',
};

const LIGHT_THEME_STYLE: TodThemeStyle = {
  '--sb-tod-text': 'rgba(15,23,42,0.92)',
  '--sb-tod-muted': 'rgba(51,65,85,0.72)',
  '--sb-tod-faint': 'rgba(71,85,105,0.58)',
  '--sb-tod-border': 'rgba(15,23,42,0.13)',
  '--sb-tod-border-strong': 'rgba(15,23,42,0.16)',
  '--sb-tod-surface': 'rgba(15,23,42,0.035)',
  '--sb-tod-surface-strong': 'rgba(15,23,42,0.05)',
  '--sb-tod-control': 'rgba(15,23,42,0.06)',
  '--sb-tod-control-strong': 'rgba(15,23,42,0.08)',
  '--sb-tod-row-bg': 'rgba(15,23,42,0.025)',
  '--sb-tod-row-hover-bg': 'rgba(15,23,42,0.055)',
  '--sb-tod-bar-track': 'rgba(15,23,42,0.12)',
};

function readTodThemeStyle(root?: HTMLElement | null): TodThemeStyle {
  const hostLightMode = readHostLightMode(root);
  if (hostLightMode !== null) return hostLightMode ? LIGHT_THEME_STYLE : DARK_THEME_STYLE;

  try {
    const theme = ui.getResolvedTheme();
    if (theme === 'light') return LIGHT_THEME_STYLE;
    if (theme === 'dark') return DARK_THEME_STYLE;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return LIGHT_THEME_STYLE;
    }
  } catch {
    /* fall through to dark default */
  }
  return DARK_THEME_STYLE;
}

function readHostLightMode(root?: HTMLElement | null): boolean | null {
  if (typeof window === 'undefined') return null;
  const doc = root?.ownerDocument ?? window.document;
  let node: HTMLElement | null = root?.parentElement ?? null;
  let depth = 0;

  while (node && depth < 8) {
    const lightMode = elementBackgroundIsLight(node);
    if (lightMode !== null) return lightMode;
    node = node.parentElement;
    depth++;
  }

  return elementBackgroundIsLight(doc.body) ?? elementBackgroundIsLight(doc.documentElement);
}

function elementBackgroundIsLight(element: Element | null): boolean | null {
  if (!element) return null;
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  const background = parseCssRgb(view.getComputedStyle(element).backgroundColor);
  if (!background || background.alpha < 0.2) return null;
  return relativeLuminance(background.red, background.green, background.blue) > 0.62;
}

function parseCssRgb(value: string): { red: number; green: number; blue: number; alpha: number } | null {
  const match = value.match(/^rgba?\((.+)\)$/i);
  if (!match) return null;
  const parts = match[1]
    .trim()
    .replace(/\s*\/\s*/, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const [red, green, blue] = parts.slice(0, 3).map(parseCssColorChannel);
  const alpha = parts[3] === undefined ? 1 : parseCssAlpha(parts[3]);
  if ([red, green, blue, alpha].some((part) => !Number.isFinite(part))) return null;
  return { red, green, blue, alpha };
}

function parseCssColorChannel(value: string): number {
  if (value.endsWith('%')) return (Number.parseFloat(value) / 100) * 255;
  return Number.parseFloat(value);
}

function parseCssAlpha(value: string): number {
  if (value.endsWith('%')) return Number.parseFloat(value) / 100;
  return Number.parseFloat(value);
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const TEXT_COLOR = 'var(--sb-tod-text)';
const MUTED_COLOR = 'var(--sb-tod-muted)';
const FAINT_COLOR = 'var(--sb-tod-faint)';
const BORDER_COLOR = 'var(--sb-tod-border)';
const BORDER_STRONG_COLOR = 'var(--sb-tod-border-strong)';
const SURFACE_COLOR = 'var(--sb-tod-surface)';
const SURFACE_STRONG_COLOR = 'var(--sb-tod-surface-strong)';
const CONTROL_COLOR = 'var(--sb-tod-control)';
const CONTROL_STRONG_COLOR = 'var(--sb-tod-control-strong)';
const ROW_BG_COLOR = 'var(--sb-tod-row-bg)';
const ROW_HOVER_BG_COLOR = 'var(--sb-tod-row-hover-bg)';
const BAR_TRACK_COLOR = 'var(--sb-tod-bar-track)';

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 14,
  maxHeight: '100%',
  overflowY: 'auto',
  boxSizing: 'border-box',
  color: TEXT_COLOR,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  paddingBottom: 4,
  borderBottom: `1px solid ${BORDER_STRONG_COLOR}`,
};

const headerActionsStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  flex: '0 0 auto',
};

const eyebrowStyle: React.CSSProperties = {
  color: FAINT_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
  letterSpacing: 0,
};

const titleStyle: React.CSSProperties = {
  margin: '2px 0 2px',
  fontSize: 18,
  lineHeight: 1.15,
  fontWeight: 700,
  color: TEXT_COLOR,
  letterSpacing: 0,
};

const statusLineStyle: React.CSSProperties = {
  color: MUTED_COLOR,
  fontSize: 11,
  lineHeight: 1.35,
};

const statGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
};

const statStyle: React.CSSProperties = {
  minWidth: 0,
  padding: '7px 8px',
  borderRadius: 6,
  border: `1px solid ${BORDER_COLOR}`,
  backgroundColor: SURFACE_COLOR,
};

const statLabelStyle: React.CSSProperties = {
  display: 'block',
  color: MUTED_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
};

const statValueStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 2,
  color: TEXT_COLOR,
  fontSize: 14,
  lineHeight: 1.2,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  paddingTop: 2,
};

const buildPanelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 9,
  borderRadius: 6,
  border: `1px solid ${BORDER_STRONG_COLOR}`,
  backgroundColor: SURFACE_STRONG_COLOR,
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const sectionStripeStyle: React.CSSProperties = {
  width: 4,
  height: 28,
  borderRadius: 4,
  flex: '0 0 auto',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.2,
  color: TEXT_COLOR,
  fontWeight: 700,
  letterSpacing: 0,
};

const sectionSignalStyle: React.CSSProperties = {
  margin: '2px 0 0',
  fontSize: 10,
  lineHeight: 1.25,
  color: MUTED_COLOR,
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};

const builderControlsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 112px',
  gap: 6,
  minWidth: 0,
};

const builderFooterStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minWidth: 0,
};

const proposalStatusStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 10,
  lineHeight: 1.25,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const segmentedStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 3,
  minWidth: 0,
  padding: 2,
  borderRadius: 6,
  border: `1px solid ${BORDER_COLOR}`,
  backgroundColor: CONTROL_COLOR,
};

const segmentButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minWidth: 0,
  border: '1px solid transparent',
  borderRadius: 4,
  padding: '4px 5px',
  cursor: 'pointer',
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const confirmButtonStyle: React.CSSProperties = {
  appearance: 'none',
  flex: '0 0 auto',
  minWidth: 58,
  border: '1px solid currentColor',
  borderRadius: 5,
  backgroundColor: CONTROL_STRONG_COLOR,
  padding: '5px 8px',
  fontSize: 11,
  lineHeight: 1.2,
  fontWeight: 800,
  whiteSpace: 'nowrap',
};

const rowButtonStyle: React.CSSProperties = {
  minHeight: 48,
  padding: '7px 8px',
  borderRadius: 6,
  border: `1px solid ${BORDER_COLOR}`,
  cursor: 'pointer',
  outline: 'none',
};

const rowTopStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const stationNameStyle: React.CSSProperties = {
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  lineHeight: 1.25,
  color: TEXT_COLOR,
};

const transferBadgeStyle: React.CSSProperties = {
  marginLeft: 6,
  color: FAINT_COLOR,
  fontSize: 10,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const scorePillStyle: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: 12,
  lineHeight: 1.2,
  fontWeight: 700,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const rowActionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 7,
  flex: '0 0 auto',
};

const buildButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid currentColor',
  borderRadius: 5,
  backgroundColor: CONTROL_COLOR,
  padding: '3px 6px',
  color: TEXT_COLOR,
  cursor: 'pointer',
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const noBuildStyle: React.CSSProperties = {
  color: FAINT_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const rowBottomStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 7,
};

const barTrackStyle: React.CSSProperties = {
  position: 'relative',
  display: 'block',
  flex: '1 1 auto',
  height: 5,
  minWidth: 74,
  overflow: 'hidden',
  borderRadius: 4,
  backgroundColor: BAR_TRACK_COLOR,
};

const barFillStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: 4,
};

const detailStyle: React.CSSProperties = {
  flex: '0 0 auto',
  maxWidth: 170,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: MUTED_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  color: MUTED_COLOR,
  fontSize: 11,
};

const footnoteStyle: React.CSSProperties = {
  margin: '-2px 0 0',
  color: FAINT_COLOR,
  fontSize: 10,
  lineHeight: 1.35,
};

const diagnosticsStyle: React.CSSProperties = {
  borderTop: `1px solid ${BORDER_STRONG_COLOR}`,
  paddingTop: 8,
};

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: MUTED_COLOR,
  fontSize: 11,
  lineHeight: 1.4,
};

const diagnosticsBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 8,
};

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: MUTED_COLOR,
  fontSize: 11,
};

const calibrationGridStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '7px 8px',
  borderRadius: 6,
  border: `1px solid ${BORDER_COLOR}`,
  backgroundColor: ROW_BG_COLOR,
};

const diagnosticRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 10,
  color: MUTED_COLOR,
  fontSize: 10,
  lineHeight: 1.35,
};

const diagnosticLabelStyle: React.CSSProperties = {
  flex: '0 0 auto',
  color: FAINT_COLOR,
};

const diagnosticValueStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: MUTED_COLOR,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

function downloadDebug(snapshot: Snapshot) {
  recordFlightEvent('debug.download.start', {
    stations: snapshot.stations,
    demandPoints: snapshot.demandPoints,
    pops: snapshot.pops,
  });
  sampleRuntimeTrace('debug-download', {
    includeCompletedCommutes: true,
    fullScan: true,
  });
  const dump = (s: ScoredStation) => ({
    id: s.id,
    name: s.name,
    memberCount: s.memberCount,
    center: s.center,
    totals: s.totals,
    score: s.score,
    access: s.access,
  });
  const topResidential = [...snapshot.scored]
    .sort((a, b) => b.access.residential - a.access.residential)
    .slice(0, TOP_N)
    .map(dump);
  const topCommercial = [...snapshot.scored]
    .sort((a, b) => b.access.commercial - a.access.commercial)
    .slice(0, TOP_N)
    .map(dump);
  const riskCandidates = snapshot.scored.filter((s) => s.score.ridership > 0);
  const topRisk = [...riskCandidates]
    .sort((a, b) => b.score.risk - a.score.risk)
    .slice(0, TOP_N)
    .map(dump);
  const topCaptured = [...snapshot.scored]
    .sort((a, b) => b.score.capturedValue - a.score.capturedValue)
    .slice(0, TOP_N)
    .map(dump);
  const state = getModState();
  const runtimeTrace = runtimeTraceSnapshot();
  const flightRecorder = flightRecorderSnapshot();
  const payload = {
    timestamp: new Date().toISOString(),
    bundleVersion: 'panel-v49-deferred-day-tick',
    counts: {
      stations: snapshot.stations,
      demandPoints: snapshot.demandPoints,
      pops: snapshot.pops,
      scoredLength: snapshot.scored.length,
      currentDay: snapshot.currentDay,
      budget: safeBudget(),
      riskExcludedZeroRidership: snapshot.scored.length - riskCandidates.length,
    },
    calibration: snapshot.calibration,
    topResidential,
    topCommercial,
    topCaptured,
    topRisk,
    modState: state.stats(),
    deals: state.getDeals(),
    moneyTrace: moneyTraceSnapshot(),
    runtimeTrace,
    flightRecorder,
    runtimeProbe: probeRuntimeState(runtimeTrace),
    flightRecorderProbe: probeFlightRecorder(flightRecorder),
    groupProbe: probeStationGroups(snapshot.scored),
    demandShapeProbe: probeDemandShape(),
    demandIntegrity: probeDemandIntegrity(state),
    splitTimingProbe: probeSplitTiming(state),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sb-tod-debug-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function probeStationGroups(scored: ScoredStation[]) {
  const sampleStationIds = scored.slice(0, 3).map((s) => s.id);
  const out: Record<string, unknown> = { sampleStationIds };

  out.getStationGroups = describe(() => gameState.getStationGroups());
  out.getTransferStationIds = describe(() => gameState.getTransferStationIds());
  out.getSiblingStationIds = sampleStationIds.map((id) => ({
    forStationId: id,
    forStationName: scored.find((s) => s.id === id)?.name,
    result: describe(() => gameState.getSiblingStationIds(id)),
  }));

  return out;
}

function describe(fn: () => unknown): unknown {
  try {
    const value = fn();
    return shape(value, 0);
  } catch (err) {
    return { __error: String(err) };
  }
}

function probeDemandShape(): unknown {
  try {
    const demand = gameState.getDemandData();
    const points = Array.from(demand.points.values());
    if (points.length === 0) return { __empty: true };

    const first = points[0];
    const residentsHeavy = points.reduce(
      (best, p) => (p.residents > best.residents ? p : best),
      points[0]
    );
    const jobsHeavy = points.reduce(
      (best, p) => (p.jobs > best.jobs ? p : best),
      points[0]
    );

    const pops = demand.popsMap;
    const samplePopIds = (residentsHeavy.popIds ?? []).slice(0, 3);
    const samplePops = samplePopIds
      .map((id) => pops.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));

    return {
      pointFields: Object.keys(first as object),
      firstPoint: deepShape(first, 0),
      residentsHeavyPoint: {
        id: (residentsHeavy as any).id,
        residents: residentsHeavy.residents,
        jobs: residentsHeavy.jobs,
        full: deepShape(residentsHeavy, 0),
      },
      jobsHeavyPoint: {
        id: (jobsHeavy as any).id,
        residents: jobsHeavy.residents,
        jobs: jobsHeavy.jobs,
        full: deepShape(jobsHeavy, 0),
      },
      samplePopsFromResidentsHeavy: samplePops.map((p) => deepShape(p, 0)),
    };
  } catch (err) {
    return { __error: String(err) };
  }
}

function probeRuntimeState(runtimeTrace: ReturnType<typeof runtimeTraceSnapshot>): unknown {
  return {
    currentDay: describe(() => gameState.getCurrentDay()),
    currentHour: describe(() => gameState.getCurrentHour()),
    elapsedSeconds: describe(() => gameState.getElapsedSeconds()),
    gameSpeed: describe(() => gameState.getGameSpeed()),
    paused: describe(() => gameState.isPaused()),
    budget: describe(() => gameState.getBudget()),
    ridershipStats: describe(() => gameState.getRidershipStats()),
    modeChoiceStats: describe(() => gameState.getModeChoiceStats()),
    completedCommutes: describe(() => summarizeCompletedCommutes(gameState.getCompletedCommutes())),
    traceCount: runtimeTrace.length,
    traceTail: runtimeTrace.slice(-20),
  };
}

function probeFlightRecorder(flight: ReturnType<typeof flightRecorderSnapshot>): unknown {
  const byType: Record<string, number> = {};
  for (const entry of flight.entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }
  return {
    enabled: flight.enabled,
    count: flight.count,
    firstSeq: flight.entries[0]?.seq ?? null,
    lastSeq: flight.entries[flight.entries.length - 1]?.seq ?? null,
    lastType: flight.entries[flight.entries.length - 1]?.type ?? null,
    byType,
    tail: flight.entries.slice(-80),
  };
}

function summarizeCompletedCommutes(commutes: unknown[]): unknown {
  const byOrigin: Record<string, number> = {};
  let splitPopCount = 0;
  const splitExamples: unknown[] = [];
  for (const commute of commutes as any[]) {
    const origin = typeof commute?.origin === 'string' ? commute.origin : 'unknown';
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
    const popId = typeof commute?.popId === 'string' ? commute.popId : '';
    if (popId.startsWith(SPLIT_POP_PREFIX)) {
      splitPopCount++;
      if (splitExamples.length < 12) {
        splitExamples.push({
          popId,
          size: commute.size,
          origin: commute.origin,
          journeyStart: commute.journeyStart,
          journeyEnd: commute.journeyEnd,
          stationRoutes: shape(commute.stationRoutes, 0),
        });
      }
    }
  }
  return {
    count: commutes.length,
    splitPopCount,
    byOrigin,
    splitExamples,
  };
}

function inferSplitOriginId(childId: string, childToOrigin: Map<string, string>): string | null {
  const tracked = childToOrigin.get(childId);
  if (tracked) return tracked;
  if (!childId.startsWith(SPLIT_POP_PREFIX)) return null;
  const rest = childId.slice(SPLIT_POP_PREFIX.length);
  const firstColon = rest.indexOf(':');
  return firstColon > 0 ? rest.slice(0, firstColon) : null;
}

function safeSecondOfDay(): number | null {
  try {
    const elapsed = gameState.getElapsedSeconds();
    if (typeof elapsed === 'number' && Number.isFinite(elapsed)) {
      return ((elapsed % 86_400) + 86_400) % 86_400;
    }
  } catch {
    /* fall back to hour below */
  }
  try {
    const hour = gameState.getCurrentHour();
    if (typeof hour === 'number' && Number.isFinite(hour)) {
      return Math.max(0, Math.min(23, Math.floor(hour))) * 3600;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function formatSecond(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sec = ((Math.floor(value) % 86_400) + 86_400) % 86_400;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
    .toString()
    .padStart(2, '0')}`;
}

function hourBucket(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'bad';
  const sec = ((value % 86_400) + 86_400) % 86_400;
  return Math.floor(sec / 3600).toString().padStart(2, '0');
}

function secondsUntil(from: number, to: unknown): number | null {
  if (typeof to !== 'number' || !Number.isFinite(to)) return null;
  const target = ((to % 86_400) + 86_400) % 86_400;
  return (target - from + 86_400) % 86_400;
}

function bumpCount(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

function bumpSized(
  map: Record<string, { count: number; size: number }>,
  key: string,
  size: number
): void {
  const row = map[key] ?? { count: 0, size: 0 };
  row.count++;
  row.size += size;
  map[key] = row;
}

function topCountMap(map: Record<string, number>, limit = 20): Array<{ key: string; count: number }> {
  return Object.entries(map)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function readTransitPaths(pop: any): any[] {
  const paths = pop?.lastCommute?.transitPaths;
  return Array.isArray(paths) ? paths : [];
}

function routeIdsFor(paths: any[]): string[] {
  const ids = new Set<string>();
  for (const path of paths) {
    if (typeof path?.routeId === 'string' && path.routeId.length > 0) ids.add(path.routeId);
  }
  return [...ids].slice(0, 8);
}

function pathSignature(paths: any[]): string {
  if (paths.length === 0) return 'empty';
  return paths
    .slice(0, 5)
    .map((p) => `${p?.routeId ?? '?'}:${p?.fromStopId ?? '?'}>${p?.toStopId ?? '?'}`)
    .join('|');
}

function splitPopSummary(pop: any, demand: ReturnType<typeof gameState.getDemandData>, childToOrigin: Map<string, string>) {
  const residence = demand.points.get(pop.residenceId);
  const job = demand.points.get(pop.jobId);
  const paths = readTransitPaths(pop);
  const inResidence = residence ? endpointHasPopId(residence, pop.id) : false;
  const inJob = job ? endpointHasPopId(job, pop.id) : false;
  const role = inResidence && inJob ? 'both' : inResidence ? 'residence' : inJob ? 'job' : 'neither';
  return {
    id: pop.id,
    originId: inferSplitOriginId(pop.id, childToOrigin),
    role,
    size: pop.size,
    residenceId: pop.residenceId,
    jobId: pop.jobId,
    homeDepartureTime: pop.homeDepartureTime,
    homeDepartureClock: formatSecond(pop.homeDepartureTime),
    workDepartureTime: pop.workDepartureTime,
    workDepartureClock: formatSecond(pop.workDepartureTime),
    modeChoice: pop.lastCommute?.modeChoice,
    modeTotal: modeChoiceTotal(pop.lastCommute?.modeChoice),
    transitPathCount: paths.length,
    routeIds: routeIdsFor(paths),
    firstTransitPath: paths[0]
      ? {
          routeId: paths[0].routeId,
          fromStopId: paths[0].fromStopId,
          toStopId: paths[0].toStopId,
          departureTime: paths[0].departureTime,
          departureClock: formatSecond(paths[0].departureTime),
          arrivalTime: paths[0].arrivalTime,
          arrivalClock: formatSecond(paths[0].arrivalTime),
          isWalking: paths[0].isWalking,
          isDriving: paths[0].isDriving,
        }
      : null,
  };
}

function probeSplitTiming(state: ReturnType<typeof getModState>): unknown {
  try {
    const demand = gameState.getDemandData();
    const snap = state.isReady() ? state.mutator().snapshot() : null;
    const childToOrigin = new Map<string, string>();
    if (snap) {
      for (const [originId, childIds] of snap.splitChildren) {
        for (const childId of childIds) childToOrigin.set(childId, originId);
      }
    }

    const now = safeSecondOfDay();
    const homeDepartureHours: Record<string, { count: number; size: number }> = {};
    const workDepartureHours: Record<string, { count: number; size: number }> = {};
    const pathDepartureHours: Record<string, { count: number; size: number }> = {};
    const pathArrivalHours: Record<string, { count: number; size: number }> = {};
    const routeCounts: Record<string, number> = {};
    const signatureCounts: Record<string, number> = {};
    const originCounts: Record<string, number> = {};
    const endpointCounts: Record<string, number> = {};
    const pathAnomalies: Record<string, number> = {
      emptyTransitPaths: 0,
      transitModeWithoutPath: 0,
      pathWithoutTransitMode: 0,
      badPathTimes: 0,
      backwardPathSegments: 0,
      boundaryClampedTimes: 0,
      missingRouteId: 0,
      missingStopId: 0,
    };
    const departureAnomalies: Record<string, number> = {
      badHomeDepartures: 0,
      badWorkDepartures: 0,
      boundaryHomeDepartures: 0,
      boundaryWorkDepartures: 0,
    };
    const splitSamples: unknown[] = [];
    const anomalyExamples: unknown[] = [];
    const upcoming: unknown[] = [];

    let splitPops = 0;
    let splitSize = 0;
    let residenceSide = 0;
    let jobSide = 0;
    let bothSide = 0;
    let neitherSide = 0;

    for (const pop of demand.popsMap.values() as Iterable<any>) {
      if (typeof pop?.id !== 'string' || !pop.id.startsWith(SPLIT_POP_PREFIX)) continue;
      splitPops++;
      const size = typeof pop.size === 'number' && Number.isFinite(pop.size) ? pop.size : 0;
      splitSize += size;

      const originId = inferSplitOriginId(pop.id, childToOrigin) ?? 'unknown';
      bumpCount(originCounts, originId);
      bumpSized(homeDepartureHours, hourBucket(pop.homeDepartureTime), size);
      bumpSized(workDepartureHours, hourBucket(pop.workDepartureTime), size);
      if (typeof pop.homeDepartureTime !== 'number' || !Number.isFinite(pop.homeDepartureTime)) {
        departureAnomalies.badHomeDepartures++;
      } else if (pop.homeDepartureTime <= 0 || pop.homeDepartureTime >= 86_399) {
        departureAnomalies.boundaryHomeDepartures++;
      }
      if (typeof pop.workDepartureTime !== 'number' || !Number.isFinite(pop.workDepartureTime)) {
        departureAnomalies.badWorkDepartures++;
      } else if (pop.workDepartureTime <= 0 || pop.workDepartureTime >= 86_399) {
        departureAnomalies.boundaryWorkDepartures++;
      }

      const residence = demand.points.get(pop.residenceId);
      const job = demand.points.get(pop.jobId);
      const inResidence = residence ? endpointHasPopId(residence, pop.id) : false;
      const inJob = job ? endpointHasPopId(job, pop.id) : false;
      const role = inResidence && inJob ? 'both' : inResidence ? 'residence' : inJob ? 'job' : 'neither';
      bumpCount(endpointCounts, role);
      if (role === 'both') bothSide++;
      else if (role === 'residence') residenceSide++;
      else if (role === 'job') jobSide++;
      else neitherSide++;

      const paths = readTransitPaths(pop);
      const transitMode = numField(pop.lastCommute?.modeChoice, 'transit');
      if (paths.length === 0) pathAnomalies.emptyTransitPaths++;
      if (transitMode > 1 && paths.length === 0) pathAnomalies.transitModeWithoutPath++;
      if (transitMode <= 1 && paths.length > 0) pathAnomalies.pathWithoutTransitMode++;

      bumpCount(signatureCounts, pathSignature(paths));
      for (const routeId of routeIdsFor(paths)) bumpCount(routeCounts, routeId);

      let popHadPathAnomaly = false;
      for (const path of paths) {
        const dep = path?.departureTime;
        const arr = path?.arrivalTime;
        bumpSized(pathDepartureHours, hourBucket(dep), size);
        bumpSized(pathArrivalHours, hourBucket(arr), size);
        if (typeof path?.routeId !== 'string' || path.routeId.length === 0) {
          pathAnomalies.missingRouteId++;
          popHadPathAnomaly = true;
        }
        if (
          typeof path?.fromStopId !== 'string' ||
          typeof path?.toStopId !== 'string' ||
          path.fromStopId.length === 0 ||
          path.toStopId.length === 0
        ) {
          pathAnomalies.missingStopId++;
          popHadPathAnomaly = true;
        }
        if (
          typeof dep !== 'number' ||
          !Number.isFinite(dep) ||
          typeof arr !== 'number' ||
          !Number.isFinite(arr)
        ) {
          pathAnomalies.badPathTimes++;
          popHadPathAnomaly = true;
          continue;
        }
        if (arr < dep) {
          pathAnomalies.backwardPathSegments++;
          popHadPathAnomaly = true;
        }
        if (dep <= 0 || dep >= 86_399 || arr <= 0 || arr >= 86_399) {
          pathAnomalies.boundaryClampedTimes++;
          popHadPathAnomaly = true;
        }
      }

      if (splitSamples.length < 18) {
        splitSamples.push(splitPopSummary(pop, demand, childToOrigin));
      }
      if (popHadPathAnomaly && anomalyExamples.length < 18) {
        anomalyExamples.push(splitPopSummary(pop, demand, childToOrigin));
      }

      if (now != null) {
        const homeUntil = secondsUntil(now, pop.homeDepartureTime);
        const workUntil = secondsUntil(now, pop.workDepartureTime);
        if (homeUntil != null) {
          upcoming.push({
            popId: pop.id,
            originId,
            kind: 'home',
            secondsUntil: homeUntil,
            at: pop.homeDepartureTime,
            clock: formatSecond(pop.homeDepartureTime),
            role,
            routeIds: routeIdsFor(paths),
            transitPathCount: paths.length,
          });
        }
        if (workUntil != null) {
          upcoming.push({
            popId: pop.id,
            originId,
            kind: 'work',
            secondsUntil: workUntil,
            at: pop.workDepartureTime,
            clock: formatSecond(pop.workDepartureTime),
            role,
            routeIds: routeIdsFor(paths),
            transitPathCount: paths.length,
          });
        }
      }
    }

    upcoming.sort((a: any, b: any) => a.secondsUntil - b.secondsUntil);

    return {
      currentTime: {
        secondOfDay: now,
        clock: now == null ? null : formatSecond(now),
        currentDay: describe(() => gameState.getCurrentDay()),
        currentHour: describe(() => gameState.getCurrentHour()),
        elapsedSeconds: describe(() => gameState.getElapsedSeconds()),
      },
      counts: {
        splitPops,
        splitSize,
        trackedSplitChildren: childToOrigin.size,
        residenceSide,
        jobSide,
        bothSide,
        neitherSide,
      },
      homeDepartureHours,
      workDepartureHours,
      pathDepartureHours,
      pathArrivalHours,
      pathAnomalies,
      departureAnomalies,
      endpointCounts: topCountMap(endpointCounts),
      topOriginCounts: topCountMap(originCounts),
      topRouteIds: topCountMap(routeCounts),
      topPathSignatures: topCountMap(signatureCounts, 12),
      upcomingDepartures: upcoming.slice(0, 32),
      splitSamples,
      anomalyExamples,
    };
  } catch (err) {
    return { __error: String(err) };
  }
}

function numField(v: unknown, key: string): number {
  const n = (v as Record<string, unknown> | null | undefined)?.[key];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function modeChoiceTotal(value: unknown): number {
  return (
    numField(value, 'walking') +
    numField(value, 'driving') +
    numField(value, 'transit') +
    numField(value, 'unknown')
  );
}

function endpointHasPopId(point: unknown, popId: string): boolean {
  const ids = (point as { popIds?: unknown })?.popIds;
  return Array.isArray(ids) && ids.includes(popId);
}

function probeDemandIntegrity(state: ReturnType<typeof getModState>): unknown {
  try {
    const demand = gameState.getDemandData();
    const points = Array.from(demand.points.values());
    const pops = Array.from(demand.popsMap.values());
    const snap = state.isReady() ? state.mutator().snapshot() : null;

    const residenceSums = new Map<string, number>();
    const jobSums = new Map<string, number>();
    const residenceCounts = new Map<string, number>();
    const jobCounts = new Map<string, number>();
    const splitResidenceCounts = new Map<string, number>();
    const splitJobCounts = new Map<string, number>();
    const anomalies: Record<string, number> = {
      splitPops: 0,
      orphanSplitPops: 0,
      trackedSplitChildren: 0,
      missingTrackedChildren: 0,
      missingResidencePoint: 0,
      missingJobPoint: 0,
      splitResidenceMemberships: 0,
      splitJobMemberships: 0,
      splitMissingAllMembership: 0,
      splitMissingResidenceMembership: 0,
      splitMissingJobMembership: 0,
      nonFiniteSize: 0,
      oversizedSplitPops: 0,
      modeChoiceMismatch: 0,
      nonFiniteDepartureTimes: 0,
      pointDuplicatePopIds: 0,
      pointMissingPopIds: 0,
    };
    const splitExamples: unknown[] = [];
    const popAnomalyExamples: unknown[] = [];

    const trackedSplitIds = new Set<string>();
    if (snap) {
      for (const ids of snap.splitChildren.values()) {
        for (const id of ids) trackedSplitIds.add(id);
      }
    }
    anomalies.trackedSplitChildren = trackedSplitIds.size;
    for (const id of trackedSplitIds) {
      if (!demand.popsMap.has(id)) anomalies.missingTrackedChildren++;
    }

    for (const pop of pops as any[]) {
      const isSplit = typeof pop.id === 'string' && pop.id.startsWith(SPLIT_POP_PREFIX);
      if (isSplit) anomalies.splitPops++;
      if (isSplit && !trackedSplitIds.has(pop.id)) anomalies.orphanSplitPops++;
      if (typeof pop.size !== 'number' || !Number.isFinite(pop.size)) {
        anomalies.nonFiniteSize++;
      }
      if (isSplit && pop.size > 200) anomalies.oversizedSplitPops++;

      const residence = demand.points.get(pop.residenceId);
      const job = demand.points.get(pop.jobId);
      if (!residence) anomalies.missingResidencePoint++;
      if (!job) anomalies.missingJobPoint++;
      const inResidence = residence ? endpointHasPopId(residence, pop.id) : false;
      const inJob = job ? endpointHasPopId(job, pop.id) : false;

      if (inResidence) {
        residenceSums.set(pop.residenceId, (residenceSums.get(pop.residenceId) ?? 0) + pop.size);
        residenceCounts.set(pop.residenceId, (residenceCounts.get(pop.residenceId) ?? 0) + 1);
      }
      if (inJob) {
        jobSums.set(pop.jobId, (jobSums.get(pop.jobId) ?? 0) + pop.size);
        jobCounts.set(pop.jobId, (jobCounts.get(pop.jobId) ?? 0) + 1);
      }
      if (isSplit) {
        if (inResidence) {
          splitResidenceCounts.set(pop.residenceId, (splitResidenceCounts.get(pop.residenceId) ?? 0) + 1);
          anomalies.splitResidenceMemberships++;
        }
        if (inJob) {
          splitJobCounts.set(pop.jobId, (splitJobCounts.get(pop.jobId) ?? 0) + 1);
          anomalies.splitJobMemberships++;
        }
        if (!inResidence && !inJob) anomalies.splitMissingAllMembership++;
      }

      const modeTotal = modeChoiceTotal(pop.lastCommute?.modeChoice);
      if (Math.abs(modeTotal - pop.size) > 1) {
        anomalies.modeChoiceMismatch++;
        if (popAnomalyExamples.length < 12) {
          popAnomalyExamples.push({
            id: pop.id,
            size: pop.size,
            modeTotal,
            residenceId: pop.residenceId,
            jobId: pop.jobId,
            isSplit,
          });
        }
      }
      if (
        typeof pop.homeDepartureTime !== 'number' ||
        !Number.isFinite(pop.homeDepartureTime) ||
        typeof pop.workDepartureTime !== 'number' ||
        !Number.isFinite(pop.workDepartureTime)
      ) {
        anomalies.nonFiniteDepartureTimes++;
      }
      if (isSplit && splitExamples.length < 16) {
        splitExamples.push({
          id: pop.id,
          size: pop.size,
          residenceId: pop.residenceId,
          jobId: pop.jobId,
          inResidencePopIds: residence ? endpointHasPopId(residence, pop.id) : false,
          inJobPopIds: job ? endpointHasPopId(job, pop.id) : false,
          homeDepartureTime: pop.homeDepartureTime,
          workDepartureTime: pop.workDepartureTime,
          modeTotal,
        });
      }
    }

    const residentMismatches: unknown[] = [];
    const jobMismatches: unknown[] = [];
    const modeShareMismatches: unknown[] = [];
    for (const point of points as any[]) {
      const popIds = Array.isArray(point.popIds) ? point.popIds : [];
      const unique = new Set(popIds);
      if (unique.size !== popIds.length) anomalies.pointDuplicatePopIds++;
      for (const id of popIds) {
        if (!demand.popsMap.has(id)) anomalies.pointMissingPopIds++;
      }

      const residentPopSize = residenceSums.get(point.id) ?? 0;
      const jobPopSize = jobSums.get(point.id) ?? 0;
      const residentDiff = point.residents - residentPopSize;
      const jobDiff = point.jobs - jobPopSize;
      if (Math.abs(residentDiff) > 1) {
        residentMismatches.push({
          id: point.id,
          residents: point.residents,
          residentPopSize,
          diff: residentDiff,
          residencePopCount: residenceCounts.get(point.id) ?? 0,
          splitResidenceCount: splitResidenceCounts.get(point.id) ?? 0,
        });
      }
      if (Math.abs(jobDiff) > 1) {
        jobMismatches.push({
          id: point.id,
          jobs: point.jobs,
          jobPopSize,
          diff: jobDiff,
          jobPopCount: jobCounts.get(point.id) ?? 0,
          splitJobCount: splitJobCounts.get(point.id) ?? 0,
        });
      }
      const residentModeTotal = modeChoiceTotal(point.residentModeShare);
      const workerModeTotal = modeChoiceTotal(point.workerModeShare);
      if (
        Math.abs(residentModeTotal - point.residents) > 1 ||
        Math.abs(workerModeTotal - point.jobs) > 1
      ) {
        modeShareMismatches.push({
          id: point.id,
          residents: point.residents,
          residentModeTotal,
          jobs: point.jobs,
          workerModeTotal,
        });
      }
    }

    const byAbsDiff = (a: any, b: any) => Math.abs(b.diff) - Math.abs(a.diff);
    residentMismatches.sort(byAbsDiff);
    jobMismatches.sort(byAbsDiff);

    const trackedPointAudits: unknown[] = [];
    if (snap) {
      for (const [pointId, delta] of snap.cumulativeDeltas) {
        const point = demand.points.get(pointId) as any;
        const baseline = snap.baselineDemand.get(pointId);
        if (!point || !baseline) continue;
        const cumulativeResidents =
          delta.residents.fromDeals + delta.residents.fromOrganic;
        const cumulativeJobs = delta.jobs.fromDeals + delta.jobs.fromOrganic;
        trackedPointAudits.push({
          id: pointId,
          live: { residents: point.residents, jobs: point.jobs },
          baseline,
          cumulative: { residents: cumulativeResidents, jobs: cumulativeJobs },
          expectedLive: {
            residents: baseline.residents + cumulativeResidents,
            jobs: baseline.jobs + cumulativeJobs,
          },
          residencePopSize: residenceSums.get(pointId) ?? 0,
          jobPopSize: jobSums.get(pointId) ?? 0,
          residencePopCount: residenceCounts.get(pointId) ?? 0,
          jobPopCount: jobCounts.get(pointId) ?? 0,
          splitResidenceCount: splitResidenceCounts.get(pointId) ?? 0,
          splitJobCount: splitJobCounts.get(pointId) ?? 0,
        });
      }
    }

    return {
      counts: {
        points: points.length,
        pops: pops.length,
      },
      anomalies,
      topResidentAggregateMismatches: residentMismatches.slice(0, 20),
      topJobAggregateMismatches: jobMismatches.slice(0, 20),
      modeShareMismatches: modeShareMismatches.slice(0, 20),
      splitExamples,
      popAnomalyExamples,
      trackedPointAudits: trackedPointAudits.slice(0, 40),
    };
  } catch (err) {
    return { __error: String(err) };
  }
}

function deepShape(value: unknown, depth: number): unknown {
  if (depth > 5) return '__max-depth';
  if (value === null) return null;
  if (value === undefined) return undefined;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 8) {
      return {
        __type: 'Array',
        length: value.length,
        sampleItems: value.slice(0, 8).map((v) => deepShape(v, depth + 1)),
      };
    }
    return value.map((v) => deepShape(v, depth + 1));
  }
  if (value instanceof Map || value instanceof Set) {
    return shape(value, depth);
  }
  if (t === 'object' && value) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = deepShape(obj[k], depth + 1);
    }
    return out;
  }
  return { __type: t };
}

function shape(value: unknown, depth: number): unknown {
  if (value === null) return { __type: 'null' };
  if (value === undefined) return { __type: 'undefined' };
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return value;
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).slice(0, 5);
    return {
      __type: 'Map',
      size: value.size,
      sampleEntries: entries.map(([k, v]) => [
        shape(k, depth + 1),
        depth < 2 ? shape(v, depth + 1) : '__truncated',
      ]),
    };
  }
  if (value instanceof Set) {
    const items = Array.from(value).slice(0, 10);
    return {
      __type: 'Set',
      size: value.size,
      sampleItems: items.map((v) => shape(v, depth + 1)),
    };
  }
  if (Array.isArray(value)) {
    return {
      __type: 'Array',
      length: value.length,
      sampleItems: value.slice(0, 5).map((v) => (depth < 2 ? shape(v, depth + 1) : '__truncated')),
    };
  }
  if (t === 'object' && value) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 20);
    const out: Record<string, unknown> = { __type: 'object', keys };
    if (depth < 2) {
      const sample: Record<string, unknown> = {};
      for (const k of keys.slice(0, 8)) {
        sample[k] = shape(obj[k], depth + 1);
      }
      out.sample = sample;
    }
    return out;
  }
  return { __type: t };
}
