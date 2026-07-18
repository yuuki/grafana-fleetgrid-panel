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

/** 初回描画が落ち着くまで待ち、安定した frameHash を返す(未描画フレームを基準に取る誤りを防ぐ) */
async function stableHash(canvas: Locator): Promise<number> {
  await expect.poll(() => isPainted(canvas)).toBe(true);
  let prev = await frameHash(canvas);
  await expect
    .poll(async () => {
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
 * canvas の (x,y) にホバーし、表示されたツールチップの階層パスを返す。セル外なら null。
 * 固定 sleep ではなくツールチップ内容が現れるまで短時間ポーリングする(遅い環境での取りこぼし対策)。
 */
async function readPath(canvas: Locator, panel: Locator, x: number, y: number): Promise<CellPath | null> {
  await canvas.hover({ position: { x, y } });
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

/** 指定列(x)を上から探ってセルが当たる y を返す */
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

  // 初回描画が安定してから基準ハッシュを取る(未描画フレームを「切替による再描画」と誤認しない)
  const before = await stableHash(canvas);
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

  // node-a10 は次のグリッド行(col0, node-a1 の真下)に存在する。欠落・消失でないことを確認する。
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
  const mainCanvas = main.locator.locator('canvas');
  await expect(mainCanvas).toBeVisible();
  // 低速環境で 0 色を掴まないよう、描画完了(連続配色は多色)を待ってから確定値を取る
  await expect.poll(() => dominantColorCount(mainCanvas, 15)).toBeGreaterThan(4);
  const continuousColors = await dominantColorCount(mainCanvas, 15);

  const threshold = await dashboardPage.getPanelByTitle('Threshold Mode');
  await threshold.scrollIntoView();
  const canvas = threshold.locator.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => isPainted(canvas)).toBe(true);
  // 12個の異なる値が3つの閾値帯に畳まれる(離散)。描画完了まで待って確定値を取る。
  await expect.poll(() => dominantColorCount(canvas, 15)).toBeGreaterThanOrEqual(2);
  const thresholdColors = await dominantColorCount(canvas, 15);

  // 離散配色は連続配色より必ず少なく、帯数(3)前後に収束する。
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
  // 既定は refId A 選択。A には byFrameRefID=A の links override があり click で遷移する。
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

  // refId B へ切替。override は A のみのため B のセルはリンクを持たず、click でポップオーバーになる。
  const optionB = panel.locator.getByRole('radio', { name: 'B' });
  await optionB.click();
  await expect(optionB).toBeChecked();

  const cellY = await findCellY(canvas, panel.locator, 22);
  const page = canvas.page();
  const urlBefore = page.url();
  await canvas.click({ position: { x: 22, y: cellY } });
  await expect(panel.locator.getByRole('button', { name: '閉じる' })).toBeVisible();
  // 遷移していない(URL 不変・リンククエリなし)
  expect(page.url()).toBe(urlBefore);
  expect(page.url()).not.toContain('from=celllink');
});
