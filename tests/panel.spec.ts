import { test, expect } from '@grafana/plugin-e2e';
import type { Locator } from '@playwright/test';

// The subject under test is provisioning/dashboards/clusterview.json (uid: clusterview-e2e).
// Since the panel renders into a single <canvas>, items that can't be asserted via the DOM
// are verified automatically using the canvas's getImageData and the tooltip/legend/popover (all React DOM).
const FILE = 'clusterview.json';

/** Whether even a single opaque pixel is drawn on the canvas (= whether something was actually rendered) */
async function isPainted(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) {
      return false;
    }
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        return true;
      }
    }
    return false;
  });
}

/** The number of distinct colors that dominate as cell fill colors (sample count >= minCount). Colors are quantized to 5 bits to collapse AA noise. */
async function dominantColorCount(canvas: Locator, minCount: number): Promise<number> {
  return canvas.evaluate((el, min) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) {
      return 0;
    }
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const counts: Record<string, number> = {};
    for (let i = 0; i < data.length; i += 4 * 5) {
      if (data[i + 3] < 200) {
        continue;
      }
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.values(counts).filter((n) => n >= min).length;
  }, minCount);
}

/** A simple hash of the rendered content (for detecting re-renders such as selector switches) */
async function frameHash(canvas: Locator): Promise<number> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) {
      return 0;
    }
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < data.length; i += 4 * 11) {
      h = (h * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) >>> 0;
    }
    return h;
  });
}

/** Waits for the initial render to settle and returns a stable frameHash (avoids mistakenly using an unrendered frame as the baseline) */
async function stableHash(canvas: Locator): Promise<number> {
  await expect.poll(() => isPainted(canvas)).toBe(true);
  let prev = await frameHash(canvas);
  await expect
    .poll(async () => {
      // Insert a time gap before the second sample, to avoid an accidental match from back-to-back reads and confirm genuine stability
      await canvas.page().waitForTimeout(60);
      const h = await frameHash(canvas);
      const same = h === prev;
      prev = h;
      return same;
    })
    .toBe(true);
  return prev;
}

interface CellPath {
  zone: string;
  host: string;
  gpu: string;
  text: string;
}

const PATH_RE = /(zone-[a-z0-9]+)\s*\/\s*(node-[a-z0-9]+)\s*\/\s*(gpu\d+)/i;

/**
 * Hovers over (x,y) on the canvas and returns the hierarchy path from the displayed tooltip. null if outside a cell.
 * Polls briefly for the tooltip content to appear rather than using a fixed sleep (a safeguard against missed detection on slow environments).
 */
async function readPath(canvas: Locator, panel: Locator, x: number, y: number): Promise<CellPath | null> {
  await canvas.hover({ position: { x, y } });
  // Right after hover, the previous cell's tooltip may still linger. Wait one frame before reading the content (prevents misreading the old tooltip).
  await canvas.page().evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const deadline = Date.now() + 300;
  do {
    const text = await panel.innerText();
    const m = text.match(PATH_RE);
    if (m) {
      return { zone: m[1], host: m[2], gpu: m[3], text };
    }
    await canvas.page().waitForTimeout(30);
  } while (Date.now() < deadline);
  return null;
}

/** Scans a given column (x) from the top and returns the y where a cell is hit */
async function findCellY(canvas: Locator, panel: Locator, x: number): Promise<number> {
  for (let y = 30; y <= 150; y += 5) {
    if (await readPath(canvas, panel, x, y)) {
      return y;
    }
  }
  throw new Error('no cell found while probing the column');
}

test('main panel renders the canvas with painted pixels', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
});

test('metric selector exposes two options and switching re-renders', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  const radios = panel.locator.getByRole('radio');
  await expect(radios).toHaveCount(2);
  await expect(radios.first()).toBeChecked();

  // Take the baseline hash only after the initial render stabilizes (avoids mistaking an unrendered frame for a "re-render from switching")
  const before = await stableHash(canvas);
  // Click directly on the radio input itself (the topmost element) via role+name. Clicking the label
  // would have the pointer captured by the invisible input layered on top, so target the input without force.
  const optionB = panel.locator.getByRole('radio', { name: 'B' });
  await optionB.click();
  await expect(optionB).toBeChecked();
  // Switching to a different metric (power -> temp) changes the rendering
  await expect.poll(() => frameHash(canvas)).not.toBe(before);
});

test('hover tooltip lists every metric with its configured unit', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  let hit: CellPath | null = null;
  for (let y = 40; y <= 140 && hit === null; y += 6) {
    hit = await readPath(canvas, panel.locator, 25, y);
  }
  if (hit === null) {
    throw new Error('no cell tooltip found while probing the first row');
  }
  expect(hit.text).toMatch(/zone-a\s*\/\s*node-a\d+\s*\/\s*gpu\d/);
  // Query A = watt, query B = celsius (override). Both appear in the tooltip with units.
  expect(hit.text).toMatch(/\d+(\.\d+)?\s*W\b/);
  expect(hit.text).toContain('°C');
});

