/**
 * TOD panel — Stage 1 first slice.
 *
 * Headline counts, plus top stations by TOD potential and TOD risk.
 * A Debug button downloads the raw scored data so we can inspect
 * shapes without browser DevTools (probes used the same trick).
 *
 * Layout uses flex divs rather than <table> + Tailwind utilities — the
 * game's CSS subset doesn't reliably honor `truncate` / `table-fixed`,
 * so we fall back to inline styles + flex which behave predictably.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { gameState, utils, actions } from '../api';
import {
  scoreAllStationsDetailed,
  type CalibrationInfo,
  type ScoredStation,
} from '../scoring';
import { clearHighlight, setHighlight } from './mapHighlight';
import { getModState } from '../state/mod-state';
import { findWalkshed } from '../scoring/walkshed';
import { storage } from '../api';
import {
  validateProposal,
  confirmProposal,
  DEFAULT_TIER_TABLE,
  DURATION_PRESETS,
  type Deal,
  type DealKind,
  type DealTier,
} from '../sim/deals';

const HIGHLIGHT_RADIUS_M = 500;

const { Button } = utils.components as Record<string, React.ComponentType<any>>;

const TOP_N = 5;

interface Snapshot {
  stations: number;
  demandPoints: number;
  pops: number;
  scored: ScoredStation[];
  calibration: CalibrationInfo;
}

const FALLBACK_CALIBRATION: CalibrationInfo = {
  ridershipScale: 500,
  supplySaturation: 30_000,
  residentSaturation: 5_000,
  jobSaturation: 10_000,
  residentTransitScale: 200,
  workerTransitScale: 500,
  source: 'default',
};

function readSnapshot(): Snapshot {
  try {
    const stations = gameState.getStations();
    const demand = gameState.getDemandData();
    const { scored, calibration } = scoreAllStationsDetailed();
    return {
      stations: stations?.length ?? 0,
      demandPoints: demand.points?.size ?? 0,
      pops: demand.popsMap?.size ?? 0,
      scored,
      calibration,
    };
  } catch (err) {
    console.error('[sb-tod] readSnapshot failed:', err);
    return {
      stations: 0,
      demandPoints: 0,
      pops: 0,
      scored: [],
      calibration: FALLBACK_CALIBRATION,
    };
  }
}

export function HelloTodPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const onRowClick = useCallback(
    (row: ScoredStation) => {
      if (highlightedId === row.id) {
        clearHighlight();
        setHighlightedId(null);
        return;
      }
      setHighlight(row.center, HIGHLIGHT_RADIUS_M);
      setHighlightedId(row.id);
    },
    [highlightedId]
  );

  // ESC: clear the pin first if one is set; otherwise let the game's
  // own ESC handler close the panel. Capture phase + stopPropagation so
  // we intercept before the game sees it. We don't preventDefault when
  // letting it pass through — the game's handler reads the bubble phase.
  useEffect(() => {
    if (!highlightedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      clearHighlight();
      setHighlightedId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [highlightedId]);

  const topResidential = useMemo(
    () =>
      [...snapshot.scored]
        .sort((a, b) => b.access.residential - a.access.residential)
        .slice(0, TOP_N),
    [snapshot]
  );
  const topCommercial = useMemo(
    () =>
      [...snapshot.scored]
        .sort((a, b) => b.access.commercial - a.access.commercial)
        .slice(0, TOP_N),
    [snapshot]
  );
  // Risk excludes stations with no recorded ridership: those are
  // almost always brand-new builds or stations not yet on a route, not
  // genuine "land use is failing the station" stories. We surface the
  // excluded count so the filter is transparent.
  const riskCandidates = useMemo(
    () => snapshot.scored.filter((s) => s.score.ridership > 0),
    [snapshot]
  );
  const topRisk = useMemo(
    () => [...riskCandidates].sort((a, b) => b.score.risk - a.score.risk).slice(0, TOP_N),
    [riskCandidates]
  );
  const riskExcluded = snapshot.scored.length - riskCandidates.length;
  const topCaptured = useMemo(
    () =>
      [...snapshot.scored]
        .sort((a, b) => b.score.capturedValue - a.score.capturedValue)
        .slice(0, TOP_N),
    [snapshot]
  );
  const totalRiders = useMemo(
    () => snapshot.scored.reduce((sum, s) => sum + s.score.ridership, 0),
    [snapshot]
  );

  return (
    <div
      className="text-sm"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        maxHeight: '80vh',
        overflowY: 'auto',
      }}
    >
      <section style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Row
          label="Stations"
          value={`${snapshot.stations.toLocaleString()} (${snapshot.scored.length.toLocaleString()} groups)`}
        />
        <Row label="Demand Points" value={snapshot.demandPoints.toLocaleString()} />
        <Row label="Pops" value={snapshot.pops.toLocaleString()} />
        <Row label="Riders (15min)" value={Math.round(totalRiders).toLocaleString()} />
      </section>

      <AccessSection
        heading="Top residential TOD"
        subhead="Residents here use transit · room to add housing. Upzone for homes."
        rows={topResidential}
        kind="residential"
        highlightedId={highlightedId}
        onRowClick={onRowClick}
      />

      <AccessSection
        heading="Top commercial TOD"
        subhead="Workers here arrive by transit · room to add jobs. Upzone for offices."
        rows={topCommercial}
        kind="commercial"
        highlightedId={highlightedId}
        onRowClick={onRowClick}
      />

      <Section
        heading="Top captured value"
        subhead="Dense walkshed, well-served. Station and area working together."
        rows={topCaptured}
        metric="capturedValue"
        highlightedId={highlightedId}
        onRowClick={onRowClick}
      />

      <Section
        heading="Top TOD risk"
        subhead="Dense walkshed, weak capture. Station being failed by the area."
        rows={topRisk}
        metric="risk"
        highlightedId={highlightedId}
        onRowClick={onRowClick}
        footnote={
          riskExcluded > 0
            ? `${riskExcluded} station${riskExcluded === 1 ? '' : 's'} excluded (no recorded ridership — likely new or disconnected)`
            : undefined
        }
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => setSnapshot(readSnapshot())}>Refresh</Button>
        <Button
          variant="secondary"
          onClick={() => {
            clearHighlight();
            setHighlightedId(null);
          }}
        >
          Clear pin
        </Button>
        <Button variant="secondary" onClick={() => downloadDebug(snapshot)}>
          Debug DL
        </Button>
      </div>

      <DealsSection
        pinned={highlightedId ? snapshot.scored.find((s) => s.id === highlightedId) ?? null : null}
        onAfter={() => setSnapshot(readSnapshot())}
      />

      <DebugTodSection
        highlightedId={highlightedId}
        scored={snapshot.scored}
        onAfter={() => setSnapshot(readSnapshot())}
      />


      <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
        Stage 1 · 500m walkshed · scores ranked relative to this map (auto-calibrated)
        <br />
        residential scale {Math.round(snapshot.calibration.residentTransitScale).toLocaleString()} ·
        sat {Math.round(snapshot.calibration.residentSaturation).toLocaleString()}
        <br />
        commercial scale {Math.round(snapshot.calibration.workerTransitScale).toLocaleString()} ·
        sat {Math.round(snapshot.calibration.jobSaturation).toLocaleString()}
        <br />
        risk scale {Math.round(snapshot.calibration.ridershipScale).toLocaleString()} riders ·
        supply sat {Math.round(snapshot.calibration.supplySaturation).toLocaleString()}{' '}
        ({snapshot.calibration.source})
      </p>
    </div>
  );
}

function Section({
  heading,
  subhead,
  rows,
  metric,
  highlightedId,
  onRowClick,
  footnote,
}: {
  heading: string;
  subhead: string;
  rows: ScoredStation[];
  metric: 'potential' | 'risk' | 'capturedValue';
  highlightedId: string | null;
  onRowClick: (row: ScoredStation) => void;
  footnote?: string;
}) {
  return (
    <section>
      <SectionHeader heading={heading} subhead={subhead} />
      <StationList rows={rows} metric={metric} highlightedId={highlightedId} onRowClick={onRowClick} />
      {footnote && (
        <p style={{ fontSize: 10, color: MUTED_COLOR, marginTop: 4, fontStyle: 'italic' }}>
          {footnote}
        </p>
      )}
    </section>
  );
}

function AccessSection({
  heading,
  subhead,
  rows,
  kind,
  highlightedId,
  onRowClick,
}: {
  heading: string;
  subhead: string;
  rows: ScoredStation[];
  kind: 'residential' | 'commercial';
  highlightedId: string | null;
  onRowClick: (row: ScoredStation) => void;
}) {
  return (
    <section>
      <SectionHeader heading={heading} subhead={subhead} />
      <AccessList rows={rows} kind={kind} highlightedId={highlightedId} onRowClick={onRowClick} />
    </section>
  );
}

function SectionHeader({ heading, subhead }: { heading: string; subhead: string }) {
  return (
    <>
      <h3
        className="text-xs uppercase tracking-wide text-muted-foreground"
        style={{ marginBottom: 2 }}
      >
        {heading}
      </h3>
      <p className="text-xs text-muted-foreground" style={{ marginBottom: 6 }}>
        {subhead}
      </p>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'rgba(255,255,255,0.92)' }}>
      <span style={{ color: 'rgba(255,255,255,0.55)' }}>{label}</span>
      <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{value}</span>
    </div>
  );
}

function displayName(name: string | undefined, id: string): string {
  if (!name || name === id) return `#${id.slice(0, 6)}`;
  if (name.length >= 32 && name.includes('-')) return `#${id.slice(0, 6)}`;
  if (name.length > 16) return name.slice(0, 15) + '…';
  return name;
}

const TEXT_COLOR = 'rgba(255,255,255,0.92)';
const MUTED_COLOR = 'rgba(255,255,255,0.55)';

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  paddingTop: 3,
  paddingBottom: 3,
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  color: TEXT_COLOR,
};

const nameColStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  color: TEXT_COLOR,
};

const metricsColStyle: React.CSSProperties = {
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
  fontSize: 11,
  fontFamily: 'ui-monospace, Menlo, monospace',
  color: TEXT_COLOR,
};

function StationList({
  rows,
  metric,
  highlightedId,
  onRowClick,
}: {
  rows: ScoredStation[];
  metric: 'potential' | 'risk' | 'capturedValue';
  highlightedId: string | null;
  onRowClick: (row: ScoredStation) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No stations yet.</p>;
  }
  return (
    <div>
      <div
        style={{
          ...rowStyle,
          color: MUTED_COLOR,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        <span style={{ ...nameColStyle, color: MUTED_COLOR, fontSize: 10 }}>Station</span>
        <span style={{ ...metricsColStyle, color: MUTED_COLOR, fontSize: 10 }}>
          riders · wshed · score
        </span>
      </div>
      {rows.map((r) => (
        <ClickableRow
          key={r.id}
          row={r}
          isHighlighted={highlightedId === r.id}
          onClick={onRowClick}
          right={
            <>
              {fmt(r.score.ridership)} · {fmt(r.score.walkshedSupply)} ·{' '}
              {r.score[metric].toFixed(2)}
            </>
          }
        />
      ))}
    </div>
  );
}

function AccessList({
  rows,
  kind,
  highlightedId,
  onRowClick,
}: {
  rows: ScoredStation[];
  kind: 'residential' | 'commercial';
  highlightedId: string | null;
  onRowClick: (row: ScoredStation) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No stations yet.</p>;
  }
  // Residential view: transit-using residents · total residents · score.
  // Commercial view:  transit-using workers  · total jobs      · score.
  // The transit/total ratio gives the player an instant "what % of the
  // walkshed currently uses transit" read alongside the score.
  const headerRight = kind === 'residential' ? 'transit · res · score' : 'transit · jobs · score';
  return (
    <div>
      <div
        style={{
          ...rowStyle,
          color: MUTED_COLOR,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        <span style={{ ...nameColStyle, color: MUTED_COLOR, fontSize: 10 }}>Station</span>
        <span style={{ ...metricsColStyle, color: MUTED_COLOR, fontSize: 10 }}>
          {headerRight}
        </span>
      </div>
      {rows.map((r) => {
        const transit =
          kind === 'residential' ? r.access.residentTransit : r.access.workerTransit;
        const total = kind === 'residential' ? r.totals.residents : r.totals.jobs;
        const score = kind === 'residential' ? r.access.residential : r.access.commercial;
        return (
          <ClickableRow
            key={r.id}
            row={r}
            isHighlighted={highlightedId === r.id}
            onClick={onRowClick}
            right={
              <>
                {fmt(transit)} · {fmt(total)} · {score.toFixed(2)}
              </>
            }
          />
        );
      })}
    </div>
  );
}

function ClickableRow({
  row,
  isHighlighted,
  onClick,
  right,
}: {
  row: ScoredStation;
  isHighlighted: boolean;
  onClick: (row: ScoredStation) => void;
  right: React.ReactNode;
}) {
  const baseStyle: React.CSSProperties = {
    ...rowStyle,
    cursor: 'pointer',
    paddingLeft: 6,
    paddingRight: 6,
    marginLeft: -6,
    marginRight: -6,
    borderRadius: 3,
    backgroundColor: isHighlighted ? 'rgba(251,191,36,0.12)' : 'transparent',
    boxShadow: isHighlighted ? 'inset 2px 0 0 0 #fbbf24' : undefined,
  };
  return (
    <div
      style={baseStyle}
      title={`${row.name}\n${row.id}\n${row.memberCount} platform${row.memberCount === 1 ? '' : 's'}\n(click to highlight on map)`}
      onClick={() => onClick(row)}
      onMouseEnter={(e) => {
        if (!isHighlighted) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isHighlighted) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
        }
      }}
    >
      <span style={nameColStyle}>
        {displayName(row.name, row.id)}
        {row.memberCount > 1 && (
          <span style={{ marginLeft: 6, color: MUTED_COLOR, fontSize: 10 }}>
            ⇄{row.memberCount}
          </span>
        )}
      </span>
      <span style={metricsColStyle}>{right}</span>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1000) return Math.round(n / 100) / 10 + 'k';
  return Math.round(n).toString();
}

function downloadDebug(snapshot: Snapshot) {
  const dump = (s: ScoredStation) => ({
    id: s.id,
    name: s.name,
    memberCount: s.memberCount,
    totals: s.totals,
    score: s.score,
    access: s.access,
  });
  const topResidential = [...snapshot.scored]
    .sort((a, b) => b.access.residential - a.access.residential)
    .slice(0, TOP_N)
    .map(dump);
  const topCommercial = [...snapshot.scored]
    .sort((a, b) => b.access.commercial - a.access.commercial)
    .slice(0, TOP_N)
    .map(dump);
  const riskCandidates = snapshot.scored.filter((s) => s.score.ridership > 0);
  const topRisk = [...riskCandidates]
    .sort((a, b) => b.score.risk - a.score.risk)
    .slice(0, TOP_N)
    .map(dump);
  const topCaptured = [...snapshot.scored]
    .sort((a, b) => b.score.capturedValue - a.score.capturedValue)
    .slice(0, TOP_N)
    .map(dump);
  const payload = {
    timestamp: new Date().toISOString(),
    bundleVersion: 'panel-v10-esc-clears-pin',
    counts: {
      stations: snapshot.stations,
      demandPoints: snapshot.demandPoints,
      pops: snapshot.pops,
      scoredLength: snapshot.scored.length,
      riskExcludedZeroRidership: snapshot.scored.length - riskCandidates.length,
    },
    calibration: snapshot.calibration,
    topResidential,
    topCommercial,
    topCaptured,
    topRisk,
    groupProbe: probeStationGroups(snapshot.scored),
    demandShapeProbe: probeDemandShape(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sb-tod-debug-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Probe the station group / sibling / transfer API surface.
 *
 * We don't know the exact shapes ahead of time, so we capture:
 *   - typeof, Array.isArray, instanceof Map / Set
 *   - keys/length/size, plus a small sample
 *   - getSiblingStationIds() called on the first three known stations
 */
