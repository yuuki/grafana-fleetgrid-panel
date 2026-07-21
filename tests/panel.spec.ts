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

/**
 * The number of distinct cell-fill colors on the canvas (each seen at >= minCount sampled points).
 * Only counts points sitting inside a locally uniform region: a point is kept solely when its 8 neighbors
 * (radius r) share its 5-bit-quantized color. That structurally excludes chrome that isn't a cell fill —
 * thin borders, glyph text, and anti-aliased cell edges are never locally flat — so the count reflects fill
 * colors alone. Counting the whole canvas instead is version-fragile: theme border/label colors differ per
 * Grafana version and leak into a naive dominant-color tally (observed on grafana-enterprise 13.1).
 */
async function cellFillColorCount(canvas: Locator, minCount: number): Promise<number> {
  return canvas.evaluate((el, min) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) {
      return 0;
    }
    const w = c.width;
    const h = c.height;
    const img = ctx.getImageData(0, 0, w, h).data;
    const quant = (x: number, y: number): string | null => {
      const p = (y * w + x) * 4;
      if (img[p + 3] < 200) {
        return null; // transparent background (canvas is cleared, not filled)
      }
      return `${img[p] >> 3},${img[p + 1] >> 3},${img[p + 2] >> 3}`;
    };
    const counts: Record<string, number> = {};
    const step = 6;
    const r = 3; // neighborhood radius (px); cells are far larger than 2r, borders/glyphs are not
    for (let y = r; y < h - r; y += step) {
      for (let x = r; x < w - r; x += step) {
        const center = quant(x, y);
        if (center === null) {
          continue;
        }
        if (
          quant(x - r, y) === center &&
          quant(x + r, y) === center &&
          quant(x, y - r) === center &&
          quant(x, y + r) === center &&
          quant(x - r, y - r) === center &&
          quant(x + r, y + r) === center &&
          quant(x + r, y - r) === center &&
          quant(x - r, y + r) === center
        ) {
          counts[center] = (counts[center] ?? 0) + 1;
        }
      }
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
async function readPath(canvas: Locator, panel: Locator, x: number, y: number, timeout = 300): Promise<CellPath | null> {
  await canvas.hover({ position: { x, y } });
  return readCurrentPath(canvas, panel, timeout);
}

/** Reads a path for structural layout probing using the same browser event as an end-user hover. */
async function probePath(canvas: Locator, panel: Locator, x: number, y: number): Promise<CellPath | null> {
  return readPath(canvas, panel, x, y, 120);
}

async function readCurrentPath(canvas: Locator, panel: Locator, timeout = 300): Promise<CellPath | null> {
  // Right after a pointer event, the previous cell's tooltip may still linger. Wait one frame before reading the content (prevents misreading the old tooltip).
  await canvas.page().evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const deadline = Date.now() + timeout;
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
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('canvas has no bounding box');
  }
  for (let y = 0; y <= box.height; y += 5) {
    if (await readPath(canvas, panel, x, y, 120)) {
      return y;
    }
  }
  throw new Error('no cell found while probing the column');
}

/** Finds a cell without assuming a particular panel padding or canvas offset. */
async function findCellPoint(canvas: Locator, panel: Locator): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('canvas has no bounding box');
  }
  const xCandidates = [12, 25, box.width / 4, box.width / 2, (box.width * 3) / 4].map(Math.floor);
  for (const x of xCandidates) {
    for (let y = 0; y <= box.height; y += 5) {
      if (await readPath(canvas, panel, x, y, 120)) {
        return { x, y };
      }
    }
  }
  throw new Error('no cell found while probing the canvas');
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

  const point = await findCellPoint(canvas, panel.locator);
  const hit = await readPath(canvas, panel.locator, point.x, point.y);
  expect(hit).not.toBeNull();
  expect(hit.text).toMatch(/zone-a\s*\/\s*node-a\d+\s*\/\s*gpu\d/);
  // Query A = watt, query B = celsius (override). Both appear in the tooltip with units.
  expect(hit.text).toMatch(/\d+(\.\d+)?\s*W\b/);
  expect(hit.text).toContain('°C');
});

test('renders the provisioned 2 / 8 / 2 grid in row-major order', async ({
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

  // Identify the y of zone-a's first cell row without assuming Grafana's panel padding.
  const firstPoint = await findCellPoint(canvas, panel.locator);
  const firstCell = await probePath(canvas, panel.locator, firstPoint.x, firstPoint.y);
  expect(firstCell?.zone).toBe('zone-a');
  const rowY = firstPoint.y;

  // Scan the first row left to right and collect each cell path once.
  const order: string[] = [];
  for (let x = 2; x <= box.width; x += 5) {
    const p = await probePath(canvas, panel.locator, x, rowY);
    const key = p && `${p.zone}/${p.host}/${p.gpu}`;
    if (key && order[order.length - 1] !== key) {
      order.push(key);
    }
  }

  const zoneAFirstRow = Array.from({ length: 8 }, (_, host) =>
    ['gpu0', 'gpu1'].map((gpu) => `zone-a/node-a${host + 1}/${gpu}`)
  ).flat();
  expect(order.slice(0, zoneAFirstRow.length)).toEqual(zoneAFirstRow);
  expect(order).toContain('zone-b/node-b1/gpu0');
  expect(order).not.toContain('zone-a/node-a9/gpu0');

  // Eight host columns force node-a9 onto the next host row.
  let secondRow: CellPath | null = null;
  for (let y = rowY + 5; y <= box.height && secondRow === null; y += 5) {
    const p = await probePath(canvas, panel.locator, firstPoint.x, y);
    if (p?.host === 'node-a9') {
      secondRow = p;
    }
  }
  expect(secondRow).toMatchObject({ zone: 'zone-a', host: 'node-a9' });
});

test('clicking a cell opens the drilldown popover', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  const point = await findCellPoint(canvas, panel.locator);
  await canvas.click({ position: point });
  // The popover opens (close button). Since it's instant TestData, there's no time series and no sparkline appears.
  await expect(panel.locator.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(panel.locator.getByText('No time series').first()).toBeVisible();
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
  // Continuous colors are mostly unique per cell, so count each locally uniform color once; threshold bands repeat across many cells below.
  await expect.poll(() => cellFillColorCount(mainCanvas, 1)).toBeGreaterThan(4);
  const continuousColors = await cellFillColorCount(mainCanvas, 1);

  const threshold = await dashboardPage.getPanelByTitle('Threshold Mode');
  await threshold.scrollIntoView();
  const canvas = threshold.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
  // 12 distinct values collapse into 3 threshold bands (discrete). Wait for rendering to complete before taking the final value.
  await expect.poll(() => cellFillColorCount(canvas, 15)).toBeGreaterThanOrEqual(2);
  const thresholdColors = await cellFillColorCount(canvas, 15);

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
    page.waitForURL(/drilldown=celllink/, { timeout: 15000 }),
    canvas.click({ position: { x: 22, y: cellY } }),
  ]);
  // Assert the marker persists (not just briefly present): `drilldown` is a non-reserved query param, so
  // Grafana's dashboard URL reconcile leaves it intact. A reserved time param like `from` would be
  // overwritten by the time-range sync (invalid value -> default) on some versions (e.g. 12.0.x).
  expect(page.url()).toContain('drilldown=celllink');
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
  await expect(panel.locator.getByRole('button', { name: 'Close' })).toBeVisible();
  // No navigation occurred (URL unchanged, no link query)
  expect(page.url()).toBe(urlBefore);
  expect(page.url()).not.toContain('drilldown=celllink');
});
