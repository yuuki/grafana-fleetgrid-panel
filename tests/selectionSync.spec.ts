import { test, expect } from '@grafana/plugin-e2e';
import type { DashboardPage } from '@grafana/plugin-e2e';
import type { Locator } from '@playwright/test';

// The subject under test is provisioning/dashboards/selection-sync.json (uid: fleetgrid-selection-sync-e2e):
// six FleetGrid panels with one cell per host, each naming a different kind of dashboard variable in
// "Sync selection to variable", and the text panel "Variables", which shows what every variable gives
// to a panel that uses it.
//
// The rule these tests hold the panel to: the bar says that a variable holds the selection only when
// the variable does, and a variable that cannot hold a selection is not written at all.
const FILE = 'selection-sync.json';
const HOSTS = ['node-a001', 'node-a002', 'node-a003', 'node-b001', 'node-b002', 'node-b003'];
const ALL_HOSTS = HOSTS.join(',');

// Every panel of the dashboard is on screen at once: Grafana does not mount panels below the viewport.
test.use({ viewport: { width: 1600, height: 1000 } });

interface Grid {
  panel: Locator;
  canvas: Locator;
  /** A point inside the cell of each host. */
  cells: Record<string, { x: number; y: number }>;
}

/** Finds the cell of every host with the hover tooltip, which names the host of the cell under the pointer. */
async function openGrid(dashboardPage: DashboardPage, title: string): Promise<Grid> {
  const panel = dashboardPage.getPanelByTitle(title).locator;
  const canvas = panel.locator('canvas');
  await expect(canvas).toBeVisible();
  const cells: Grid['cells'] = {};
  await expect
    .poll(async () => {
      const found = await canvas.evaluate(async (el) => {
        const container = el.parentElement as HTMLElement;
        const box = el.getBoundingClientRect();
        const seen: Record<string, { x0: number; x1: number; y0: number; y1: number }> = {};
        for (let y = 3; y < box.height; y += 6) {
          for (let x = 3; x < box.width; x += 6) {
            el.dispatchEvent(
              new MouseEvent('mousemove', { bubbles: true, clientX: box.left + x, clientY: box.top + y })
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
            // The tooltip is labelled with the path of its cell: "host: node-a001".
            const label = container.querySelector('[role="tooltip"]')?.getAttribute('aria-label') ?? '';
            const host = /^host: (.+)$/.exec(label)?.[1];
            if (host) {
              const cell = (seen[host] ??= { x0: x, x1: x, y0: y, y1: y });
              cell.x1 = Math.max(cell.x1, x);
              cell.y1 = Math.max(cell.y1, y);
            }
          }
        }
        el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
        return seen;
      });
      for (const [host, { x0, x1, y0, y1 }] of Object.entries(found)) {
        cells[host] = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      }
      return Object.keys(found).sort();
    })
    .toEqual(HOSTS);
  return { panel, canvas, cells };
}

const select = (grid: Grid, host: string) => grid.canvas.click({ position: grid.cells[host], modifiers: ['Shift'] });

// Grafana 13 can float a pane over the right side of a panel, so the click is dispatched to the
// button instead of aimed at its position.
const clear = (grid: Grid) => grid.panel.getByTestId('selection-clear').dispatchEvent('click');

/** What the variables give to another panel, as the text panel "Variables" shows it: `name=value` per line. */
function variableText(dashboardPage: DashboardPage, name: string): () => Promise<string | undefined> {
  const panel = dashboardPage.getPanelByTitle('Variables').locator;
  return async () =>
    (await panel.innerText())
      .split('\n')
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1);
}

const urlValues = (dashboardPage: DashboardPage, name: string) => () =>
  new URL(dashboardPage.ctx.page.url()).searchParams.getAll(`var-${name}`);

async function openDashboard(
  gotoDashboardPage: (args: { uid: string }) => Promise<DashboardPage>,
  readProvisionedDashboard: (args: { fileName: string }) => Promise<{ uid: string }>
): Promise<DashboardPage> {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  await expect.poll(variableText(dashboardPage, 'hosts')).toBe(ALL_HOSTS);
  return dashboardPage;
}

test('a multi-value variable holds exactly the selected hosts, also after a refresh, and gets its value back', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  test.setTimeout(90_000);
  const dashboardPage = await openDashboard(gotoDashboardPage, readProvisionedDashboard);
  const grid = await openGrid(dashboardPage, 'Sync A');
  const hosts = variableText(dashboardPage, 'hosts');
  const sync = grid.panel.getByTestId('selection-sync');

  await select(grid, 'node-a002');
  await select(grid, 'node-b001');
  await expect(sync).toHaveText('→ $hosts');
  await expect.poll(hosts).toBe('node-a002,node-b001');

  // A dashboard refresh makes Grafana check its variables again. The variable keeps the selection.
  await dashboardPage.refreshDashboard();
  await expect.poll(hosts).toBe('node-a002,node-b001');
  await expect(sync).toHaveText('→ $hosts');

  await clear(grid);
  await expect(grid.panel.getByTestId('selection-bar')).toHaveCount(0);
  await expect.poll(hosts).toBe(ALL_HOSTS);
  await expect.poll(urlValues(dashboardPage, 'hosts')).toEqual(['$__all']);
});

