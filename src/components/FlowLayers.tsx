import React from 'react';
import { FLOW_DIM_OPACITY } from '../render/flowRenderer';

const LAYER_STYLE: React.CSSProperties = { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' };

export interface FlowLayersProps {
  /** Whether an edge query is named. The canvases exist only then. */
  active: boolean;
  restRef: React.RefObject<HTMLCanvasElement>;
  focusRef: React.RefObject<HTMLCanvasElement>;
  /** Whether arcs are in focus: the arcs at rest are then dimmed. */
  focused: boolean;
}

/**
 * The flow overlay's canvases, stacked on the cell canvas in the same content coordinates: the arcs at
 * rest and the arcs in focus. The arcs at rest are dimmed with CSS, which the browser composites without
 * painting. Pointer events pass through both canvases, so hover and click still reach the cells.
 */
export const FlowLayers: React.FC<FlowLayersProps> = ({ active, restRef, focusRef, focused }) => {
  if (!active) {
    return null;
  }
  return (
    <>
      <canvas
        ref={restRef}
        data-testid="flow-overlay"
        aria-hidden
        style={{ ...LAYER_STYLE, opacity: focused ? FLOW_DIM_OPACITY : 1 }}
      />
      <canvas ref={focusRef} data-testid="flow-focus" aria-hidden style={LAYER_STYLE} />
    </>
  );
};
