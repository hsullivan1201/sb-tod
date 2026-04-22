/**
 * SB TOD — entry point
 *
 * Stage 0: register a toolbar panel that opens the Hello TOD view.
 * UI registration happens inside `onMapReady` (per AA's debugging
 * notes). Guard against double-init: the hook can fire more than
 * once on save load.
 */

import { hooks, ui, apiVersion } from './api';
import { HelloTodPanel } from './ui/HelloTodPanel';
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
      render: HelloTodPanel,
    });

    initMapHighlight();

    // Best-effort first init. Demand might not be ready yet — that's fine,
    // the first onDayChange (or a panel interaction) will retry.
    getModState()
      .ensureInit()
      .then((ok) => {
        if (ok) {
          const s = getModState().stats();
          console.log(
            `${TAG} Mod state initialized (${s.pointsTracked} baselines, ${s.popsTracked} pops, ${s.pointsWithDeltas} with deltas, hydrate:`,
            s.lastHydrate
          );
        }
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

// The TOD tick. Daily cadence per ARCHITECTURE decision 4 — NOT on
// onDemandChange, which fires ~49× per game day and would compound into
// a feedback loop if we reacted to our own writes.
hooks.onDayChange((day) => {
  getModState().onDayTick(day);
});

// Observability only. Never mutate from this handler.
hooks.onDemandChange(() => {
  getModState().onDemandChangeFired();
});

hooks.onGameSaved(() => {
  getModState().onGameSavedFired();
});

hooks.onGameLoaded(() => {
  getModState().onGameLoadedFired();
});
