/**
 * Storage adapter — auto-detects whether `api.storage` actually works
 * and falls back to `localStorage` when it doesn't.
 *
 * The `api.storage` namespace is documented as Electron-only; in browser
 * builds of Subway Builder it's a silent no-op (`set` resolves but writes
 * nothing, `get` always returns the default). We hit that case in
 * session 6 testing — the player's environment had storage round-trips
 * returning null even though `set()` resolved cleanly.
 *
 * Strategy: on first `set`, try the API backend and verify via immediate
 * readback. If the round-trip fails, switch permanently to localStorage
 * for the rest of the session and report the backend in use so the
 * debug panel can show it.
 *
 * localStorage limit (~5MB per origin) is roughly 50× our current
 * payload's worst case (a few hundred KB) — comfortable for a long time.
 */

import { storage as apiStorage } from '../api';
import type { StorageLike } from './mod-state';

export type StorageBackendKind = 'api' | 'local' | 'none';

export interface AdaptiveStorage extends StorageLike {
  keys(): Promise<string[]>;
  /** Which backend the last successful set used. `'none'` if neither worked. */
  lastBackend(): StorageBackendKind;
  /** Force a backend (for tests / opt-in override). */
  forceBackend(kind: StorageBackendKind | 'auto'): void;
}

const LS_AVAILABLE = (() => {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probe = '__sb-tod-probe__';
    localStorage.setItem(probe, '1');
    const v = localStorage.getItem(probe);
    localStorage.removeItem(probe);
    return v === '1';
  } catch {
    return false;
  }
})();

export function createAdaptiveStorage(): AdaptiveStorage {
  // 'auto' means "try api first, fall back on failure". After the first
  // round-trip we lock to whichever backend won.
  let mode: StorageBackendKind | 'auto' = 'auto';
  let lastSuccessful: StorageBackendKind = 'none';

  function localSet(key: string, value: unknown): void {
    if (!LS_AVAILABLE) throw new Error('localStorage unavailable');
    localStorage.setItem(key, JSON.stringify(value));
  }
  function localGet<T>(key: string, defaultValue: T): T {
    if (!LS_AVAILABLE) return defaultValue;
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  }
  function localDelete(key: string): void {
    if (!LS_AVAILABLE) return;
    localStorage.removeItem(key);
  }
  function localKeys(): string[] {
    if (!LS_AVAILABLE) return [];
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k != null) out.push(k);
    }
    return out;
  }

  async function tryApiSet(key: string, value: unknown): Promise<boolean> {
    try {
      await apiStorage.set(key, value);
      const readback = await apiStorage.get<unknown>(key, null);
      // Compare via JSON to handle Map/Date/etc round-tripping. We just
      // need "is this the same payload back?"; full deep equality isn't
      // required for the verify step.
      const a = JSON.stringify(readback);
      const b = JSON.stringify(value);
      return a === b && readback !== null;
    } catch (err) {
      console.warn('[sb-tod] api.storage probe threw:', err);
      return false;
    }
  }

  return {
    async set(key, value) {
      if (mode === 'local') {
        localSet(key, value);
        lastSuccessful = 'local';
        return;
      }
      if (mode === 'api') {
        // Locked to API. Trust it (we already verified once).
        await apiStorage.set(key, value);
        lastSuccessful = 'api';
        return;
      }
      // mode === 'auto': probe.
      const apiOk = await tryApiSet(key, value);
      if (apiOk) {
        mode = 'api';
        lastSuccessful = 'api';
        console.log('[sb-tod] storage backend: api.storage (round-trip verified)');
        return;
      }
      if (LS_AVAILABLE) {
        localSet(key, value);
        mode = 'local';
        lastSuccessful = 'local';
        console.warn(
          '[sb-tod] api.storage round-trip failed — falling back to localStorage for this session.'
        );
        return;
      }
      mode = 'none';
      lastSuccessful = 'none';
      throw new Error(
        '[sb-tod] no working storage backend (api.storage no-ops, localStorage unavailable)'
      );
    },

    async get<T>(key: string, defaultValue: T): Promise<T> {
      // On read we don't know which backend has the data — try API first,
      // then localStorage. Once we've successfully written, mode is locked.
      if (mode === 'local') return localGet(key, defaultValue);
      if (mode === 'api') return apiStorage.get<T>(key, defaultValue);

      // mode === 'auto': try both, prefer non-default.
      try {
        const apiVal = await apiStorage.get<T>(key, defaultValue as T);
        if (apiVal !== defaultValue && apiVal !== null && apiVal !== undefined) {
          return apiVal;
        }
      } catch {
        // ignore
      }
      if (LS_AVAILABLE) {
        return localGet(key, defaultValue);
      }
      return defaultValue;
    },

    async delete(key) {
      // Delete from both — cheap, avoids stale data after a backend switch.
      try {
        await apiStorage.delete(key);
      } catch {
        /* ignore */
      }
      if (LS_AVAILABLE) localDelete(key);
    },

    async keys() {
      // Union of both backends, deduped.
      const out = new Set<string>();
      try {
        const apiKeys = await (
          apiStorage as typeof apiStorage & { keys?: () => Promise<string[]> }
        ).keys?.();
        if (Array.isArray(apiKeys)) for (const k of apiKeys) out.add(`api:${k}`);
      } catch {
        /* ignore */
      }
      if (LS_AVAILABLE) for (const k of localKeys()) out.add(`local:${k}`);
      return [...out];
    },

    lastBackend() {
      return lastSuccessful;
    },

    forceBackend(kind) {
      mode = kind;
    },
  };
}
