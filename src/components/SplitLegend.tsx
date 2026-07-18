import React from 'react';
import { MetricInfo } from '../data/display';
import { MAX_SPLIT, splitRects } from '../render/split';

export const SplitLegend: React.FC<{ metricInfos: MetricInfo[] }> = ({ metricInfos }) => {
  const shown = metricInfos.slice(0, MAX_SPLIT);
  const rects = splitRects(shown.length);
  const hidden = metricInfos.length - shown.length;
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
      {shown.map((info, i) => (
        <span key={info.refId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {/* Zone-position miniature: which zone within the cell this metric is drawn in (the spec's position-mapping diagram) */}
          <span
            aria-hidden
            style={{ position: 'relative', width: 14, height: 14, border: '1px solid currentColor', display: 'inline-block' }}
          >
            <span
              style={{
                position: 'absolute',
                left: `${rects[i].x * 100}%`,
                top: `${rects[i].y * 100}%`,
                width: `${rects[i].w * 100}%`,
                height: `${rects[i].h * 100}%`,
                background: 'currentColor',
              }}
            />
          </span>
          <span>{`${i + 1}: ${info.name}`}</span>
        </span>
      ))}
      {hidden > 0 && <span style={{ opacity: 0.7 }}>{`分割表示は9クエリまでです(${hidden}件は非表示)`}</span>}
    </div>
  );
};