function probeStationGroups(scored: ScoredStation[]) {
  const sampleStationIds = scored.slice(0, 3).map((s) => s.id);
  const out: Record<string, unknown> = { sampleStationIds };

  out.getStationGroups = describe(() => gameState.getStationGroups());
  out.getTransferStationIds = describe(() => gameState.getTransferStationIds());
  out.getSiblingStationIds = sampleStationIds.map((id) => ({
    forStationId: id,
    forStationName: scored.find((s) => s.id === id)?.name,
    result: describe(() => gameState.getSiblingStationIds(id)),
  }));

  return out;
}

function describe(fn: () => unknown): unknown {
  try {
    const value = fn();
    return shape(value, 0);
  } catch (err) {
    return { __error: String(err) };
  }
}

/**
 * Probe `DemandPoint.residentModeShare` / `workerModeShare` and
 * `Pop.lastCommute` shapes. probe-2 noted "Shape TBD — probe them with
 * the first real usage." This is the first real usage.
 *
 * Sampling strategy:
 *   - first DemandPoint by Map iteration order (baseline)
 *   - point with the most residents (likely populated modeshare)
 *   - point with the most jobs (likely populated workerModeShare)
 *   - first 3 Pops referenced by the residents-heavy point (lastCommute)
 *
 * Uses `deepShape` (depth 5) instead of the standard `shape` so nested
 * objects like `{ transit: {...}, driving: {...} }` are fully visible.
 */
