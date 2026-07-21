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

const expandRange = (value: number, preferredDirection: 'up' | 'down'): [number, number] => {
  const delta = Math.max(1, Math.abs(value) * Number.EPSILON);
  const up = value + delta;
  const down = value - delta;
  if (preferredDirection === 'up') {
    if (Number.isFinite(up) && up > value) {
      return [value, up];
    }
    if (Number.isFinite(down) && down < value) {
      return [down, value];
    }
  } else {
    if (Number.isFinite(down) && down < value) {
      return [down, value];
    }
    if (Number.isFinite(up) && up > value) {
      return [value, up];
    }
  }
  return [0, 1];
};

const hasFinitePositiveDelta = (min: number, max: number): boolean => {
  const delta = max - min;
  return Number.isFinite(delta) && delta > 0;
};

export interface MetricInfo {
  refId: string;
  name: string;
  effectiveMin: number;
  effectiveMax: number;
  minConfigured: boolean;
  maxConfigured: boolean;
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
    const hasFinitePreset = preset && Number.isFinite(preset.min) && Number.isFinite(preset.max);
    let min = hasFinitePreset ? preset.min : Number.POSITIVE_INFINITY;
    let max = hasFinitePreset ? preset.max : Number.NEGATIVE_INFINITY;
    if (!hasFinitePreset) {
      for (const f of group) {
        for (const field of f.fields) {
          if (field.type !== FieldType.number) {
            continue;
          }
          for (const v of field.values) {
            if (typeof v !== 'number' || !Number.isFinite(v)) {
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
      [min, max] = expandRange(min, 'up');
    }

    const minConfigured = Number.isFinite(firstNumeric.field.config.min);
    const maxConfigured = Number.isFinite(firstNumeric.field.config.max);
    const config = { ...firstNumeric.field.config };
    let effMin = minConfigured ? (config.min as number) : min;
    let effMax = maxConfigured ? (config.max as number) : max;
    if (minConfigured && maxConfigured) {
      if (effMin > effMax) {
        [effMin, effMax] = [effMax, effMin];
      } else if (effMin === effMax) {
        [effMin, effMax] = expandRange(effMin, 'up');
      }
    } else if (minConfigured && effMin >= effMax) {
      [effMin, effMax] = expandRange(effMin, 'up');
    } else if (maxConfigured && effMin >= effMax) {
      [effMin, effMax] = expandRange(effMax, 'down');
    }
    // Extreme finite endpoints can overflow when expanded. A valid scale takes precedence over retaining an impossible endpoint.
    if (!Number.isFinite(effMin) || !Number.isFinite(effMax) || effMin >= effMax) {
      effMin = 0;
      effMax = 1;
    }
    if (!hasFinitePositiveDelta(effMin, effMax)) {
      effMin /= 2;
      effMax /= 2;
    }
    if (!hasFinitePositiveDelta(effMin, effMax)) {
      effMin = 0;
      effMax = 1;
    }
    const delta = effMax - effMin;
    config.min = effMin;
    config.max = effMax;
    // The display processor prioritizes field.state.range over config, so keep both in sync
    const field: Field = {
      ...firstNumeric.field,
      config,
      state: { ...firstNumeric.field.state, range: { min: effMin, max: effMax, delta } },
    };
    const processor = getDisplayProcessor({ field, theme, timeZone });

    infos.push({
      refId,
      name: group[0].name ?? refId,
      effectiveMin: effMin,
      effectiveMax: effMax,
      minConfigured,
      maxConfigured,
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
