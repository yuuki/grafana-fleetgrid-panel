import { DataFrame, DataQueryRequest } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { isObservable, lastValueFrom } from 'rxjs';

const MAX_POINTS = 100;

export function buildDrilldownRequest(base: DataQueryRequest): DataQueryRequest {
  const spanMs = base.range.to.valueOf() - base.range.from.valueOf();
  const intervalMs = Math.max(15000, Math.floor(spanMs / MAX_POINTS));
  return {
    ...base,
    requestId: `${base.requestId}-drilldown`,
    maxDataPoints: MAX_POINTS,
    intervalMs,
    interval: `${Math.round(intervalMs / 1000)}s`,
    targets: base.targets.map((t) => ({ ...t, instant: false, range: true })),
  };
}

async function runQuery(dsRef: unknown, request: DataQueryRequest): Promise<DataFrame[]> {
  const ds = await getDataSourceSrv().get(dsRef as never);
  const result = ds.query(request);
  // DataSourceApi.queryはPromiseとObservableの両方があり得る
  const response = isObservable(result) ? await lastValueFrom(result) : await result;
  return ((response as { data?: DataFrame[] })?.data ?? []) as DataFrame[];
}

export async function fetchDrilldownFrames(base: DataQueryRequest): Promise<DataFrame[]> {
  const req = buildDrilldownRequest(base);
  // Mixedデータソース対応: datasourceごとにtargetsを分割して実行する
  const groups = new Map<string, typeof req.targets>();
  for (const t of req.targets) {
    const key = JSON.stringify(t.datasource ?? null);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const results = await Promise.all(
    [...groups.values()].map((targets) => runQuery(targets[0].datasource, { ...req, targets }))
  );
  return results.flat();
}
