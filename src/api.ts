/**
 * SB TOD — typed API wrapper
 *
 * Narrows `window.SubwayBuilderAPI` (untyped global) into the methods
 * the mod actually uses. Every call site goes through this module so
 * we can swap or stub in tests, and so missing API surface is a
 * compile-time error rather than a runtime crash.
 */

import type { DemandData, StationGroup } from './types';
import type { ModdingAPI } from './types/api';

// Lazy lookup so test environments (no `window`) can import this module
// without erroring at evaluation. The actual game enforces presence the
// first time a wrapper method runs.
function getRaw(): ModdingAPI {
  const w = typeof window !== 'undefined' ? (window as any) : undefined;
  const raw = w?.SubwayBuilderAPI as ModdingAPI | undefined;
  if (!raw) {
    throw new Error('[sb-tod] SubwayBuilderAPI not found on window');
  }
  return raw;
}

export const apiVersion: string =
  typeof window !== 'undefined' && (window as any).SubwayBuilderAPI
    ? (window as any).SubwayBuilderAPI.version
    : 'unset';

export const gameState = {
  getDemandData(): DemandData {
    return getRaw().gameState.getDemandData() as DemandData;
  },
  getStations() {
    return getRaw().gameState.getStations();
  },
  getStationRidership(stationId: string) {
    return getRaw().gameState.getStationRidership(stationId);
  },
  getCurrentDay(): number {
    return getRaw().gameState.getCurrentDay();
  },
  getCurrentHour(): number {
    return getRaw().gameState.getCurrentHour();
  },
  getElapsedSeconds(): number {
    return getRaw().gameState.getElapsedSeconds();
  },
  getGameSpeed() {
    return getRaw().gameState.getGameSpeed();
  },
  isPaused(): boolean {
    return getRaw().gameState.isPaused();
  },
  getBudget(): number {
    return getRaw().gameState.getBudget();
  },
  getRidershipStats() {
    return getRaw().gameState.getRidershipStats();
  },
  getModeChoiceStats() {
    return getRaw().gameState.getModeChoiceStats();
  },
  getCompletedCommutes() {
    return getRaw().gameState.getCompletedCommutes();
  },
  getSaveName(): string | null {
    const name = (getRaw().gameState as any).getSaveName?.();
    return typeof name === 'string' && name.length > 0 ? name : null;
  },
  // Group/transfer surface — bundled template types don't list these,
  // but probe-1 confirmed they exist and Debug DL confirmed shapes
  // (2026-04-22). Cast through `any` since the d.ts is stale.
  getStationGroups(): StationGroup[] {
    const groups = (getRaw().gameState as any).getStationGroups?.();
    return Array.isArray(groups) ? (groups as StationGroup[]) : [];
  },
  getTransferStationIds(): string[] {
    const ids = (getRaw().gameState as any).getTransferStationIds?.();
    return Array.isArray(ids) ? (ids as string[]) : [];
  },
  getSiblingStationIds(stationId: string): string[] {
    const ids = (getRaw().gameState as any).getSiblingStationIds?.(stationId);
    return Array.isArray(ids) ? (ids as string[]) : [];
  },
};

export const hooks = {
  onGameInit(cb: () => void): void {
    getRaw().hooks.onGameInit(cb);
  },
  onMapReady(cb: (map: unknown) => void): void {
    getRaw().hooks.onMapReady(cb);
  },
  onGameLoaded(cb: (saveName: string) => void): void {
    getRaw().hooks.onGameLoaded(cb);
  },
  onGameSaved(cb: (saveName: string) => void): void {
    getRaw().hooks.onGameSaved(cb);
  },
  onGameEnd(cb: () => void): void {
    getRaw().hooks.onGameEnd(cb);
  },
  onDayChange(cb: (day: number) => void): void {
    getRaw().hooks.onDayChange(cb);
  },
  onDemandChange(cb: (popCount: number) => void): void {
    getRaw().hooks.onDemandChange(cb);
  },
  onMoneyChanged(cb: (newBalance: number, change: number, type: 'revenue' | 'expense', category?: string) => void): void {
    getRaw().hooks.onMoneyChanged(cb);
  },
};

export const actions = {
  subtractMoney(amount: number, category?: string): void {
    getRaw().actions.subtractMoney(amount, category);
  },
  addMoney(amount: number, category?: string): void {
    getRaw().actions.addMoney(amount, category);
  },
  setMoney(amount: number): void {
    getRaw().actions.setMoney(amount);
  },
};

export const storage = {
  set(key: string, value: unknown): Promise<void> {
    return getRaw().storage.set(key, value);
  },
  get<T>(key: string, defaultValue: T): Promise<T> {
    return getRaw().storage.get<T>(key, defaultValue);
  },
  delete(key: string): Promise<void> {
    return getRaw().storage.delete(key);
  },
  keys(): Promise<string[]> {
    return (getRaw().storage as any).keys?.() ?? Promise.resolve([]);
  },
};

export const ui = {
  addToolbarPanel(config: {
    id: string;
    icon: string;
    tooltip: string;
    title: string;
    width: number;
    render: () => unknown;
  }): void {
    getRaw().ui.addToolbarPanel(config);
  },
  // Floating panels don't render a full-screen backdrop, so the map
  // underneath stays pannable and clickable while the panel is open.
  addFloatingPanel(config: {
    id: string;
    title?: string;
    icon?: string;
    defaultWidth?: number;
    defaultHeight?: number;
    defaultPosition?: { x: number; y: number };
    render: () => unknown;
  }): void {
    getRaw().ui.addFloatingPanel(config);
  },
  showNotification(message: string, level: 'info' | 'success' | 'warning' | 'error'): void {
    getRaw().ui.showNotification(message, level);
  },
  getResolvedTheme(): string {
    const themeApi = getRaw().ui as any;
    return themeApi.getResolvedTheme?.() ?? themeApi.getTheme?.() ?? 'dark';
  },
};

export const map = {
  registerSource(id: string, config: {
    type: 'geojson';
    data: unknown;
  }): void {
    getRaw().map.registerSource(id, config);
  },
  registerLayer(config: {
    id: string;
    type: 'fill' | 'line' | 'circle';
    source: string;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  }): void {
    getRaw().map.registerLayer(config);
  },
};

export const utils: any = new Proxy(
  {},
  {
    get(_, prop) {
      return (getRaw().utils as any)[prop];
    },
  }
);

/** Live MapLibre instance, or null if not yet ready. */
export function getMap(): any {
  try {
    return (getRaw().utils as any).getMap?.() ?? null;
  } catch {
    return null;
  }
}
