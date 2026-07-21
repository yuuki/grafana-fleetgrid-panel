import React, { useMemo } from 'react';
import { formattedValueToString } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import { MetricInfo } from '../data/display';

const COMPACT_WIDTH = 480;
const GRADIENT_SAMPLES = 33;

export const rangeStateLabel = (metricInfo: MetricInfo): 'Fixed' | 'Auto' | 'Min fixed' | 'Max fixed' => {
  if (metricInfo.minConfigured && metricInfo.maxConfigured) {
    return 'Fixed';
  }
  if (metricInfo.minConfigured) {
    return 'Min fixed';
  }
  if (metricInfo.maxConfigured) {
    return 'Max fixed';
  }
  return 'Auto';
};

export const formatRangeEndpoint = (metricInfo: MetricInfo, value: number): string =>
  formattedValueToString(metricInfo.processor(value));

const buildGradient = (metricInfo: MetricInfo): string => {
  const colors = Array.from({ length: GRADIENT_SAMPLES }, (_, index) => {
    const ratio = index / (GRADIENT_SAMPLES - 1);
    const value = metricInfo.effectiveMin + (metricInfo.effectiveMax - metricInfo.effectiveMin) * ratio;
    const color = metricInfo.processor(value).color ?? 'transparent';
    return `${color} ${ratio * 100}%`;
  });
  return `linear-gradient(to right, ${colors.join(', ')})`;
};

export const RangeLegend: React.FC<{ metricInfo?: MetricInfo; metricName?: string; width: number }> = ({
  metricInfo,
  metricName,
  width,
}) => {
  const theme = useTheme2();
  const isCompact = width < COMPACT_WIDTH;
  const range = useMemo(() => {
    if (!metricInfo) {
      return null;
    }
    return {
      state: rangeStateLabel(metricInfo),
      min: formatRangeEndpoint(metricInfo, metricInfo.effectiveMin),
      max: formatRangeEndpoint(metricInfo, metricInfo.effectiveMax),
      gradient: isCompact ? undefined : buildGradient(metricInfo),
      isConfigured: metricInfo.minConfigured || metricInfo.maxConfigured,
    };
  }, [metricInfo, isCompact]);
  if (!metricInfo) {
    const name = metricName ?? 'Metric';
    return (
      <div
        data-testid="range-legend"
        aria-label={`${name} range, No data`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          padding: isCompact ? '2px 6px' : '3px 6px',
          border: `1px solid ${theme.colors.border.medium}`,
          borderRadius: 3,
          color: theme.colors.text.primary,
          background: theme.colors.background.secondary,
          fontSize: 11,
          whiteSpace: 'nowrap',
        }}
      >
        <span>{name}</span>
        <span style={{ color: theme.colors.text.secondary }}>No data</span>
      </div>
    );
  }
  const { state, min, max, gradient, isConfigured } = range!;

  if (isCompact) {
    return (
      <span
        data-testid="range-legend"
        aria-label={`${metricInfo.name} range, ${state}, ${min} to ${max}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          minWidth: 0,
          padding: '2px 6px',
          border: `1px solid ${theme.colors.border.medium}`,
          borderRadius: 3,
          color: theme.colors.text.primary,
          background: theme.colors.background.secondary,
          fontSize: 11,
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden style={{ color: theme.colors.text.secondary }}>
          {isConfigured ? '🔒' : '↕'}
        </span>
        <span>{`${min}–${max}`}</span>
      </span>
    );
  }

  return (
    <div
      data-testid="range-legend"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        padding: '3px 6px',
        border: `1px solid ${theme.colors.border.medium}`,
        borderRadius: 3,
        color: theme.colors.text.primary,
        background: theme.colors.background.secondary,
        fontSize: 11,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metricInfo.name}</span>
      {isConfigured && <span aria-hidden>🔒</span>}
      <span style={{ color: theme.colors.text.secondary, whiteSpace: 'nowrap' }}>{state}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{min}</span>
      <span
        data-testid="range-gradient"
        aria-hidden
        style={{
          width: 120,
          height: 8,
          flex: '0 1 120px',
          minWidth: 40,
          border: `1px solid ${theme.colors.border.medium}`,
          borderRadius: 2,
          background: gradient,
        }}
      />
      <span style={{ whiteSpace: 'nowrap' }}>{max}</span>
    </div>
  );
};
