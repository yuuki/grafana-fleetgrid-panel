import {
  DataFrame,
  DisplayProcessor,
  DisplayValue,
  Field,
  FieldType,
  GrafanaTheme2,
  formattedValueToString,
  getDisplayProcessor,
} from '@grafana/data';

export interface MetricInfo {
  refId: string;
  name: string;
  processor: DisplayProcessor;
  field: Field;
  frame: DataFrame;
}

export function buildMetricInfos(
  frames: DataFrame[],
  theme: GrafanaTheme2,
  timeZone: string,
  rangeByRef?: Map<string, { min: number; max: number }>
): MetricInfo[] {
  const byRef = new Map<string, DataFrame[]>();
  for (const f of frames) {
    const refId = f.refId ?? 'A';
    byRef.set(refId, [...(byRef.get(refId) ?? []), f]);
  }

  const infos: MetricInfo[] = [];
  for (const [refId, group] of byRef) {
    const firstNumeric = group
      .flatMap((f) => f.fields.map((field) => ({ field, frame: f })))
      .find(({ field }) => field.type === FieldType.number);
    if (!firstNumeric) {
      continue;
    }

    // Per-refId min/max: prefer rangeByRef derived from cell values, and fall back to scanning frames if unavailable (explicit config always takes precedence)
    const preset = rangeByRef?.get(refId);
    let min = preset ? preset.min : Number.POSITIVE_INFINITY;
    let max = preset ? preset.max : Number.NEGATIVE_INFINITY;
    if (!preset) {
      for (const f of group) {
        for (const field of f.fields) {
          if (field.type !== FieldType.number) {
            continue;
          }
          for (const v of field.values) {
            if (v == null || Number.isNaN(v)) {
              continue;
            }
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        }
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 1;
    }
    if (min === max) {
      max = min + 1;
    }

    const config = { ...firstNumeric.field.config };
    const effMin = config.min ?? min;
    const effMax = config.max ?? max;
    config.min = effMin;
    config.max = effMax;
    // The display processor prioritizes field.state.range over config, so keep both in sync
    const field: Field = {
      ...firstNumeric.field,
      config,
      state: { ...firstNumeric.field.state, range: { min: effMin, max: effMax, delta: effMax - effMin } },
    };
    const processor = getDisplayProcessor({ field, theme, timeZone });

    infos.push({
      refId,
      name: group[0].name ?? refId,
      processor,
      field,
      frame: firstNumeric.frame,
    });
  }
  return infos;
}

const FONT_MIN = 9;
const FONT_MAX = 15;
const TEXT_PAD = 4;

export function chooseCellText(
  display: DisplayValue,
  cellW: number,
  cellH: number,
  measure: (text: string, fontPx: number) => number
): { text: string; fontPx: number } | null {
  const fontPx = Math.min(FONT_MAX, Math.max(FONT_MIN, cellH * 0.38));
  if (cellH < FONT_MIN + 2) {
    return null;
  }
  const withSuffix = formattedValueToString(display); // Standard formatting including prefix/suffix
  if (measure(withSuffix, fontPx) + TEXT_PAD <= cellW) {
    return { text: withSuffix, fontPx };
  }
  if (measure(display.text, fontPx) + TEXT_PAD <= cellW) {
    return { text: display.text, fontPx };
  }
  return null;
}
