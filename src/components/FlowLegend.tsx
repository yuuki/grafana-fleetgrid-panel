import React from 'react';
import { formattedValueToString } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import { FlowModel, MAX_FLOW_ARCS } from '../data/edges';
import { RangeLegend } from './RangeLegend';

/** An edge value formatted with the edge query's standard field config (unit, decimals, mappings). */
export function formatFlowValue(model: FlowModel, value: number | null): string {
  if (value === null) {
    return 'No data';
  }
  return model.metricInfo ? formattedValueToString(model.metricInfo.processor(value)) : String(value);
}

export interface FlowLegendSummary {
  /** How many edges are drawn, of how many, and by which filter. */
  text: string;
  /** Whether the draw bound left edges out. */
  bound: boolean;
  /** What was read and what was left out, for the legend's tooltip. */
  details: string[];
}

function countText(model: FlowModel): string {
  const { edges, stats, config } = model;
  if (stats.edgeCount === 0) {
    return 'no edges';
  }
  if (edges.length > MAX_FLOW_ARCS) {
    return `${MAX_FLOW_ARCS} of ${edges.length} edges drawn, worst first`;
  }
  if (config.threshold === undefined) {
    return `${edges.length} edges`;
  }
  const comparison = `${config.worst === 'high' ? '>' : '<'} ${formatFlowValue(model, config.threshold)}`;
  return `${edges.length} of ${stats.edgeCount} edges ${comparison}`;
}

export function flowLegendSummary(model: FlowModel): FlowLegendSummary {
  const { stats, config } = model;
  const details = [`Edge query ${config.refId}: ${stats.readRows} of ${stats.totalRows} rows read`];
  if (stats.selfEdges > 0) {
    details.push(
      `${stats.selfEdges} rows start and end at the same ${model.groupLevel ? 'group' : 'cell'} (not drawn)`
    );
  }
  if (stats.noValue > 0) {
    details.push(
      `${stats.noValue} edges have no value` + (config.threshold === undefined ? ' (dashed)' : ' (not drawn)')
    );
  }
  const excluded = stats.missingLabel + stats.unmatched + stats.ambiguous;
  if (excluded > 0) {
    details.push(`${excluded} rows left out (see the warning)`);
  }
  const text = countText(model) + (config.show === 'hover' ? ', shown on hover' : '');
  return { text, bound: model.edges.length > MAX_FLOW_ARCS, details };
}

const FlowLegendComponent: React.FC<{ model: FlowModel; width: number }> = ({ model, width }) => {
  const theme = useTheme2();
  const summary = flowLegendSummary(model);
  return (
    <div
      data-testid="flow-legend"
      title={summary.details.join('\n')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11 }}
    >
      <span style={{ color: theme.colors.text.secondary }}>Flows</span>
      {model.metricInfo && model.edges.some((edge) => edge.value !== null) && (
        <RangeLegend metricInfo={model.metricInfo} width={width} />
      )}
      <span
        data-testid="flow-legend-count"
        style={{ whiteSpace: 'nowrap', color: summary.bound ? theme.colors.warning.text : theme.colors.text.primary }}
      >
        {summary.text}
      </span>
    </div>
  );
};

// Memoized: the panel re-renders on every pointer move, the legend only when the flow model changes.
export const FlowLegend = React.memo(FlowLegendComponent);
