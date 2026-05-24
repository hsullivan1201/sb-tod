/**
 * Runtime freeze trace.
 *
 * Debug DL snapshots are taken after the game is already stuck, so the
 * current demand graph can look healthy while the preceding sim tick was
 * not. This module keeps a small rolling buffer of cheap runtime samples:
 * game time, demand counts, split-pop counts, completed commute counts,
 * ridership/mode stats, and TOD day-tick state.
 */

import { gameState, hooks } from '../api';
import { SPLIT_POP_PREFIX } from '../sim/mutate';
import { getModState } from '../state/mod-state';
import type { DemandData } from '../types';
import { isFlightRecorderEnabled } from './flightRecorder';

const RUNTIME_TRACE_INTERVAL_MS = 2500;
const RUNTIME_TRACE_LIMIT = 240;
const RUNTIME_TRACE_DEMAND_SCAN_LIMIT = 2000;
const RUNTIME_TRACE_COMMUTE_SCAN_LIMIT = 1000;

export interface RuntimeTraceSampleOptions {
  /** Expensive: calls and scans the completed-commutes array. */
  includeCompletedCommutes?: boolean;
  /** Expensive: scans complete demand/commute collections instead of bounded samples. */
  fullScan?: boolean;
}

export interface RuntimeTraceSamplerOptions {
  /**
   * Off by default. The sampler used to run every 2.5s in normal play,
   * which made the freeze diagnostic path a potential freeze source.
   */
  interval?: boolean;
  intervalMs?: number;
}

export interface RuntimeTraceEntry {
  at: number;
  reason: string;
  game: {
    currentDay: number | null;
    currentHour: number | null;
    elapsedSeconds: number | null;
    secondOfDay: number | null;
    gameSpeed: unknown;
    paused: boolean | null;
    budget: number | null;
  };
  demand: {
    points: number;
    pops: number;
    splitPops: number;
    splitSize: number;
    popsScanned: number;
    scanTruncated: boolean;
  } | null;
  modState: {
    initialized: boolean;
    dayTicks: number;
    lastDay: number | null;
    activeDeals: number;
    completedDeals: number;
    cancelledDeals: number;
    pointsWithDeltas: number;
    dayTickPhase: string;
    lastTickActiveDealId: string | null;
    lastTickError: string | null;
  } | null;
  ridershipStats: unknown;
  modeChoiceStats: unknown;
  completedCommutes: {
    count: number;
    splitPopCount: number;
    splitPopIdsSample: string[];
    commutesScanned: number;
    scanTruncated: boolean;
  } | null;
  demandEventsSinceLastSample: number;
  lastDemandEventAt: number | null;
}

interface RuntimeTraceState {
  entries: RuntimeTraceEntry[];
  hookRegistered: boolean;
  intervalId: number | null;
  demandEventsSinceLastSample: number;
  lastDemandEventAt: number | null;
  lastSampleAt: number | null;
}

