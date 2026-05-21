/**
 * TOD dashboard panel.
 *
 * The scoring model lives under `src/scoring/`; this file is only the
 * in-game presentation layer: compact rankings, day-aware refresh, and
 * contextual map pins.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { actions, gameState, getMap, hooks, ui, utils } from '../api';
import {
  confirmProposal,
  DEFAULT_TIER_TABLE,
  DEAL_COST_MULTIPLIER,
  dealProgressFraction,
  validateProposal,
  type Deal,
  type DealKind,
  type ProposalResult,
  type DealTier,
} from '../sim/deals';
import {
  scoreAllStationsDetailed,
  type CalibrationInfo,
  type ScoredStation,
} from '../scoring';
import { haversineMeters } from '../scoring/walkshed';
import { getModState } from '../state/mod-state';
import { clearHighlight, setHighlight } from './mapHighlight';

const HIGHLIGHT_RADIUS_M = 500;
const MAP_CLICK_STATION_RADIUS_M = 200;
const TOP_N = 5;

const { Button } = utils.components as Record<string, React.ComponentType<any>>;

type SectionKind = 'residential' | 'commercial' | 'captured' | 'risk';

interface HighlightState {
  id: string;
  kind: SectionKind;
}

interface BuildAction {
  kind: DealKind;
  label: string;
}

interface Snapshot {
  stations: number;
  demandPoints: number;
  pops: number;
  currentDay: number;
  scored: ScoredStation[];
  calibration: CalibrationInfo;
}

interface SectionMeta {
  title: string;
  signal: string;
  color: string;
  softColor: string;
  empty: string;
}

const SECTION_META: Record<SectionKind, SectionMeta> = {
  residential: {
    title: 'Housing Growth',
    signal: 'Transit riders nearby, room for homes',
    color: '#38bdf8',
    softColor: 'rgba(56,189,248,0.16)',
    empty: 'No housing candidates yet.',
  },
  commercial: {
    title: 'Job Growth',
    signal: 'Transit arrivals nearby, room for jobs',
    color: '#34d399',
    softColor: 'rgba(52,211,153,0.16)',
    empty: 'No job-growth candidates yet.',
  },
  captured: {
    title: 'Captured Value',
    signal: 'Dense areas already working with transit',
    color: '#fbbf24',
    softColor: 'rgba(251,191,36,0.18)',
    empty: 'No captured-value stations yet.',
  },
  risk: {
    title: 'TOD Risk',
    signal: 'Dense areas with weak transit capture',
    color: '#fb7185',
    softColor: 'rgba(251,113,133,0.16)',
    empty: 'No risk candidates yet.',
  },
};

const BUILD_ACTIONS: Partial<Record<SectionKind, BuildAction>> = {
  residential: { kind: 'housing', label: 'Build homes' },
  commercial: { kind: 'commercial', label: 'Build jobs' },
  captured: { kind: 'mixed', label: 'Build mixed' },
  risk: { kind: 'mixed', label: 'Build mixed' },
};

const DEAL_KIND_OPTIONS: DealKind[] = ['housing', 'commercial', 'mixed'];
const DEAL_TIER_OPTIONS: DealTier[] = ['S', 'M', 'L'];

const FALLBACK_CALIBRATION: CalibrationInfo = {
  ridershipScale: 500,
  supplySaturation: 30_000,
  residentSaturation: 5_000,
  jobSaturation: 10_000,
  residentTransitScale: 200,
  workerTransitScale: 500,
  source: 'default',
};

const dayListeners = new Set<(day: number) => void>();
let dayHookRegistered = false;

function subscribeDayChange(listener: (day: number) => void): () => void {
  if (!dayHookRegistered) {
    dayHookRegistered = true;
    hooks.onDayChange((day) => {
      for (const cb of Array.from(dayListeners)) {
        cb(day);
      }
    });
  }
  dayListeners.add(listener);
  return () => {
    dayListeners.delete(listener);
  };
}

function readSnapshot(): Snapshot {
  try {
    const stations = gameState.getStations();
    const demand = gameState.getDemandData();
    const { scored, calibration } = scoreAllStationsDetailed();
    return {
      stations: stations?.length ?? 0,
      demandPoints: demand.points?.size ?? 0,
      pops: demand.popsMap?.size ?? 0,
      currentDay: safeCurrentDay(),
      scored,
      calibration,
    };
  } catch (err) {
    console.error('[sb-tod] readSnapshot failed:', err);
    return {
      stations: 0,
      demandPoints: 0,
      pops: 0,
      currentDay: 0,
      scored: [],
      calibration: FALLBACK_CALIBRATION,
    };
  }
}

function safeCurrentDay(): number {
  try {
    return gameState.getCurrentDay();
  } catch {
    return 0;
  }
}

export function TodPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot());
  const [highlighted, setHighlighted] = useState<HighlightState | null>(null);
  const [proposalKind, setProposalKind] = useState<DealKind>('housing');
  const [proposalTier, setProposalTier] = useState<DealTier>('S');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [dealVersion, setDealVersion] = useState(0);

  const selectedStation = useMemo(
    () => (highlighted ? snapshot.scored.find((row) => row.id === highlighted.id) ?? null : null),
    [highlighted, snapshot.scored]
  );

  const refresh = useCallback(() => {
    setSnapshot(readSnapshot());
    setDealVersion((v) => v + 1);
  }, []);

  const clearSelection = useCallback(() => {
    clearHighlight();
    setHighlighted(null);
  }, []);

  const selectStation = useCallback(
    (row: ScoredStation, kind: SectionKind, options: { easeCamera?: boolean } = {}) => {
      const meta = SECTION_META[kind];
      setHighlight(row.center, HIGHLIGHT_RADIUS_M, {
        color: meta.color,
        easeCamera: options.easeCamera,
      });
      setHighlighted({ id: row.id, kind });
    },
    []
  );

  const onRowClick = useCallback(
    (row: ScoredStation, kind: SectionKind) => {
      if (highlighted?.id === row.id && highlighted.kind === kind) {
        clearSelection();
        return;
      }
      const action = BUILD_ACTIONS[kind];
      if (action) setProposalKind(action.kind);
      selectStation(row, kind);
    },
    [clearSelection, highlighted, selectStation]
  );

  const onPrepareBuild = useCallback(
    (row: ScoredStation, sectionKind: SectionKind, action: BuildAction) => {
      setProposalKind(action.kind);
      selectStation(row, sectionKind);
    },
    [selectStation]
  );

  const onConfirmDeal = useCallback(
    async (row: ScoredStation, kind: DealKind, tier: DealTier) => {
      const demand = gameState.getDemandData();
      const state = getModState();
      const ready = await state.ensureInit(demand);
      const sectionKind = sectionKindForDeal(kind);
      selectStation(row, sectionKind);

      if (!ready) {
        ui.showNotification('TOD state is not ready yet. Try again after the next game day tick.', 'warning');
        return;
      }

      const proposal = validateProposal({
        kind,
        tier,
        centerLngLat: row.center,
        radiusMeters: HIGHLIGHT_RADIUS_M,
        walkshedPoints: demand.points.values(),
        budget: gameState.getBudget(),
        costMultiplier: DEAL_COST_MULTIPLIER,
      });
      if (!proposal.ok) {
        ui.showNotification(`Cannot build at ${displayName(row.name, row.id)}: ${proposal.message}`, 'warning');
        return;
      }

      const persistenceReady = await state.persist();
      if (!persistenceReady) {
        setDealVersion((v) => v + 1);
        ui.showNotification(
          'TOD persistence is not available. New development is disabled until storage can save and read back data.',
          'error'
        );
        return;
      }

      const deal = confirmProposal({
        proposal,
        startDay: safeCurrentDay(),
        centerStationGroupId: row.id,
        centerStationGroupName: row.name,
        centerLngLat: row.center,
        radiusMeters: HIGHLIGHT_RADIUS_M,
      });

      try {
        actions.subtractMoney(deal.totalCost, 'TOD Deal');
      } catch (err) {
        console.warn('[sb-tod] subtractMoney failed:', err);
        ui.showNotification('Could not charge the TOD deal cost. Deal was not started.', 'error');
        return;
      }

      const stored = await state.addDeal(deal);
      if (!stored) {
        try {
          actions.addMoney(deal.totalCost, 'TOD Deal refund');
        } catch (err) {
          console.warn('[sb-tod] refund after failed deal persist failed:', err);
        }
        setDealVersion((v) => v + 1);
        ui.showNotification(
          'TOD persistence failed after charging. The deal was not started and the cost was refunded.',
          'error'
        );
        return;
      }
      setSnapshot(readSnapshot());
      setDealVersion((v) => v + 1);
      ui.showNotification(
        `Started ${deal.kind}/${deal.tier} at ${displayName(row.name, row.id)}: ${dealSummary(deal)} over ${deal.durationDays} days.`,
        'success'
      );
    },
    [selectStation]
  );

  // ESC clears a selected pin before the game handles the key for panel chrome.
  useEffect(() => {
    if (!highlighted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      clearSelection();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clearSelection, highlighted]);

  // Station markers are DOM elements that call e.stopPropagation() in their
  // own click handler, so MapLibre's 'click' event never fires for them. A
  // capture-phase listener on the map container runs before the marker handles
  // the click, so we still catch station clicks and mirror the selection into
  // the dashboard. We unproject the click point to lng/lat and match the
  // nearest scored station.
  useEffect(() => {
    const m = getMap();
    if (!m || typeof m.getContainer !== 'function' || typeof m.unproject !== 'function') {
      return undefined;
    }
    const container = m.getContainer() as HTMLElement | null;
    if (!container) return undefined;
    const onContainerClick = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      let lngLat;
      try {
        lngLat = m.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      } catch {
        return;
      }
      const lng = lngLat?.lng;
      const lat = lngLat?.lat;
      if (typeof lng !== 'number' || typeof lat !== 'number') return;
      const nearest = nearestStation(snapshot.scored, [lng, lat], MAP_CLICK_STATION_RADIUS_M);
      if (!nearest) return;
      selectStation(nearest.row, sectionKindForDeal(proposalKind), { easeCamera: false });
    };
    container.addEventListener('click', onContainerClick, true);
    return () => container.removeEventListener('click', onContainerClick, true);
  }, [proposalKind, selectStation, snapshot.scored]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    return subscribeDayChange(() => {
      setSnapshot(readSnapshot());
      setDealVersion((v) => v + 1);
    });
  }, [autoRefresh]);

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
  const riskCandidates = useMemo(
    () => snapshot.scored.filter((s) => s.score.ridership > 0),
    [snapshot]
  );
  const topRisk = useMemo(
    () => [...riskCandidates].sort((a, b) => b.score.risk - a.score.risk).slice(0, TOP_N),
    [riskCandidates]
  );
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

  const riskExcluded = snapshot.scored.length - riskCandidates.length;
  const deals = useMemo(() => [...getModState().getDeals()], [snapshot, dealVersion]);
  const dealStats = useMemo(() => summarizeDeals(deals), [deals]);
  const stateStats = useMemo(() => getModState().stats(), [snapshot, dealVersion]);
  const persistenceBlocked = stateStats.storageRoundTripOk === false;
  const proposalPreview = useMemo(
    () => (selectedStation ? readProposalPreview(selectedStation, proposalKind, proposalTier) : null),
    [selectedStation, proposalKind, proposalTier, snapshot, dealVersion]
  );

  return (
    <div className="text-sm" style={panelStyle}>
      <header style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrowStyle}>Transit-Oriented Development</div>
          <h2 style={titleStyle}>TOD Dashboard</h2>
          <div style={statusLineStyle}>
            Day {snapshot.currentDay.toLocaleString()} · {autoRefresh ? 'auto-refresh on' : 'manual refresh'}
          </div>
        </div>
        <div style={headerActionsStyle}>
          <Button onClick={refresh}>Refresh</Button>
          {highlighted && (
            <Button
              variant="secondary"
              onClick={clearSelection}
            >
              Clear pin
            </Button>
          )}
        </div>
      </header>

      <div style={statGridStyle}>
        <Stat label="Station areas" value={snapshot.scored.length.toLocaleString()} />
        <Stat label="Platforms" value={snapshot.stations.toLocaleString()} />
        <Stat label="Riders / 15 min" value={Math.round(totalRiders).toLocaleString()} />
        <Stat label="Demand points" value={snapshot.demandPoints.toLocaleString()} />
        <Stat label="Pops" value={snapshot.pops.toLocaleString()} />
        <Stat label="Active deals" value={dealStats.active.toLocaleString()} />
      </div>

      <BuildSection
        station={selectedStation}
        proposalKind={proposalKind}
        proposalTier={proposalTier}
        proposalPreview={proposalPreview}
        persistenceBlocked={persistenceBlocked}
        onKindChange={setProposalKind}
        onTierChange={setProposalTier}
        onConfirm={() => {
          if (!selectedStation) return;
          void onConfirmDeal(selectedStation, proposalKind, proposalTier);
        }}
      />

      <StationSection
        kind="residential"
        rows={topResidential}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.access.residential,
          detail: `${fmt(row.access.residentTransit)} transit / ${fmt(row.totals.residents)} residents`,
        })}
      />

      <StationSection
        kind="commercial"
        rows={topCommercial}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.access.commercial,
          detail: `${fmt(row.access.workerTransit)} transit / ${fmt(row.totals.jobs)} jobs`,
        })}
      />

      <StationSection
        kind="captured"
        rows={topCaptured}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.score.capturedValue,
          detail: `${fmt(row.score.ridership)} riders / ${fmt(row.score.walkshedSupply)} nearby`,
        })}
      />

      <StationSection
        kind="risk"
        rows={topRisk}
        highlighted={highlighted}
        onRowClick={onRowClick}
        onBuild={onPrepareBuild}
        getMetric={(row) => ({
          score: row.score.risk,
          detail: `${fmt(row.score.ridership)} riders / ${fmt(row.score.walkshedSupply)} nearby`,
        })}
        footnote={
          riskExcluded > 0
            ? `${riskExcluded} station area${riskExcluded === 1 ? '' : 's'} hidden with no recorded ridership`
            : undefined
        }
      />

      <DealsSection
        deals={deals}
        currentDay={snapshot.currentDay}
        onLocate={(deal) => {
          setHighlight(deal.centerLngLat, deal.radiusMeters, { color: dealColor(deal.kind) });
          setProposalKind(deal.kind);
          setProposalTier(deal.tier);
          setHighlighted({ id: deal.centerStationGroupId, kind: sectionKindForDeal(deal.kind) });
        }}
        onCancel={(deal) => {
          if (!getModState().cancelDeal(deal.id)) return;
          setDealVersion((v) => v + 1);
          setSnapshot(readSnapshot());
        }}
      />

      <details style={diagnosticsStyle}>
        <summary style={summaryStyle}>Diagnostics</summary>
        <div style={diagnosticsBodyStyle}>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
            />
            Auto-refresh each day
          </label>
          <CalibrationSummary calibration={snapshot.calibration} />
          <StateSummary />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => downloadDebug(snapshot)}>
              Debug DL
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

function BuildSection({
  station,
  proposalKind,
  proposalTier,
  proposalPreview,
  persistenceBlocked,
  onKindChange,
  onTierChange,
  onConfirm,
}: {
  station: ScoredStation | null;
  proposalKind: DealKind;
  proposalTier: DealTier;
  proposalPreview: ProposalResult | null;
  persistenceBlocked: boolean;
  onKindChange: (kind: DealKind) => void;
  onTierChange: (tier: DealTier) => void;
  onConfirm: () => void;
}) {
  const color = dealColor(proposalKind);
  const tierConfig = DEFAULT_TIER_TABLE[proposalKind][proposalTier];
  const previewOk = proposalPreview?.ok === true;
  const previewText =
    persistenceBlocked
      ? 'Persistence unavailable; new deals are disabled.'
      : proposalPreview == null
      ? `${fmtMoney(Math.round(tierConfig.cost * DEAL_COST_MULTIPLIER))} · ${densitySummary(tierConfig.totalDensity)} · ${tierConfig.duration} days`
      : proposalPreview.ok
        ? `${fmtMoney(proposalPreview.totalCost)} · ${densitySummary(proposalPreview.totalDensity)} · ${proposalPreview.durationDays} days · ${proposalPreview.eligiblePoints.length} points`
        : proposalPreview.message;
  const buildDisabled = !station || !previewOk || persistenceBlocked;

  return (
    <section style={{ ...buildPanelStyle, borderColor: `${color}55` }}>
      <div style={sectionHeaderStyle}>
        <span style={{ ...sectionStripeStyle, backgroundColor: color }} />
        <div style={{ minWidth: 0 }}>
          <h3 style={sectionTitleStyle}>New Development</h3>
          <p style={sectionSignalStyle}>
            {station ? displayName(station.name, station.id) : 'No station selected'}
          </p>
        </div>
      </div>

      <div style={builderControlsStyle}>
        <SegmentedControl
          options={DEAL_KIND_OPTIONS}
          value={proposalKind}
          color={color}
          getLabel={dealKindLabel}
          onChange={onKindChange}
        />
        <SegmentedControl
          options={DEAL_TIER_OPTIONS}
          value={proposalTier}
          color={color}
          getLabel={(tier) => tier}
          onChange={onTierChange}
        />
      </div>

      <div style={builderFooterStyle}>
        <span style={{ ...proposalStatusStyle, color: persistenceBlocked || (proposalPreview && !previewOk) ? SECTION_META.risk.color : MUTED_COLOR }}>
          {previewText}
        </span>
        <button
          type="button"
          disabled={buildDisabled}
          style={{
            ...confirmButtonStyle,
            borderColor: color,
            color: buildDisabled ? FAINT_COLOR : color,
            cursor: buildDisabled ? 'not-allowed' : 'pointer',
            opacity: buildDisabled ? 0.62 : 1,
          }}
          onClick={onConfirm}
        >
          Build
        </button>
      </div>
    </section>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  color,
  getLabel,
  onChange,
}: {
  options: T[];
  value: T;
  color: string;
  getLabel: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div style={segmentedStyle}>
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            style={{
              ...segmentButtonStyle,
              borderColor: active ? color : 'transparent',
              backgroundColor: active ? `${color}24` : 'transparent',
              color: active ? TEXT_COLOR : MUTED_COLOR,
            }}
            onClick={() => onChange(option)}
          >
            {getLabel(option)}
          </button>
        );
      })}
    </div>
  );
}

function DealsSection({
  deals,
  currentDay,
  onLocate,
  onCancel,
}: {
  deals: Deal[];
  currentDay: number;
  onLocate: (deal: Deal) => void;
  onCancel: (deal: Deal) => void;
}) {
  const active = deals.filter((deal) => deal.state === 'active');
  const completed = deals.filter((deal) => deal.state === 'completed');
  const cancelled = deals.filter((deal) => deal.state === 'cancelled');
  const visible = [...active, ...completed].slice(0, 4);

  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <span style={{ ...sectionStripeStyle, backgroundColor: '#a78bfa' }} />
        <div style={{ minWidth: 0 }}>
          <h3 style={sectionTitleStyle}>Deals</h3>
          <p style={sectionSignalStyle}>
            {active.length} active · {completed.length} complete · {cancelled.length} cancelled
          </p>
        </div>
      </div>

      {visible.length === 0 ? (
        <p style={emptyStyle}>New development deals will appear here.</p>
      ) : (
        <div style={listStyle}>
          {visible.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              currentDay={currentDay}
              onLocate={onLocate}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DealRow({
  deal,
  currentDay,
  onLocate,
  onCancel,
}: {
  deal: Deal;
  currentDay: number;
  onLocate: (deal: Deal) => void;
  onCancel: (deal: Deal) => void;
}) {
  const color = dealColor(deal.kind);
  const progress = deal.state === 'active' ? dealProgressFraction(deal, currentDay) : 1;
  const delivered = dealDeliveryFraction(deal);
  const fraction = clamp01(Math.max(progress, delivered));

  return (
    <div style={{ ...rowButtonStyle, cursor: 'default', borderColor: `${color}66` }}>
      <div style={rowTopStyle}>
        <span style={stationNameStyle}>
          {dealKindLabel(deal.kind)}/{deal.tier}
          <span style={transferBadgeStyle}>
            {deal.state === 'active' ? `day ${Math.max(1, currentDay - deal.startDay + 1)}/${deal.durationDays}` : deal.state}
          </span>
        </span>
        <span style={rowActionStyle}>
          <button
            type="button"
            style={{ ...buildButtonStyle, borderColor: color, color }}
            onClick={() => onLocate(deal)}
          >
            Locate
          </button>
          {deal.state === 'active' && (
            <>
              <button
                type="button"
                style={{ ...buildButtonStyle, borderColor: FAINT_COLOR, color: MUTED_COLOR }}
                onClick={() => onCancel(deal)}
              >
                Cancel
              </button>
            </>
          )}
        </span>
      </div>
      <div style={rowBottomStyle}>
        <ScoreBar score={fraction} color={color} />
        <span style={detailStyle}>
          {displayName(deal.centerStationGroupName, deal.centerStationGroupId)} · {dealSummary(deal)} · {fmtMoney(deal.totalCost)}
        </span>
      </div>
    </div>
  );
}

function StationSection({
  kind,
  rows,
  highlighted,
  onRowClick,
  onBuild,
  getMetric,
  footnote,
}: {
  kind: SectionKind;
  rows: ScoredStation[];
  highlighted: HighlightState | null;
  onRowClick: (row: ScoredStation, kind: SectionKind) => void;
  onBuild: (row: ScoredStation, sectionKind: SectionKind, action: BuildAction) => void;
  getMetric: (row: ScoredStation) => { score: number; detail: string };
  footnote?: string;
}) {
  const meta = SECTION_META[kind];
  const buildAction = BUILD_ACTIONS[kind];
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <span style={{ ...sectionStripeStyle, backgroundColor: meta.color }} />
        <div style={{ minWidth: 0 }}>
          <h3 style={sectionTitleStyle}>{meta.title}</h3>
          <p style={sectionSignalStyle}>{meta.signal}</p>
        </div>
      </div>

      <div style={listStyle}>
        {rows.length === 0 ? (
          <p style={emptyStyle}>{meta.empty}</p>
        ) : (
          rows.map((row) => {
            const metric = getMetric(row);
            return (
              <ScoreRow
                key={`${kind}-${row.id}`}
                row={row}
                kind={kind}
                metric={metric}
                buildAction={buildAction}
                isHighlighted={highlighted?.id === row.id && highlighted.kind === kind}
                onClick={onRowClick}
                onBuild={onBuild}
              />
            );
          })
        )}
      </div>

      {footnote && <p style={footnoteStyle}>{footnote}</p>}
    </section>
  );
}

function ScoreRow({
  row,
  kind,
  metric,
  buildAction,
  isHighlighted,
  onClick,
  onBuild,
}: {
  row: ScoredStation;
  kind: SectionKind;
  metric: { score: number; detail: string };
  buildAction?: BuildAction;
  isHighlighted: boolean;
  onClick: (row: ScoredStation, kind: SectionKind) => void;
  onBuild: (row: ScoredStation, sectionKind: SectionKind, action: BuildAction) => void;
}) {
  const meta = SECTION_META[kind];
  const score = clamp01(metric.score);
  const backgroundColor = isHighlighted ? meta.softColor : 'rgba(255,255,255,0.025)';
  const borderColor = isHighlighted ? meta.color : 'rgba(255,255,255,0.07)';

  return (
    <div
      role="button"
      tabIndex={0}
      style={{
        ...rowButtonStyle,
        backgroundColor,
        borderColor,
        boxShadow: isHighlighted ? `inset 2px 0 0 0 ${meta.color}` : undefined,
      }}
      title={`${row.name}\n${row.memberCount} platform${row.memberCount === 1 ? '' : 's'}\n${HIGHLIGHT_RADIUS_M}m walkshed`}
      onClick={() => onClick(row, kind)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClick(row, kind);
      }}
      onMouseEnter={(e) => {
        if (!isHighlighted) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(255,255,255,0.05)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isHighlighted) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(255,255,255,0.025)';
        }
      }}
    >
      <div style={rowTopStyle}>
        <span style={stationNameStyle}>
          {displayName(row.name, row.id)}
          {row.memberCount > 1 && (
            <span style={transferBadgeStyle}>x{row.memberCount}</span>
          )}
        </span>
        <span style={rowActionStyle}>
          {buildAction ? (
            <button
              type="button"
              style={{ ...buildButtonStyle, borderColor: meta.color, color: meta.color }}
              onClick={(e) => {
                e.stopPropagation();
                onBuild(row, kind, buildAction);
              }}
            >
              {buildAction.label}
            </button>
          ) : (
            <span style={noBuildStyle}>Fix service first</span>
          )}
          <span style={{ ...scorePillStyle, color: meta.color }}>
            {score.toFixed(2)}
          </span>
        </span>
      </div>
      <div style={rowBottomStyle}>
        <ScoreBar score={score} color={meta.color} />
        <span style={detailStyle}>{metric.detail}</span>
      </div>
    </div>
  );
}

function ScoreBar({ score, color }: { score: number; color: string }) {
  const pct = `${Math.round(clamp01(score) * 100)}%`;
  return (
    <span style={barTrackStyle}>
      <span style={{ ...barFillStyle, width: pct, backgroundColor: color }} />
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <span style={statLabelStyle}>{label}</span>
      <span style={statValueStyle}>{value}</span>
    </div>
  );
}

function CalibrationSummary({ calibration }: { calibration: CalibrationInfo }) {
  return (
    <div style={calibrationGridStyle}>
      <DiagnosticRow
        label="Housing scale"
        value={`${fmt(calibration.residentTransitScale)} transit / ${fmt(calibration.residentSaturation)} residents`}
      />
      <DiagnosticRow
        label="Jobs scale"
        value={`${fmt(calibration.workerTransitScale)} transit / ${fmt(calibration.jobSaturation)} jobs`}
      />
      <DiagnosticRow
        label="Risk scale"
        value={`${fmt(calibration.ridershipScale)} riders / ${fmt(calibration.supplySaturation)} supply`}
      />
      <DiagnosticRow label="Calibration" value={calibration.source} />
    </div>
  );
}

function StateSummary() {
  let stats;
  try {
    stats = getModState().stats();
  } catch {
    stats = null;
  }
  if (!stats) return null;
  const hydrate = stats.lastHydrate?.fromStorage
    ? `stored · kept ${stats.lastHydrate.preserved} · replayed ${stats.lastHydrate.replayed} · shifted ${stats.lastHydrate.baselineShift}`
    : 'fresh';

  return (
    <div style={calibrationGridStyle}>
      <DiagnosticRow label="Save slot" value={stats.currentSaveName ?? '_unsaved'} />
      <DiagnosticRow
        label="Tracked"
        value={`${stats.pointsTracked.toLocaleString()} points / ${stats.popsTracked.toLocaleString()} pops`}
      />
      <DiagnosticRow
        label="Deltas"
        value={`${stats.pointsWithDeltas.toLocaleString()} points · ${stats.storageBackend}`}
      />
      <DiagnosticRow label="Hydrate" value={hydrate} />
      <DiagnosticRow
        label="Persist"
        value={stats.lastPersistOk == null ? 'not yet' : stats.lastPersistOk ? 'ok' : 'failed'}
      />
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={diagnosticRowStyle}>
      <span style={diagnosticLabelStyle}>{label}</span>
      <span style={diagnosticValueStyle}>{value}</span>
    </div>
  );
}

function readProposalPreview(
  row: ScoredStation,
  kind: DealKind,
  tier: DealTier
): ProposalResult | null {
  try {
    const demand = gameState.getDemandData();
    return validateProposal({
      kind,
      tier,
      centerLngLat: row.center,
      radiusMeters: HIGHLIGHT_RADIUS_M,
      walkshedPoints: demand.points.values(),
      budget: gameState.getBudget(),
      costMultiplier: DEAL_COST_MULTIPLIER,
    });
  } catch {
    return null;
  }
}

function nearestStation(
  rows: ScoredStation[],
  click: [number, number],
  maxMeters: number
): { row: ScoredStation; distanceMeters: number } | null {
  let best: { row: ScoredStation; distanceMeters: number } | null = null;
  for (const row of rows) {
    const distanceMeters = haversineMeters(click, [row.center[0], row.center[1]]);
    if (distanceMeters > maxMeters) continue;
    if (!best || distanceMeters < best.distanceMeters) {
      best = { row, distanceMeters };
    }
  }
  return best;
}

function summarizeDeals(deals: Deal[]): { active: number; completed: number; cancelled: number } {
  let active = 0;
  let completed = 0;
  let cancelled = 0;
  for (const deal of deals) {
    if (deal.state === 'active') active++;
    else if (deal.state === 'completed') completed++;
    else if (deal.state === 'cancelled') cancelled++;
  }
  return { active, completed, cancelled };
}

function sectionKindForDeal(kind: DealKind): SectionKind {
  if (kind === 'housing') return 'residential';
  if (kind === 'commercial') return 'commercial';
  return 'captured';
}

function dealColor(kind: DealKind): string {
  return SECTION_META[sectionKindForDeal(kind)].color;
}

function dealKindLabel(kind: DealKind): string {
  if (kind === 'housing') return 'Housing';
  if (kind === 'commercial') return 'Jobs';
  return 'Mixed';
}

function dealSummary(deal: Deal): string {
  return densitySummary(deal.totalDensity);
}

function densitySummary(totalDensity: { residents: number; jobs: number }): string {
  const parts: string[] = [];
  if (totalDensity.residents > 0) {
    parts.push(`+${fmt(totalDensity.residents)} residents`);
  }
  if (totalDensity.jobs > 0) {
    parts.push(`+${fmt(totalDensity.jobs)} jobs`);
  }
  return parts.join(' / ') || '+0';
}

function dealDeliveryFraction(deal: Deal): number {
  const parts: number[] = [];
  if (deal.totalDensity.residents > 0) {
    parts.push(deal.appliedSoFar.residents / deal.totalDensity.residents);
  }
  if (deal.totalDensity.jobs > 0) {
    parts.push(deal.appliedSoFar.jobs / deal.totalDensity.jobs);
  }
  if (parts.length === 0) return 0;
  return parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

function displayName(name: string | undefined, id: string): string {
  if (!name || name === id) return `#${id.slice(0, 6)}`;
  if (name.length >= 32 && name.includes('-')) return `#${id.slice(0, 6)}`;
  if (name.length > 20) return name.slice(0, 19) + '...';
  return name;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return Math.round(n).toLocaleString();
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${Math.round(n / 100_000_000) / 10}b`;
  if (n >= 1_000_000) return `$${Math.round(n / 100_000) / 10}m`;
  if (n >= 1000) return `$${Math.round(n / 100) / 10}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

const TEXT_COLOR = 'rgba(255,255,255,0.92)';
const MUTED_COLOR = 'rgba(255,255,255,0.58)';
const FAINT_COLOR = 'rgba(255,255,255,0.38)';

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 14,
  maxHeight: '100%',
  overflowY: 'auto',
  boxSizing: 'border-box',
  color: TEXT_COLOR,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  paddingBottom: 4,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
};

const headerActionsStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  flex: '0 0 auto',
};

const eyebrowStyle: React.CSSProperties = {
  color: FAINT_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
  letterSpacing: 0,
};

const titleStyle: React.CSSProperties = {
  margin: '2px 0 2px',
  fontSize: 18,
  lineHeight: 1.15,
  fontWeight: 700,
  color: TEXT_COLOR,
  letterSpacing: 0,
};

const statusLineStyle: React.CSSProperties = {
  color: MUTED_COLOR,
  fontSize: 11,
  lineHeight: 1.35,
};

const statGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
};

const statStyle: React.CSSProperties = {
  minWidth: 0,
  padding: '7px 8px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.07)',
  backgroundColor: 'rgba(255,255,255,0.03)',
};

const statLabelStyle: React.CSSProperties = {
  display: 'block',
  color: MUTED_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
};

const statValueStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 2,
  color: TEXT_COLOR,
  fontSize: 14,
  lineHeight: 1.2,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  paddingTop: 2,
};

const buildPanelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 9,
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.08)',
  backgroundColor: 'rgba(255,255,255,0.035)',
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const sectionStripeStyle: React.CSSProperties = {
  width: 4,
  height: 28,
  borderRadius: 4,
  flex: '0 0 auto',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.2,
  color: TEXT_COLOR,
  fontWeight: 700,
  letterSpacing: 0,
};

const sectionSignalStyle: React.CSSProperties = {
  margin: '2px 0 0',
  fontSize: 10,
  lineHeight: 1.25,
  color: MUTED_COLOR,
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};

const builderControlsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 112px',
  gap: 6,
  minWidth: 0,
};

const builderFooterStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minWidth: 0,
};

const proposalStatusStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 10,
  lineHeight: 1.25,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const segmentedStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 3,
  minWidth: 0,
  padding: 2,
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.07)',
  backgroundColor: 'rgba(0,0,0,0.18)',
};

const segmentButtonStyle: React.CSSProperties = {
  appearance: 'none',
  minWidth: 0,
  border: '1px solid transparent',
  borderRadius: 4,
  padding: '4px 5px',
  cursor: 'pointer',
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const confirmButtonStyle: React.CSSProperties = {
  appearance: 'none',
  flex: '0 0 auto',
  minWidth: 58,
  border: '1px solid currentColor',
  borderRadius: 5,
  backgroundColor: 'rgba(0,0,0,0.2)',
  padding: '5px 8px',
  fontSize: 11,
  lineHeight: 1.2,
  fontWeight: 800,
  whiteSpace: 'nowrap',
};

const rowButtonStyle: React.CSSProperties = {
  minHeight: 48,
  padding: '7px 8px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.07)',
  cursor: 'pointer',
  outline: 'none',
};

const rowTopStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const stationNameStyle: React.CSSProperties = {
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  lineHeight: 1.25,
  color: TEXT_COLOR,
};

const transferBadgeStyle: React.CSSProperties = {
  marginLeft: 6,
  color: FAINT_COLOR,
  fontSize: 10,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const scorePillStyle: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: 12,
  lineHeight: 1.2,
  fontWeight: 700,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const rowActionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 7,
  flex: '0 0 auto',
};

const buildButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid currentColor',
  borderRadius: 5,
  backgroundColor: 'rgba(0,0,0,0.18)',
  padding: '3px 6px',
  color: TEXT_COLOR,
  cursor: 'pointer',
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const noBuildStyle: React.CSSProperties = {
  color: FAINT_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const rowBottomStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 7,
};

const barTrackStyle: React.CSSProperties = {
  position: 'relative',
  display: 'block',
  flex: '1 1 auto',
  height: 5,
  minWidth: 74,
  overflow: 'hidden',
  borderRadius: 4,
  backgroundColor: 'rgba(255,255,255,0.11)',
};

const barFillStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: 4,
};

const detailStyle: React.CSSProperties = {
  flex: '0 0 auto',
  maxWidth: 170,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: MUTED_COLOR,
  fontSize: 10,
  lineHeight: 1.2,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  color: MUTED_COLOR,
  fontSize: 11,
};

const footnoteStyle: React.CSSProperties = {
  margin: '-2px 0 0',
  color: FAINT_COLOR,
  fontSize: 10,
  lineHeight: 1.35,
};

const diagnosticsStyle: React.CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.08)',
  paddingTop: 8,
};

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: MUTED_COLOR,
  fontSize: 11,
  lineHeight: 1.4,
};

const diagnosticsBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 8,
};

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: MUTED_COLOR,
  fontSize: 11,
};

const calibrationGridStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '7px 8px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.07)',
  backgroundColor: 'rgba(255,255,255,0.025)',
};

const diagnosticRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 10,
  color: MUTED_COLOR,
  fontSize: 10,
  lineHeight: 1.35,
};

const diagnosticLabelStyle: React.CSSProperties = {
  flex: '0 0 auto',
  color: FAINT_COLOR,
};

const diagnosticValueStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: MUTED_COLOR,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

function downloadDebug(snapshot: Snapshot) {
  const dump = (s: ScoredStation) => ({
    id: s.id,
    name: s.name,
    memberCount: s.memberCount,
    center: s.center,
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
  const state = getModState();
  const payload = {
    timestamp: new Date().toISOString(),
    bundleVersion: 'panel-v14-storage-fallback',
    counts: {
      stations: snapshot.stations,
      demandPoints: snapshot.demandPoints,
      pops: snapshot.pops,
      scoredLength: snapshot.scored.length,
      currentDay: snapshot.currentDay,
      riskExcludedZeroRidership: snapshot.scored.length - riskCandidates.length,
    },
    calibration: snapshot.calibration,
    topResidential,
    topCommercial,
    topCaptured,
    topRisk,
    modState: state.stats(),
    deals: state.getDeals(),
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