function probeDemandShape(): unknown {
  try {
    const demand = gameState.getDemandData();
    const points = Array.from(demand.points.values());
    if (points.length === 0) return { __empty: true };

    const first = points[0];
    const residentsHeavy = points.reduce(
      (best, p) => (p.residents > best.residents ? p : best),
      points[0]
    );
    const jobsHeavy = points.reduce(
      (best, p) => (p.jobs > best.jobs ? p : best),
      points[0]
    );

    const pops = demand.popsMap;
    const samplePopIds = (residentsHeavy.popIds ?? []).slice(0, 3);
    const samplePops = samplePopIds
      .map((id) => pops.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));

    return {
      pointFields: Object.keys(first as object),
      firstPoint: deepShape(first, 0),
      residentsHeavyPoint: {
        id: (residentsHeavy as any).id,
        residents: residentsHeavy.residents,
        jobs: residentsHeavy.jobs,
        full: deepShape(residentsHeavy, 0),
      },
      jobsHeavyPoint: {
        id: (jobsHeavy as any).id,
        residents: jobsHeavy.residents,
        jobs: jobsHeavy.jobs,
        full: deepShape(jobsHeavy, 0),
      },
      samplePopsFromResidentsHeavy: samplePops.map((p) => deepShape(p, 0)),
    };
  } catch (err) {
    return { __error: String(err) };
  }
}

