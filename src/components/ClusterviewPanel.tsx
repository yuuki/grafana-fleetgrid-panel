import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DataFrame, Field, LinkModel, PanelProps } from '@grafana/data';
import { PanelDataErrorView } from '@grafana/runtime';
import { RadioButtonGroup, useTheme2 } from '@grafana/ui';
import { CellModel, ClusterviewOptions } from '../types';
import { buildModel } from '../data/model';
import { computeLayout } from '../layout/layout';
import { renderCanvas } from '../render/renderer';
import { hitTest } from '../render/hitTest';
import { splitRects } from '../render/split';
import { drilldownSeries, getCellLinks } from '../drilldown/series';
import { fetchDrilldownFrames } from '../drilldown/requery';
import { CellTooltip } from './CellTooltip';
import { DrilldownPopover } from './DrilldownPopover';
import { SplitLegend } from './SplitLegend';
import { placeOverlay } from './overlay';

// showHeader時のヘッダー高フォールバック(実高はレイアウト後に測定して上書きする)
const HEADER_H = 32;
// 部分除外などの警告を出す帯の高さ(Canvas領域から差し引く)
const WARN_H = 20;
const LINK_MENU_W = 240;
const LINK_MENU_ROW_H = 28;

export const ClusterviewPanel: React.FC<PanelProps<ClusterviewOptions>> = (props) => {
  const { data, width, height, options, timeZone } = props;
  const theme = useTheme2();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(options.defaultMetric || undefined);
  const [hover, setHover] = useState<{ cell: CellModel; x: number; y: number } | null>(null);
  // ポップオーバー/リンクメニューはコンテンツ座標(x/y)で保持し、スクロールに追従させる。
  // min/maxはクリック時点の可視領域(コンテンツ座標)の左上・右下端で、反転配置の両端クランプに使う。
  const [popover, setPopover] = useState<{
    cell: CellModel;
    x: number;
    y: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  const [linkMenu, setLinkMenu] = useState<{
    links: Array<LinkModel<Field>>;
    x: number;
    y: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  // instantクエリ時のドリルダウン用にオンデマンドで取得したrangeフレーム(パネル単位でキャッシュ)
  const [drillFrames, setDrillFrames] = useState<DataFrame[] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(false);
  const drillCacheId = useRef<string | undefined>(undefined);
  // 再クエリの世代トークン。requestIdが変わるたびに進め、進行中の古いリクエストの応答を捨てる判定に使う
  const drillGen = useRef(0);

  const targetRefIds = useMemo(
    () => (data.request?.targets ?? []).map((t) => t.refId).filter((r): r is string => Boolean(r)),
    [data.request]
  );
  const model = useMemo(
    () => buildModel(data.series, options, theme, timeZone, targetRefIds),
    [data.series, options, theme, timeZone, targetRefIds]
  );

  // displayModeはTask 14で登録済みだが、登録前に保存したダッシュボードはキーを持たない。single を既定に正規化する
  const displayMode = options.displayMode ?? 'single';
  // split判定はrenderer(metricInfos>0で区画描画)と統一する。0系列refIdはMetricInfoを持たず区画・凡例から外れる
  const isSplit = displayMode === 'split' && model.metricInfos.length > 0;
  // 複数クエリ時はヘッダを常設し、分割モードは凡例・単一モードはメトリクスセレクタを載せる
  const showHeader = model.refIds.length > 1;
  // ヘッダー実高を測定してCanvas領域から差し引く。多メトリクスで凡例が折返して32pxを超えても重ならない。
  // 測定できない環境(jsdom)ではフォールバックHEADER_Hを使う。幅変化で折返しが変わるためResizeObserverで追従する。
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = showHeader ? headerRef.current : null;
    const measure = () => {
      // レイアウト確定後のDOM実測をReact stateへ同期する(measure-then-set)。
      setHeaderH(el && el.offsetHeight ? el.offsetHeight : showHeader ? HEADER_H : 0);
    };
    measure();
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [showHeader, model, width]);
  // 警告(部分除外など)がある場合は帯の高さも差し引く
  const warnH = model.warnings.length > 0 ? WARN_H : 0;
  const bodyH = height - headerH - warnH;

  const layout = useMemo(
    () => computeLayout(model.root, options.levels, width, bodyH),
    [model.root, options.levels, width, bodyH]
  );

  const selectedRefId = selected && model.refIds.includes(selected) ? selected : model.refIds[0] ?? 'A';

  useEffect(() => {
    if (canvasRef.current) {
      renderCanvas(canvasRef.current, {
        layout,
        metricInfos: model.metricInfos,
        selectedRefId,
        displayMode,
        showValues: options.showValues,
        missingColor: options.missingColor,
        theme,
        scrollTop,
        viewportH: bodyH,
      });
    }
  }, [layout, model, selectedRefId, displayMode, options, theme, scrollTop, bodyH]);

  // パネルデータが更新されたらキャッシュ・エラー・取得中を破棄し世代を進める(キャッシュはパネル単位・requestIdで無効化)。
  // 世代を進めることで、進行中だった古いリクエストの応答(成功/失敗/finally)を後段のガードで確実に捨てる。
  // 取得中もリセットするため、古いリクエストのfinallyをガードで飛ばしても新しいloadingが残らずデッドロックしない。
  useEffect(() => {
    if (data.request?.requestId !== drillCacheId.current) {
      drillGen.current += 1;
      setDrillFrames(null);
      setDrillError(false);
      setDrillLoading(false);
    }
  }, [data.request?.requestId]);

  // ポップオーバーを開いたとき、instantクエリで手元に時系列がないメトリクスがあれば再クエリ(1リフレッシュにつき1回)。
  // range-only(手元にrangeデータがあり得る)では再クエリしない。drillErrorガードで失敗時の再試行ループを防ぐ。
  // 応答は取得開始時の世代を捕捉し、届いた時点の世代と一致するときのみ反映して古い応答を捨てる。
  useEffect(() => {
    if (!popover || drillFrames || drillLoading || drillError || !data.request) {
      return;
    }
    // 手元データがrangeクエリ由来なら再クエリ不要。instant targetがある場合のみ実行する
    const hasInstant = (data.request.targets ?? []).some((t) => (t as { instant?: boolean }).instant);
    if (!hasInstant) {
      return;
    }
    const cellLabels = popover.cell.labelSets ?? popover.cell.labels;
    const missing = model.metricInfos.some(
      (info) => drilldownSeries(data.series, info.refId, cellLabels, options.spatialAggregation).frame === null
    );
    if (!missing) {
      return;
    }
    const gen = drillGen.current;
    const requestId = data.request.requestId;
    // ポップオーバー起点の意図的な非同期取得。loadingは取得中UIかつ再入ガードなので同期設定が必要
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrillLoading(true);
    fetchDrilldownFrames(data.request)
      .then((frames) => {
        if (drillGen.current !== gen) {
          return; // requestIdが変わった後に届いた古い応答は捨てる
        }
        drillCacheId.current = requestId;
        setDrillFrames(frames);
      })
      .catch(() => {
        if (drillGen.current !== gen) {
          return; // 古いリクエストの失敗を新しいエラーstateに反映しない
        }
        setDrillError(true);
      })
      .finally(() => {
        if (drillGen.current !== gen) {
          return; // 古いリクエストのfinallyで新しいloadingを消さない
        }
        setDrillLoading(false);
      });
  }, [popover, drillFrames, drillLoading, drillError, data, model.metricInfos, options.spatialAggregation]);

  // Esc・外側ポインタダウンでポップオーバー/メニューを閉じる(ポップオーバー側はstopPropagationで防御)
  useEffect(() => {
    const close = () => {
      setPopover(null);
      setLinkMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', close);
    };
  }, []);

  // リンク実行: LinkModel.onClickを保持しているリンク(パネル内SPA遷移等)はそれを優先する
  const followLink = (link: LinkModel<Field>, e: React.MouseEvent) => {
    if (link.onClick) {
      link.onClick(e);
      return;
    }
    window.open(link.href, link.target ?? '_self');
  };

  if (data.series.length === 0) {
    return <PanelDataErrorView panelId={props.id} data={data} />;
  }
  if (options.levels.length === 0) {
    return <p>パネルオプションで階層レベルを設定してください。</p>;
  }
  // 描画すべきセルが1件も成立しない場合、黙って空Canvasにせず理由を明示する。
  // 警告があれば警告を、無ければ「数値セルを構築できない」旨のデータエラーを表示する(仕様: 黙って空表示にしない)。
  if (layout.cells.length === 0) {
    return (
      <div role="alert" style={{ padding: 8 }}>
        {model.warnings.length > 0 ? (
          model.warnings.map((w) => (
            <p key={w} style={{ margin: '2px 0' }}>
              {w}
            </p>
          ))
        ) : (
          <p>
            クエリ結果から数値セルを構築できませんでした。数値を返すクエリと、ラベルに一致する階層レベルの設定を確認してください。
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      {showHeader && (
        <div ref={headerRef} style={{ minHeight: HEADER_H, display: 'flex', alignItems: 'center' }}>
          {isSplit ? (
            // 分割モードは単一モードのセレクタの代わりに区画位置の凡例を出す
            <SplitLegend metricInfos={model.metricInfos} />
          ) : (
            <RadioButtonGroup
              size="sm"
              // 選択肢はrefId基準。0系列クエリはmetricInfoが無いためrefIdを表示名にフォールバックする
              options={model.refIds.map((refId) => ({
                value: refId,
                label: model.metricInfos.find((m) => m.refId === refId)?.name ?? refId,
              }))}
              value={selectedRefId}
              onChange={setSelected}
            />
          )}
        </div>
      )}
      {model.warnings.length > 0 && (
        // セルが描画できている場合でも警告(部分除外など)を常時表示する。邪魔にならないよう1行の帯にする。
        <div
          role="alert"
          style={{
            height: WARN_H,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
            padding: '0 6px',
            fontSize: 11,
            color: theme.colors.warning.text,
            background: theme.colors.warning.transparent,
          }}
        >
          {model.warnings.map((w) => (
            <span key={w} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {w}
            </span>
          ))}
        </div>
      )}
      <div
        style={{
          width,
          height: bodyH,
          position: 'relative',
          overflowY: layout.scrollable ? 'auto' : 'hidden',
          // S_MINでも幅に収まらない設定(列数過多など)では横スクロールで切れを防ぐ
          overflowX: layout.contentWidth > width ? 'auto' : 'hidden',
        }}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // スクロールすると保持済み座標が実体とずれるため閉じる
          setPopover(null);
          setLinkMenu(null);
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // hitTestもツールチップも、スクロールコンテナのコンテンツ座標系で扱う。
          // absolute子のツールチップはコンテンツ座標に置かれ、hitTestの当たり判定もコンテンツ座標のため、
          // 縦横スクロール量(scrollTop/scrollLeft)を加味しないとスクロール時に別セル判定・誤配置になる。
          const cx = e.clientX - rect.left + e.currentTarget.scrollLeft;
          const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
          const hit = hitTest(layout, cx, cy);
          setHover(hit ? { cell: hit.cell, x: cx, y: cy } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // クリックもホバーと同じコンテンツ座標系(scrollLeft/scrollTop込み)でヒットテストする
          const cx = e.clientX - rect.left + e.currentTarget.scrollLeft;
          const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
          const hit = hitTest(layout, cx, cy);
          if (!hit) {
            setPopover(null);
            setLinkMenu(null);
            return;
          }
          // 分割モードではクリックした区画のメトリクスをリンク対象にする
          let clickRefId = selectedRefId;
          if (isSplit) {
            const rects = splitRects(model.metricInfos.length);
            const rel = { x: (cx - hit.x) / hit.w, y: (cy - hit.y) / hit.h };
            const idx = rects.findIndex((r) => rel.x >= r.x && rel.x < r.x + r.w && rel.y >= r.y && rel.y < r.y + r.h);
            if (idx >= 0 && model.metricInfos[idx]) {
              clickRefId = model.metricInfos[idx].refId;
            }
          }
          const info = model.metricInfos.find((m) => m.refId === clickRefId);
          const v = hit.cell.values.get(clickRefId);
          // Data Links優先: getLinksが存在するフィールドのみリンクを返す(config.links長ではなくgetLinksの有無が契約)。
          // 抽出キー衝突を含めた全原値ラベル組で探索する。
          const links = getCellLinks(
            data.series,
            clickRefId,
            hit.cell.labelSets ?? hit.cell.labels,
            v != null ? info?.processor(v) : undefined
          );
          if (links.length === 1) {
            followLink(links[0], e);
            return;
          }
          const minX = e.currentTarget.scrollLeft;
          const minY = e.currentTarget.scrollTop;
          const maxX = minX + width;
          const maxY = minY + bodyH;
          if (links.length > 1) {
            // 複数リンクは選択メニューを出す(ポップオーバーと同じ可視範囲でクランプする)
            setLinkMenu({ links, x: cx, y: cy, minX, minY, maxX, maxY });
            setPopover(null);
            return;
          }
          // リンクが無ければ手元rangeデータのスパークライン付きポップオーバー
          setLinkMenu(null);
          setPopover({ cell: hit.cell, x: cx, y: cy, minX, minY, maxX, maxY });
        }}
      >
        <canvas ref={canvasRef} />
        {hover && (
          <CellTooltip
            cell={hover.cell}
            metricInfos={model.metricInfos}
            missingColor={options.missingColor}
            x={hover.x}
            y={hover.y}
          />
        )}
        {popover && (
          <DrilldownPopover
            cell={popover.cell}
            metricInfos={model.metricInfos}
            // まず手元rangeデータで合成し、無ければ再クエリ済みフレーム(instantクエリ時)で合成する
            seriesFor={(refId) => {
              const cellLabels = popover.cell.labelSets ?? popover.cell.labels;
              const local = drilldownSeries(data.series, refId, cellLabels, options.spatialAggregation);
              if (local.frame) {
                return local;
              }
              return drillFrames
                ? drilldownSeries(drillFrames, refId, cellLabels, options.spatialAggregation)
                : { frame: null, seriesCount: 0, aggregated: false };
            }}
            loading={drillLoading}
            error={drillError}
            x={popover.x}
            y={popover.y}
            minX={popover.minX}
            minY={popover.minY}
            maxX={popover.maxX}
            maxY={popover.maxY}
            onClose={() => setPopover(null)}
          />
        )}
        {linkMenu &&
          (() => {
            // ポップオーバーと同じ反転+可視範囲クランプで右端・下端のはみ出しを防ぐ
            const menuH = linkMenu.links.length * LINK_MENU_ROW_H + 8;
            const { left, top } = placeOverlay(linkMenu.x, linkMenu.y, LINK_MENU_W, menuH, linkMenu);
            return (
              <div
                role="menu"
                onPointerDown={(e) => e.stopPropagation()}
                // メニュー内クリックがコンテナのonClickに伝播してヒットテスト→再オープンするのを防ぐ
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width: LINK_MENU_W,
                  zIndex: 30,
                  // 固定暗色ではなくテーマ由来の配色にし、ライト/ダーク双方で読めるようにする
                  background: theme.colors.background.elevated ?? theme.colors.background.secondary,
                  color: theme.colors.text.primary,
                  border: `1px solid ${theme.colors.border.medium}`,
                  borderRadius: 4,
                  padding: 4,
                  boxShadow: theme.shadows.z3,
                }}
              >
                {linkMenu.links.map((l, i) => (
                  <a
                    // 意味の異なる同一hrefリンクを保持しうるためindexを含めて一意化する
                    key={`${i}-${l.href}`}
                    href={l.href}
                    target={l.target}
                    // onClickを保持するリンク(SPA遷移等)も単一リンクと同様にfollowLinkで実行する
                    onClick={(e) => {
                      e.preventDefault();
                      followLink(l, e);
                      setLinkMenu(null);
                    }}
                    style={{
                      display: 'block',
                      padding: '4px 8px',
                      color: theme.colors.text.primary,
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {l.title || l.href}
                  </a>
                ))}
              </div>
            );
          })()}
      </div>
    </div>
  );
};
