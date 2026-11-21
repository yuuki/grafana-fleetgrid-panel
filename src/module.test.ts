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

describe('playback and color mode options', () => {
  it('registers playback and delta/z-score options with backward-compatible defaults', () => {
    interface RecordedOption {
      path: string;
      defaultValue?: unknown;
      showIf?: (opts: FleetGridOptions) => boolean;
    }
    const recorded = new Map<string, RecordedOption>();
    const record = (opt: RecordedOption) => {
      recorded.set(opt.path, opt);
      return builder;
    };
    const builder = {
      addCustomEditor: record,
      addRadio: record,
      addTextInput: record,
      addBooleanSwitch: record,
      addColorPicker: record,
      addSelect: record,
      addNumberInput: record,
    };
    plugin.getPanelOptionsSupplier()(builder as never, {} as never);

    expect(recorded.get('colorMode')?.defaultValue).toBe('value');
    expect(recorded.get('deltaLookbackSec')?.defaultValue).toBe(0);
    expect(recorded.get('zScoreGroupDepth')?.defaultValue).toBe(-1);
    expect(recorded.get('zScoreMethod')?.defaultValue).toBe('mean');
    expect(recorded.get('zScoreLimit')?.defaultValue).toBe(3);
    expect(recorded.get('enablePlayback')?.defaultValue).toBe(false);

    expect(recorded.get('deltaLookbackSec')?.showIf?.({ colorMode: 'delta' } as FleetGridOptions)).toBe(true);
    expect(recorded.get('deltaLookbackSec')?.showIf?.({ colorMode: 'value' } as FleetGridOptions)).toBe(false);
    expect(recorded.get('zScoreMethod')?.showIf?.({ colorMode: 'zscore' } as FleetGridOptions)).toBe(true);
    expect(recorded.get('zScoreMethod')?.showIf?.({ colorMode: 'delta' } as FleetGridOptions)).toBe(false);
  });
});
