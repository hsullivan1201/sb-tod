import { describe, expect, it } from 'vitest';
import type { DemandData, DemandPoint, Pop } from '../types';
import { createModState, type StorageLike, type PersistedState } from './mod-state';

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

function makeStorage(): StorageLike & { _data: Map<string, unknown> } {
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
  it('persists on day tick when dirty (configurable cadence)', async () => {
    const storage = makeStorage();
    const A = point('P', 100, 1000);
    const x = pop('x', 'P', 'P', 50);
    const state = createModState({
      mutatorOptions: {},
      storage,
      getDemand: () => fixture([A], [x]),
      persistEveryNDays: 1,
    });
    await state.ensureInit();
    state.applyDensityDelta('P', { residents: 50 }, 'deals');
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(false);

    state.onDayTick(5);
    // tick is sync but persist is async — wait a microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(storage._data.has('sb-tod:state:v1:_unsaved')).toBe(true);
    expect(state.stats().lastDay).toBe(5);
    expect(state.stats().dayTicks).toBe(1);
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