/**
 * Like `shape` but recurses to depth 5 and shows ALL keys (not just 8).
 * Use only on small focal samples — emits more verbose output than
 * the per-station-group probe wants.
 */
function deepShape(value: unknown, depth: number): unknown {
  if (depth > 5) return '__max-depth';
  if (value === null) return null;
  if (value === undefined) return undefined;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 8) {
      return {
        __type: 'Array',
        length: value.length,
        sampleItems: value.slice(0, 8).map((v) => deepShape(v, depth + 1)),
      };
    }
    return value.map((v) => deepShape(v, depth + 1));
  }
  if (value instanceof Map || value instanceof Set) {
    return shape(value, depth);
  }
  if (t === 'object' && value) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = deepShape(obj[k], depth + 1);
    }
    return out;
  }
  return { __type: t };
}

function shape(value: unknown, depth: number): unknown {
  if (value === null) return { __type: 'null' };
  if (value === undefined) return { __type: 'undefined' };
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return value;
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).slice(0, 5);
    return {
      __type: 'Map',
      size: value.size,
      sampleEntries: entries.map(([k, v]) => [
        shape(k, depth + 1),
        depth < 2 ? shape(v, depth + 1) : '__truncated',
      ]),
    };
  }
  if (value instanceof Set) {
    const items = Array.from(value).slice(0, 10);
    return {
      __type: 'Set',
      size: value.size,
      sampleItems: items.map((v) => shape(v, depth + 1)),
    };
  }
  if (Array.isArray(value)) {
    return {
      __type: 'Array',
      length: value.length,
      sampleItems: value.slice(0, 5).map((v) => (depth < 2 ? shape(v, depth + 1) : '__truncated')),
    };
  }
  if (t === 'object' && value) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 20);
    const out: Record<string, unknown> = { __type: 'object', keys };
    if (depth < 2) {
      const sample: Record<string, unknown> = {};
      for (const k of keys.slice(0, 8)) {
        sample[k] = shape(obj[k], depth + 1);
      }
      out.sample = sample;
    }
    return out;
  }
  return { __type: t };
}

