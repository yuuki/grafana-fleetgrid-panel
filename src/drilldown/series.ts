import { DataFrame, DisplayValue, Field, FieldType, LinkModel } from '@grafana/data';
import { SpatialAggregation } from '../types';

function labelsMatch(fieldLabels: Record<string, string> | undefined, want: Record<string, string>): boolean {
  if (!fieldLabels) {
    return Object.keys(want).length === 0;
  }
  return Object.entries(want).every(([k, v]) => fieldLabels[k] === v);
}

interface SeriesCandidate {
  frame: DataFrame;
  time: Field;
  value: Field;
}

/**
 * refIdが一致し時間フィールドが2点以上あるフレームから、セルlabelsを含む数値フィールドを
 * 「1系列=1数値フィールド」として列挙する。wide frame(1フレームに複数数値フィールド)は
 * normalize側と同じく数値フィールドごとに別系列として扱い、セル値との系列集合を一致させる。
 */
function collectSeries(frames: DataFrame[], refId: string, labels: Record<string, string>): SeriesCandidate[] {
  const out: SeriesCandidate[] = [];
  for (const frame of frames) {
    if ((frame.refId ?? 'A') !== refId) {
      continue;
    }
    const time = frame.fields.find((f) => f.type === FieldType.time);
    if (!time || frame.length < 2) {
      continue;
    }
    for (const value of frame.fields) {
      if (value.type === FieldType.number && labelsMatch(value.labels, labels)) {
        out.push({ frame, time, value });
      }
    }
  }
  return out;
}

/** セルlabelsを含む数値フィールドを持つフレーム(スパークライン用に2点以上)を重複なく返す */
export function findSeriesFrames(frames: DataFrame[], refId: string, labels: Record<string, string>): DataFrame[] {
  const seen = new Set<DataFrame>();
  const out: DataFrame[] = [];
  for (const c of collectSeries(frames, refId, labels)) {
    if (!seen.has(c.frame)) {
      seen.add(c.frame);
      out.push(c.frame);
    }
  }
  return out;
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

export interface DrilldownResult {
  frame: DataFrame | null;
  seriesCount: number;
  /** 複数系列を時点ごとに集約したか。falseなら先頭系列のみのフォールバック表示 */
  aggregated: boolean;
}

/**
 * セルに複数系列が畳まれている場合、時刻配列が一致すればスパークラインにも同じ空間集約を
 * 時点ごとに適用してセル値と整合させる。欠損サンプル(null/undefined/NaN)は集約から除外し、
 * その時点の有効値が0件なら時点値をnullにする。時刻が揃わなければ集約せず先頭系列を返す
 * (aggregated:falseで区別できる)。
 */
export function drilldownSeries(
  frames: DataFrame[],
  refId: string,
  labels: Record<string, string>,
  agg: SpatialAggregation
): DrilldownResult {
  const series = collectSeries(frames, refId, labels);
  if (series.length === 0) {
    return { frame: null, seriesCount: 0, aggregated: false };
  }
  // スパークラインは一致した数値フィールドのみを描くよう[time, value]で再構成する
  const asFrame = (s: SeriesCandidate): DataFrame => ({ ...s.frame, fields: [s.time, s.value] });
  if (series.length === 1) {
    return { frame: asFrame(series[0]), seriesCount: 1, aggregated: false };
  }
  const base = series[0].time.values;
  const aligned = series.every((s) => {
    const t = s.time.values;
    return t.length === base.length && t.every((v, i) => v === base[i]);
  });
  if (!aligned) {
    // 時刻が揃わない場合は集約せず先頭系列を示す(seriesCount/aggregatedで区別可能)
    return { frame: asFrame(series[0]), seriesCount: series.length, aggregated: false };
  }
  const agged: Array<number | null> = base.map((_, i) => {
    const vals = series
      .map((s) => s.value.values[i])
      .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
    return vals.length === 0 ? null : aggregatePoint(vals, agg);
  });
  const frame: DataFrame = {
    ...series[0].frame,
    fields: [series[0].time, { ...series[0].value, values: agged } as Field],
  };
  return { frame, seriesCount: series.length, aggregated: true };
}

export function getCellLinks(
  frames: DataFrame[],
  refId: string,
  labels: Record<string, string>,
  calculatedValue?: DisplayValue
): Array<LinkModel<Field>> {
  const out: Array<LinkModel<Field>> = [];
  for (const frame of frames) {
    if ((frame.refId ?? 'A') !== refId) {
      continue;
    }
    // 系列形式: labels一致の数値フィールドすべてを対象にする(wide frameは複数系列)。
    // reduce値なのでcalculatedValueを渡す(Grafanaの契約)。
    const seriesFields = frame.fields.filter((f) => f.type === FieldType.number && labelsMatch(f.labels, labels));
    if (seriesFields.length > 0) {
      for (const field of seriesFields) {
        if (field.getLinks) {
          out.push(...field.getLinks({ calculatedValue }));
        }
      }
      continue;
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
          for (const vf of frame.fields.filter((f) => f.type === FieldType.number)) {
            if (vf.getLinks) {
              out.push(...vf.getLinks({ valueRowIndex: row }));
            }
          }
          break;
        }
      }
    }
  }
  return out;
}
