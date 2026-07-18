import { test, expect } from '@grafana/plugin-e2e';
import type { Locator } from '@playwright/test';

// 検証対象は provisioning/dashboards/clusterview.json(uid: clusterview-e2e)。
// パネルは単一の <canvas> に描画するため、DOM 断言できない項目は canvas の getImageData と
// ツールチップ/凡例/ポップオーバー(いずれも React の DOM)を使って自動検証する。
const FILE = 'clusterview.json';

/** canvas に不透明ピクセルが1つでも描かれているか(= 実際に描画されたか) */
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

/** セル塗り色として支配的(サンプル数 >= minCount)な色の種類数。色は5bit量子化しAAノイズを畳む。 */
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

/** 描画内容の簡易ハッシュ(セレクタ切替などの再描画検出用) */
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

interface CellPath {
  zone: string;
  host: string;
  gpu: string;
  text: string;
}

/** canvas の (x,y) にホバーし、表示されたツールチップの階層パスを返す。セル外なら null。 */
async function readPath(canvas: Locator, panel: Locator, x: number, y: number): Promise<CellPath | null> {
  await canvas.hover({ position: { x, y } });
  await canvas.page().waitForTimeout(60);
  const text = await panel.innerText();
  const m = text.match(/(zone-[a-z0-9]+)\s*\/\s*(node-[a-z0-9]+)\s*\/\s*(gpu\d+)/i);
  return m ? { zone: m[1], host: m[2], gpu: m[3], text } : null;
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

  const before = await frameHash(canvas);
  // radio input 自体(最前面要素)を role+name で直接クリックする。ラベルをクリックすると
  // 上に重なる不可視 input に pointer が奪われるため、force なしで input を狙う。
  const optionB = panel.locator.getByRole('radio', { name: 'B' });
  await optionB.click();
  await expect(optionB).toBeChecked();
  // 別メトリクス(power -> temp)への切替で描画が変わる
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
  // クエリA = watt, クエリB = celsius(override)。両方がツールチップに単位付きで並ぶ。
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

  // zone-a の最初のセル行の y を特定する
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

  // その行を左から右へ走査し、host の出現順を集める
  const order: string[] = [];
  for (let x = 4; x <= box.width; x += 10) {
    const p = await readPath(canvas, panel.locator, x, rowY);
    if (p?.zone === 'zone-a' && order[order.length - 1] !== p.host) {
      order.push(p.host);
    }
  }
  // grid 3列の1行目 = natural sort 順。辞書順なら [node-a1, node-a10, node-a2] になる。
  expect(order.slice(0, 3)).toEqual(['node-a1', 'node-a2', 'node-a9']);
  expect(order).not.toContain('node-a10');
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
  // ポップオーバーが開く(閉じるボタン)。instant な TestData なので時系列は無く sparkline は出ない。
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
  // SplitLegend は "1: A" / "2: B" を表示し、単一モードのセレクタ(radio)は出さない
  await expect(panel.locator.getByText('1: A')).toBeVisible();
  await expect(panel.locator.getByText('2: B')).toBeVisible();
  await expect(panel.locator.getByRole('radio')).toHaveCount(0);
});

test('threshold color mode renders discrete colors', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });

  // 連続配色(main)は値ごとに多数の色、閾値配色は帯ごとの少数の色になる
  const main = await dashboardPage.getPanelByTitle('ClusterView');
  await main.scrollIntoView();
  await expect(main.locator.locator('canvas')).toBeVisible();
  const continuousColors = await dominantColorCount(main.locator.locator('canvas'), 15);

  const threshold = await dashboardPage.getPanelByTitle('Threshold Mode');
  await threshold.scrollIntoView();
  const canvas = threshold.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
  const thresholdColors = await dominantColorCount(canvas, 15);

  // 12個の異なる値が3つの閾値帯に畳まれる(離散)。連続配色より必ず少ない。
  expect(thresholdColors).toBeGreaterThanOrEqual(2);
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

test('a data link on a cell navigates on click', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('Data Links');
  await panel.scrollIntoView();
  const canvas = panel.locator.locator('canvas');
  await expect(canvas).toBeVisible();

  let cellY: number | null = null;
  for (let y = 30; y <= 130 && cellY === null; y += 5) {
    if (await readPath(canvas, panel.locator, 22, y)) {
      cellY = y;
    }
  }
  if (cellY === null) {
    throw new Error('no cell found in the Data Links panel');
  }
  const page = canvas.page();
  await Promise.all([
    page.waitForURL(/from=celllink/, { timeout: 15000 }),
    canvas.click({ position: { x: 22, y: cellY } }),
  ]);
  expect(page.url()).toContain('from=celllink');
});
