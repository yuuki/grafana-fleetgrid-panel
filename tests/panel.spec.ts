import { test, expect } from '@grafana/plugin-e2e';

test('provisioned dashboard renders the clusterview canvas', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'clusterview.json' });
  const page = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await page.getPanelByTitle('ClusterView');
  await expect(panel.locator.locator('canvas')).toBeVisible();
});

test('metric selector switches without error', async ({ gotoDashboardPage, readProvisionedDashboard, page }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'clusterview.json' });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  await panel.locator.getByRole('radio').last().click({ force: true });
  await expect(panel.locator.locator('canvas')).toBeVisible();
});