test('two panels that sync to one variable add their selections up, and the last Clear restores it', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  test.setTimeout(90_000);
  const dashboardPage = await openDashboard(gotoDashboardPage, readProvisionedDashboard);
  const a = await openGrid(dashboardPage, 'Sync A');
  const b = await openGrid(dashboardPage, 'Sync B');
  const hosts = variableText(dashboardPage, 'hosts');

  await select(a, 'node-a001');
  await expect(a.panel.getByTestId('selection-sync')).toHaveText('→ $hosts');
  await select(b, 'node-b002');
  await expect.poll(hosts).toBe('node-a001,node-b002');
  await expect(a.panel.getByTestId('selection-sync')).toHaveText('→ $hosts (with 1 other panel)');
  await expect(b.panel.getByTestId('selection-sync')).toHaveText('→ $hosts (with 1 other panel)');

  // Clearing one panel leaves the other panel's selection in the variable, not the first panel's.
  await clear(a);
  await expect.poll(hosts).toBe('node-b002');
  await expect(b.panel.getByTestId('selection-sync')).toHaveText('→ $hosts');

  // Clearing the last one puts back All, which the variable held before either selection.
  await clear(b);
  await expect.poll(hosts).toBe(ALL_HOSTS);
  await expect.poll(urlValues(dashboardPage, 'hosts')).toEqual(['$__all']);
});

test('a text box holds one regular expression for the selected hosts', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  test.setTimeout(90_000);
  const dashboardPage = await openDashboard(gotoDashboardPage, readProvisionedDashboard);
  const grid = await openGrid(dashboardPage, 'Text box');
  const regex = variableText(dashboardPage, 'host_regex');

  await select(grid, 'node-a001');
  await select(grid, 'node-a003');
  await expect(grid.panel.getByTestId('selection-sync')).toHaveText('→ $host_regex');
  await expect.poll(regex).toBe('^(node-a001|node-a003)$');
  await dashboardPage.refreshDashboard();
  await expect.poll(regex).toBe('^(node-a001|node-a003)$');
  await expect(grid.panel.getByTestId('selection-sync')).toHaveText('→ $host_regex');

  await clear(grid);
  await expect.poll(regex).toBe('.*');
});

test('a variable that takes one value is not written, and the bar says why', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  test.setTimeout(90_000);
  const dashboardPage = await openDashboard(gotoDashboardPage, readProvisionedDashboard);
  const grid = await openGrid(dashboardPage, 'Single value');
  const oneHost = variableText(dashboardPage, 'one_host');
  const sync = grid.panel.getByTestId('selection-sync');

  await select(grid, 'node-a002');
  await select(grid, 'node-b001');
  await expect(sync).toHaveText('Variable "one_host" takes one value: sync to a multi-value variable or a text box');
  // Longer than the delay before a write and the time a write takes to show.
  await dashboardPage.ctx.page.waitForTimeout(1500);
  expect(await oneHost()).toBe('node-a001');
  expect(urlValues(dashboardPage, 'one_host')()).toEqual(['node-a001']);

  await dashboardPage.refreshDashboard();
  await expect(sync).toHaveText('Variable "one_host" takes one value: sync to a multi-value variable or a text box');
  expect(await oneHost()).toBe('node-a001');

  await clear(grid);
  await expect(grid.panel.getByTestId('selection-bar')).toHaveCount(0);
  expect(await oneHost()).toBe('node-a001');
});

test('nothing is written without a selection label, and the bar says what to set', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  test.setTimeout(90_000);
  const dashboardPage = await openDashboard(gotoDashboardPage, readProvisionedDashboard);
  const grid = await openGrid(dashboardPage, 'No label');
  const unlabelled = variableText(dashboardPage, 'unlabelled');

  await select(grid, 'node-a002');
  // The copy buttons still work by the label the panel chose when the selection began.
  await expect(grid.panel.getByTestId('selection-label')).toHaveText('1 host value:');
  await expect(grid.panel.getByTestId('selection-sync')).toHaveText('Set "Selection label" to sync to $unlabelled');
  await dashboardPage.ctx.page.waitForTimeout(1500);
  expect(await unlabelled()).toBe(ALL_HOSTS);
  expect(urlValues(dashboardPage, 'unlabelled')()).toEqual(['$__all']);
});

test('the bar says so when Grafana takes the selection out of the variable at a refresh', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  test.setTimeout(90_000);
  const dashboardPage = await openDashboard(gotoDashboardPage, readProvisionedDashboard);
  const grid = await openGrid(dashboardPage, 'Query options');
  const listed = variableText(dashboardPage, 'listed');
  const sync = grid.panel.getByTestId('selection-sync');
  const options = await listed();

  // The options of this query variable are not hosts. Grafana takes the hosts all the same, until it
  // loads the options again.
  await select(grid, 'node-a001');
  await select(grid, 'node-a002');
  await expect(sync).toHaveText('→ $listed');
  await expect.poll(listed).toBe('node-a001,node-a002');

  // The variable loads its options on a refresh, and Grafana puts it back to one of them.
  await dashboardPage.refreshDashboard();
  await expect(sync).toHaveText('$listed was changed and no longer holds the selection');
  await expect.poll(listed).toBe(options);
  // The panel does not write the selection again: only a change of the selection writes.
  await dashboardPage.ctx.page.waitForTimeout(2500);
  expect(await listed()).toBe(options);
  await expect(grid.panel.getByTestId('selection-count')).toHaveText('2 cells selected');

  // The variable is Grafana's now: Clear does not "restore" it.
  await clear(grid);
  await expect(grid.panel.getByTestId('selection-bar')).toHaveCount(0);
  expect(await listed()).toBe(options);
});
