import React, { useState } from 'react';
import { StandardEditorProps } from '@grafana/data';
import { Input } from '@grafana/ui';
import { MAX_FLOW_ARCS, normalizeFlowRestArcs } from '../data/edges';

/**
 * The number of arcs drawn at rest. The stored value is always a whole number from 1 to MAX_FLOW_ARCS:
 * what is typed is normalized when the field is left (or Enter is pressed), and the normalized number is
 * both shown and stored. A standard number input showed the limited number but stored the typed one.
 */
export const FlowRestArcsEditor: React.FC<StandardEditorProps<number | undefined>> = ({ value, onChange }) => {
  // The text while the field is being edited; null shows the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const stored = normalizeFlowRestArcs(value);
  const commit = () => {
    if (draft === null) {
      return;
    }
    const next = normalizeFlowRestArcs(draft.trim() === '' ? undefined : Number(draft));
    setDraft(null);
    if (next !== value) {
      onChange(next);
    }
  };
  return (
    <Input
      type="number"
      aria-label="Arcs at rest"
      min={1}
      max={MAX_FLOW_ARCS}
      step={1}
      width={12}
      value={draft ?? String(stored)}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        }
      }}
    />
  );
};
