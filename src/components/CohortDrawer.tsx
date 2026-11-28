import React, { useMemo } from 'react';
import { formattedValueToString } from '@grafana/data';
import { Drawer, useTheme2 } from '@grafana/ui';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';
import { CohortSummary, compareCohorts } from '../selection/cohort';

export interface CohortDrawerProps {
  selected: CellModel[];
  rest: CellModel[];
  /** Selected cells that are not in the current data. */
  missingCount: number;
  /** Every query of the panel, in query order, including one that returned no series. */
  refIds: string[];
  metricInfos: MetricInfo[];
  onClose: () => void;
}

const NONE = '–';

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** δ with its sign and two decimals; a value that rounds to zero carries no sign. */
export function formatDelta(delta: number | undefined): string {
  if (delta === undefined) {
    return NONE;
  }
  const text = Math.abs(delta).toFixed(2);
  return Number(text) === 0 ? text : `${delta > 0 ? '+' : '−'}${text}`;
}

/**
 * The cohort comparison: for every query, the selected cells against all other cells of the grid.
 * It is computed here, when the drawer is open and its inputs change, so no pointer event pays for it.
 */
export const CohortDrawer: React.FC<CohortDrawerProps> = ({
  selected,
  rest,
  missingCount,
  refIds,
  metricInfos,
  onClose,
}) => {
  const theme = useTheme2();
  const comparisons = useMemo(() => compareCohorts(selected, rest, refIds), [selected, rest, refIds]);
  const infoByRef = new Map(metricInfos.map((info) => [info.refId, info]));
  const cell: React.CSSProperties = { padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' };
  const head: React.CSSProperties = { ...cell, fontWeight: theme.typography.fontWeightMedium };
  const rule = `1px solid ${theme.colors.border.weak}`;

  const summaryCells = (refId: string, summary: CohortSummary) => {
    const format = (value: number | undefined) => {
      const info = infoByRef.get(refId);
      if (value === undefined) {
        return NONE;
      }
      return info ? formattedValueToString(info.processor(value)) : String(value);
    };
    return (
      <>
        <td style={cell}>{summary.count}</td>
        <td style={cell}>{summary.missing}</td>
        <td style={cell}>{format(summary.min)}</td>
        <td style={cell}>{format(summary.median)}</td>
        <td style={cell}>{format(summary.p95)}</td>
        <td style={cell}>{format(summary.max)}</td>
      </>
    );
  };

  return (
    <Drawer
      title="Cohort comparison"
      subtitle={`${plural(selected.length, 'selected cell')} against ${plural(rest.length, 'other cell')}`}
      size="md"
      onClose={onClose}
    >
      <div data-testid="cohort-comparison" style={{ fontSize: theme.typography.bodySmall.fontSize }}>
        {missingCount > 0 && (
          <p>{`${plural(missingCount, 'selected cell')} not in the current data: counted on neither side.`}</p>
        )}
        {rest.length === 0 && <p>Every cell is selected, so there is nothing to compare the selection with.</p>}
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ borderBottom: rule }}>
              <th scope="col" style={{ ...head, textAlign: 'left' }}>
                Query
              </th>
              <th scope="col" style={{ ...head, textAlign: 'left' }}>
                Group
              </th>
              <th scope="col" style={head}>
                With value
              </th>
              <th scope="col" style={head}>
                No value
              </th>
              <th scope="col" style={head}>
                Min
              </th>
              <th scope="col" style={head}>
                Median
              </th>
              <th scope="col" style={head}>
                p95
              </th>
              <th scope="col" style={head}>
                Max
              </th>
              <th scope="col" style={head} title="Cliff's delta of the selected cells against the other cells">
                δ
              </th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((comparison) => (
              <React.Fragment key={comparison.refId}>
                <tr data-testid={`cohort-selected-${comparison.refId}`}>
                  <th scope="rowgroup" rowSpan={2} style={{ ...head, textAlign: 'left', verticalAlign: 'top' }}>
                    {infoByRef.get(comparison.refId)?.name ?? comparison.refId}
                  </th>
                  <th scope="row" style={{ ...cell, textAlign: 'left', fontWeight: 'normal' }}>
                    Selected
                  </th>
                  {summaryCells(comparison.refId, comparison.selected)}
                  <td
                    rowSpan={2}
                    data-testid={`cohort-delta-${comparison.refId}`}
                    style={{ ...cell, verticalAlign: 'middle', fontWeight: theme.typography.fontWeightMedium }}
                  >
                    {formatDelta(comparison.delta)}
                  </td>
                </tr>
                <tr data-testid={`cohort-rest-${comparison.refId}`} style={{ borderBottom: rule }}>
                  <th scope="row" style={{ ...cell, textAlign: 'left', fontWeight: 'normal' }}>
                    Other
                  </th>
                  {summaryCells(comparison.refId, comparison.rest)}
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: theme.spacing(2), color: theme.colors.text.secondary }}>
          <p>
            A cell counts with the value the grid shows for the query. Cells under <em>No value</em> have none; they are
            not treated as zero and are left out of the statistics. Median and p95 are interpolated between the two
            nearest values, so in a small group p95 lies just below the maximum.
          </p>
          <p>
            δ (Cliff&apos;s delta) compares every selected cell with every other cell: the share of pairs in which the
            selected cell is higher, minus the share in which it is lower. +1 means that every selected cell is above
            every other cell, −1 that every one is below, and 0 that the selection is as often above as below, as it is
            when the two groups look alike. The further δ is from 0, the more this query tells the selection apart.
          </p>
        </div>
      </div>
    </Drawer>
  );
};
