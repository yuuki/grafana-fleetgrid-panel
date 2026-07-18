import { dateTime } from '@grafana/data';
import { buildDrilldownRequest, fetchDrilldownFrames } from './requery';

const baseRequest = {
  requestId: 'Q100',
  interval: '30s',
  intervalMs: 30000,
  maxDataPoints: 1000,
  range: { from: dateTime(0), to: dateTime(3600_000), raw: { from: 'now-1h', to: 'now' } },
  scopedVars: {},
  targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'ds1' }, instant: true, range: false }],
  timezone: 'browser',
  app: 'dashboard',
  startTime: 0,
} as any;

describe('buildDrilldownRequest', () => {
  it('converts targets to range queries with capped data points', () => {
    const req = buildDrilldownRequest(baseRequest);
    expect(req.maxDataPoints).toBe(100);
    expect(req.intervalMs).toBe(36000); // 3600s / 100 = 36s
    expect(req.requestId).toBe('Q100-drilldown');
    expect(req.targets[0]).toMatchObject({ instant: false, range: true });
  });

  it('clamps intervalMs to the 15s floor for short ranges and converts every target', () => {
    // 60s span / 100 = 600ms → 15000msの下限に丸める。全targetをinstant:false/range:trueへ変換する
    const shortReq = {
      ...baseRequest,
      range: { from: dateTime(0), to: dateTime(60_000), raw: baseRequest.range.raw },
      targets: [
        { refId: 'A', datasource: { type: 'prometheus', uid: 'ds1' }, instant: true, range: false },
        { refId: 'B', datasource: { type: 'prometheus', uid: 'ds1' }, instant: true, range: false },
      ],
    } as any;
    const req = buildDrilldownRequest(shortReq);
    expect(req.intervalMs).toBe(15000);
    expect(req.interval).toBe('15s');
    expect(req.targets).toHaveLength(2);
    req.targets.forEach((t) => expect(t).toMatchObject({ instant: false, range: true }));
  });
});

describe('fetchDrilldownFrames', () => {
  it('queries the datasource and returns frames', async () => {
    const frames = [{ refId: 'A', fields: [], length: 0 }];
    const { of } = jest.requireActual('rxjs');
    const getMock = jest.fn().mockResolvedValue({ query: () => of({ data: frames }) });
    jest.spyOn(require('@grafana/runtime'), 'getDataSourceSrv').mockReturnValue({ get: getMock } as any);
    const result = await fetchDrilldownFrames(baseRequest);
    expect(getMock).toHaveBeenCalledWith({ type: 'prometheus', uid: 'ds1' });
    expect(result).toEqual(frames);
  });

  it('supports datasources whose query returns a promise', async () => {
    const frames = [{ refId: 'A', fields: [], length: 0 }];
    const getMock = jest.fn().mockResolvedValue({ query: () => Promise.resolve({ data: frames }) });
    jest.spyOn(require('@grafana/runtime'), 'getDataSourceSrv').mockReturnValue({ get: getMock } as any);
    await expect(fetchDrilldownFrames(baseRequest)).resolves.toEqual(frames);
  });

  it('groups targets by datasource (Mixed) and queries each datasource once with its own targets', async () => {
    const { of } = jest.requireActual('rxjs');
    const query = jest.fn().mockReturnValue(of({ data: [] }));
    const getMock = jest.fn().mockResolvedValue({ query });
    jest.spyOn(require('@grafana/runtime'), 'getDataSourceSrv').mockReturnValue({ get: getMock } as any);
    const mixed = {
      ...baseRequest,
      targets: [
        { refId: 'A', datasource: { type: 'prometheus', uid: 'ds1' }, instant: true, range: false },
        { refId: 'B', datasource: { type: 'prometheus', uid: 'ds1' }, instant: true, range: false },
        { refId: 'C', datasource: { type: 'loki', uid: 'ds2' }, instant: true, range: false },
      ],
    } as any;
    await fetchDrilldownFrames(mixed);
    // 2つの異なるdatasource → get/queryは各1回(同一datasourceのtargetsは束ねる)
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledWith({ type: 'prometheus', uid: 'ds1' });
    expect(getMock).toHaveBeenCalledWith({ type: 'loki', uid: 'ds2' });
    // 各requestが自datasourceのtargetsのみを保持している(A,Bはds1、Cはds2)
    const requests = query.mock.calls.map((c: any[]) => c[0]);
    const ds1req = requests.find((r: any) => r.targets[0].datasource.uid === 'ds1');
    const ds2req = requests.find((r: any) => r.targets[0].datasource.uid === 'ds2');
    expect(ds1req.targets.map((t: any) => t.refId)).toEqual(['A', 'B']);
    expect(ds2req.targets.map((t: any) => t.refId)).toEqual(['C']);
  });
});
