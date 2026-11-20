import React from 'react';
import { useTheme2 } from '@grafana/ui';
import { FlowModel, FlowNodeHop, FlowNodeSummary, MAX_FLOW_ARCS } from '../data/edges';
import { formatFlowValue } from './FlowLegend';

const HOP_LINES = 3;
/** Rows the section adds to the cell tooltip, for its placement estimate. */
export const FLOW_TOOLTIP_ROWS = 3 + HOP_LINES;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

function hopText(hop: FlowNodeHop): string {
  const number = hop.order === null ? '' : ` hop ${hop.order}`;
  return `${hop.path === '' ? 'Path' : hop.path}${number} ${hop.direction === 'out' ? 'out' : 'in'}`;
}

export interface FlowTooltipSectionProps {
  model: FlowModel;
  summary: FlowNodeSummary;
  missingColor: string;
}

/**
 * What the cell tooltip says about the hovered cell's edges: how many peers, and the worst one. When
 * the endpoints resolve to a group, the section names the group, because the numbers are the group's.
 */
export const FlowTooltipSection: React.FC<FlowTooltipSectionProps> = ({ model, summary, missingColor }) => {
  const theme = useTheme2();
  const { worst } = summary;
  const total = summary.outCount + summary.inCount;
  const display =
    worst.edge.value !== null && model.metricInfo ? model.metricInfo.processor(worst.edge.value) : undefined;
  const owner = model.groupLevel ? ` of ${model.levelLabel} ${summary.node.label}` : '';
  return (
    <div
      data-testid="flow-tooltip"
      style={{ marginTop: 4, paddingTop: 4, borderTop: `1px solid ${theme.colors.border.weak}` }}
    >
      <div style={{ overflowWrap: 'anywhere' }}>
        {`Flows${owner}: ${summary.outCount} out, ${summary.inCount} in, ${plural(summary.peerCount, 'peer')}`}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            flex: 'none',
            background: display?.color ?? missingColor,
            display: 'inline-block',
          }}
        />
        <span style={{ overflowWrap: 'anywhere' }}>
          {`Worst: ${worst.direction === 'out' ? 'to' : 'from'} ${worst.peer?.label ?? 'unknown'}`}
        </span>
        <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{formatFlowValue(model, worst.edge.value)}</span>
      </div>
      {total > MAX_FLOW_ARCS && (
        <div
          style={{ color: theme.colors.text.secondary }}
        >{`${MAX_FLOW_ARCS} of ${total} edges drawn, worst first`}</div>
      )}
      {summary.hops.slice(0, HOP_LINES).map((hop, index) => (
        <div key={index} style={{ color: theme.colors.text.secondary, overflowWrap: 'anywhere' }}>
          {hopText(hop)}
        </div>
      ))}
      {summary.hops.length > HOP_LINES && (
        <div style={{ color: theme.colors.text.secondary }}>{`+${summary.hops.length - HOP_LINES} more hops`}</div>
      )}
    </div>
  );
};
