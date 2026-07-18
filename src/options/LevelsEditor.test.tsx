import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { toDataFrame, FieldType, DataFrame, StandardEditorProps } from '@grafana/data';
import { DEFAULT_LEVEL, LevelDef } from '../types';
import { detectLabelKeys, previewLevel, LevelsEditor } from './LevelsEditor';

// jsdom lacks IntersectionObserver, which @grafana/ui's Select menu (ScrollIndicators) requires.
Object.defineProperty(global, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: jest.fn(() => ({
    observe: jest.fn(),
    unobserve: jest.fn(),
    disconnect: jest.fn(),
    takeRecords: jest.fn(() => []),
  })),
});

const tsFrame = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'Time', type: FieldType.time, values: [1] },
    { name: 'Value', type: FieldType.number, values: [1], labels: { zone: 'zone-a', gpu: '0' } },
  ],
});
const tableFrame = toDataFrame({
  refId: 'B',
  fields: [
    { name: 'host', type: FieldType.string, values: ['node-a001', 'node-a002', 'node-a001'] },
    { name: 'Value', type: FieldType.number, values: [1, 2, 3] },
  ],
});

describe('detectLabelKeys', () => {
  it('collects label keys from series labels and table string columns', () => {
    expect(detectLabelKeys([tsFrame, tableFrame]).sort()).toEqual(['gpu', 'host', 'zone']);
  });
});

describe('previewLevel', () => {
  it('counts distinct extracted keys with samples in natural order', () => {
    const p = previewLevel([tableFrame], { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' });
    expect(p.count).toBe(2);
    expect(p.samples).toEqual(['001', '002']);
  });
  it('returns zero when nothing matches', () => {
    const p = previewLevel([tableFrame], {
      ...DEFAULT_LEVEL,
      label: 'host',
      extract: 'regex',
      regex: 'nomatch-(\\d+)',
    });
    expect(p.count).toBe(0);
  });
  it('extracts and naturally sorts distinct keys from time series labels', () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1] },
        { name: 'v1', type: FieldType.number, values: [1], labels: { host: 'node-a002' } },
        { name: 'v2', type: FieldType.number, values: [1], labels: { host: 'node-a010' } },
        { name: 'v3', type: FieldType.number, values: [1], labels: { host: 'node-a001' } },
      ],
    });
    const p = previewLevel([frame], { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' });
    expect(p.count).toBe(3);
    expect(p.samples).toEqual(['001', '002', '010']);
  });
});

function editorProps(
  value: LevelDef[],
  onChange: (v?: LevelDef[]) => void,
  frames: DataFrame[] = []
): StandardEditorProps<LevelDef[]> {
  return { value, onChange, context: { data: frames }, item: { id: 'levels', name: 'levels' } };
}

// 制御コンポーネントなので、抽出プリセット切替後の再描画を検証するには親側で状態を保持する。
function StatefulLevelsEditor({ initial, frames = [] }: { initial: LevelDef[]; frames?: DataFrame[] }) {
  const [value, setValue] = React.useState<LevelDef[]>(initial);
  return <LevelsEditor {...editorProps(value, (v) => setValue(v ?? []), frames)} />;
}

describe('LevelsEditor (component)', () => {
  it('appends a DEFAULT_LEVEL when レベル追加 is clicked', () => {
    const onChange = jest.fn();
    render(<LevelsEditor {...editorProps([], onChange)} />);
    fireEvent.click(screen.getByRole('button', { name: 'レベル追加' }));
    expect(onChange).toHaveBeenCalledWith([{ ...DEFAULT_LEVEL }]);
  });

  it('removes the target level when 削除 is clicked', () => {
    const onChange = jest.fn();
    render(<LevelsEditor {...editorProps([{ ...DEFAULT_LEVEL, label: 'host' }], onChange)} />);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('moves a level down when 下へ is clicked', () => {
    const onChange = jest.fn();
    const a = { ...DEFAULT_LEVEL, label: 'host' };
    const b = { ...DEFAULT_LEVEL, label: 'zone' };
    render(<LevelsEditor {...editorProps([a, b], onChange)} />);
    fireEvent.click(screen.getAllByRole('button', { name: '下へ' })[0]);
    expect(onChange).toHaveBeenCalledWith([b, a]);
  });

  it('moves a level up when 上へ is clicked', () => {
    const onChange = jest.fn();
    const a = { ...DEFAULT_LEVEL, label: 'host' };
    const b = { ...DEFAULT_LEVEL, label: 'zone' };
    render(<LevelsEditor {...editorProps([a, b], onChange)} />);
    fireEvent.click(screen.getAllByRole('button', { name: '上へ' })[1]);
    expect(onChange).toHaveBeenCalledWith([b, a]);
  });

  it('reveals the regex input after switching 抽出 to 正規表現', () => {
    render(<StatefulLevelsEditor initial={[{ ...DEFAULT_LEVEL, label: 'host', extract: 'raw' }]} />);
    expect(screen.queryByPlaceholderText('node-.+?(\\d+)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('正規表現'));
    expect(screen.getByPlaceholderText('node-.+?(\\d+)')).toBeInTheDocument();
  });

  it('renders live preview with distinct group count and leading samples', () => {
    const level = { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' as const };
    render(<LevelsEditor {...editorProps([level], jest.fn(), [tableFrame])} />);
    expect(screen.getByText(/グループ/)).toHaveTextContent('2グループ: 001, 002');
  });
});
