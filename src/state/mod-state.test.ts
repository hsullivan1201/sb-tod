import { describe, expect, it } from 'vitest';
import type { DemandData, DemandPoint, Pop } from '../types';
import { createModState, type StorageLike, type PersistedState } from './mod-state';
import type { Deal } from '../sim/deals';

function point(id: string, jobs: number, residents: number): DemandPoint {
  return {
    id,
    location: [-122, 37],
    jobs,
    residents,
    popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

function pop(id: string, residenceId: string, jobId: string, size: number): Pop {
  return {
    id,
    size,
    residenceId,
    jobId,
    drivingSeconds: 0,
    drivingDistance: 0,
    homeDepartureTime: 0,
    workDepartureTime: 0,
    lastCommute: {
      modeChoice: { walking: 0, driving: 0, transit: 0, unknown: 0 },
      transitPaths: [],
      walking: { time: 0, distance: 0 },
    },
  };
}

function fixture(points: DemandPoint[], pops: Pop[]): DemandData {
  return {
    points: new Map(points.map((p) => [p.id, p])),
    popsMap: new Map(pops.map((p) => [p.id, p])),
  };
}

function makeStorage(): StorageLike & { _data: Map<string, unknown>; keys(): Promise<string[]> } {
  const data = new Map<string, unknown>();
  return {
    _data: data,
    async set(key, value) {
      // Simulate JSON round-trip — strips Maps, undefined, etc.
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async get<T>(key: string, defaultValue: T): Promise<T> {
      return (data.has(key) ? (data.get(key) as T) : defaultValue);
    },
    async delete(key) {
      data.delete(key);
    },
    async keys() {
      return [...data.keys()];
    },
  };
}

function makeNoopStorage(): StorageLike {
  return {
    async set() {
      // Simulates browser/no-op api.storage: set resolves, get returns default.
    },
    async get<T>(_key: string, defaultValue: T): Promise<T> {
      return defaultValue;
    },
    async delete() {
      // no-op
    },
  };
}

function deal(id = 'deal-1', overrides: Partial<Deal> = {}): Deal {
  return {
    id,
    kind: 'housing',
    tier: 'S',
    centerStationGroupId: 'station-1',
    centerStationGroupName: 'Station 1',
    centerLngLat: [-122, 37],
    radiusMeters: 500,
    totalDensity: { residents: 600, jobs: 0 },
    totalCost: 250_000,
    startDay: 1,
    durationDays: 1,
    state: 'active',
    appliedSoFar: { residents: 0, jobs: 0 },
    pending: { residents: 0, jobs: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------
describe('mod state — fresh init', () => {
  it('captures live demand as baseline when no storage exists', async () => {
    const P = point('P', 100, 200);
    const x = pop('x', 'P', 'P', 10);
    const demand = fixture([P], [x]);
    const storage = makeStorage();
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => demand });

    expect(state.isReady()).toBe(false);
    const ok = await state.ensureInit();
    expect(ok).toBe(true);
    expect(state.isReady()).toBe(true);

    expect(state.mutator().getBaseline('P')).toEqual({ jobs: 100, residents: 200 });
    expect(state.stats().pointsTracked).toBe(1);
    expect(state.stats().popsTracked).toBe(1);
    expect(state.stats().lastHydrate?.fromStorage).toBe(false);
  });

  it('returns false from ensureInit when demand is unavailable', async () => {
    const storage = makeStorage();
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => null });
    expect(await state.ensureInit()).toBe(false);
    expect(state.isReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persist + reload roundtrip
// ---------------------------------------------------------------------------
describe('mod state — persist roundtrip', () => {
  it('serializes and reloads cumulative deltas through storage', async () => {
    const storage = makeStorage();

    // Session 1: init, mutate, persist.
    const A = point('P', 100, 1000);
    const xA = pop('x', 'P', 'P', 50);
    const demandA = fixture([A], [xA]);
    const sessionA = createModState({ mutatorOptions: {}, storage, getDemand: () => demandA });
    await sessionA.ensureInit();
    sessionA.applyDensityDelta('P', { residents: 200 }, 'deals');
    expect(await sessionA.persist()).toBe(true);

    // Session 2: fresh demand object (game reset our writes — residents back
    // to 1000, pop size back to 50). New mod state. Storage has session-1 data.
    const B = point('P', 100, 1000);
    const xB = pop('x', 'P', 'P', 50);
    const demandB = fixture([B], [xB]);
    const sessionB = createModState({ mutatorOptions: {}, storage, getDemand: () => demandB });
    await sessionB.ensureInit();

    expect(sessionB.stats().lastHydrate?.fromStorage).toBe(true);
    expect(sessionB.stats().lastHydrate?.replayed).toBe(1);
    // Replay restored the mutation: residents 1200, pop scaled to 60.
    expect(B.residents).toBe(1200);
    expect(xB.size).toBeCloseTo(60, 10);
    expect(sessionB.mutator().getBaseline('P')).toEqual({ jobs: 100, residents: 1000 });
    expect(sessionB.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 200 });
  });

  it('detects "preserved" case and skips re-mutation', async () => {
    const storage = makeStorage();

    // Session 1: mutate + persist.
    const A = point('P', 100, 1000);
    const xA = pop('x', 'P', 'P', 50);
    const sessionA = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], [xA]) });
    await sessionA.ensureInit();
    sessionA.applyDensityDelta('P', { residents: 200 }, 'deals');
    await sessionA.persist();

    // Session 2: simulate the game preserving our writes — live demand is
    // already at the post-mutation values. Pop size is scaled.
    const B = point('P', 100, 1200);
    const xB = pop('x', 'P', 'P', 60);
    const sessionB = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([B], [xB]) });
    await sessionB.ensureInit();

    expect(sessionB.stats().lastHydrate?.preserved).toBe(1);
    expect(sessionB.stats().lastHydrate?.replayed).toBe(0);
    // Critically: NO double-application — residents stay at 1200, pop at 60.
    expect(B.residents).toBe(1200);
    expect(xB.size).toBe(60);
    // Tracking state matches: future deltas anchor on baseline 1000.
    expect(sessionB.mutator().getBaseline('P')).toEqual({ jobs: 100, residents: 1000 });
    expect(sessionB.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 200 });
  });

  it('preserved-aggregate-but-missing-children: reconcilePoint recreates lost split children on hydrate', async () => {
    // Game preserves point.residents through save/load, but our
    // runtime-added split-child pops in popsMap don't survive.
    // Hydrate's preserved path used to skip reconciliation, leaving
    // pop count too low. This test pins the fix.
    const storage = makeStorage();

    // Session 1: 600 residents in 3 pops of 200 each. Strict mode.
    // Mutate +200 → 4 pops desired (3 originals + 1 child).
    const A = point('P', 0, 600);
    const a = pop('a', 'P', 'P', 200);
    const b = pop('b', 'P', 'P', 200);
    const c = pop('c', 'P', 'P', 200);
    const sessionA = createModState({
      storage,
      getDemand: () => fixture([A], [a, b, c]),
      // No mutatorOptions override → defaults to strictUnitSize: 200.
    });
    await sessionA.ensureInit();
    sessionA.applyDensityDelta('P', { residents: 200 }, 'deals');
    await sessionA.persist();

    // Session 2: simulate game preserving aggregate (800 residents)
    // but dropping our runtime split children (only 3 originals in
    // popsMap, no sb-tod-split:* entries).
    const B = point('P', 0, 800);
    const a2 = pop('a', 'P', 'P', 200);
    const b2 = pop('b', 'P', 'P', 200);
    const c2 = pop('c', 'P', 'P', 200);
    const demandB = fixture([B], [a2, b2, c2]);
    const sessionB = createModState({
      storage,
      getDemand: () => demandB,
    });
    await sessionB.ensureInit();

    expect(sessionB.stats().lastHydrate?.preserved).toBe(1);
    // Reconciliation should have created 1 missing child to bring
    // pop count up to floor(800/200) = 4.
    expect(demandB.popsMap.size).toBe(4);
    for (const p of demandB.popsMap.values()) {
      expect(p.size).toBe(200);
    }
  });

  it('drops stale delta and rebaselines when live matches neither baseline nor expected', async () => {
    const storage = makeStorage();

    // Persist a state with baseline 1000 + delta 200 → expected 1200.
    const persisted: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [['P', { jobs: 100, residents: 1000 }]],
      baselinePopSizes: [['x', 50]],
      cumulativeDeltas: [
        [
          'P',
          {
            jobs: { fromDeals: 0, fromOrganic: 0 },
            residents: { fromDeals: 200, fromOrganic: 0 },
          },
        ],
      ],
    };
    await storage.set('sb-tod:state:v1:_unsaved', persisted);

    // Live demand is at 800 — baseline shifted (game patch, edited save, etc.).
    const B = point('P', 100, 800);
    const xB = pop('x', 'P', 'P', 50);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([B], [xB]) });
    await state.ensureInit();

    expect(state.stats().lastHydrate?.baselineShift).toBe(1);
    // Live untouched: residents stays 800.
    expect(B.residents).toBe(800);
    // Baseline rebaselined to live; cumulative delta dropped.
    expect(state.mutator().getBaseline('P')).toEqual({ jobs: 100, residents: 800 });
    expect(state.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
  });

  it('captures fresh baselines for new points present in live but not in storage', async () => {
    const storage = makeStorage();
    const persisted: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [['P', { jobs: 100, residents: 1000 }]],
      baselinePopSizes: [],
      cumulativeDeltas: [],
    };
    await storage.set('sb-tod:state:v1:_unsaved', persisted);

    const P = point('P', 100, 1000);
    const Q_new = point('Q-new', 50, 50); // didn't exist when we last saved
    const demand = fixture([P, Q_new], []);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => demand });
    await state.ensureInit();

    expect(state.mutator().getBaseline('Q-new')).toEqual({ jobs: 50, residents: 50 });
  });

  it('handles JSON round-trip — persisted state is plain-data-safe', async () => {
    const storage = makeStorage();
    const A = point('P', 250, 1750);
    const xA = pop('x', 'P', 'P', 12.5);
    const sessionA = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], [xA]) });
    await sessionA.ensureInit();
    sessionA.applyDensityDelta('P', { residents: 175, jobs: 50 }, 'deals');
    sessionA.applyDensityDelta('P', { residents: 50 }, 'organic');
    await sessionA.persist();

    // Verify the stored value is JSON-roundtrippable.
    const stored = storage._data.get('sb-tod:state:v1:_unsaved');
    const cloned = JSON.parse(JSON.stringify(stored));
    expect(cloned.version).toBe(1);
    expect(cloned.baselineDemand[0][0]).toBe('P');
    expect(cloned.cumulativeDeltas[0][1].residents.fromDeals).toBe(175);
    expect(cloned.cumulativeDeltas[0][1].residents.fromOrganic).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------
