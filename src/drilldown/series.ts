import { DataFrame, DisplayValue, Field, FieldType, LinkModel } from '@grafana/data';
import { SpatialAggregation } from '../types';

function labelsMatch(fieldLabels: Record<string, string> | undefined, want: Record<string, string>): boolean {
  if (!fieldLabels) {
    return Object.keys(want).length === 0;
  }
  return Object.entries(want).every(([k, v]) => fieldLabels[k] === v);
}

/** A cell may have multiple original label sets (extraction-key collisions). A single set is also normalized to an array. */
type LabelSpec = Record<string, string> | Array<Record<string, string>>;
function toLabelSets(labels: LabelSpec): Array<Record<string, string>> {
  return Array.isArray(labels) ? labels : [labels];
}
function matchesAnySet(fieldLabels: Record<string, string> | undefined, sets: Array<Record<string, string>>): boolean {
  return sets.some((s) => labelsMatch(fieldLabels, s));
}

interface SeriesCandidate {
  frame: DataFrame;
  time: Field;
  value: Field;
}

/**
 * From frames whose refId matches and that have 2 or more time points, enumerate the numeric fields
 * containing the cell's labels as "1 series = 1 numeric field". A wide frame (multiple numeric fields
 * in one frame) is treated as a separate series per numeric field, same as on the normalize side, to match the series set against the cell value.
 */
function collectSeries(frames: DataFrame[], refId: string, sets: Array<Record<string, string>>): SeriesCandidate[] {
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
      if (value.type === FieldType.number && matchesAnySet(value.labels, sets)) {
        out.push({ frame, time, value });
      }
    }
  }
  return out;
}

/** Returns, without duplicates, the frames with a numeric field containing the cell's labels (2+ points, for the sparkline) */
export function findSeriesFrames(frames: DataFrame[], refId: string, labels: LabelSpec): DataFrame[] {
  const seen = new Set<DataFrame>();
  const out: DataFrame[] = [];
  for (const c of collectSeries(frames, refId, toLabelSets(labels))) {
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
  /** Whether multiple series were aggregated per timestamp. If false, it's a fallback display of the first series only */
  aggregated: boolean;
}

/**
 * When multiple series are collapsed into a cell and their time arrays match, apply the same spatial
 * aggregation per timestamp to the sparkline too, to keep it consistent with the cell value. Missing
 * samples (null/undefined/NaN) are excluded from the aggregation, and a timestamp's value becomes null
 * if it has zero valid values. If the times don't align, skip aggregation and return the first series (distinguishable via aggregated:false).
 */
export function drilldownSeries(
  frames: DataFrame[],
  refId: string,
  labels: LabelSpec,
  agg: SpatialAggregation
): DrilldownResult {
  const series = collectSeries(frames, refId, toLabelSets(labels));
  if (series.length === 0) {
    return { frame: null, seriesCount: 0, aggregated: false };
  }
  // Reconstruct as [time, value] so the sparkline only draws the matched numeric field
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
    // If times don't align, skip aggregation and show the first series (distinguishable via seriesCount/aggregated)
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

/**
 * Collapses only links that are semantically identical. Typically handles the case where the same
 * Data Link config is applied to each series, returning identical (href/title/target) links once per series — collapsed to one.
 * onClick is treated conservatively since behavior can differ; only identified as the same when the
 * function reference matches exactly (even with a matching origin, a different function reference is kept as distinct; when in doubt, keep it).
 */
function sameLink(a: LinkModel<Field>, b: LinkModel<Field>): boolean {
  if (a.href !== b.href || a.title !== b.title || (a.target ?? '') !== (b.target ?? '')) {
    return false;
  }
  if (!a.onClick && !b.onClick) {
    // Pure href links: considered identical if href/title/target match
    return true;
  }
  if (a.onClick && b.onClick) {
    // Both have onClick: origin only indicates the source and doesn't guarantee identical behavior.
    // Only collapse as the same behavior when the function reference is identical.
    return a.onClick === b.onClick;
  }
  // Only one side has onClick: kept as distinct since the behavior differs
  return false;
}

function dedupeLinks(links: Array<LinkModel<Field>>): Array<LinkModel<Field>> {
  const out: Array<LinkModel<Field>> = [];
  for (const link of links) {
    if (!out.some((kept) => sameLink(kept, link))) {
      out.push(link);
    }
  }
  return out;
}

export function getCellLinks(
  frames: DataFrame[],
  refId: string,
  labels: LabelSpec,
  calculatedValue?: DisplayValue
): Array<LinkModel<Field>> {
  const sets = toLabelSets(labels);
  const out: Array<LinkModel<Field>> = [];
  for (const frame of frames) {
    if ((frame.refId ?? 'A') !== refId) {
      continue;
    }
    // Series format: target every numeric field whose labels match (a wide frame has multiple series).
    // Pass calculatedValue since it's a reduced value (Grafana's contract).
    const seriesFields = frame.fields.filter((f) => f.type === FieldType.number && matchesAnySet(f.labels, sets));
    if (seriesFields.length > 0) {
      for (const field of seriesFields) {
        if (field.getLinks) {
          out.push(...field.getLinks({ calculatedValue }));
        }
      }
      continue;
    }
    // Table format: target every row where all required label columns exist and their values match (a missing column is a mismatch).
    // Don't stop at the first matching row — collect links from every matching row (duplicates are collapsed by the trailing dedupe).
    const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
    if (stringFields.length > 0) {
      const numberFields = frame.fields.filter((f) => f.type === FieldType.number);
      for (let row = 0; row < frame.length; row++) {
        const ok = sets.some((set) =>
          Object.entries(set).every(([k, v]) => {
            const col = stringFields.find((f) => f.name === k);
            return col !== undefined && String(col.values[row]) === v;
          })
        );
        if (!ok) {
          continue;
        }
        for (const vf of numberFields) {
          if (vf.getLinks) {
            out.push(...vf.getLinks({ valueRowIndex: row }));
          }
        }
      }
    }
  }
  // Prevents a semantically single link from being duplicated per series and either firing repeatedly on immediate execution or flooding the menu with duplicate keys
  return dedupeLinks(out);
}
