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

const RUNTIME_TRACE_INTERVAL_MS = 2500;
const RUNTIME_TRACE_LIMIT = 240;

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

function summarizeDemand(demand: DemandData | null): RuntimeTraceEntry['demand'] {
  if (!demand || !demand.points || !demand.popsMap) return null;
  let splitPops = 0;
  let splitSize = 0;
  for (const pop of demand.popsMap.values() as Iterable<any>) {
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

function summarizeCompletedCommutes(): RuntimeTraceEntry['completedCommutes'] {
  return safe(() => {
    const commutes = gameState.getCompletedCommutes();
    let splitPopCount = 0;
    const splitPopIdsSample: string[] = [];
    for (const commute of commutes as any[]) {
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
    };
  }, null);
}

export function sampleRuntimeTrace(reason: string): RuntimeTraceEntry {
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
    demand: summarizeDemand(demand),
    modState: summarizeModState(),
    ridershipStats: safe(() => gameState.getRidershipStats(), null),
    modeChoiceStats: safe(() => gameState.getModeChoiceStats(), null),
    completedCommutes: summarizeCompletedCommutes(),
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

export function ensureRuntimeTraceSampler(): void {
  const state = getRuntimeTraceState();
  if (state.hookRegistered) return;
  state.hookRegistered = true;

  try {
    hooks.onDayChange((day) => {
      sampleRuntimeTrace(`day-change:${day}`);
    });
  } catch (err) {
    console.warn('[sb-tod] runtime trace day hook failed:', err);
  }

  try {
    hooks.onDemandChange(() => {
      state.demandEventsSinceLastSample++;
      state.lastDemandEventAt = Date.now();
    });
  } catch (err) {
    console.warn('[sb-tod] runtime trace demand hook failed:', err);
  }

  if (typeof window !== 'undefined') {
    state.intervalId = window.setInterval(() => {
      sampleRuntimeTrace('interval');
    }, RUNTIME_TRACE_INTERVAL_MS);
  }

  sampleRuntimeTrace('start');
}

export function runtimeTraceSnapshot(): RuntimeTraceEntry[] {
  return [...getRuntimeTraceState().entries];
}