describe('mod state — lifecycle hooks', () => {
  it('uses the current game save name before first init', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], []),
      getSaveName: () => 'alpha',
    });

    await state.ensureInit();
    expect(state.getCurrentSaveName()).toBe('alpha');
    state.applyDensityDelta('P', { residents: 50 }, 'deals');
    expect(await state.persist()).toBe(true);
    expect(storage._data.has('sb-tod:state:v1:alpha')).toBe(true);
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);
  });

  it('defers dirty day-tick persistence until the game save hook', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
    });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 50 }, 'deals');
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);

    state.onDayTick(5);
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);
    expect(state.stats().lastDay).toBe(5);
    expect(state.stats().dayTicks).toBe(1);
    expect(state.stats().dirty).toBe(true);

    state.onGameSavedFired('_unsaved');
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(true);
    expect(state.stats().dirty).toBe(false);
  });

  it('does not persist when not dirty', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], []) });
    await state.ensureInit();
    state.onDayTick(1);
    state.onDayTick(2);
    state.onDayTick(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);
  });

  it('flushes dirty state on game end', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], []) });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 50 }, 'deals');

    state.onGameEndFired();
    await Promise.resolve();
    await Promise.resolve();

    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(true);
  });

  it('rebinds to refreshed DemandData before applying deal ticks', async () => {
    const storage = makeStorage();
    const stalePoint = point('P', 100, 1000);
    let liveDemand = fixture([stalePoint], [pop('x', 'P', 'P', 50)]);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => liveDemand,
    });
    await state.ensureInit();
    expect(
      await state.addDeal(
        deal('deal-refresh', {
          centerStationGroupId: 'P',
          centerStationGroupName: 'P',
          totalDensity: { residents: 2000, jobs: 0 },
          startDay: 1,
          durationDays: 2,
        })
      )
    ).toBe(true);

    const freshPoint = point('P', 100, 1000);
    liveDemand = fixture([freshPoint], [pop('x', 'P', 'P', 50)]);

    state.onDayTick(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(freshPoint.residents).toBe(2000);
    expect(stalePoint.residents).toBe(1000);
    expect(state.stats().lastTickReports[0].applied.residents).toBe(1000);
  });

  it('does not replay preserved old deltas during a routine DemandData rebind', async () => {
    const storage = makeStorage();
    const P = point('P', 0, 600);
    let liveDemand = fixture(
      [P],
      [pop('a', 'P', 'P', 200), pop('b', 'P', 'P', 200), pop('c', 'P', 'P', 200)]
    );
    const state = createModState({
      storage,
      getDemand: () => liveDemand,
    });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 200 }, 'deals');
    expect(liveDemand.popsMap.size).toBe(4);

    // The game handed the mod a fresh DemandData object where the point
    // aggregate is preserved but split children are absent. A normal day
    // tick should rebuild internal tracking without rematerializing every
    // old persisted split child in the hot path.
    const freshPoint = point('P', 0, 800);
    liveDemand = fixture(
      [freshPoint],
      [pop('a', 'P', 'P', 200), pop('b', 'P', 'P', 200), pop('c', 'P', 'P', 200)]
    );

    state.onDayTick(7);

    expect(state.stats().lastHydrate?.preserved).toBe(1);
    expect(freshPoint.residents).toBe(800);
    expect(liveDemand.popsMap.size).toBe(3);
    expect(state.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 200 });
  });

  it('cancels and refunds a zero-progress active deal when it loads with negative budget', async () => {
    const storage = makeStorage();
    const rescueDeal = deal('deal-rescue', {
      tier: 'L',
      totalDensity: { residents: 8000, jobs: 0 },
      totalCost: 600_000_000,
      durationDays: 3,
      startDay: 34,
    });
    const persisted: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [['P', { jobs: 100, residents: 1000 }]],
      baselinePopSizes: [],
      cumulativeDeltas: [],
      deals: [rescueDeal],
    };
    await storage.set('sb-tod:state:v1:_unsaved', persisted);

    const refunds: number[] = [];
    const P = point('P', 100, 1000);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([P], []),
      getBudget: () => -5_000_000,
      addMoney: (amount) => {
        refunds.push(amount);
      },
    });

    await state.ensureInit();

    expect(refunds).toEqual([600_000_000]);
    expect(state.getDeals()[0].state).toBe('cancelled');
    const stored = storage._data.get('sb-tod:state:v1:_unsaved') as PersistedState;
    expect(stored.deals?.[0].state).toBe('cancelled');
  });

  it('counts onDemandChange events without ever mutating', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], [x]) });
    await state.ensureInit();

    for (let i = 0; i < 49; i++) state.onDemandChangeFired();
    expect(state.stats().demandChangeEvents).toBe(49);
    // Demand untouched.
    expect(A.residents).toBe(1000);
    expect(x.size).toBe(50);
    // No deltas.
    expect(state.stats().pointsWithDeltas).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyDensityDelta proxy + revert
