import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { splitRects } from '../render/split';
import { SplitLegend } from './SplitLegend';

const theme = createTheme();
const frame = (refId: string, name: string) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [1], labels: {} },
    ],
  });

describe('SplitLegend', () => {
  it('lists region number and query name in order', () => {
    const infos = buildMetricInfos([frame('A', 'power'), frame('B', 'temp')], theme, 'browser');
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText('1: power')).toBeInTheDocument();
    expect(screen.getByText('2: temp')).toBeInTheDocument();
  });
  it('warns when more than 9 queries', () => {
    const infos = buildMetricInfos(
      Array.from({ length: 11 }, (_, i) => frame(String.fromCharCode(65 + i), `m${i}`)),
      theme,
      'browser'
    );
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText(/9クエリまで/)).toBeInTheDocument();
    expect(screen.getByText(/2件は非表示/)).toBeInTheDocument();
  });
  it('positions each minimap fill to match splitRects percentages', () => {
    const infos = buildMetricInfos([frame('A', 'power'), frame('B', 'temp')], theme, 'browser');
    const { container } = render(<SplitLegend metricInfos={infos} />);
    const rects = splitRects(infos.length);
    // ミニチュア枠(aria-hidden)の直下spanが区画塗り。splitRectsと同じ割合であることを検証(単一の真実の源)
    const fills = container.querySelectorAll<HTMLElement>('span[aria-hidden] > span');
    expect(fills).toHaveLength(rects.length);
    fills.forEach((el, i) => {
      expect(el.style.left).toBe(`${rects[i].x * 100}%`);
      expect(el.style.top).toBe(`${rects[i].y * 100}%`);
      expect(el.style.width).toBe(`${rects[i].w * 100}%`);
      expect(el.style.height).toBe(`${rects[i].h * 100}%`);
    });
  });
});