test('hosts are ordered by natural sort (a2 before a9, a10 wraps to next row)', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('canvas has no bounding box');
  }

  // Identify the y of zone-a's first cell row
  let rowY: number | null = null;
  for (let y = 40; y <= 140 && rowY === null; y += 5) {
    const p = await readPath(canvas, panel.locator, 25, y);
    if (p?.zone === 'zone-a') {
      rowY = y;
    }
  }
  if (rowY === null) {
    throw new Error('could not locate the first cell row of zone-a');
  }

  // Scan that row left to right and collect the appearance order of hosts
  const order: string[] = [];
  for (let x = 4; x <= box.width; x += 10) {
    const p = await readPath(canvas, panel.locator, x, rowY);
    if (p?.zone === 'zone-a' && order[order.length - 1] !== p.host) {
      order.push(p.host);
    }
  }
  // Row 1 of a 3-column grid = natural sort order. Lexicographic order would give [node-a1, node-a10, node-a2].
  expect(order.slice(0, 3)).toEqual(['node-a1', 'node-a2', 'node-a9']);
  expect(order).not.toContain('node-a10');

  // node-a10 is on the next grid row (col0, directly below node-a1). Confirms it isn't missing or dropped.
  let a10Y: number | null = null;
  for (let y = rowY + 20; y <= rowY + 140 && a10Y === null; y += 5) {
    const p = await readPath(canvas, panel.locator, 25, y);
    if (p?.host === 'node-a10') {
      a10Y = y;
    }
  }
  if (a10Y === null) {
    throw new Error('node-a10 was not found on the row below the first');
  }
  expect(a10Y).toBeGreaterThan(rowY);
});

test('clicking a cell opens the drilldown popover', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  let cellY: number | null = null;
  for (let y = 40; y <= 140 && cellY === null; y += 5) {
    if (await readPath(canvas, panel.locator, 25, y)) {
      cellY = y;
    }
  }
  if (cellY === null) {
    throw new Error('no cell found to click');
  }
  await canvas.click({ position: { x: 25, y: cellY } });
  // The popover opens (close button). Since it's instant TestData, there's no time series and no sparkline appears.
  await expect(panel.locator.getByRole('button', { name: '閉じる' })).toBeVisible();
  await expect(panel.locator.getByText('時系列なし').first()).toBeVisible();
});

test('split mode shows the position legend instead of the selector', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('Split Mode');
  await panel.scrollIntoView();
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
  // SplitLegend displays "1: A" / "2: B" and doesn't show the single-mode selector (radio)
  await expect(panel.locator.getByText('1: A')).toBeVisible();
  await expect(panel.locator.getByText('2: B')).toBeVisible();
  await expect(panel.locator.getByRole('radio')).toHaveCount(0);
});

test('threshold color mode renders discrete colors', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });

  // Continuous coloring (main) produces many colors per value; threshold coloring produces few colors per band
  const main = await dashboardPage.getPanelByTitle('ClusterView');
  await main.scrollIntoView();
  const mainCanvas = main.locator.locator('canvas');
  await expect(mainCanvas).toBeVisible();
  // To avoid capturing 0 colors on a slow environment, wait for rendering to complete (continuous coloring = many colors) before taking the final value
  await expect.poll(() => dominantColorCount(mainCanvas, 15)).toBeGreaterThan(4);
  const continuousColors = await dominantColorCount(mainCanvas, 15);

  const threshold = await dashboardPage.getPanelByTitle('Threshold Mode');
  await threshold.scrollIntoView();
  const canvas = threshold.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
  // 12 distinct values collapse into 3 threshold bands (discrete). Wait for rendering to complete before taking the final value.
  await expect.poll(() => dominantColorCount(canvas, 15)).toBeGreaterThanOrEqual(2);
  const thresholdColors = await dominantColorCount(canvas, 15);

  // Discrete coloring is always fewer than continuous coloring, converging to around the band count (3).
  expect(thresholdColors).toBeLessThanOrEqual(4);
  expect(thresholdColors).toBeLessThan(continuousColors);
});

test('panel keeps rendering after the viewport shrinks', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  await canvas.page().setViewportSize({ width: 700, height: 500 });
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
});

test('query-A cell navigates via its per-query data-link override', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('Data Links');
  await panel.scrollIntoView();
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  // The default selects refId A. A has a byFrameRefID=A links override and navigates on click.
  await expect(panel.locator.getByRole('radio', { name: 'A' })).toBeChecked();

  const cellY = await findCellY(canvas, panel.locator, 22);
  const page = canvas.page();
  await Promise.all([
    page.waitForURL(/from=celllink/, { timeout: 15000 }),
    canvas.click({ position: { x: 22, y: cellY } }),
  ]);
  expect(page.url()).toContain('from=celllink');
});

test('query-B cell has no link and opens the popover instead of navigating', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('Data Links');
  await panel.scrollIntoView();
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  // Switch to refId B. Since the override is A-only, B's cells have no link, and click opens a popover instead.
  const optionB = panel.locator.getByRole('radio', { name: 'B' });
  await optionB.click();
  await expect(optionB).toBeChecked();

  const cellY = await findCellY(canvas, panel.locator, 22);
  const page = canvas.page();
  const urlBefore = page.url();
  await canvas.click({ position: { x: 22, y: cellY } });
  await expect(panel.locator.getByRole('button', { name: '閉じる' })).toBeVisible();
  // No navigation occurred (URL unchanged, no link query)
  expect(page.url()).toBe(urlBefore);
  expect(page.url()).not.toContain('from=celllink');
});
