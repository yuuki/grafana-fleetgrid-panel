import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DataFrame, Field, LinkModel, PanelProps } from '@grafana/data';
import { PanelDataErrorView } from '@grafana/runtime';
import { RadioButtonGroup, useTheme2 } from '@grafana/ui';
import { CellModel, FleetGridOptions } from '../types';
import { buildModel } from '../data/model';
import { computeLayout } from '../layout/layout';
import { renderCanvas } from '../render/renderer';
import { hitTest } from '../render/hitTest';
import { splitRects } from '../render/split';
import { drilldownSeries, getCellLinks } from '../drilldown/series';
import { fetchDrilldownFrames } from '../drilldown/requery';
import { CellTooltip } from './CellTooltip';
import { DrilldownPopover } from './DrilldownPopover';
import { RangeLegend } from './RangeLegend';
import { SplitLegend } from './SplitLegend';
import { placeOverlay, VisibleBounds } from './overlay';
import { cellRangeFor } from '../data/cellRange';

// Header height fallback for when showHeader is on (the actual height is measured after layout and overwrites this)
const HEADER_H = 32;
// Height of the banner showing warnings such as partial exclusions (subtracted from the canvas area)
const WARN_H = 20;
const LINK_MENU_W = 240;
const LINK_MENU_ROW_H = 28;
// Fixed dimensions for deterministically computing the menu height (assumes box-sizing: border-box)
const LINK_MENU_PAD = 4;
const LINK_MENU_BORDER = 1;

const measureVisibleBounds = (el: HTMLElement): VisibleBounds => {
  const minX = el.scrollLeft;
  const minY = el.scrollTop;
  return { minX, minY, maxX: minX + el.clientWidth, maxY: minY + el.clientHeight };
};

const sameVisibleBounds = (a: VisibleBounds, b: VisibleBounds): boolean =>
  a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;

