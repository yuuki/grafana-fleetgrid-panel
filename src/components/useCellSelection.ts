import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CellModel, HierarchyNode, LevelDef } from '../types';
import { LayoutResult } from '../layout/layout';
import { cellsInRect, hitTest, labelAt, Rect, rectFromPoints } from '../render/hitTest';
import {
  addCells,
  CellSelection,
  EMPTY_SELECTION,
  groupCells,
  indexCells,
  resolveSelection,
  ResolvedSelection,
  toggleCell,
  toggleGroup,
} from '../selection/selection';

/** Distance in CSS px a Shift press travels before it is a rectangle drag and no longer a click. */
export const DRAG_THRESHOLD = 4;

// One Shift press, from pointer-down to pointer-up. Kept in a ref: a pointer move must not render.
interface Gesture {
  pointerId: number;
  /** Where the press started, in content coordinates: it scrolls with the grid. */
  x: number;
  y: number;
  /** Where the press started and where the pointer is now, in client coordinates. */
  downClientX: number;
  downClientY: number;
  clientX: number;
  clientY: number;
  dragging: boolean;
}

function contentPoint(container: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const box = container.getBoundingClientRect();
  return { x: clientX - box.left + container.scrollLeft, y: clientY - box.top + container.scrollTop };
}

/** The pointer and keyboard side of the selection, for the panel's event handlers. */
export interface SelectionGestures {
  /** Handlers for the scroll container. */
  containerProps: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture' | 'onMouseDown'
  >;
  /** Whether a Shift press is in progress. The hover tooltip stays away meanwhile. */
  isGesturing: () => boolean;
  /** True, once, for the click event that a Shift press ends with: that click is not a plain click. */
  consumeClick: () => boolean;
  /** The container scrolled: the band follows, because its start point scrolls with the grid. */
  onScroll: (container: HTMLElement) => void;
  /** Escape clears the selection, unless an overlay is open and takes this key press. */
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>, overlayOpen: boolean) => void;
}

export interface CellSelectionApi {
  /** The selection split into present selected cells and the rest; undefined while nothing is selected. */
  resolved: ResolvedSelection | undefined;
  /** The selected cells of the current data, for the renderer; undefined while nothing is selected. */
  selectedSet: ReadonlySet<CellModel> | undefined;
  gestures: SelectionGestures;
  /** The rubber band element, positioned by the hook while a rectangle is dragged. */
  bandRef: React.RefObject<HTMLDivElement>;
  /** The selection bar, which receives keyboard focus after a pointer gesture. */
  barRef: React.RefObject<HTMLDivElement>;
  clear: () => void;
}

/**
 * Viewer-local cell selection and the pointer gestures that edit it. Every gesture starts with a
 * Shift press of the primary button (mouse or pen):
 *
 *   Shift+click a cell          toggles the cell
 *   Shift+click a group label   toggles the group's cells as one unit
 *   Shift+drag                  adds the cells the rectangle overlaps
 *
 * Shift is read at pointer-down only, so releasing the key before the button changes nothing. The
 * rubber band is moved by writing to its element directly: a pointer move renders nothing, runs no
 * layout and does not repaint the canvas. The selection changes once, at pointer-up.
 */
