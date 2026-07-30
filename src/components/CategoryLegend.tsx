import React, { useEffect, useState } from 'react';
import { CategoryModel } from '../data/categories';

// Touch has no hover state, so a tap must never seed a hover preview; mouse and pen do hover. An unknown or
// empty pointerType (some engines/test envs omit it) is treated as hoverable, matching the mouse fallback.
export const hoverablePointer = (pointerType: string): boolean => pointerType !== 'touch';

interface CategoryLegendProps {
  category: CategoryModel;
  selectedValues: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  /** Fires with the effective highlight value (pointer over focus), or undefined when neither is on a chip. */
  onHover: (value: string | undefined) => void;
}

const CategoryLegendComponent: React.FC<CategoryLegendProps> = ({
  category,
  selectedValues,
  onToggle,
  onClear,
  onHover,
}) => {
  // Preview state machine, driven by three signals:
  //  - pointerValue: the chip the (non-touch) pointer is currently over.
  //  - focusValue:   the chip that currently holds DOM focus.
  //  - lastModality: whether the most recent interaction was a pointer or the keyboard.
  // The effective preview is `pointerValue ?? (lastModality === 'keyboard' ? focusValue : undefined)`. Focus is
  // only a preview under keyboard modality (i.e. focus-visible), so a click — which focuses the button under
  // pointer modality — never leaves a preview stuck on after the pointer leaves, and touch focus (which also
  // arrives under pointer modality) is ignored too.
  const [pointerValue, setPointerValue] = useState<string | undefined>(undefined);
  const [focusValue, setFocusValue] = useState<string | undefined>(undefined);
  const [lastModality, setLastModality] = useState<'pointer' | 'keyboard'>('pointer');
  useEffect(() => {
    // Track the input modality globally (capture, so it settles before the ensuing focus event): any keydown
    // is keyboard intent (focus-visible), any pointerdown is pointer intent.
    const onKey = () => setLastModality('keyboard');
    const onPointer = () => setLastModality('pointer');
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
  // A chip that unmounts (its value dropped from the model) fires no leave/blur, so drop any pointer or focus
  // value that no longer exists — otherwise a stale value would suppress a genuine later re-hover.
  // Guarded, so each branch settles in one pass rather than cascading.
  useEffect(() => {
    if (pointerValue !== undefined && !category.colorByValue.has(pointerValue)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPointerValue(undefined);
    }
    if (focusValue !== undefined && !category.colorByValue.has(focusValue)) {
      setFocusValue(undefined);
    }
  }, [category, pointerValue, focusValue]);
  const effective = pointerValue ?? (lastModality === 'keyboard' ? focusValue : undefined);
  // onHover is the parent's stable state setter, so this fires only when the effective value actually changes.
  useEffect(() => {
    onHover(effective);
  }, [effective, onHover]);

  return (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
    {category.values.map((value) => (
      <button
        type="button"
        key={value}
        data-testid={`category-legend-${value}`}
        aria-pressed={selectedValues.includes(value)}
        onClick={() => onToggle(value)}
        // Hover is pointer-driven and excludes touch (a tap must not leave a hover preview). Compatibility
        // mouse events are ignored since we never listen for them.
        onPointerEnter={(e) => {
          if (hoverablePointer(e.pointerType)) {
            setPointerValue(value);
          }
        }}
        onPointerLeave={() => setPointerValue((current) => (current === value ? undefined : current))}
        onPointerCancel={() => setPointerValue((current) => (current === value ? undefined : current))}
        onFocus={() => setFocusValue(value)}
        onBlur={() => setFocusValue((current) => (current === value ? undefined : current))}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          border: 0,
          padding: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          opacity: selectedValues.length > 0 && !selectedValues.includes(value) ? 0.6 : 1,
        }}
      >
        <span
          aria-hidden
          style={{ width: 10, height: 10, background: category.colorByValue.get(value), display: 'inline-block' }}
        />
        <span>{value}</span>
      </button>
    ))}
    {selectedValues.length > 0 && (
      <button
        type="button"
        data-testid="category-legend-clear"
        onClick={onClear}
        style={{ border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
      >
        Clear
      </button>
    )}
  </div>
  );
};

export const CategoryLegend = React.memo(CategoryLegendComponent);
