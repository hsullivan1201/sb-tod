/**
 * SB TOD — entry point
 *
 * Register a toolbar panel that opens the TOD dashboard.
 * UI registration happens inside `onMapReady` (per AA's debugging
 * notes). Guard against double-init: the hook can fire more than
 * once on save load.
 */

import { hooks, ui, apiVersion } from './api';
import { recordFlightEvent } from './diagnostics/flightRecorder';
import { ensureRuntimeTraceSampler } from './diagnostics/runtimeTrace';
import { TodPanel } from './ui/TodPanel';
import { initMapHighlight } from './ui/mapHighlight';
import { getModState } from './state/mod-state';

const MOD_ID = 'dev.hazel.sb-tod';
const MOD_VERSION = '0.2.4';
const TAG = '[sb-tod]';

console.log(`${TAG} v${MOD_VERSION} loading | API v${apiVersion}`);
recordFlightEvent('main.load', { modVersion: MOD_VERSION, apiVersion }, { includeGame: false });

let uiInitialized = false;

hooks.onMapReady(() => {
  if (uiInitialized) return;
  uiInitialized = true;
  recordFlightEvent('main.map-ready', { modVersion: MOD_VERSION, apiVersion }, { includeGame: false });

  try {
    // Floating panel (not a toolbar panel) so the player can pan the map
    // and click stations to select them while the dashboard is open.
    ui.addFloatingPanel({
      id: 'sb-tod-panel',
      icon: 'Building2',
      title: 'TOD',
      defaultWidth: 420,
      defaultHeight: 640,
      render: TodPanel,
    });

    initMapHighlight();
    ensureRuntimeTraceSampler();

    // Best-effort init. Demand may not be ready yet; the first day tick
    // or panel interaction will retry if this returns false.
    getModState()
      .ensureInit()
      .then((ok) => {
        recordFlightEvent('main.ensure-init.resolved', { ok }, { includeGame: true });
        if (!ok) return;
        const s = getModState().stats();
        console.log(
          `${TAG} Mod state initialized (${s.pointsTracked} baselines, ${s.popsTracked} pops, ${s.pointsWithDeltas} with deltas).`
        );
      })
      .catch((e) => {
        recordFlightEvent('main.ensure-init.throw', { error: String(e) }, { includeGame: true });
        console.warn(`${TAG} Initial mod-state init deferred:`, e);
      });

    console.log(`${TAG} Initialized.`);
  } catch (err) {
    recordFlightEvent('main.init.throw', { error: String(err) }, { includeGame: false });
    console.error(`${TAG} Init failed:`, err);
    try {
      ui.showNotification(`${MOD_ID} failed to load — check console.`, 'error');
    } catch {
      // notification can also fail mid-init; swallow
    }
  }
});

// Daily cadence only. onDemandChange is observability because the game
// fires it often enough that mutating there would form a feedback loop.
hooks.onDayChange((day) => {
  getModState().onDayTick(day);
});

hooks.onDemandChange(() => {
  getModState().onDemandChangeFired();
});

hooks.onGameSaved((saveName) => {
  getModState().onGameSavedFired(saveName);
});

hooks.onGameLoaded((saveName) => {
  getModState().onGameLoadedFired(saveName);
});

hooks.onGameEnd(() => {
  getModState().onGameEndFired();
});
