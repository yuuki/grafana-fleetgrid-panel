import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FieldType, StandardEditorProps, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions, FlowEndpointMapping } from '../types';
import { FlowEndpointsEditor, validateFlowEndpoint } from './FlowEndpointsEditor';

const cells = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'zone', type: FieldType.string, values: ['zone-a'] },
    { name: 'host', type: FieldType.string, values: ['node-a1'] },
    { name: 'power', type: FieldType.number, values: [1] },
  ],
});
const edges = toDataFrame({
  refId: 'E',
  fields: [
    { name: 'src_host', type: FieldType.string, values: ['node-a1'] },
    { name: 'dst_host', type: FieldType.string, values: ['node-a2'] },
    { name: 'loss', type: FieldType.number, values: [1] },
  ],
});

const panelOptions = {
  levels: [
    { ...DEFAULT_LEVEL, label: 'zone' },
    { ...DEFAULT_LEVEL, label: 'host' },
  ],
  flowRefId: 'E',
} as FleetGridOptions;

type Props = StandardEditorProps<FlowEndpointMapping[], unknown, FleetGridOptions>;

const props = (value: FlowEndpointMapping[] | undefined, onChange: Props['onChange']): Props => ({
  value: value as FlowEndpointMapping[],
  onChange,
  context: { data: [cells, edges], options: panelOptions },
  item: { id: 'flowEndpoints', name: 'flowEndpoints' } as Props['item'],
});

const hostMapping: FlowEndpointMapping = { level: 'host', source: 'src_host', destination: 'dst_host' };

describe('validateFlowEndpoint', () => {
  it('accepts a complete mapping of a hierarchy label', () => {
    expect(validateFlowEndpoint(hostMapping, ['zone', 'host'])).toEqual([]);
  });

  it('reports each reason a mapping cannot be used', () => {
    expect(validateFlowEndpoint({ level: '', source: '', destination: '' }, ['host'])).toEqual([
      'Hierarchy label is required.',
      'Source label is required.',
      'Destination label is required.',
    ]);
    expect(validateFlowEndpoint({ ...hostMapping, level: 'rack' }, ['host'])).toEqual([
      '"rack" is not a hierarchy label.',
    ]);
    expect(validateFlowEndpoint({ ...hostMapping, destination: 'src_host' }, ['host'])).toEqual([
      'Source and destination must be different labels.',
    ]);
  });
});

describe('FlowEndpointsEditor', () => {
  it('adds, edits and removes a mapping', () => {
    const onChange = jest.fn();
    const view = render(<FlowEndpointsEditor {...props([], onChange)} />);
    fireEvent.click(screen.getByRole('button', { name: /Add endpoint mapping/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ level: '', source: '', destination: '' }]);

    view.rerender(<FlowEndpointsEditor {...props([{ level: 'host', source: '', destination: '' }], onChange)} />);
    fireEvent.change(screen.getByLabelText('Source label 1'), { target: { value: 'src_host' } });
    expect(onChange).toHaveBeenLastCalledWith([{ level: 'host', source: 'src_host', destination: '' }]);
    fireEvent.change(screen.getByLabelText('Destination label 1'), { target: { value: 'dst_host' } });
    expect(onChange).toHaveBeenLastCalledWith([{ level: 'host', source: '', destination: 'dst_host' }]);
    fireEvent.change(screen.getByLabelText('Hierarchy label 1'), { target: { value: 'zone' } });
    expect(onChange).toHaveBeenLastCalledWith([{ level: 'zone', source: '', destination: '' }]);

    fireEvent.click(screen.getByTestId('remove-flow-endpoint-0'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('suggests the hierarchy labels and the labels of the edge query only', () => {
    render(<FlowEndpointsEditor {...props([hostMapping], jest.fn())} />);
    expect(screen.getByText('Labels of query E: dst_host, src_host')).toBeInTheDocument();
    const options = [...document.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'));
    expect(options).toEqual(['zone', 'host', 'dst_host', 'src_host']);
  });

  it('shows why a mapping cannot be used', () => {
    render(<FlowEndpointsEditor {...props([{ level: 'rack', source: 'src_host', destination: '' }], jest.fn())} />);
    expect(screen.getByText('"rack" is not a hierarchy label.')).toBeInTheDocument();
    expect(screen.getByText('Destination label is required.')).toBeInTheDocument();
  });

  it('tolerates a missing or malformed stored value', () => {
    render(<FlowEndpointsEditor {...props(undefined, jest.fn())} />);
    expect(screen.queryByTestId('flow-endpoint-0')).not.toBeInTheDocument();
    render(<FlowEndpointsEditor {...props([null, { level: 5 }] as never, jest.fn())} />);
    expect(screen.getAllByText('Hierarchy label is required.')).toHaveLength(2);
  });
});
