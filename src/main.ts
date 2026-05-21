/**
 * SB TOD — entry point
 *
 * Register a toolbar panel that opens the TOD dashboard.
 * UI registration happens inside `onMapReady` (per AA's debugging
 * notes). Guard against double-init: the hook can fire more than
 * once on save load.
 */

import { hooks, ui, apiVersion } from './api';
import { TodPanel } from './ui/TodPanel';
import { initMapHighlight } from './ui/mapHighlight';
import { getModState } from './state/mod-state';

const MOD_ID = 'dev.hazel.sb-tod';
const MOD_VERSION = '0.1.0';
const TAG = '[sb-tod]';

console.log(`${TAG} v${MOD_VERSION} loading | API v${apiVersion}`);

let uiInitialized = false;

hooks.onMapReady(() => {
  if (uiInitialized) return;
  uiInitialized = true;

  try {
    ui.addToolbarPanel({
      id: 'sb-tod-panel',
      icon: 'Building2',
      tooltip: 'Transit-Oriented Development',
      title: 'TOD',
      width: 420,
      render: TodPanel,
    });

    initMapHighlight();

    // Best-effort init. Demand may not be ready yet; the first day tick
    // or panel interaction will retry if this returns false.
    getModState()
      .ensureInit()
      .then((ok) => {
        if (!ok) return;
        const s = getModState().stats();
        console.log(
          `${TAG} Mod state initialized (${s.pointsTracked} baselines, ${s.popsTracked} pops, ${s.pointsWithDeltas} with deltas).`
        );
      })
      .catch((e) => console.warn(`${TAG} Initial mod-state init deferred:`, e));

    console.log(`${TAG} Initialized.`);
  } catch (err) {
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