export function useCellSelection(
  root: HierarchyNode,
  layout: LayoutResult,
  levels: LevelDef[],
  onGestureStart: () => void
): CellSelectionApi {
  const [selection, setSelection] = useState<CellSelection>(EMPTY_SELECTION);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  // Counts finished gestures. It is state so that every gesture renders once, even one that selects
  // nothing new, and the focus effect below runs for exactly that gesture.
  const [gesturesDone, setGesturesDone] = useState(0);
  const bandRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Cell keys are hierarchy paths. They name other cells, or none, once the levels change.
  const levelsKey = useMemo(() => JSON.stringify(levels), [levels]);
  const selectionLevels = useRef(levelsKey);
  useEffect(() => {
    if (selectionLevels.current !== levelsKey) {
      selectionLevels.current = levelsKey;
      setSelection(EMPTY_SELECTION);
    }
  }, [levelsKey]);

  // Indexing every cell by key costs a pass over the grid, so it waits until something is selected.
  const resolved = useMemo(
    () => (selection.size === 0 ? undefined : resolveSelection(indexCells(root), selection)),
    [root, selection]
  );

  const moveBand = (container: HTMLElement) => {
    const current = gesture.current;
    const band = bandRef.current;
    if (!current?.dragging || !band) {
      return;
    }
    const pointer = contentPoint(container, current.clientX, current.clientY);
    const drawn = clampRect(rectFromPoints(current.x, current.y, pointer.x, pointer.y), {
      x: 0,
      y: 0,
      w: Math.max(layout.contentWidth, container.clientWidth),
      h: Math.max(layout.contentHeight, container.clientHeight),
    });
    band.style.display = 'block';
    band.style.left = `${drawn.x}px`;
    band.style.top = `${drawn.y}px`;
    band.style.width = `${drawn.w}px`;
    band.style.height = `${drawn.h}px`;
    const count = cellsInRect(layout, rectFromPoints(current.x, current.y, pointer.x, pointer.y)).length;
    if (band.firstElementChild) {
      band.firstElementChild.textContent = count === 1 ? '1 cell' : `${count} cells`;
    }
  };

  const clear = useCallback(() => setSelection(EMPTY_SELECTION), []);

  // Ends the press without selecting anything.
  const abort = useCallback(() => {
    gesture.current = null;
    if (bandRef.current) {
      bandRef.current.style.display = 'none';
    }
  }, []);

  // Escape during a press abandons it, whatever has the keyboard focus, and goes no further: the same
  // key press must not also clear the selection or leave Grafana's panel view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) {
        event.stopPropagation();
        abort();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [abort]);

  // After a pointer gesture the selection bar takes the focus, so Escape and Tab continue from there.
  useLayoutEffect(() => {
    if (gesturesDone > 0) {
      barRef.current?.focus({ preventScroll: true });
    }
  }, [gesturesDone]);

  const finish = (container: HTMLElement) => {
    const current = gesture.current;
    if (!current) {
      return;
    }
    abort();
    setGesturesDone((count) => count + 1);
    if (current.dragging) {
      const pointer = contentPoint(container, current.clientX, current.clientY);
      const hits = cellsInRect(layout, rectFromPoints(current.x, current.y, pointer.x, pointer.y));
      const cells = hits.map((hit) => hit.cell);
      setSelection((previous) => addCells(previous, cells));
      return;
    }
    // A group label is tested before the cells: the pinned top label covers the cells under it.
    const label = labelAt(layout, current.x, current.y, container.scrollTop);
    if (label) {
      const cells = groupCells(root, label.path);
      setSelection((previous) => toggleGroup(previous, cells));
      return;
    }
    const hit = hitTest(layout, current.x, current.y);
    if (hit) {
      setSelection((previous) => toggleCell(previous, hit.cell));
    }
  };

  const containerProps: SelectionGestures['containerProps'] = {
    onMouseDown: (event) => {
      // A Shift press would extend the page's text selection and could start a native drag.
      if (event.shiftKey && event.button === 0) {
        event.preventDefault();
      }
    },
    onPointerDown: (event) => {
      abort();
      const container = event.currentTarget;
      const box = container.getBoundingClientRect();
      // A press on the container's own scrollbar is outside its client box and stays a scrollbar press.
      const onContent =
        event.clientX - box.left < (container.clientWidth || Infinity) &&
        event.clientY - box.top < (container.clientHeight || Infinity);
      // Touch has no Shift key, and a touch drag scrolls the grid.
      const starts = event.shiftKey && event.button === 0 && event.pointerType !== 'touch' && onContent;
      // The click that ends this press belongs to the gesture, also when the gesture is abandoned.
      swallowClick.current = starts;
      if (!starts) {
        return;
      }
      const point = contentPoint(container, event.clientX, event.clientY);
      gesture.current = {
        pointerId: event.pointerId,
        x: point.x,
        y: point.y,
        downClientX: event.clientX,
        downClientY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        dragging: false,
      };
      try {
        // Keeps the moves and the release coming when the pointer leaves the panel or the window.
        container.setPointerCapture?.(event.pointerId);
      } catch {
        // No such active pointer (a synthetic event): the gesture then ends where it leaves the grid.
      }
      onGestureStart();
    },
    onPointerMove: (event) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) {
        return;
      }
      current.clientX = event.clientX;
      current.clientY = event.clientY;
      const travelled = Math.hypot(event.clientX - current.downClientX, event.clientY - current.downClientY);
      if (!current.dragging && travelled < DRAG_THRESHOLD) {
        return;
      }
      current.dragging = true;
      moveBand(event.currentTarget);
    },
    onPointerUp: (event) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) {
        return;
      }
      current.clientX = event.clientX;
      current.clientY = event.clientY;
      finish(event.currentTarget);
    },
    // The browser took the pointer away (context menu, window switch): nothing is selected.
    onPointerCancel: abort,
    onLostPointerCapture: abort,
  };

  const gestures: SelectionGestures = {
    containerProps,
    isGesturing: () => gesture.current !== null,
    consumeClick: () => {
      const swallow = swallowClick.current;
      swallowClick.current = false;
      return swallow;
    },
    onScroll: moveBand,
    onKeyDown: (event, overlayOpen) => {
      // A portal (the comparison drawer) bubbles its events here through React, not through the DOM.
      const inside = event.target instanceof Node && event.currentTarget.contains(event.target);
      if (event.key !== 'Escape' || selection.size === 0 || overlayOpen || !inside) {
        return;
      }
      // This key press is used up: Grafana must not also leave the panel view.
      event.stopPropagation();
      setSelection(EMPTY_SELECTION);
    },
  };

  return { resolved, selectedSet: resolved?.selectedSet, gestures, bandRef, barRef, clear };
}

/** Height of the selection bar on one line, used where the real height cannot be measured (jsdom). */
export const SELECTION_BAR_H = 32;

/**
 * The height the selection bar takes from the grid's box: its rendered height while cells are
 * selected, kept current while it wraps or unwraps, and 0 otherwise. With Auto Grid fit-content it
 * is always 0, because the panel then grows by the bar instead.
 */
export function useSelectionBarHeight(
  barRef: React.RefObject<HTMLElement>,
  resolved: ResolvedSelection | undefined,
  fitContent: boolean | undefined
): number {
  const present = resolved !== undefined && !fitContent;
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = present ? barRef.current : null;
    // Sync the DOM measurement into state after layout (measure-then-set), before the browser paints.
    const measure = () => setHeight(element ? element.offsetHeight || SELECTION_BAR_H : 0);
    measure();
    if (element && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    return undefined;
  }, [barRef, present]);
  // The state still holds the old height in the render that removes the bar.
  return present ? height : 0;
}

function clampRect(rect: Rect, bounds: Rect): Rect {
  const x1 = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.w);
  const y1 = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.h);
  const x2 = Math.min(Math.max(rect.x + rect.w, bounds.x), bounds.x + bounds.w);
  const y2 = Math.min(Math.max(rect.y + rect.h, bounds.y), bounds.y + bounds.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
