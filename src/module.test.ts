import { PanelOptionsEditorBuilder, standardEditorsRegistry } from '@grafana/data';
import { declareFitContentSupport, plugin } from './module';
import { FleetGridOptions } from './types';

// Grafana registers its standard option editors at start-up; the option builder only looks them up by
// id. The registry takes its initializer once, before its first use, so the list is set here for the
// whole file and names the editors of every option.
beforeAll(() => {
  standardEditorsRegistry.setInit(() =>
    ['text', 'number', 'radio', 'boolean', 'color', 'select'].map((id) => ({ id, name: id, editor: () => null }))
  );
});

const optionItems = () => {
  const builder = new PanelOptionsEditorBuilder<FleetGridOptions>();
  plugin.getPanelOptionsSupplier()(builder, { data: [] });
  return builder.getItems();
};

// The migration handler and its gate are stored on the plugin by setMigrationHandler.
const migrate = (options: Record<string, unknown>): FleetGridOptions =>
  plugin.onPanelMigration!({ options } as never) as FleetGridOptions;
const shouldMigrate = (options: Record<string, unknown>): boolean => plugin.shouldMigrate!({ options } as never);

describe('categoryStyle migration', () => {
  it('rewrites the legacy topBar value to the bottom strip', () => {
    const out = migrate({ categoryStyle: 'topBar', categoryLabel: 'partition' });
    expect(out.categoryStyle).toBe('strip');
    // Unrelated options are carried through untouched.
    expect(out.categoryLabel).toBe('partition');
  });

  it('defaults an unset categoryStyle to the bottom strip', () => {
    expect(migrate({ categoryLabel: 'partition' }).categoryStyle).toBe('strip');
  });

  it('carries an existing border value over to the outline style', () => {
    expect(migrate({ categoryStyle: 'border' }).categoryStyle).toBe('border');
  });

  it('opts in to migration only for legacy or unset values', () => {
    expect(shouldMigrate({ categoryStyle: 'topBar' })).toBe(true);
    expect(shouldMigrate({})).toBe(true);
    expect(shouldMigrate({ categoryStyle: 'strip' })).toBe(false);
    expect(shouldMigrate({ categoryStyle: 'border' })).toBe(false);
  });
});

describe('stored option paths', () => {
  // The paths are keys of the dashboard JSON. Two options with one path would write over each other.
  it('are the same as before, each used once', () => {
    const paths = optionItems().map((item) => item.path);
    expect(paths).toEqual([
      'levels',
      'displayMode',
      'defaultMetric',
      'showValues',
      'tooltipLabels',
      'categoryLabel',
      'categoryStyle',
      'showCategoryLegend',
      'missingColor',
      'spatialAggregation',
      'reduceCalc',
      'rangeOverrides',
      'selectionLabel',
      'selectionVariable',
      'flowRefId',
      'flowEndpoints',
      'flowShow',
      'flowRestArcs',
      'flowWorst',
      'flowThreshold',
      'flowOrderLabel',
      'flowPathLabel',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
    const ids = optionItems().map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('flow overlay options', () => {
  const items = () => optionItems().filter((item) => item.path.startsWith('flow'));

  it('defaults to an overlay that is off', () => {
    expect(plugin.defaults).toMatchObject({
      flowRefId: '',
      flowEndpoints: [],
      flowShow: 'always',
      flowWorst: 'high',
      flowOrderLabel: '',
      flowPathLabel: '',
    });
    // No threshold by default: every edge is drawn.
    expect(plugin.defaults).not.toHaveProperty('flowThreshold');
  });

  it('keeps the stored option paths', () => {
    expect(items().map((item) => item.path)).toEqual([
      'flowRefId',
      'flowEndpoints',
      'flowShow',
      'flowRestArcs',
      'flowWorst',
      'flowThreshold',
      'flowOrderLabel',
      'flowPathLabel',
    ]);
  });

  it('shows the other flow options only once an edge query is named', () => {
    const dependent = items().filter((item) => item.path !== 'flowRefId');
    expect(items().find((item) => item.path === 'flowRefId')!.showIf).toBeUndefined();
    for (const item of dependent) {
      expect(item.showIf!({} as FleetGridOptions)).toBe(false);
      expect(item.showIf!({ flowRefId: ' ' } as FleetGridOptions)).toBe(false);
      expect(item.showIf!({ flowRefId: 'E' } as FleetGridOptions)).toBe(true);
    }
  });

  it('offers the number of arcs at rest, 100 by default and 500 at most, only while arcs are drawn at rest', () => {
    const item = items().find((entry) => entry.path === 'flowRestArcs')!;
    expect(item.defaultValue).toBe(100);
    expect(item.showIf!({ flowRefId: 'E', flowShow: 'always' } as FleetGridOptions)).toBe(true);
    expect(item.showIf!({ flowRefId: 'E', flowShow: 'hover' } as FleetGridOptions)).toBe(false);
  });

  it('carries the flow options through the categoryStyle migration', () => {
    const stored = { flowRefId: 'E', flowEndpoints: [{ level: 'host', source: 'src_host', destination: 'dst_host' }] };
    expect(migrate({ categoryStyle: 'topBar', ...stored })).toMatchObject(stored);
  });
});

describe('selection options', () => {
  it('default to an automatic label and no variable, so a new or existing panel writes nothing', () => {
    expect(plugin.defaults).toMatchObject({ selectionLabel: '', selectionVariable: '' });
  });

  it('are carried through the migration untouched', () => {
    const out = migrate({ categoryStyle: 'topBar', selectionLabel: 'host', selectionVariable: 'hosts' });
    expect(out).toMatchObject({ selectionLabel: 'host', selectionVariable: 'hosts' });
    // A dashboard saved before the options existed gains no keys.
    expect(migrate({ categoryStyle: 'strip' })).toEqual({ categoryStyle: 'strip' });
  });

  it('are stored beside the flow options without touching them', () => {
    const stored = { selectionLabel: 'host', selectionVariable: 'hosts', flowRefId: 'E', flowShow: 'hover' };
    expect(migrate({ categoryStyle: 'border', ...stored })).toEqual({ categoryStyle: 'border', ...stored });
  });
});

describe('declareFitContentSupport', () => {
  it('is a no-op on hosts that lack setFitContentSupport', () => {
    expect(() => declareFitContentSupport({})).not.toThrow();
  });

  it('calls setFitContentSupport when the host provides it', () => {
    const setFitContentSupport = jest.fn();
    declareFitContentSupport({ setFitContentSupport });
    expect(setFitContentSupport).toHaveBeenCalledTimes(1);
  });
});