// ---------------------------------------------------------------------------
describe('mod state — applyDensityDelta + revert', () => {
  it('marks dirty after a successful mutation', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], [x]) });
    await state.ensureInit();

    expect(await state.persist()).toBe(true);
    storage._data.delete('sb-tod:state:v1:_unsaved');

    state.applyDensityDelta('P', { residents: 100 }, 'deals');
    state.onDayTick(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);
    expect(state.stats().dirty).toBe(true);

    state.onGameEndFired();
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(true);
  });

  it('isolates state per save name (no cross-save bleed)', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);

    // Session on save "alpha": +200 residents.
    const sessionAlpha = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
      initialSaveName: 'alpha',
    });
    await sessionAlpha.ensureInit();
    sessionAlpha.applyDensityDelta('P', { residents: 200 }, 'deals');
    await sessionAlpha.persist();
    expect(storage._data.has('sb-tod:state:v1:alpha')).toBe(true);
    expect(storage._data.has('sb-tod:state:v1:beta')).toBe(false);

    // Fresh "beta" save with the same city — must NOT see alpha's deltas.
    const Bp = point('P', 100, 1000);
    const Bx = pop('x', 'P', 'P', 50);
    const sessionBeta = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([Bp], [Bx]),
      initialSaveName: 'beta',
    });
    await sessionBeta.ensureInit();
    expect(sessionBeta.stats().lastHydrate?.fromStorage).toBe(false);
    expect(sessionBeta.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
    // Mutate beta; persist.
    sessionBeta.applyDensityDelta('P', { residents: -50 }, 'deals');
    await sessionBeta.persist();
    expect(storage._data.has('sb-tod:state:v1:beta')).toBe(true);

    // Re-open alpha — must still see +200, not -50.
    const Ap2 = point('P', 100, 1000);
    const Ax2 = pop('x', 'P', 'P', 50);
    const sessionAlpha2 = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([Ap2], [Ax2]),
      initialSaveName: 'alpha',
    });
    await sessionAlpha2.ensureInit();
    expect(sessionAlpha2.mutator().getCumulativeDeltaTotal('P').residents).toBe(200);
  });

  it('switches to a new save via setCurrentSaveName, persisting old before re-init', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
      initialSaveName: 'alpha',
    });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 100 }, 'deals');
    // Switch saves WITHOUT explicit persist — setCurrentSaveName must save first.
    await state.setCurrentSaveName('beta');
    expect(storage._data.has('sb-tod:state:v1:alpha')).toBe(true);
    expect(state.getCurrentSaveName()).toBe('beta');
    // Beta starts fresh.
    expect(state.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 0 });
  });

  it('does not recursively live-sync while persisting a dirty old slot during save switch', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    let liveName = 'old';
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
      getSaveName: () => liveName,
      initialSaveName: 'old',
    });
    await state.ensureInit();
    state.markDirty();

    liveName = 'new';
    await state.setCurrentSaveName('new');

    expect(state.getCurrentSaveName()).toBe('new');
    expect(storage._data.has('sb-tod:state:v1:old')).toBe(true);
  });

  it('carries an unstarted active deal through live save-name sync before first tick', async () => {
    const storage = makeStorage();
    const P = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const demand = fixture([P], [x]);
    let liveName: string | null = null;
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => demand,
      getSaveName: () => liveName,
    });
    await state.ensureInit();

    expect(
      await state.addDeal(
        deal('pending-deal', {
          chargeAudit: {
            budgetBefore: 500_000,
            expectedBudgetAfter: 250_000,
            budgetAfter: 250_000,
            chargedAt: Date.now(),
          },
        })
      )
    ).toBe(true);

    liveName = 'fresh-save';
    await state.ensureInit();

    expect(state.getCurrentSaveName()).toBe('fresh-save');
    expect(state.getDeals().map((d) => d.id)).toEqual(['pending-deal']);

    state.onGameSavedFired('fresh-save');
    await Promise.resolve();
    await Promise.resolve();

    const stored = storage._data.get('sb-tod:state:v1:fresh-save') as PersistedState;
    expect(stored.deals?.map((d) => d.id)).toEqual(['pending-deal']);
  });

  it('waits for pending live save-name sync before accepting a new deal', async () => {
    const storage = makeStorage();
    const P = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const demand = fixture([P], [x]);
    let liveName = 'old';
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => demand,
      getSaveName: () => liveName,
    });
    await state.ensureInit();

    liveName = 'new';
    state.getDeals();
    expect(await state.addDeal(deal('late-deal'))).toBe(true);

    expect(state.getCurrentSaveName()).toBe('new');
    expect(state.getDeals().map((d) => d.id)).toEqual(['late-deal']);
  });

  it('recovers a recent charged deal-only _unsaved slot for an empty named save', async () => {
    const storage = makeStorage();
    const orphanDeal = deal('orphan-deal', {
      chargeAudit: {
        budgetBefore: 500_000,
        expectedBudgetAfter: 250_000,
        budgetAfter: 250_000,
        chargedAt: Date.now(),
      },
    });
    const orphanState: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [],
      baselinePopSizes: [],
      cumulativeDeltas: [],
      deals: [orphanDeal],
    };
    await storage.set('sb-tod:state:v1:_unsaved', orphanState);

    const P = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([P], [x]),
      getSaveName: () => 'fresh-save',
    });

    await state.ensureInit();

    expect(state.getCurrentSaveName()).toBe('fresh-save');
    expect(state.getDeals().map((d) => d.id)).toEqual(['orphan-deal']);
    expect(state.stats().dirty).toBe(true);
  });

  it('carries dirty unsaved deals through same-save game-loaded reinit', async () => {
    const storage = makeStorage();
    const oldDeal = deal('old-deal', {
      state: 'completed',
      centerStationGroupId: 'old-station',
      centerStationGroupName: 'Old Station',
    });
    const persisted: PersistedState = {
      version: 1,
      savedAt: Date.now() - 10_000,
      baselineDemand: [],
      baselinePopSizes: [],
      cumulativeDeltas: [],
      deals: [oldDeal],
    };
    await storage.set('sb-tod:state:v1:alpha', persisted);

    const P = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([P], [x]),
      getSaveName: () => 'alpha',
    });
    await state.ensureInit();
    expect(state.getDeals().map((d) => d.id)).toEqual(['old-deal']);

    expect(await state.addDeal(deal('new-unsaved-deal'))).toBe(true);
    state.onGameLoadedFired('alpha');
    await Promise.resolve();
    await Promise.resolve();

    expect(state.getCurrentSaveName()).toBe('alpha');
    expect(state.getDeals().map((d) => d.id)).toEqual(['old-deal', 'new-unsaved-deal']);
    expect(state.stats().dirty).toBe(true);
  });

  it('migrates richer legacy _unsaved state when the named save slot is skinny', async () => {
    const storage = makeStorage();
    const legacyDeal = deal('legacy-deal', { state: 'completed' });
    const namedOnlyDeal = deal('named-deal', {
      centerStationGroupId: 'Q',
      centerStationGroupName: 'Q',
    });
    const legacyState: PersistedState = {
      version: 1,
      savedAt: Date.now() - 10_000,
      baselineDemand: [['P', { jobs: 100, residents: 1000 }]],
      baselinePopSizes: [['x', 50]],
      cumulativeDeltas: [
        [
          'P',
          {
            jobs: { fromDeals: 0, fromOrganic: 0 },
            residents: { fromDeals: 200, fromOrganic: 0 },
          },
        ],
      ],
      deals: [legacyDeal],
    };
    const skinnyNamedState: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [],
      baselinePopSizes: [],
      cumulativeDeltas: [],
      deals: [namedOnlyDeal],
    };
    await storage.set('sb-tod:state:v1:_unsaved', legacyState);
    await storage.set('sb-tod:state:v1:alpha', skinnyNamedState);

    const P = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([P], [x]),
    });
    await state.ensureInit();
    expect(P.residents).toBe(1200);

    await state.setCurrentSaveName('alpha');

    expect(state.getCurrentSaveName()).toBe('alpha');
    expect(state.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 200 });
    expect(state.getDeals().map((d) => d.id)).toEqual(['legacy-deal', 'named-deal']);
    expect(state.stats().dirty).toBe(true);

    state.onGameSavedFired('alpha');
    await Promise.resolve();
    await Promise.resolve();

    const stored = storage._data.get('sb-tod:state:v1:alpha') as PersistedState;
    expect(stored.cumulativeDeltas).toHaveLength(1);
    expect(stored.deals?.map((d) => d.id)).toEqual(['legacy-deal', 'named-deal']);
  });

  it('chooses the richest compatible existing slot when a new save name has no TOD key yet', async () => {
    const storage = makeStorage();
    const fallbackDeal = deal('fallback-deal', { state: 'completed' });
    const richDealA = deal('rich-deal-a', {
      state: 'completed',
      centerStationGroupId: 'P',
      centerStationGroupName: 'P',
      totalDensity: { residents: 200, jobs: 0 },
    });
    const richDealB = deal('rich-deal-b', {
      state: 'completed',
      centerStationGroupId: 'Q',
      centerStationGroupName: 'Q',
      totalDensity: { residents: 800, jobs: 0 },
    });
    const fallbackState: PersistedState = {
      version: 1,
      savedAt: Date.now() - 10_000,
      baselineDemand: [['P', { jobs: 100, residents: 1000 }]],
      baselinePopSizes: [],
      cumulativeDeltas: [
        [
          'P',
          {
            jobs: { fromDeals: 0, fromOrganic: 0 },
            residents: { fromDeals: 200, fromOrganic: 0 },
          },
        ],
      ],
      deals: [fallbackDeal],
    };
    const richState: PersistedState = {
      version: 1,
      savedAt: Date.now() - 5_000,
      baselineDemand: [
        ['P', { jobs: 100, residents: 1000 }],
        ['Q', { jobs: 100, residents: 1000 }],
      ],
      baselinePopSizes: [],
      cumulativeDeltas: [
        [
          'P',
          {
            jobs: { fromDeals: 0, fromOrganic: 0 },
            residents: { fromDeals: 200, fromOrganic: 0 },
          },
        ],
        [
          'Q',
          {
            jobs: { fromDeals: 0, fromOrganic: 0 },
            residents: { fromDeals: 800, fromOrganic: 0 },
          },
        ],
      ],
      deals: [richDealA, richDealB],
    };
    await storage.set('sb-tod:state:v1:_unsaved', fallbackState);
    await storage.set('sb-tod:state:v1:old-save', richState);

    let liveName: string | null = null;
    let liveDemand = fixture([point('P', 100, 1000), point('Q', 100, 1000)], []);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => liveDemand,
      getSaveName: () => liveName,
    });
    await state.ensureInit();
    expect(state.getDeals().map((d) => d.id)).toEqual(['fallback-deal']);

    // The game announces a just-created save name after the old save has
    // loaded. Its TOD key does not exist yet, but the live city matches
    // the richer old slot, not the fallback _unsaved payload.
    liveName = 'new-copy';
    liveDemand = fixture([point('P', 100, 1200), point('Q', 100, 1800)], []);
    await state.ensureInit();

    expect(state.getCurrentSaveName()).toBe('new-copy');
    expect(state.mutator().getCumulativeDeltaTotal('P')).toEqual({ jobs: 0, residents: 200 });
    expect(state.mutator().getCumulativeDeltaTotal('Q')).toEqual({ jobs: 0, residents: 800 });
    expect(state.getDeals().map((d) => d.id)).toEqual(['rich-deal-a', 'rich-deal-b']);
    expect(state.stats().dirty).toBe(true);

    state.onGameSavedFired('new-copy');
    await Promise.resolve();
    await Promise.resolve();

    const stored = storage._data.get('sb-tod:state:v1:new-copy') as PersistedState;
    expect(stored.cumulativeDeltas.map(([id]) => id).sort()).toEqual(['P', 'Q']);
    expect(stored.deals?.map((d) => d.id)).toEqual(['rich-deal-a', 'rich-deal-b']);
  });

  it('onGameSavedFired with a new name updates the slot before persisting (save-as)', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
      initialSaveName: 'alpha',
    });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 100 }, 'deals');
    // Player did "save as alpha-copy". Game fires onGameSaved("alpha-copy").
    state.onGameSavedFired('alpha-copy');
    await Promise.resolve();
    await Promise.resolve();
    expect(state.getCurrentSaveName()).toBe('alpha-copy');
    expect(storage._data.has('sb-tod:state:v1:alpha-copy')).toBe(true);
  });

  it('save-as copies clean state into the new slot too', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
      initialSaveName: 'alpha',
    });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 100 }, 'deals');
    expect(await state.persist()).toBe(true);

    // State is clean now, but a Save As still needs to copy it to the
    // new save slot so it doesn't stay stranded under the old key.
    state.onGameSavedFired('alpha-copy');
    await Promise.resolve();
    await Promise.resolve();

    expect(state.getCurrentSaveName()).toBe('alpha-copy');
    expect(storage._data.has('sb-tod:state:v1:alpha')).toBe(true);
    expect(storage._data.has('sb-tod:state:v1:alpha-copy')).toBe(true);
  });

  it('accepts new deals before storage round-trip and reports save failure later', async () => {
    const A = point('P', 100, 1000);
    const state = createModState({
      mutatorOptions: {},
      storage: makeNoopStorage(),
      getDemand: () => fixture([A], []),
    });
    await state.ensureInit();

    expect(await state.addDeal(deal())).toBe(true);
    expect(state.getDeals()).toHaveLength(1);
    expect(state.stats().dirty).toBe(true);

    state.onGameSavedFired('_unsaved');
    await Promise.resolve();
    await Promise.resolve();
    expect(state.stats().storageRoundTripOk).toBe(false);
    expect(state.stats().dirty).toBe(true);
  });

  it('rejects duplicate same-day development deals before they enter state', async () => {
    const A = point('P', 100, 1000);
    const state = createModState({
      mutatorOptions: {},
      storage: makeStorage(),
      getDemand: () => fixture([A], []),
    });
    await state.ensureInit();

    expect(await state.addDeal(deal('deal-a'))).toBe(true);
    expect(await state.addDeal(deal('deal-b'))).toBe(false);
    expect(state.getDeals().map((d) => d.id)).toEqual(['deal-a']);
  });

  it('suppresses persisted duplicate active deals before applying a day tick', async () => {
    const storage = makeStorage();
    const duplicateA = deal('deal-a', { startDay: 1, totalCost: 250_000 });
    const duplicateB = deal('deal-b', { startDay: 1, totalCost: 250_000 });
    const persisted: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      baselineDemand: [['P', { jobs: 100, residents: 1000 }]],
      baselinePopSizes: [['x', 200]],
      cumulativeDeltas: [],
      deals: [duplicateA, duplicateB],
    };
    await storage.set('sb-tod:state:v1:_unsaved', persisted);

    const refunds: number[] = [];
    const P = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 200);
    const state = createModState({
      storage,
      getDemand: () => fixture([P], [x]),
      addMoney: (amount) => refunds.push(amount),
    });
    await state.ensureInit();

    state.onDayTick(1);

    expect(state.stats().lastTickReports.map((r) => r.dealId)).toEqual(['deal-a']);
    expect(state.getDeals().map((d) => [d.id, d.state])).toEqual([
      ['deal-a', 'completed'],
      ['deal-b', 'cancelled'],
    ]);
    expect(refunds).toEqual([250_000]);
  });

  it('does not refresh demand while accepting a new deal', async () => {
    const A = point('P', 100, 1000);
    const demand = fixture([A], []);
    const storage = makeStorage();
    let throwOnDemand = false;
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => {
        if (throwOnDemand) throw new Error('demand refresh exploded');
        return demand;
      },
    });
    await state.ensureInit();

    throwOnDemand = true;
    await expect(state.addDeal(deal())).resolves.toBe(true);

    expect(state.getDeals()).toHaveLength(1);
    expect(state.stats().dirty).toBe(true);
  });

  it('does not mark dirty on failed mutation (ghost-town reject)', async () => {
    const storage = makeStorage();
    const A = point('P', 0, 0);
    const state = createModState({ mutatorOptions: {}, storage, getDemand: () => fixture([A], []) });
    await state.ensureInit();

    const r = state.applyDensityDelta('P', { residents: 100 }, 'deals');
    expect(r.ok).toBe(false);
    state.onDayTick(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);
  });
});
