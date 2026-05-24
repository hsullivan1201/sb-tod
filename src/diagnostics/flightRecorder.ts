import { gameState } from '../api';

const FLIGHT_RECORDER_KEY = 'sb-tod:flight-recorder-enabled';
const FLIGHT_RECORDER_LIMIT = 800;
const MAX_DETAIL_DEPTH = 3;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 36;
const MAX_STRING_LENGTH = 240;

export interface FlightRecorderEntry {
  seq: number;
  at: number;
  type: string;
  game?: {
    currentDay: number | null;
    currentHour: number | null;
    elapsedSeconds: number | null;
    secondOfDay: number | null;
    gameSpeed: unknown;
    paused: boolean | null;
    budget: number | null;
  };
  detail?: unknown;
}

export interface FlightRecorderSnapshot {
  enabled: boolean;
  limit: number;
  count: number;
  entries: FlightRecorderEntry[];
}

interface FlightRecorderState {
  enabled: boolean;
  entries: FlightRecorderEntry[];
  nextSeq: number;
}

export interface RecordFlightEventOptions {
  /** Default true. Game getters are cheap and give every breadcrumb a clock. */
  includeGame?: boolean;
}

function getState(): FlightRecorderState {
  const root = globalThis as typeof globalThis & {
    __sbTodFlightRecorder?: FlightRecorderState;
  };
  if (!root.__sbTodFlightRecorder) {
    root.__sbTodFlightRecorder = {
      enabled: readStoredEnabled(),
      entries: [],
      nextSeq: 1,
    };
  }
  return root.__sbTodFlightRecorder;
}

function readStoredEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(FLIGHT_RECORDER_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (enabled) localStorage.setItem(FLIGHT_RECORDER_KEY, '1');
    else localStorage.removeItem(FLIGHT_RECORDER_KEY);
  } catch {
    /* best effort */
  }
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

function gameSnapshot(): FlightRecorderEntry['game'] {
  const elapsedSeconds = finite(safe(() => gameState.getElapsedSeconds(), NaN));
  return {
    currentDay: finite(safe(() => gameState.getCurrentDay(), NaN)),
    currentHour: finite(safe(() => gameState.getCurrentHour(), NaN)),
    elapsedSeconds,
    secondOfDay: secondOfDay(elapsedSeconds),
    gameSpeed: safe(() => gameState.getGameSpeed(), null),
    paused: safe(() => gameState.isPaused(), null),
    budget: finite(safe(() => gameState.getBudget(), NaN)),
  };
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...<truncated ${value.length - MAX_STRING_LENGTH}>`
      : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DETAIL_DEPTH) return shape(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '<cycle>';
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push(`<${value.length - MAX_ARRAY_ITEMS} more>`);
    }
    return out;
  }

  if (value instanceof Map) {
    return {
      type: 'Map',
      size: value.size,
      sample: sanitize([...value.entries()].slice(0, MAX_ARRAY_ITEMS), depth + 1, seen),
    };
  }

  if (value instanceof Set) {
    return {
      type: 'Set',
      size: value.size,
      sample: sanitize([...value.values()].slice(0, MAX_ARRAY_ITEMS), depth + 1, seen),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = sanitize(item, depth + 1, seen);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
  }
  return out;
}

function shape(value: unknown): string {
  if (value == null) return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (typeof value === 'object') return `Object(${Object.keys(value).length})`;
  return typeof value;
}

export function isFlightRecorderEnabled(): boolean {
  return getState().enabled;
}

export function setFlightRecorderEnabled(enabled: boolean): void {
  const state = getState();
  state.enabled = enabled;
  writeStoredEnabled(enabled);
  if (enabled) {
    recordFlightEvent('flight-recorder.enabled', undefined, { includeGame: true });
  }
}

export function clearFlightRecorder(): void {
  const state = getState();
  state.entries = [];
}

export function recordFlightEvent(
  type: string,
  detail?: unknown,
  options: RecordFlightEventOptions = {}
): void {
  const state = getState();
  if (!state.enabled) return;

  const entry: FlightRecorderEntry = {
    seq: state.nextSeq++,
    at: Date.now(),
    type,
  };
  if (options.includeGame !== false) entry.game = gameSnapshot();
  if (detail !== undefined) entry.detail = sanitize(detail);

  state.entries.push(entry);
  if (state.entries.length > FLIGHT_RECORDER_LIMIT) {
    state.entries.splice(0, state.entries.length - FLIGHT_RECORDER_LIMIT);
  }
}

export function flightRecorderSnapshot(): FlightRecorderSnapshot {
  const state = getState();
  return {
    enabled: state.enabled,
    limit: FLIGHT_RECORDER_LIMIT,
    count: state.entries.length,
    entries: [...state.entries],
  };
}