// ---------------------------------------------------------------------------
// Debug TOD section — manual mutation testing for stage 2.
// Lets us verify the mutator + persistence path end-to-end in-game.
// Removed once deals UI ships; for now it's the only entry point that
// actually invokes a mutation.
// ---------------------------------------------------------------------------
function DebugTodSection({
  highlightedId,
  scored,
  onAfter,
}: {
  highlightedId: string | null;
  scored: ScoredStation[];
  onAfter: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [stats, setStats] = useState(() => getModState().stats());

  const refreshStats = useCallback(() => setStats(getModState().stats()), []);

  const pinned = useMemo(
    () => (highlightedId ? scored.find((s) => s.id === highlightedId) ?? null : null),
    [highlightedId, scored]
  );

  const poke = useCallback(
    async (kind: 'residents' | 'jobs', amount: number) => {
      if (!pinned) {
        setLast('No station pinned. Click a row first.');
        return;
      }
      const state = getModState();
      const ok = await state.ensureInit();
      if (!ok) {
        setLast('Mod state not ready (demand data unavailable yet).');
        return;
      }

      const demand = gameState.getDemandData();
      if (!demand) {
        setLast('No demand data.');
        return;
      }
      // Pick the heaviest-weighted point in the pinned station's walkshed
      // for the dimension we're poking. If all points are zero in that
      // dimension, the apply will fail with ghost-town and we report it.
      const hits = findWalkshed([pinned.center[0], pinned.center[1]], demand.points.values(), {
        radiusMeters: HIGHLIGHT_RADIUS_M,
      });
      if (hits.length === 0) {
        setLast(`No DemandPoints in ${HIGHLIGHT_RADIUS_M}m of ${pinned.name}.`);
        return;
      }
      const ranked = hits
        .map((h) => ({
          h,
          score: (kind === 'residents' ? h.point.residents : h.point.jobs) * h.weight,
        }))
        .sort((a, b) => b.score - a.score);
      const target = ranked[0].h;

      const r = state.applyDensityDelta(
        target.point.id,
        kind === 'residents' ? { residents: amount } : { jobs: amount },
        'deals'
      );

      if (r.ok) {
        setLast(
          `OK: ${kind} ${amount > 0 ? '+' : ''}${amount} on point ${target.point.id} (${pinned.name} walkshed). Affected ${r.affectedPops} pops. Splits: +${r.splitsCreated} / -${r.splitsRemoved}. Cumulative now ${r.cumulativeDelta.jobs}j/${r.cumulativeDelta.residents}r.`
        );
        onAfter();
      } else {
        setLast(`FAIL (${r.reason}): ${r.message}`);
      }
      refreshStats();
    },
    [pinned, onAfter, refreshStats]
  );

  const persistNow = useCallback(async () => {
    const ok = await getModState().persist();
    setLast(ok ? 'Persisted to storage.' : 'Persist FAILED — check console.');
    refreshStats();
  }, [refreshStats]);

  const revertAll = useCallback(() => {
    const state = getModState();
    if (!state.isReady()) {
      setLast('Mod state not ready.');
      return;
    }
    state.mutator().revertAll();
    state.markDirty();
    setLast('Reverted all mutations to baseline.');
    onAfter();
    refreshStats();
  }, [onAfter, refreshStats]);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            refreshStats();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 10,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          ▸ Stage 2 debug · mutator
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px dashed rgba(255,255,255,0.15)',
        borderRadius: 4,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 11 }}>Stage 2 debug · mutator</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          ▾
        </button>
      </div>

      <div style={{ color: 'rgba(255,255,255,0.6)' }}>
        {pinned ? (
          <>Targets walkshed of: <strong>{pinned.name}</strong></>
        ) : (
          <em>Pin a station above to enable poking.</em>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button onClick={() => poke('residents', 100)} disabled={!pinned}>
          +100 res
        </Button>
        <Button onClick={() => poke('residents', -100)} disabled={!pinned}>
          −100 res
        </Button>
        <Button onClick={() => poke('jobs', 100)} disabled={!pinned}>
          +100 jobs
        </Button>
        <Button onClick={() => poke('jobs', -100)} disabled={!pinned}>
          −100 jobs
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={persistNow}>
          Persist now
        </Button>
        <Button variant="secondary" onClick={revertAll}>
          Revert all
        </Button>
        <Button variant="secondary" onClick={refreshStats}>
          Refresh stats
        </Button>
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              // Probe BOTH backends. Use the CURRENT save's key (not the
              // legacy un-namespaced one) so we see what the live mod
              // state would actually load from.
              const key = getModState().stats().currentStorageKey;
              const apiKeys = await storage.keys().catch(() => [] as string[]);
              const apiRaw = await storage.get<unknown>(key, null).catch(() => null);
              const lsAvailable = typeof localStorage !== 'undefined';
              const lsKeys: string[] = [];
              let lsRaw: unknown = null;
              if (lsAvailable) {
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i);
                  if (k != null) lsKeys.push(k);
                }
                const lsStr = localStorage.getItem(key);
                if (lsStr != null) {
                  try {
                    lsRaw = JSON.parse(lsStr);
                  } catch {
                    lsRaw = '<unparseable>';
                  }
                }
              }
              const summary = (raw: unknown) => {
                if (raw == null) return 'null';
                if (typeof raw !== 'object' || raw === null) return String(raw);
                const o = raw as any;
                const dealsTotal = Array.isArray(o.deals) ? o.deals.length : 0;
                const dealsActive = Array.isArray(o.deals)
                  ? o.deals.filter((d: any) => d?.state === 'active').length
                  : 0;
                return `{ version: ${o.version}, savedAt: ${o.savedAt}, points: ${o.baselineDemand?.length ?? '?'}, pops: ${o.baselinePopSizes?.length ?? '?'}, deltas: ${o.cumulativeDeltas?.length ?? '?'}, deals: ${dealsTotal} (${dealsActive} active) }`;
              };
              setLast(
                `key: ${key}\n` +
                  `api.storage.keys: [${apiKeys.join(', ') || '<empty>'}]\n` +
                  `api.storage.get(${key}): ${summary(apiRaw)}\n` +
                  `localStorage available: ${lsAvailable}\n` +
                  `localStorage keys: [${lsKeys.join(', ') || '<empty>'}]\n` +
                  `localStorage[${key}]: ${summary(lsRaw)}`
              );
            } catch (e: any) {
              setLast(`storage check threw: ${e?.message ?? e}`);
            }
            refreshStats();
          }}
        >
          Check storage
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            try {
              const day = gameState.getCurrentDay();
              getModState().onDayTick(day);
              const reports = getModState().stats().lastTickReports;
              if (reports.length === 0) {
                setLast(`Tick fired (day ${day}). No active deals to apply.`);
              } else {
                const lines = reports.map(
                  (r) =>
                    `  ${r.dealId}: +${r.applied.residents.toFixed(1)}r / +${r.applied.jobs.toFixed(1)}j across ${r.pointsAffected} pt(s)${r.rejections > 0 ? ` · ${r.rejections} rejected` : ''}${r.marksCompletion ? ' · COMPLETED' : ''}`
                );
                setLast(`Tick fired (day ${day}):\n${lines.join('\n')}`);
              }
              onAfter();
              refreshStats();
            } catch (e: any) {
              setLast(`tick threw: ${e?.message ?? e}`);
            }
          }}
        >
          Tick now
        </Button>
      </div>

      {last && (
        <div style={{ color: 'rgba(255,255,255,0.7)', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
          {last}
        </div>
      )}

      <div style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', lineHeight: 1.5 }}>
        ready: {String(stats.initialized)} · day: {stats.lastDay ?? '—'} · ticks: {stats.dayTicks}
        <br />
        save: {stats.currentSaveName ?? '<unsaved>'} · key: {stats.currentStorageKey}
        <br />
        baselines: {stats.pointsTracked}p / {stats.popsTracked}pop · with deltas: {stats.pointsWithDeltas}
        <br />
        demandChange events: {stats.demandChangeEvents}
        <br />
        last persist: {stats.lastPersistOk == null ? '—' : stats.lastPersistOk ? 'ok' : 'FAIL'}
        {' · '}
        round-trip: {stats.storageRoundTripOk == null ? '—' : stats.storageRoundTripOk ? 'ok' : 'FAIL (data lost)'}
        {' · '}
        backend: {stats.storageBackend}
        <br />
        hydrate: {stats.lastHydrate == null
          ? '—'
          : stats.lastHydrate.fromStorage
          ? `from-storage · preserved ${stats.lastHydrate.preserved} · replayed ${stats.lastHydrate.replayed} · shifted ${stats.lastHydrate.baselineShift}`
          : 'fresh (no persisted state found — either first run, game reset mod storage, or storage backend broken)'}
        {stats.initProbe && (
          <>
            <br />
            init probe @ {new Date(stats.initProbe.at).toLocaleTimeString()} (save: {stats.initProbe.saveName ?? '<unsaved>'}):
            <br />
            &nbsp;&nbsp;api: {stats.initProbe.apiHasOurKey ? '✓' : '✗'} {stats.initProbe.apiOurKeyShape} · {stats.initProbe.apiKeysAtInit.length} keys
            <br />
            &nbsp;&nbsp;localStorage: {stats.initProbe.localStorageAvailable ? 'avail' : 'NA'} · {stats.initProbe.localStorageHasOurKey ? '✓' : '✗'} {stats.initProbe.localStorageOurKeyShape} · {stats.initProbe.localStorageKeysAtInit.length} keys
            {stats.initProbe.otherSaveKeys.length > 0 && (
              <>
                <br />
                &nbsp;&nbsp;other save slots present: {stats.initProbe.otherSaveKeys.join(', ')}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DealsSection — Stage 2 main feature.
// Pin a station → propose a housing/commercial/mixed deal targeting its
// walkshed. Active deals tick daily via mod-state; this section just lets
// the player propose, monitor, and (eventually) cancel them.
// ---------------------------------------------------------------------------

const DEAL_KINDS: DealKind[] = ['housing', 'commercial', 'mixed'];
const DEAL_TIERS: DealTier[] = ['S', 'M', 'L'];

const KIND_LABELS: Record<DealKind, string> = {
  housing: 'Housing',
  commercial: 'Commercial',
  mixed: 'Mixed-use',
};

const KIND_COLORS: Record<DealKind, string> = {
  housing: '#60a5fa',     // blue
  commercial: '#fb923c',   // orange
  mixed: '#a78bfa',        // purple
};

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function DealsSection({
  pinned,
  onAfter,
}: {
  pinned: ScoredStation | null;
  onAfter: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [tick, setTick] = useState(0); // bump to refresh deals list
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const state = getModState();
  const deals = state.getDeals();
  // recompute split groups whenever tick changes
  const _ = tick; void _;

  const active = useMemo(() => deals.filter((d) => d.state === 'active'), [deals, tick]);
  const completed = useMemo(() => deals.filter((d) => d.state === 'completed'), [deals, tick]);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          ▸ Deals ({active.length} active, {completed.length} done)
        </button>
      </div>
    );
  }

  return (
    <section
      style={{
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 4,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 12 }}>
          Deals — {active.length} active · {completed.length} done
        </strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          ▾
        </button>
      </div>

      <ProposeDeal pinned={pinned} onAfter={() => { refresh(); onAfter(); }} />

      {active.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>
            Active
          </div>
          {active.map((d) => (
            <DealCard key={d.id} deal={d} onCancel={() => { state.cancelDeal(d.id); refresh(); }} />
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>
            Completed
          </div>
          {completed.slice(-5).reverse().map((d) => (
            <DealCard key={d.id} deal={d} onCancel={null} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProposeDeal({
  pinned,
  onAfter,
}: {
  pinned: ScoredStation | null;
  onAfter: () => void;
}) {
  const [kind, setKind] = useState<DealKind>('housing');
  const [tier, setTier] = useState<DealTier>('S');
  // null = use the tier's default duration; number = explicit override.
  const [durationOverride, setDurationOverride] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const tierConfig = DEFAULT_TIER_TABLE[kind][tier];
  const effectiveDuration = durationOverride ?? tierConfig.duration;

  // Reset duration override when tier changes — otherwise the chosen
  // override sticks across S/M/L bumps and gets confusing.
  const onTierChange = useCallback((next: DealTier) => {
    setTier(next);
    setDurationOverride(null);
  }, []);

  // Live preview: validate against current demand whenever inputs change.
  const preview = useMemo(() => {
    if (!pinned) return null;
    const demand = gameState.getDemandData();
    if (!demand) return null;
    let budget = 0;
    try { budget = gameState.getBudget(); } catch { /* unimplemented in some builds */ }
    return validateProposal({
      kind,
      tier,
      centerLngLat: pinned.center,
      radiusMeters: HIGHLIGHT_RADIUS_M,
      walkshedPoints: demand.points.values(),
      budget,
      durationOverride: durationOverride ?? undefined,
    });
  }, [pinned, kind, tier, durationOverride]);

  const onConfirm = useCallback(async () => {
    if (!pinned) return;
    if (!preview || !preview.ok) {
      setLastResult(`Cannot propose: ${preview?.message ?? 'no preview'}`);
      return;
    }
    const state = getModState();
    const ok = await state.ensureInit();
    if (!ok) {
      setLastResult('Mod state not ready.');
      return;
    }
    const deal = confirmProposal({
      proposal: preview,
      startDay: gameState.getCurrentDay(),
      centerStationGroupId: pinned.id,
      centerLngLat: pinned.center,
      radiusMeters: HIGHLIGHT_RADIUS_M,
    });
    try {
      actions.subtractMoney(deal.totalCost, 'TOD Deal');
    } catch (e) {
      console.warn('[sb-tod] subtractMoney threw:', e);
    }
    state.addDeal(deal);
    setLastResult(`Confirmed ${deal.kind}/${deal.tier} on ${pinned.name} — ${fmtMoney(deal.totalCost)}, ${deal.durationDays} days. Will tick daily on onDayChange.`);
    onAfter();
  }, [pinned, preview, onAfter]);

  if (!pinned) {
    return (
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}>
        Pin a station above to propose a deal.
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 4,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 11,
      }}
    >
      <div style={{ color: 'rgba(255,255,255,0.7)' }}>
        Propose deal on <strong>{pinned.name}</strong>:
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {DEAL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            style={{
              flex: 1,
              padding: '4px 6px',
              background: kind === k ? KIND_COLORS[k] : 'rgba(255,255,255,0.05)',
              color: kind === k ? '#000' : 'rgba(255,255,255,0.7)',
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: kind === k ? 600 : 400,
            }}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {DEAL_TIERS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTierChange(t)}
            style={{
              flex: 1,
              padding: '4px 6px',
              background: tier === t ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.8)',
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: tier === t ? 600 : 400,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>days:</span>
        {DURATION_PRESETS.map((d) => {
          const selected = effectiveDuration === d;
          const isDefault = d === tierConfig.duration && durationOverride === null;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDurationOverride(d === tierConfig.duration ? null : d)}
              style={{
                padding: '2px 6px',
                background: selected ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
                color: 'rgba(255,255,255,0.7)',
                border: isDefault ? '1px solid rgba(255,255,255,0.3)' : 'none',
                borderRadius: 3,
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: selected ? 600 : 400,
              }}
              title={isDefault ? `default for ${tier}` : undefined}
            >
              {d}
            </button>
          );
        })}
      </div>

      <div style={{ color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', fontSize: 10, lineHeight: 1.5 }}>
        +{tierConfig.totalDensity.residents.toLocaleString()} res ·{' '}
        +{tierConfig.totalDensity.jobs.toLocaleString()} jobs · {fmtMoney(tierConfig.cost)} ·{' '}
        {effectiveDuration}d
        {durationOverride !== null && (
          <span style={{ color: 'rgba(255,255,255,0.4)' }}> (default {tierConfig.duration})</span>
        )}
        {preview && (
          preview.ok
            ? <><br />walkshed: {preview.eligiblePoints.length} points · {preview.eligiblePoints.filter((p) => p.residentsEligible).length} can take residents · {preview.eligiblePoints.filter((p) => p.jobsEligible).length} can take jobs</>
            : <><br /><span style={{ color: '#fca5a5' }}>blocked: {preview.message}</span></>
        )}
      </div>

      <button
        type="button"
        disabled={!preview || !preview.ok}
        onClick={onConfirm}
        style={{
          padding: '6px 10px',
          background: preview?.ok ? KIND_COLORS[kind] : 'rgba(255,255,255,0.1)',
          color: preview?.ok ? '#000' : 'rgba(255,255,255,0.4)',
          border: 'none',
          borderRadius: 3,
          cursor: preview?.ok ? 'pointer' : 'not-allowed',
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        Confirm — {fmtMoney(tierConfig.cost)}
      </button>

      {lastResult && (
        <div style={{ color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', fontSize: 10, whiteSpace: 'pre-wrap' }}>
          {lastResult}
        </div>
      )}
    </div>
  );
}

function DealCard({
  deal,
  onCancel,
}: {
  deal: Deal;
  onCancel: (() => void) | null;
}) {
  const currentDay = (() => {
    try { return gameState.getCurrentDay(); } catch { return deal.startDay; }
  })();
  const elapsed = Math.max(0, Math.min(deal.durationDays, currentDay - deal.startDay + 1));
  const fraction = elapsed / deal.durationDays;
  const target = deal.totalDensity;
  const applied = deal.appliedSoFar;
  const lastReport = getModState().stats().lastTickReports.find((r) => r.dealId === deal.id);

  return (
    <div
      style={{
        border: `1px solid ${KIND_COLORS[deal.kind]}40`,
        borderLeftWidth: 3,
        borderLeftColor: KIND_COLORS[deal.kind],
        borderRadius: 3,
        padding: 6,
        fontSize: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          <strong style={{ color: KIND_COLORS[deal.kind] }}>{KIND_LABELS[deal.kind]}/{deal.tier}</strong>
          {' · '}
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>{deal.centerStationGroupId.slice(0, 8)}</span>
        </span>
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>
          {deal.state === 'active'
            ? `day ${elapsed}/${deal.durationDays}`
            : deal.state}
        </span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, fraction * 100)}%`,
            background: KIND_COLORS[deal.kind],
          }}
        />
      </div>
      <div style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace' }}>
        {target.residents > 0 && (<>res {applied.residents.toFixed(0)}/{target.residents} </>)}
        {target.jobs > 0 && (<>jobs {applied.jobs.toFixed(0)}/{target.jobs} </>)}
        · {fmtMoney(deal.totalCost)}
      </div>
      {lastReport && (lastReport.applied.residents !== 0 || lastReport.applied.jobs !== 0 || lastReport.rejections > 0) && (
        <div style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', fontSize: 9 }}>
          last tick: +{lastReport.applied.residents.toFixed(1)}r / +{lastReport.applied.jobs.toFixed(1)}j across {lastReport.pointsAffected} pt{lastReport.pointsAffected === 1 ? '' : 's'}
          {lastReport.rejections > 0 && <span style={{ color: '#fca5a5' }}> · {lastReport.rejections} rejected</span>}
        </div>
      )}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          style={{
            alignSelf: 'flex-end',
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 10,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          cancel
        </button>
      )}
    </div>
  );
}
