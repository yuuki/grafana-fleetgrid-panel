import React from 'react';
import { formattedValueToString } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import { MetricInfo } from '../data/display';
import { FlowModel, flowRestShare } from '../data/edges';
import { formatRangeEndpoint, rangeStateLabel } from './RangeLegend';

const GRADIENT_SAMPLES = 33;

/** An edge value formatted with the edge query's standard field config (unit, decimals, mappings). */
export function formatFlowValue(model: FlowModel, value: number | null): string {
  if (value === null) {
    return 'No data';
  }
  return model.metricInfo ? formattedValueToString(model.metricInfo.processor(value)) : String(value);
}

export const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export interface FlowLegendSummary {
  /** How many edges are drawn, of how many, and by which filter. */
  text: string;
  /**
   * What is not drawn, in words. They are part of the legend's visible text, not of a tooltip, because
   * they say that the picture is incomplete, and the header wraps at any panel width.
   */
  notes: string[];
  /** Whether a bound left edges out of the resting picture. */
  bound: boolean;
  /** What was read and what was left out, for the legend's tooltip. */
  details: string[];
}

function countText(model: FlowModel, drawn: number): string {
  const { edges, stats, config } = model;
  if (stats.edgeCount === 0) {
    return 'no edges';
  }
  if (config.show === 'always' && drawn < edges.length) {
    return `${drawn} of ${edges.length} edges drawn, worst first`;
  }
  if (config.threshold === undefined) {
    return pluralize(edges.length, 'edge');
  }
  const comparison = `${config.worst === 'high' ? '>' : '<'} ${formatFlowValue(model, config.threshold)}`;
  return `${edges.length} of ${stats.edgeCount} edges ${comparison}`;
}

// What the legend says about the edges without a value. With a filter none of them is drawn, because
// they cannot be compared; without one they are dashed, and the draw bound can leave some out.
function noValueNote(model: FlowModel, drawnUnknown: number): string | null {
  const { stats, config } = model;
  if (stats.noValue === 0) {
    return null;
  }
  if (config.threshold !== undefined) {
    return `${pluralize(stats.noValue, 'edge')} without a value not drawn`;
  }
  const unknown = model.edges.length - model.valuedCount;
  return config.show === 'always' && drawnUnknown < unknown
    ? `${drawnUnknown} of ${unknown} edges without a value drawn`
    : null;
}

export function flowLegendSummary(model: FlowModel): FlowLegendSummary {
  const { stats, config } = model;
  const share = flowRestShare(model);
  const drawn = share.valued + share.unknown;
  const bound = config.show === 'always' && drawn < model.edges.length;
  const notes: string[] = [];
  // More rows than the row bound: the least bad ones are not used at all.
  if (stats.readRows < stats.totalRows) {
    notes.push(`worst ${stats.readRows} of ${stats.totalRows} rows used`);
  }
  const unknownNote = noValueNote(model, share.unknown);
  if (unknownNote) {
    notes.push(unknownNote);
  }
  const details = [`Edge query ${config.refId}: ${stats.readRows} of ${stats.totalRows} rows used`];
  if (stats.selfEdges > 0) {
    details.push(
      `${stats.selfEdges} rows start and end at the same ${model.groupLevel ? 'group' : 'cell'} (not drawn)`
    );
  }
  if (stats.noValue > 0 && !unknownNote) {
    details.push(`${pluralize(stats.noValue, 'edge')} without a value (dashed)`);
  }
  const excluded = stats.missingLabel + stats.unmatched + stats.ambiguous;
  if (excluded > 0) {
    details.push(`${excluded} rows left out (see the warning)`);
  }
  const text = countText(model, drawn) + (config.show === 'hover' ? ', shown on hover' : '');
  return { text, notes, bound, details };
}

const buildGradient = (info: MetricInfo): string => {
  const colors = Array.from({ length: GRADIENT_SAMPLES }, (_, index) => {
    const ratio = index / (GRADIENT_SAMPLES - 1);
    const value = info.effectiveMin + (info.effectiveMax - info.effectiveMin) * ratio;
    return `${info.processor(value).color ?? 'transparent'} ${ratio * 100}%`;
  });
  return `linear-gradient(to right, ${colors.join(', ')})`;
};

// The color scale of the arcs: the edge query's name, its range and the colors between its ends. It is
// the legend's own element (not the cells' RangeLegend), so that the header has one of each.
const FlowScale: React.FC<{ info: MetricInfo }> = ({ info }) => {
  const theme = useTheme2();
  const min = formatRangeEndpoint(info, info.effectiveMin);
  const max = formatRangeEndpoint(info, info.effectiveMax);
  const state = rangeStateLabel(info);
  return (
    <span
      data-testid="flow-legend-scale"
      aria-label={`${info.name} flow color scale, ${state}, ${min} to ${max}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 6px',
        border: `1px solid ${theme.colors.border.medium}`,
        borderRadius: 3,
        color: theme.colors.text.primary,
        background: theme.colors.background.secondary,
        whiteSpace: 'nowrap',
      }}
    >
      <span>{info.name}</span>
      <span style={{ color: theme.colors.text.secondary }}>{state}</span>
      <span>{min}</span>
      <span
        data-testid="flow-legend-gradient"
        aria-hidden
        style={{
          width: 80,
          height: 8,
          border: `1px solid ${theme.colors.border.medium}`,
          borderRadius: 2,
          background: buildGradient(info),
        }}
      />
      <span>{max}</span>
    </span>
  );
};

const FlowLegendComponent: React.FC<{ model: FlowModel | null }> = ({ model }) => {
  const theme = useTheme2();
  // No legend while the overlay is off.
  if (!model) {
    return null;
  }
  const summary = flowLegendSummary(model);
  return (
    <div
      data-testid="flow-legend"
      title={summary.details.join('\n')}
      // The parts wrap, and long parts break: every word of the legend stays readable in a narrow panel.
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px', minWidth: 0, fontSize: 11 }}
    >
      <span style={{ color: theme.colors.text.secondary }}>Flows</span>
      {model.metricInfo && model.valuedCount > 0 && <FlowScale info={model.metricInfo} />}
      <span
        data-testid="flow-legend-count"
        style={{
          overflowWrap: 'anywhere',
          color: summary.bound ? theme.colors.warning.text : theme.colors.text.primary,
        }}
      >
        {summary.text}
      </span>
      {summary.notes.map((note) => (
        <span
          key={note}
          data-testid="flow-legend-note"
          style={{ overflowWrap: 'anywhere', color: theme.colors.warning.text }}
        >
          {note}
        </span>
      ))}
    </div>
  );
};

// Memoized: the panel re-renders on every pointer move, the legend only when the flow model changes.
export const FlowLegend = React.memo(FlowLegendComponent);
