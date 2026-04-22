/**
 * SB TOD — typed API wrapper
 *
 * Narrows `window.SubwayBuilderAPI` (untyped global) into the methods
 * the mod actually uses. Every call site goes through this module so
 * we can swap or stub in tests, and so missing API surface is a
 * compile-time error rather than a runtime crash.
 */

import type { DemandData, StationGroup } from './types';

const raw = window.SubwayBuilderAPI;

if (!raw) {
  throw new Error('[sb-tod] SubwayBuilderAPI not found on window');
}

export const apiVersion: string = raw.version;

export const gameState = {
  getDemandData(): DemandData {
    return raw.gameState.getDemandData() as DemandData;
  },
  getStations() {
    return raw.gameState.getStations();
  },
  getStationRidership(stationId: string) {
    return raw.gameState.getStationRidership(stationId);
  },
  getCurrentDay(): number {
    return raw.gameState.getCurrentDay();
  },
  isPaused(): boolean {
    return raw.gameState.isPaused();
  },
  // Group/transfer surface — bundled template types don't list these,
  // but probe-1 confirmed they exist and Debug DL confirmed shapes
  // (2026-04-22). Cast through `any` since the d.ts is stale.
  getStationGroups(): StationGroup[] {
    const groups = (raw.gameState as any).getStationGroups?.();
    return Array.isArray(groups) ? (groups as StationGroup[]) : [];
  },
  getTransferStationIds(): string[] {
    const ids = (raw.gameState as any).getTransferStationIds?.();
    return Array.isArray(ids) ? (ids as string[]) : [];
  },
  getSiblingStationIds(stationId: string): string[] {
    const ids = (raw.gameState as any).getSiblingStationIds?.(stationId);
    return Array.isArray(ids) ? (ids as string[]) : [];
  },
};

export const hooks = {
  onGameInit(cb: () => void): void {
    raw.hooks.onGameInit(cb);
  },
  onMapReady(cb: (map: unknown) => void): void {
    raw.hooks.onMapReady(cb);
  },
  onGameLoaded(cb: () => void): void {
    raw.hooks.onGameLoaded(cb);
  },
  onGameSaved(cb: () => void): void {
    raw.hooks.onGameSaved(cb);
  },
  onDayChange(cb: (day: number) => void): void {
    raw.hooks.onDayChange(cb);
  },
  onDemandChange(cb: () => void): void {
    raw.hooks.onDemandChange(cb);
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
    raw.ui.addToolbarPanel(config);
  },
  showNotification(message: string, level: 'info' | 'success' | 'warning' | 'error'): void {
    raw.ui.showNotification(message, level);
  },
};

export const map = {
  registerSource(id: string, config: {
    type: 'geojson';
    data: unknown;
  }): void {
    raw.map.registerSource(id, config);
  },
  registerLayer(config: {
    id: string;
    type: 'fill' | 'line' | 'circle';
    source: string;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  }): void {
    raw.map.registerLayer(config);
  },
};

export const utils = raw.utils;

/** Live MapLibre instance, or null if not yet ready. */
export function getMap(): any {
  try {
    return (raw.utils as any).getMap?.() ?? null;
  } catch {
    return null;
  }
}
