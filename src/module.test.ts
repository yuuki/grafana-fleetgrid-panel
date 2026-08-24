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
