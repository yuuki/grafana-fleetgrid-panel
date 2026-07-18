import { DataFrame, Field, FieldType, reduceField } from '@grafana/data';
import { NormalizedRow } from '../types';

/**
 * ラベルが列として展開されたtable形式か。
 * Prometheus/VictoriaMetricsのinstant+format=tableはTime列を含むため、Time列の有無では判定しない。
 * 「文字列列があり、かつ数値フィールドがlabelsを持たない」ことをtableの根拠にする。
 */
export function isTableFrame(frame: DataFrame): boolean {
  const hasLabeledNumber = frame.fields.some(
    (f) => f.type === FieldType.number && f.labels && Object.keys(f.labels).length > 0
  );
  const hasStringColumn = frame.fields.some((f) => f.type === FieldType.string);
  return hasStringColumn && !hasLabeledNumber;
}

export function normalizeFrames(frames: DataFrame[], reduceCalc: string): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  for (const frame of frames) {
    const refId = frame.refId ?? 'A';
    const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
    const numberFields = frame.fields.filter((f) => f.type === FieldType.number);

    if (isTableFrame(frame)) {
      // table形式: 行ごとに1レコード
      const valueField = numberFields[0];
      if (!valueField) {
        continue;
      }
      for (let i = 0; i < frame.length; i++) {
        const labels: Record<string, string> = {};
        for (const f of stringFields) {
          labels[f.name] = String(f.values[i]);
        }
        const raw = valueField.values[i];
        rows.push({ labels, value: raw == null ? null : Number(raw), refId });
      }
      continue;
    }

    // time series形式: 数値フィールドごとに1レコード
    for (const field of numberFields) {
      rows.push({
        labels: { ...(field.labels ?? {}) },
        value: reduceToValue(field, reduceCalc),
        refId,
      });
    }
  }
  return rows;
}

function reduceToValue(field: Field, reduceCalc: string): number | null {
  const stats = reduceField({ field, reducers: [reduceCalc] });
  const v = stats[reduceCalc];
  // allValues等の非数値reducerが指定されても契約(number|null)を守る
  return typeof v !== 'number' || Number.isNaN(v) ? null : v;
}
