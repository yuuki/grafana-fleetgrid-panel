import { PanelOptionsEditorBuilder, standardEditorsRegistry } from '@grafana/data';
import { declareFitContentSupport, plugin } from './module';
import { FleetGridOptions } from './types';

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

describe('flow overlay options', () => {
  // Grafana registers its standard option editors at start-up; the option builder only looks them up by id.
  beforeAll(() => {
    standardEditorsRegistry.setInit(() =>
      ['text', 'number', 'radio', 'boolean', 'color', 'select'].map((id) => ({ id, name: id, editor: () => null }))
    );
  });

  const items = () => {
    const builder = new PanelOptionsEditorBuilder<FleetGridOptions>();
    plugin.getPanelOptionsSupplier()(builder, { data: [] });
    return builder.getItems().filter((item) => item.path.startsWith('flow'));
  };

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

  it('carries the flow options through the categoryStyle migration', () => {
    const stored = { flowRefId: 'E', flowEndpoints: [{ level: 'host', source: 'src_host', destination: 'dst_host' }] };
    expect(migrate({ categoryStyle: 'topBar', ...stored })).toMatchObject(stored);
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
