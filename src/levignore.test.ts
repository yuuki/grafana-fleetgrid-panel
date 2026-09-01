/**
 * Contract test for the Levitate ignore list.
 * The GitHub Action runs `npx @grafana/levitate is-compatible` from the repo
 * root, so `.levignore.js` must stay there and keep ignoring only the known
 * setMigrationHandler false positive.
 */
const ignore = require('../.levignore.js') as {
  changes?: Array<RegExp | string>;
  removals?: Array<RegExp | string>;
  additions?: Array<RegExp | string>;
};

function matches(entries: Array<RegExp | string> | undefined, symbol: string): boolean {
  return (entries ?? []).some((entry) => new RegExp(entry).test(symbol));
}

describe('.levignore.js', () => {
  it('ignores the Levitate false positive on PanelPlugin.setMigrationHandler', () => {
    expect(matches(ignore.changes, 'PanelPlugin.setMigrationHandler')).toBe(true);
  });

  it('does not ignore unrelated Grafana APIs', () => {
    expect(matches(ignore.changes, 'PanelPlugin.setPanelOptions')).toBe(false);
    expect(matches(ignore.changes, 'PanelPlugin.useFieldConfig')).toBe(false);
    expect(matches(ignore.removals, 'PanelPlugin.setMigrationHandler')).toBe(false);
    expect(matches(ignore.additions, 'PanelPlugin.setMigrationHandler')).toBe(false);
  });
});
