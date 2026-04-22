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

const MOD_ID = 'dev.hazel.sb-tod';
const MOD_VERSION = '0.1.0';
const TAG = '[sb-tod]';

console.log(`${TAG} v${MOD_VERSION} loading | API v${apiVersion}`);

let initialized = false;

hooks.onMapReady(() => {
  if (initialized) return;
  initialized = true;

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
