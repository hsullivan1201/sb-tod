/** Subway Builder Modding API v1.0.0 */

import { ModManifest } from "./manifest";

// =============================================================================
// ELECTRON IPC TYPES
// =============================================================================

export interface ElectronAPI {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  quit(): void;
  reloadWindow(): void;
  setCurrentRoute(route: string): void;
  updateDiscordActivity(activity: unknown): void;
  saveGameToFile(data: unknown): Promise<boolean>;
  saveGameAuto(data: unknown): Promise<boolean>;
  loadGameFromFile(): Promise<unknown>;
  loadGameFromPath(path: string): Promise<unknown>;
  getSaveFilesFromDirectory(): Promise<unknown[]>;
  deleteSaveFile(filename: string): Promise<boolean>;
  importMetroFile(): Promise<unknown>;
  setLicenseKey(key: string): Promise<void>;

  openExternalURL(url: string): Promise<unknown>;
  openSaveFolder(): Promise<undefined>;

  /** Gets the absolute path to the game's "mods" folder, where users  place mod files. */
  getModsFolder: () => Promise<string>;
  /** Opens the game's "mods" folder in the user's file explorer. */
  openModsFolder?: () => Promise<unknown>;
  /** Scans the mods folder and returns a list of mod statuses. */
  scanMods: () => Promise<{ success: boolean; mods: ModStatus[] }>;
  /** Enables or disables a mod by its ID, returning whether a game restart is required. */
  setModEnabled: (modId: string, enabled: boolean) => Promise<{ success: boolean }>;

  /** Gets information about the user's system including OS platform/architecture*/
  getSystemPerformanceInfo?: () => Promise<SystemPerformanceInfo>;

  /** Gets a value from the game's settings file metro-maker4/settings.json. */
  getStorageItem: (key: string) => Promise<{ success: boolean; data: unknown }>;
  getSetting: (key: string) => Promise<{ success: boolean; value: unknown }>;

  /** Sets a value in the game's settings file metro-maker4/settings.json. */
  setStorageItem: (key: string, value: unknown) => Promise<{ success: boolean }>;
  setSetting: (key: string, value: unknown) => Promise<{ success: boolean }>;

  /** Gets the user's current language setting (e.g. "en", "fr", "de"). */
  getLanguage(): Promise<string>;
  setLanguage(locale: string): Promise<void>; // This is currently a no-op

  /** Game log operations */
  getLogFilePath(): Promise<string>;
  /** Retrieves ten most recent errors from the game's log file */
  getRecentErrors(): Promise<ErrorLog[]>;
}

export interface ElectronAPIExtended {
  loadDataFile(path: string): Promise<unknown>;
  getDataServerPort(): Promise<number>;
  buildBlueprints(): Promise<void>;
  findRoutePathOrder(routeId: string): Promise<unknown>;
}

export type ModStatus = ModManifest & {
  /** Absolute path to the mod's main JavaScript file. */
  path: string;
  /** Whether the mod is currently enabled. */
  enabled: boolean;
  requiresRestart?: boolean;
}

export type SystemPerformanceInfo = {
  totalRAMGB: number;
  cpuCores: number;
  heapSizeMB: number;
  platform: string;
  arch: string;
};

export type ErrorLog = {
  level: string,
  message: string,
  timestamp: string,
}