function getRuntimeTraceState(): RuntimeTraceState {
  const root = globalThis as typeof globalThis & {
    __sbTodRuntimeTrace?: RuntimeTraceState;
  };
  if (!root.__sbTodRuntimeTrace) {
    root.__sbTodRuntimeTrace = {
      entries: [],
      hookRegistered: false,
      intervalId: null,
      demandEventsSinceLastSample: 0,
      lastDemandEventAt: null,
      lastSampleAt: null,
    };
  }
  return root.__sbTodRuntimeTrace;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function secondOfDay(elapsedSeconds: number | null): number | null {
  if (elapsedSeconds == null) return null;
  return ((elapsedSeconds % 86_400) + 86_400) % 86_400;
}

function summarizeDemand(
  demand: DemandData | null,
  options: RuntimeTraceSampleOptions
): RuntimeTraceEntry['demand'] {
  if (!demand || !demand.points || !demand.popsMap) return null;
  let splitPops = 0;
  let splitSize = 0;
  let popsScanned = 0;
  let scanTruncated = false;
  const limit = options.fullScan ? Infinity : RUNTIME_TRACE_DEMAND_SCAN_LIMIT;
  for (const pop of demand.popsMap.values() as Iterable<any>) {
    if (popsScanned >= limit) {
      scanTruncated = true;
      break;
    }
    popsScanned++;
    if (typeof pop?.id === 'string' && pop.id.startsWith(SPLIT_POP_PREFIX)) {
      splitPops++;
      if (typeof pop.size === 'number' && Number.isFinite(pop.size)) {
        splitSize += pop.size;
      }
    }
  }
  return {
    points: demand.points.size,
    pops: demand.popsMap.size,
    splitPops,
    splitSize,
    popsScanned,
    scanTruncated,
  };
}

function summarizeModState(): RuntimeTraceEntry['modState'] {
  return safe(() => {
    const stats = getModState().stats();
    return {
      initialized: stats.initialized,
      dayTicks: stats.dayTicks,
      lastDay: stats.lastDay,
      activeDeals: stats.activeDeals,
      completedDeals: stats.completedDeals,
      cancelledDeals: stats.cancelledDeals,
      pointsWithDeltas: stats.pointsWithDeltas,
      dayTickPhase: stats.dayTickPhase,
      lastTickActiveDealId: stats.lastTickActiveDealId,
      lastTickError: stats.lastTickError,
    };
  }, null);
}

function summarizeCompletedCommutes(
  options: RuntimeTraceSampleOptions
): RuntimeTraceEntry['completedCommutes'] {
  return safe(() => {
    const commutes = gameState.getCompletedCommutes();
    let splitPopCount = 0;
    let commutesScanned = 0;
    let scanTruncated = false;
    const splitPopIdsSample: string[] = [];
    const limit = options.fullScan ? Infinity : RUNTIME_TRACE_COMMUTE_SCAN_LIMIT;
    for (const commute of commutes as any[]) {
      if (commutesScanned >= limit) {
        scanTruncated = true;
        break;
      }
      commutesScanned++;
      const popId = typeof commute?.popId === 'string' ? commute.popId : '';
      if (popId.startsWith(SPLIT_POP_PREFIX)) {
        splitPopCount++;
        if (splitPopIdsSample.length < 12) splitPopIdsSample.push(popId);
      }
    }
    return {
      count: commutes.length,
      splitPopCount,
      splitPopIdsSample,
      commutesScanned,
      scanTruncated,
    };
  }, null);
}

export function sampleRuntimeTrace(
  reason: string,
  options: RuntimeTraceSampleOptions = {}
): RuntimeTraceEntry {
  const state = getRuntimeTraceState();
  const elapsedSeconds = finite(safe(() => gameState.getElapsedSeconds(), NaN));
  const demand = safe(() => gameState.getDemandData(), null);
  const entry: RuntimeTraceEntry = {
    at: Date.now(),
    reason,
    game: {
      currentDay: finite(safe(() => gameState.getCurrentDay(), NaN)),
      currentHour: finite(safe(() => gameState.getCurrentHour(), NaN)),
      elapsedSeconds,
      secondOfDay: secondOfDay(elapsedSeconds),
      gameSpeed: safe(() => gameState.getGameSpeed(), null),
      paused: safe(() => gameState.isPaused(), null),
      budget: finite(safe(() => gameState.getBudget(), NaN)),
    },
    demand: summarizeDemand(demand, options),
    modState: summarizeModState(),
    ridershipStats: safe(() => gameState.getRidershipStats(), null),
    modeChoiceStats: safe(() => gameState.getModeChoiceStats(), null),
    completedCommutes: options.includeCompletedCommutes
      ? summarizeCompletedCommutes(options)
      : null,
    demandEventsSinceLastSample: state.demandEventsSinceLastSample,
    lastDemandEventAt: state.lastDemandEventAt,
  };

  state.entries.push(entry);
  if (state.entries.length > RUNTIME_TRACE_LIMIT) {
    state.entries.splice(0, state.entries.length - RUNTIME_TRACE_LIMIT);
  }
  state.demandEventsSinceLastSample = 0;
  state.lastSampleAt = entry.at;
  return entry;
}

export function ensureRuntimeTraceSampler(options: RuntimeTraceSamplerOptions = {}): void {
  const state = getRuntimeTraceState();
  if (!isFlightRecorderEnabled()) return;
  if (!state.hookRegistered) {
    state.hookRegistered = true;

    try {
      hooks.onDayChange((day) => {
        if (!isFlightRecorderEnabled()) return;
        sampleRuntimeTrace(`day-change:${day}`);
      });
    } catch (err) {
      console.warn('[sb-tod] runtime trace day hook failed:', err);
    }

    try {
      hooks.onDemandChange(() => {
        if (!isFlightRecorderEnabled()) return;
        state.demandEventsSinceLastSample++;
        state.lastDemandEventAt = Date.now();
      });
    } catch (err) {
      console.warn('[sb-tod] runtime trace demand hook failed:', err);
    }

    sampleRuntimeTrace('start');
  }

  if (options.interval && typeof window !== 'undefined' && state.intervalId == null) {
    state.intervalId = window.setInterval(() => {
      sampleRuntimeTrace('interval');
    }, options.intervalMs ?? RUNTIME_TRACE_INTERVAL_MS);
  }
}

export function runtimeTraceSnapshot(): RuntimeTraceEntry[] {
  return [...getRuntimeTraceState().entries];
}
