import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
import { ClusterviewPanel } from './ClusterviewPanel';
import { fetchDrilldownFrames } from '../drilldown/requery';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
}));

// 再クエリはwiring(instant判定/staleガード/キャッシュ)を検証するためモックする
jest.mock('../drilldown/requery', () => ({
  fetchDrilldownFrames: jest.fn(),
}));

// SparklineはuPlot依存のためテスト用のプレースホルダに差し替える(描画有無だけを見る)
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
}));

const mockFetch = fetchDrilldownFrames as jest.Mock;

const series = (refId: string, name: string, zone: string) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [1], labels: { zone } },
    ],
  });

const makeProps = (frames: unknown[]): any => ({
  id: 1,
  width: 400,
  height: 300,
  timeZone: 'browser',
  timeRange: getDefaultTimeRange(),
  data: {
    series: frames,
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    request: { requestId: 'Q1', targets: (frames as Array<{ refId: string }>).map((f) => ({ refId: f.refId })) },
  },
  options: {
    levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
    displayMode: 'single',
    showValues: true,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
  },
});

describe('ClusterviewPanel', () => {
  it('renders canvas and a metric selector for multiple queries', () => {
    render(<ClusterviewPanel {...makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')])} />);
    expect(document.querySelector('canvas')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('shows warnings when the hierarchy label is absent', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    p.options.levels = [{ ...DEFAULT_LEVEL, label: 'rack' }];
    render(<ClusterviewPanel {...p} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows no-data view when there are no frames', () => {
    render(<ClusterviewPanel {...makeProps([])} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('shows the metric selector when displayMode is unset (defaults to single)', () => {
    const p = makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')]);
    delete p.options.displayMode;
    render(<ClusterviewPanel {...p} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('shows the split legend and hides the single-mode selector in split mode', () => {
    const p = makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')]);
    p.options.displayMode = 'split';
    render(<ClusterviewPanel {...p} />);
    expect(screen.getByText('1: power')).toBeInTheDocument(); // 凡例(区画位置ミニチュア + 番号:名)
    expect(screen.getByText('2: temp')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument(); // 単一モードのセレクタは出さない
  });

  it('uses content coordinates (incl. scrollLeft) for hover hit testing', () => {
    // 同一refId・2ゾーンで横並び2セル(flow, s=40 → zone-a:[0,40), zone-b:[41,81))。refIdは1つなのでヘッダー無し。
    render(<ClusterviewPanel {...makeProps([series('A', 'power', 'zone-a'), series('A', 'power', 'zone-b')])} />);
    const container = document.querySelector('canvas')!.parentElement as HTMLElement;
    // 横スクロール状態(scrollLeft=50)を再現する
    Object.defineProperty(container, 'scrollLeft', { configurable: true, value: 50 });
    // clientX=10 は素朴にはzone-a([0,40))だが、+scrollLeft=50でcx=60 → zone-b([41,81))が正しいヒット
    fireEvent.mouseMove(container, { clientX: 10, clientY: 5 });
    const title = screen.getByText('zone-b'); // scrollLeftを加味した正しいセルがヒットしている
    expect(title).toBeInTheDocument();
    expect(title.parentElement).toHaveStyle({ left: '72px' }); // ツールチップx = cx(60) + 12 = コンテンツ座標
  });

  it('lists refIds for configured queries that returned no series', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    // クエリBは設定済み(targets)だが0系列(seriesには無い)
    p.data.request.targets = [{ refId: 'A' }, { refId: 'B' }];
    render(<ClusterviewPanel {...p} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('power')).toBeInTheDocument(); // Aは系列名
    expect(screen.getByText('B')).toBeInTheDocument(); // BはmetricInfoが無いのでrefId表示
  });

  it('shows a warning banner while still rendering cells when only some rows match', () => {
    const twoLevel = (zone: string, gpu?: string) =>
      toDataFrame({
        refId: 'A',
        name: 'power',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000] },
          { name: 'Value', type: FieldType.number, values: [1], labels: gpu ? { zone, gpu } : { zone } },
        ],
      });
    const p = makeProps([twoLevel('zone-a', '0'), twoLevel('zone-b')]); // 2件目は gpu 欠落 → 除外
    p.options.levels = [{ ...DEFAULT_LEVEL, label: 'zone' }, { ...DEFAULT_LEVEL, label: 'gpu' }];
    render(<ClusterviewPanel {...p} />);
    expect(document.querySelector('canvas')).toBeInTheDocument(); // マッチ行のセルは描画される
    expect(screen.getByRole('alert')).toBeInTheDocument(); // かつ警告帯も同時に出る
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
  });

  it('shows an explicit data error when queries return no numeric cells (not a silent empty canvas)', () => {
    const stringOnly = toDataFrame({
      refId: 'A',
      fields: [{ name: 'zone', type: FieldType.string, values: ['zone-a'] }], // 数値フィールド無し
    });
    render(<ClusterviewPanel {...makeProps([stringOnly])} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/数値セル/)).toBeInTheDocument();
    expect(document.querySelector('canvas')).not.toBeInTheDocument();
  });

  // 横並び2セル(zone-a:[0,40))を持つフレーム。clientX=10でzone-aをヒットする。
  const clickable = () => [series('A', 'power', 'zone-a'), series('A', 'power', 'zone-b')];
  const containerOf = () => document.querySelector('canvas')!.parentElement as HTMLElement;

  it('follows a single data link (onClick preserved) and suppresses the popover', () => {
    const onLinkClick = jest.fn();
    const frames = clickable();
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://example.com/d/x', title: 'X', target: '_self', origin: {}, onClick: onLinkClick },
    ]) as any;
    render(<ClusterviewPanel {...makeProps(frames)} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(onLinkClick).toHaveBeenCalled(); // Data Links優先で即実行
    expect(screen.queryByLabelText('閉じる')).not.toBeInTheDocument(); // ポップオーバーは抑止
  });

  it('shows a selection menu for multiple data links (not the popover)', () => {
    const frames = clickable();
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://example.com/a', title: 'Link A', target: '_blank', origin: {} },
      { href: 'https://example.com/b', title: 'Link B', target: '_blank', origin: {} },
    ]) as any;
    render(<ClusterviewPanel {...makeProps(frames)} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByText('Link A')).toBeInTheDocument();
    expect(screen.getByText('Link B')).toBeInTheDocument();
    expect(screen.queryByLabelText('閉じる')).not.toBeInTheDocument();
  });

  it('renders the link menu with theme colors (not a hardcoded dark background) and a bounded position', () => {
    const frames = clickable();
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://example.com/a', title: 'Link A', target: '_blank', origin: {} },
      { href: 'https://example.com/b', title: 'Link B', target: '_blank', origin: {} },
    ]) as any;
    render(<ClusterviewPanel {...makeProps(frames)} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    const menu = screen.getByRole('menu');
    // 旧実装の固定暗色ではなくテーマ由来の配色にする(ライトテーマでも読める)
    expect(menu.style.background).not.toBe('rgba(24,27,31,0.98)');
    expect(menu.style.background).toBeTruthy();
    // 位置は数値でクランプ範囲内(左上端は 0 以上)
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
  });

  it('opens the drilldown popover when there are no data links, then closes it on Escape', () => {
    render(<ClusterviewPanel {...makeProps(clickable())} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('閉じる')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('閉じる')).not.toBeInTheDocument();
  });

  it('closes the popover on an outside pointerdown', () => {
    render(<ClusterviewPanel {...makeProps(clickable())} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('閉じる')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByLabelText('閉じる')).not.toBeInTheDocument();
  });

  it('closes the popover on scroll', () => {
    render(<ClusterviewPanel {...makeProps(clickable())} />);
    const container = containerOf();
    fireEvent.click(container, { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('閉じる')).toBeInTheDocument();
    fireEvent.scroll(container);
    expect(screen.queryByLabelText('閉じる')).not.toBeInTheDocument();
  });

  describe('on-demand requery for instant queries', () => {
    beforeEach(() => mockFetch.mockReset());

    const sparkFrame = (v: number) =>
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000, 2000] },
          { name: 'Value', type: FieldType.number, values: [v, v + 1], labels: { zone: 'zone-a' } },
        ],
      });

    it('does not requery when the panel data has no instant targets (range-only)', () => {
      // makePropsのtargetsはinstantフラグ無し(range-only)なので再クエリは走らない
      render(<ClusterviewPanel {...makeProps(clickable())} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      expect(screen.getByLabelText('閉じる')).toBeInTheDocument(); // ポップオーバーは開く
      expect(mockFetch).not.toHaveBeenCalled(); // range-only → 再クエリしない
    });

    it('requeries once for instant queries and discards a stale response after the requestId changes', async () => {
      let resolve1!: (v: unknown) => void;
      let resolve2!: (v: unknown) => void;
      mockFetch
        .mockReturnValueOnce(new Promise((r) => (resolve1 = r)))
        .mockReturnValueOnce(new Promise((r) => (resolve2 = r)));

      const instantTargets = [{ refId: 'A', instant: true }];
      const p1 = makeProps(clickable());
      p1.data.request.targets = instantTargets;
      const { rerender } = render(<ClusterviewPanel {...p1} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      // instantで手元に時系列が無い → 再クエリ開始、取得中表示
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(screen.getByText('読み込み中…')).toBeInTheDocument();

      // requestIdがQ2へ更新される(パネルデータ更新)
      const p2 = makeProps(clickable());
      p2.data.request.requestId = 'Q2';
      p2.data.request.targets = instantTargets;
      await act(async () => {
        rerender(<ClusterviewPanel {...p2} />);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2); // 新しいrequestIdで再クエリが走る

      // 古いQ1応答が遅れて届く → staleガードで破棄され、反映されない
      await act(async () => {
        resolve1([sparkFrame(90)]);
      });
      expect(screen.getByText('読み込み中…')).toBeInTheDocument(); // まだ取得中(Q1は捨てられた)
      expect(screen.queryByTestId('sparkline')).not.toBeInTheDocument();

      // 新しいQ2応答が届く → こちらは反映されてスパークラインが出る
      await act(async () => {
        resolve2([sparkFrame(1)]);
      });
      expect(screen.getByTestId('sparkline')).toBeInTheDocument();
      expect(screen.queryByText('読み込み中…')).not.toBeInTheDocument();
    });

    it('does not surface a stale rejection as an error, then shows the fresh success', async () => {
      // Q1 を reject、Q2 を resolve
      let reject1!: (e: unknown) => void;
      let resolve2!: (v: unknown) => void;
      mockFetch
        .mockReturnValueOnce(new Promise((_, r) => (reject1 = r)))
        .mockReturnValueOnce(new Promise((r) => (resolve2 = r)));

      const instantTargets = [{ refId: 'A', instant: true }];
      const p1 = makeProps(clickable());
      p1.data.request.targets = instantTargets;
      const { rerender } = render(<ClusterviewPanel {...p1} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(screen.getByText('読み込み中…')).toBeInTheDocument();

      // requestId が Q2 へ更新 → 世代が進む
      const p2 = makeProps(clickable());
      p2.data.request.requestId = 'Q2';
      p2.data.request.targets = instantTargets;
      await act(async () => {
        rerender(<ClusterviewPanel {...p2} />);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // 遅れて届いた Q1 の失敗は staleガードで drillError に混入しない
      await act(async () => {
        reject1(new Error('boom'));
      });
      expect(screen.queryByText('再取得に失敗しました')).not.toBeInTheDocument();
      expect(screen.getByText('読み込み中…')).toBeInTheDocument(); // Q2 継続中

      // Q2 成功 → スパークライン
      await act(async () => {
        resolve2([sparkFrame(1)]);
      });
      expect(screen.getByTestId('sparkline')).toBeInTheDocument();
      expect(screen.queryByText('再取得に失敗しました')).not.toBeInTheDocument();
    });

    it('shows a failure message when the current instant re-query rejects', async () => {
      let reject1!: (e: unknown) => void;
      mockFetch.mockReturnValueOnce(new Promise((_, r) => (reject1 = r)));
      const p = makeProps(clickable());
      p.data.request.targets = [{ refId: 'A', instant: true }];
      render(<ClusterviewPanel {...p} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        reject1(new Error('boom'));
      });
      expect(screen.getByText('再取得に失敗しました')).toBeInTheDocument();
    });
  });
});
