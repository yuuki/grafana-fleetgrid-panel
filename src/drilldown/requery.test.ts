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
});
