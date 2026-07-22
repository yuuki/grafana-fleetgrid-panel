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

export interface EffectiveRange {
  min: number;
  max: number;
}

export function normalizeEffectiveRange(
  min: number,
  max: number,
  minConfigured: boolean,
  maxConfigured: boolean,
  preferredEndpoint?: 'min' | 'max'
): EffectiveRange {
  let effectiveMin = min;
  let effectiveMax = max;
  if (preferredEndpoint === 'min' && effectiveMin >= effectiveMax) {
    [effectiveMin, effectiveMax] = expandRange(effectiveMin, 'up');
  } else if (preferredEndpoint === 'max' && effectiveMin >= effectiveMax) {
    [effectiveMin, effectiveMax] = expandRange(effectiveMax, 'down');
  } else if (minConfigured && maxConfigured) {
    if (effectiveMin > effectiveMax) {
      [effectiveMin, effectiveMax] = [effectiveMax, effectiveMin];
    } else if (effectiveMin === effectiveMax) {
      [effectiveMin, effectiveMax] = expandRange(effectiveMin, 'up');
    }
  } else if (minConfigured && effectiveMin >= effectiveMax) {
    [effectiveMin, effectiveMax] = expandRange(effectiveMin, 'up');
  } else if (maxConfigured && effectiveMin >= effectiveMax) {
    [effectiveMin, effectiveMax] = expandRange(effectiveMax, 'down');
  }
  if (!Number.isFinite(effectiveMin) || !Number.isFinite(effectiveMax) || effectiveMin >= effectiveMax) {
    effectiveMin = 0;
    effectiveMax = 1;
  }
  if (!hasFinitePositiveDelta(effectiveMin, effectiveMax)) {
    effectiveMin /= 2;
    effectiveMax /= 2;
  }
  if (!hasFinitePositiveDelta(effectiveMin, effectiveMax)) {
    effectiveMin = 0;
    effectiveMax = 1;
  }
  return { min: effectiveMin, max: effectiveMax };
}

export interface MetricInfo {
  refId: string;
  name: string;
  /** Cell-derived automatic endpoints before field-config normalization. */
  autoMin?: number;
  autoMax?: number;
  /** Original finite field-config endpoints, before they are normalized for display. */
  configuredMin?: number;
  configuredMax?: number;
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
    const normalized = normalizeEffectiveRange(
      minConfigured ? (config.min as number) : min,
      maxConfigured ? (config.max as number) : max,
      minConfigured,
      maxConfigured
    );
    const effMin = normalized.min;
    const effMax = normalized.max;
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
      autoMin: min,
      autoMax: max,
      configuredMin: minConfigured ? (firstNumeric.field.config.min as number) : undefined,
      configuredMax: maxConfigured ? (firstNumeric.field.config.max as number) : undefined,
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
