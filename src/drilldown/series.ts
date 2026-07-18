import { DataFrame, DisplayValue, Field, FieldType, LinkModel } from '@grafana/data';
import { SpatialAggregation } from '../types';

function labelsMatch(fieldLabels: Record<string, string> | undefined, want: Record<string, string>): boolean {
  if (!fieldLabels) {
    return Object.keys(want).length === 0;
  }
  return Object.entries(want).every(([k, v]) => fieldLabels[k] === v);
}

export function findSeriesFrames(frames: DataFrame[], refId: string, labels: Record<string, string>): DataFrame[] {
  return frames.filter((frame) => {
    if ((frame.refId ?? 'A') !== refId) {
      return false;
    }
    const time = frame.fields.find((f) => f.type === FieldType.time);
    if (!time || frame.length < 2) {
      return false;
    }
    return frame.fields.some((f) => f.type === FieldType.number && labelsMatch(f.labels, labels));
  });
}

function aggregatePoint(values: number[], agg: SpatialAggregation): number {
  switch (agg) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

/** セルに複数系列が畳まれている場合、スパークラインにも同じ空間集約を適用してセル値と整合させる */
export function drilldownSeries(
  frames: DataFrame[],
  refId: string,
  labels: Record<string, string>,
  agg: SpatialAggregation
): { frame: DataFrame | null; seriesCount: number } {
  const matched = findSeriesFrames(frames, refId, labels);
  if (matched.length === 0) {
    return { frame: null, seriesCount: 0 };
  }
  if (matched.length === 1) {
    return { frame: matched[0], seriesCount: 1 };
  }
  const timeOf = (f: DataFrame) => f.fields.find((x) => x.type === FieldType.time)!;
  const valueOf = (f: DataFrame) => f.fields.find((x) => x.type === FieldType.number)!;
  const base = timeOf(matched[0]).values;
  const aligned = matched.every((f) => {
    const t = timeOf(f).values;
    return t.length === base.length && t.every((v, i) => v === base[i]);
  });
  if (!aligned) {
    // 時刻が揃わない場合は集約せず先頭系列を示す(seriesCountで区別可能)
    return { frame: matched[0], seriesCount: matched.length };
  }
  const agged = base.map((_, i) =>
    aggregatePoint(
      matched.map((f) => Number(valueOf(f).values[i])).filter((v) => !Number.isNaN(v)),
      agg
    )
  );
  const frame: DataFrame = {
    ...matched[0],
    fields: [timeOf(matched[0]), { ...valueOf(matched[0]), values: agged } as Field],
  };
  return { frame, seriesCount: matched.length };
}

export function getCellLinks(
  frames: DataFrame[],
  refId: string,
  labels: Record<string, string>,
  calculatedValue?: DisplayValue
): Array<LinkModel<Field>> {
  for (const frame of frames) {
    if ((frame.refId ?? 'A') !== refId) {
      continue;
    }
    // 系列形式: labels一致の数値フィールド。reduce値なのでcalculatedValueを渡す(Grafanaの契約)
    const field = frame.fields.find((f) => f.type === FieldType.number && labelsMatch(f.labels, labels));
    if (field?.getLinks) {
      return field.getLinks({ calculatedValue });
    }
    // table形式: 文字列列がセルlabelsに一致する行を特定してvalueRowIndexを渡す
    const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
    if (stringFields.length > 0) {
      for (let row = 0; row < frame.length; row++) {
        const ok = Object.entries(labels).every(([k, v]) => {
          const col = stringFields.find((f) => f.name === k);
          return !col || String(col.values[row]) === v;
        });
        if (ok) {
          const vf = frame.fields.find((f) => f.type === FieldType.number);
          if (vf?.getLinks) {
            return vf.getLinks({ valueRowIndex: row });
          }
          break;
        }
      }
    }
  }
  return [];
}
