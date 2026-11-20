import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { Button, FieldValidationMessage, IconButton, InlineField, InlineFieldRow, Input } from '@grafana/ui';
import { frameHasRefId, flowRefId } from '../data/edges';
import { FleetGridOptions, FlowEndpointMapping } from '../types';
import { collectRangeOverrideSuggestions } from './suggestions';

const EMPTY_MAPPING: FlowEndpointMapping = { level: '', source: '', destination: '' };

function normalizeMapping(value: unknown): FlowEndpointMapping {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return { level: text(record.level), source: text(record.source), destination: text(record.destination) };
}

/** Why a mapping cannot be used, in the order the fields appear; empty when it is valid. */
export function validateFlowEndpoint(mapping: FlowEndpointMapping, hierarchyLabels: string[]): string[] {
  const errors: string[] = [];
  if (!mapping.level.trim()) {
    errors.push('Hierarchy label is required.');
  } else if (!hierarchyLabels.includes(mapping.level)) {
    errors.push(`"${mapping.level}" is not a hierarchy label.`);
  }
  if (!mapping.source.trim()) {
    errors.push('Source label is required.');
  }
  if (!mapping.destination.trim()) {
    errors.push('Destination label is required.');
  }
  if (mapping.source.trim() && mapping.source === mapping.destination) {
    errors.push('Source and destination must be different labels.');
  }
  return errors;
}

type Props = StandardEditorProps<FlowEndpointMapping[], unknown, FleetGridOptions>;

export const FlowEndpointsEditor: React.FC<Props> = ({ value, onChange, context }) => {
  const mappings = Array.isArray(value) ? value.map(normalizeMapping) : [];
  const hierarchyLabels = [...new Set((context.options?.levels ?? []).map((level) => level.label))].filter(Boolean);
  const refId = flowRefId(context.options ?? {});
  // Only the edge query's own labels are useful suggestions for the source and destination labels.
  const edgeLabels = React.useMemo(
    () =>
      Object.keys(
        collectRangeOverrideSuggestions((context.data ?? []).filter((frame) => frameHasRefId(frame, refId)))
          .valuesByLabel
      ),
    [context.data, refId]
  );
  const instanceId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const levelListId = `flow-levels-${instanceId}`;
  const labelListId = `flow-labels-${instanceId}`;

  const update = (index: number, patch: Partial<FlowEndpointMapping>) => {
    onChange(mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)));
  };

  return (
    <div>
      <datalist id={levelListId}>
        {hierarchyLabels.map((label) => (
          <option value={label} key={label} />
        ))}
      </datalist>
      <datalist id={labelListId}>
        {edgeLabels.map((label) => (
          <option value={label} key={label} />
        ))}
      </datalist>
      <div style={{ marginBottom: 12, opacity: 0.8 }}>
        Labels of query {refId || '(not set)'}: {edgeLabels.join(', ') || 'None'}
      </div>
      {mappings.map((mapping, index) => (
        <div key={index} data-testid={`flow-endpoint-${index}`} style={{ marginBottom: 8 }}>
          <InlineFieldRow>
            <InlineField label="Hierarchy label" labelWidth={16}>
              <Input
                aria-label={`Hierarchy label ${index + 1}`}
                list={levelListId}
                value={mapping.level}
                onChange={(event) => update(index, { level: event.currentTarget.value })}
                width={20}
              />
            </InlineField>
            <IconButton
              name="trash-alt"
              data-testid={`remove-flow-endpoint-${index}`}
              aria-label={`Remove endpoint mapping ${index + 1}`}
              tooltip="Remove mapping"
              onClick={() => onChange(mappings.filter((_, i) => i !== index))}
            />
          </InlineFieldRow>
          <InlineFieldRow>
            <InlineField label="Source label" labelWidth={16}>
              <Input
                aria-label={`Source label ${index + 1}`}
                list={labelListId}
                value={mapping.source}
                onChange={(event) => update(index, { source: event.currentTarget.value })}
                width={20}
              />
            </InlineField>
          </InlineFieldRow>
          <InlineFieldRow>
            <InlineField label="Destination label" labelWidth={16}>
              <Input
                aria-label={`Destination label ${index + 1}`}
                list={labelListId}
                value={mapping.destination}
                onChange={(event) => update(index, { destination: event.currentTarget.value })}
                width={20}
              />
            </InlineField>
          </InlineFieldRow>
          {validateFlowEndpoint(mapping, hierarchyLabels).map((error) => (
            <FieldValidationMessage key={error}>{error}</FieldValidationMessage>
          ))}
        </div>
      ))}
      <Button icon="plus" variant="secondary" onClick={() => onChange([...mappings, { ...EMPTY_MAPPING }])}>
        Add endpoint mapping
      </Button>
    </div>
  );
};