export const FleetGridPanel: React.FC<PanelProps<FleetGridOptions>> = (props) => {
  const { data, width, height, options, timeZone } = props;
  const theme = useTheme2();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    setScrollElement((current) => (current === element ? current : element));
  }, []);
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(options.defaultMetric || undefined);
  const [hover, setHover] = useState<{ cell: CellModel; x: number; y: number } | null>(null);
  // Popover/link menu origins are kept in content coordinates. Visible bounds are measured separately so an open overlay follows panel resizes.
  const [popover, setPopover] = useState<{
    cell: CellModel;
    x: number;
    y: number;
  } | null>(null);
  const [linkMenu, setLinkMenu] = useState<{
    links: Array<LinkModel<Field>>;
    x: number;
    y: number;
  } | null>(null);
  const [visibleBounds, setVisibleBounds] = useState<VisibleBounds>({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const updateVisibleBounds = useCallback((el: HTMLElement) => {
    const measured = measureVisibleBounds(el);
    setVisibleBounds((current) => (sameVisibleBounds(current, measured) ? current : measured));
    return measured;
  }, []);
  // Range frames fetched on demand for drilldown during instant queries (cached per panel)
  const [drillFrames, setDrillFrames] = useState<DataFrame[] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(false);
  const drillCacheId = useRef<string | undefined>(undefined);
  // Requery generation token. Advanced every time requestId changes, used to decide whether to discard responses from stale in-flight requests
  const drillGen = useRef(0);

  const targetRefIds = useMemo(
    () => (data.request?.targets ?? []).map((t) => t.refId).filter((r): r is string => Boolean(r)),
    [data.request]
  );
  const model = useMemo(
    () => buildModel(data.series, options, theme, timeZone, targetRefIds),
    [data.series, options, theme, timeZone, targetRefIds]
  );

  // displayMode was already registered in Task 14, but dashboards saved before that registration lack the key. Normalize it to single by default
  const displayMode = options.displayMode ?? 'single';
  // Align the split determination with renderer (draws zones when metricInfos>0). A refId with 0 series has no MetricInfo and is excluded from zones/legend
  const isSplit = displayMode === 'split' && model.metricInfos.length > 0;
  // The range is part of the panel's visual encoding, so reserve header space even when only one metric is available.
  const showHeader = true;
  // Measure the actual header height and subtract it from the canvas area. Prevents overlap even when the legend wraps past 32px with many metrics.
  // In environments where measurement isn't possible (jsdom), fall back to HEADER_H. Track changes with ResizeObserver since wrapping changes with width.
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = showHeader ? headerRef.current : null;
    const measure = () => {
      // Sync the actual DOM measurement after layout is finalized into React state (measure-then-set).
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
  // If there's a warning (e.g. partial exclusion), also subtract the banner height
  const warnH = model.warnings.length > 0 ? WARN_H : 0;
  const bodyH = Math.max(0, height - headerH - warnH);

  useLayoutEffect(() => {
    if (!scrollElement) {
      return undefined;
    }
    const measure = () => updateVisibleBounds(scrollElement);
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(scrollElement);
      return () => observer.disconnect();
    }
    return undefined;
  }, [scrollElement, width, bodyH, updateVisibleBounds]);

  const layout = useMemo(
    () => computeLayout(model.root, options.levels, width, bodyH),
    [model.root, options.levels, width, bodyH]
  );
  const selectedRefId = selected && model.refIds.includes(selected) ? selected : (model.refIds[0] ?? 'A');
  const selectedMetricInfo = model.metricInfos.find((info) => info.refId === selectedRefId);

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

  // When panel data updates, discard the cache/error/loading state and advance the generation (cache is invalidated per panel via requestId).
  // Advancing the generation ensures that responses from stale in-flight requests (success/failure/finally) are reliably discarded by the guard downstream.
  // Loading is also reset, so even if a stale request's finally is skipped by the guard, the new loading state doesn't get stuck (no deadlock).
  useEffect(() => {
    if (data.request?.requestId !== drillCacheId.current) {
      drillGen.current += 1;
      setDrillFrames(null);
      setDrillError(false);
      setDrillLoading(false);
    }
  }, [data.request?.requestId]);

  // When the popover opens, requery (once per refresh) if there's a metric from an instant query with no time series on hand.
  // Don't requery for range-only cases (range data may already be on hand). The drillError guard prevents a retry loop on failure.
  // The response captures the generation at fetch start, and is only applied when it matches the generation at arrival time; otherwise it's discarded as stale.
  useEffect(() => {
    if (!popover || drillFrames || drillLoading || drillError || !data.request) {
      return;
    }
    // No requery needed if the data on hand comes from a range query. Only run it when there's an instant target
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
    // Intentional async fetch triggered from the popover. loading is both the in-progress UI and a re-entrancy guard, so it must be set synchronously
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrillLoading(true);
    fetchDrilldownFrames(data.request)
      .then((frames) => {
        if (drillGen.current !== gen) {
          return; // Discard stale responses that arrive after requestId has changed
        }
        drillCacheId.current = requestId;
        setDrillFrames(frames);
      })
      .catch(() => {
        if (drillGen.current !== gen) {
          return; // Don't reflect an old request's failure into the new error state
        }
        setDrillError(true);
      })
      .finally(() => {
        if (drillGen.current !== gen) {
          return; // Don't let an old request's finally clear the new loading state
        }
        setDrillLoading(false);
      });
  }, [popover, drillFrames, drillLoading, drillError, data, model.metricInfos, options.spatialAggregation]);

  // Close the popover/menu on Esc or an outside pointer-down (the popover side guards with stopPropagation)
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

  // Link execution: for links that carry a LinkModel.onClick (e.g. in-panel SPA navigation), prefer that
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
    return <p>Please configure hierarchy levels in the panel options.</p>;
  }
  // When no cells qualify for rendering at all, don't silently show an empty canvas — state the reason explicitly.
  // If there's a warning, show it; otherwise show a data error to the effect of "unable to build numeric cells" (spec: never silently show an empty display).
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
            Could not build numeric cells from the query results. Check that your queries return numeric values and that
            the hierarchy levels match your labels.
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      {showHeader && (
        <div
          ref={headerRef}
          style={{ minHeight: HEADER_H, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
          {isSplit ? (
            // In split mode, each position entry carries its own metric range.
            <SplitLegend metricInfos={model.metricInfos} rangeInfosByRef={model.rangeInfosByRef} />
          ) : (
            <>
              {model.refIds.length > 1 && (
                <RadioButtonGroup
                  size="sm"
                  // Choices are based on refId. A 0-series query has no metricInfo, so it falls back to using the refId as the display name
                  options={model.refIds.map((refId) => ({
                    value: refId,
                    label: model.metricInfos.find((m) => m.refId === refId)?.name ?? refId,
                  }))}
                  value={selectedRefId}
                  onChange={setSelected}
                />
              )}
              <RangeLegend
                metricInfo={selectedMetricInfo}
                metricName={selectedRefId}
                width={width}
                rangeInfos={selectedMetricInfo ? model.rangeInfosByRef.get(selectedMetricInfo.refId) : undefined}
              />
            </>
          )}
        </div>
      )}
      {model.warnings.length > 0 && (
        // Always show warnings (e.g. partial exclusion) even when cells render successfully. Keep it to a single-line banner so it isn't intrusive.
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
        ref={setScrollRef}
        style={{
          width,
          height: bodyH,
          position: 'relative',
          overflowY: layout.scrollable ? 'auto' : 'hidden',
          // For configurations that don't fit within the width even at S_MIN (e.g. too many columns), prevent clipping with horizontal scroll
          overflowX: layout.contentWidth > width ? 'auto' : 'hidden',
        }}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // Close it because scrolling would make the held coordinates diverge from reality
          setPopover(null);
          setLinkMenu(null);
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // Both hitTest and the tooltip are handled in the scroll container's content coordinate system.
          // The absolutely-positioned tooltip child is placed in content coordinates, and hitTest's hit detection also uses content coordinates, so
          // failing to account for the scroll amounts (scrollTop/scrollLeft) causes wrong-cell detection and misplacement while scrolling.
          const cx = e.clientX - rect.left + e.currentTarget.scrollLeft;
          const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
          const hit = hitTest(layout, cx, cy);
          setHover(hit ? { cell: hit.cell, x: cx, y: cy } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // Hit-test clicks in the same content coordinate system as hover (including scrollLeft/scrollTop)
          const cx = e.clientX - rect.left + e.currentTarget.scrollLeft;
          const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
          const hit = hitTest(layout, cx, cy);
          if (!hit) {
            setPopover(null);
            setLinkMenu(null);
            return;
          }
          // In split mode, target the metric of the clicked zone for the link
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
          // Data Links take priority: only fields with getLinks return links (the contract is the presence of getLinks, not config.links length).
          // Search across all original label sets, including those from extraction-key collisions.
          const links = getCellLinks(
            data.series,
            clickRefId,
            hit.cell.labelSets ?? hit.cell.labels,
            v != null && info ? cellRangeFor(hit.cell, info).processor(v) : undefined
          );
          if (links.length === 1) {
            followLink(links[0], e);
            return;
          }
          // Measure now for immediate first placement; subsequent commits and ResizeObserver callbacks keep these shared bounds current.
          updateVisibleBounds(e.currentTarget);
          if (links.length > 1) {
            // Show a selection menu for multiple links (clamped to the same visible range as the popover)
            setLinkMenu({ links, x: cx, y: cy });
            setPopover(null);
            return;
          }
          // If there are no links, show a popover with a sparkline from the range data on hand
          setLinkMenu(null);
          setPopover({ cell: hit.cell, x: cx, y: cy });
        }}
      >
        <canvas ref={canvasRef} />
        {hover && (
          <CellTooltip
            cell={hover.cell}
            metricInfos={model.metricInfos}
            missingColor={options.missingColor}
            tooltipLabels={options.tooltipLabels}
            x={hover.x}
            y={hover.y}
            minX={visibleBounds.minX}
            minY={visibleBounds.minY}
            maxX={visibleBounds.maxX}
            maxY={visibleBounds.maxY}
          />
        )}
        {popover && (
          <DrilldownPopover
            cell={popover.cell}
            metricInfos={model.metricInfos}
            // First compose using the range data on hand; if unavailable, compose using the requeried frame (for instant queries)
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
            minX={visibleBounds.minX}
            minY={visibleBounds.minY}
            maxX={visibleBounds.maxX}
            maxY={visibleBounds.maxY}
            onClose={() => setPopover(null)}
          />
        )}
        {linkMenu &&
          (() => {
            // Deterministically compute the menu height assuming border-box (fixing row height, padding, and border).
            const contentH = linkMenu.links.length * LINK_MENU_ROW_H + LINK_MENU_PAD * 2 + LINK_MENU_BORDER * 2;
            // Clamp a menu taller than the visible range to the visible height, and make all links reachable via internal scroll.
            const availH = Math.max(0, visibleBounds.maxY - visibleBounds.minY);
            const menuH = Math.min(contentH, availH);
            const availableWidth = Math.max(0, visibleBounds.maxX - visibleBounds.minX);
            const menuW = Math.min(LINK_MENU_W, availableWidth);
            const fitsHorizontalChrome = menuW >= (LINK_MENU_PAD + LINK_MENU_BORDER) * 2;
            const horizontalBorder = fitsHorizontalChrome ? LINK_MENU_BORDER : 0;
            const horizontalPadding = fitsHorizontalChrome ? LINK_MENU_PAD : 0;
            // Prevent right/bottom overflow with the same flip + visible-range clamp as the popover
            const { left, top } = placeOverlay(linkMenu.x, linkMenu.y, menuW, menuH, visibleBounds);
            return (
              <div
                role="menu"
                onPointerDown={(e) => e.stopPropagation()}
                // Prevent a click inside the menu from propagating to the container's onClick and triggering hitTest → reopening
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width: menuW,
                  maxHeight: menuH,
                  overflowY: contentH > menuH ? 'auto' : 'hidden',
                  boxSizing: 'border-box',
                  zIndex: 30,
                  // Use theme-derived colors instead of a fixed dark color, so it's readable in both light and dark
                  background: theme.colors.background.elevated ?? theme.colors.background.secondary,
                  color: theme.colors.text.primary,
                  border: `${LINK_MENU_BORDER}px solid ${theme.colors.border.medium}`,
                  borderLeftWidth: horizontalBorder,
                  borderRightWidth: horizontalBorder,
                  borderRadius: 4,
                  padding: `${LINK_MENU_PAD}px ${horizontalPadding}px`,
                  boxShadow: theme.shadows.z3,
                }}
              >
                {linkMenu.links.map((l, i) => (
                  <a
                    // May hold semantically different links with the same href, so include the index to make the key unique
                    key={`${i}-${l.href}`}
                    href={l.href}
                    target={l.target}
                    // Links carrying onClick (e.g. SPA navigation) are also executed via followLink, same as a single link
                    onClick={(e) => {
                      e.preventDefault();
                      followLink(l, e);
                      setLinkMenu(null);
                    }}
                    style={{
                      // Fix the row height to match the menu height calculation (single line, truncated display)
                      display: 'block',
                      height: LINK_MENU_ROW_H,
                      lineHeight: `${LINK_MENU_ROW_H}px`,
                      boxSizing: 'border-box',
                      padding: '0 8px',
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
