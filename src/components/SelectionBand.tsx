import React from 'react';
import { useTheme2 } from '@grafana/ui';

/**
 * The rubber band of a Shift+drag, with the number of cells it covers. It is rendered once, hidden;
 * `useCellSelection` shows and moves it by writing to the element, so a pointer move does not render.
 * The style below holds no position: React then never resets what the hook wrote.
 */
export const SelectionBand = React.forwardRef<HTMLDivElement>(function SelectionBand(_props, ref) {
  const theme = useTheme2();
  return (
    <div
      ref={ref}
      data-testid="selection-band"
      aria-hidden
      style={{
        display: 'none',
        position: 'absolute',
        boxSizing: 'border-box',
        zIndex: 5,
        pointerEvents: 'none',
        border: `1px dashed ${theme.colors.text.maxContrast}`,
        background: theme.colors.action.selected,
      }}
    >
      <span
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          padding: '0 4px',
          fontSize: 11,
          whiteSpace: 'nowrap',
          color: theme.colors.text.primary,
          background: theme.colors.background.primary,
        }}
      />
    </div>
  );
});
