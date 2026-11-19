import React from 'react';
import { dateTimeFormat } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';

export const PLAYBACK_SPEEDS = [1, 2, 5, 15, 30, 60] as const;
export const DEFAULT_PLAYBACK_SPEED = 5;
export const FOOTER_H = 34;

export interface TimeScrubberProps {
  footerRef: React.RefObject<HTMLDivElement>;
  timestamps: Float64Array;
  activeIndex: number;
  isScrubbing: boolean;
  isPlaying: boolean;
  stepsPerSec: number;
  timeZone: string;
  onTogglePlay: () => void;
  onScrub: (index: number) => void;
  onStep: (delta: number) => void;
  onSpeedChange: (stepsPerSec: number) => void;
  onResetLive: () => void;
}

export const TimeScrubber: React.FC<TimeScrubberProps> = ({
  footerRef,
  timestamps,
  activeIndex,
  isScrubbing,
  isPlaying,
  stepsPerSec,
  timeZone,
  onTogglePlay,
  onScrub,
  onStep,
  onSpeedChange,
  onResetLive,
}) => {
  const theme = useTheme2();
  const total = timestamps.length;
  const clampedIndex = Math.max(0, Math.min(total - 1, activeIndex));
  const ts = timestamps[clampedIndex];
  const formattedTime = Number.isFinite(ts)
    ? dateTimeFormat(ts, { timeZone, format: 'YYYY-MM-DD HH:mm:ss' })
    : '';

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 22,
    minWidth: 24,
    padding: '0 6px',
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: 3,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    fontSize: 11,
    cursor: 'pointer',
    lineHeight: 1,
  };

  return (
    <div
      ref={footerRef}
      data-testid="time-scrubber"
      style={{
        minHeight: FOOTER_H,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 6px',
        boxSizing: 'border-box',
        borderTop: `1px solid ${theme.colors.border.weak}`,
        background: theme.colors.background.secondary,
        color: theme.colors.text.primary,
        fontSize: 11,
      }}
    >
      <button
        type="button"
        data-testid="scrubber-play-toggle"
        aria-label={isPlaying ? 'Pause playback' : 'Play timeline'}
        onClick={onTogglePlay}
        style={buttonStyle}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        data-testid="scrubber-step-back"
        aria-label="Previous timestamp"
        disabled={clampedIndex <= 0}
        onClick={() => onStep(-1)}
        style={{ ...buttonStyle, opacity: clampedIndex <= 0 ? 0.45 : 1 }}
      >
        ◀
      </button>
      <button
        type="button"
        data-testid="scrubber-step-forward"
        aria-label="Next timestamp"
        disabled={clampedIndex >= total - 1}
        onClick={() => onStep(1)}
        style={{ ...buttonStyle, opacity: clampedIndex >= total - 1 ? 0.45 : 1 }}
      >
        ▶
      </button>
      <input
        type="range"
        data-testid="scrubber-slider"
        aria-label="Timeline scrubber"
        min={0}
        max={Math.max(0, total - 1)}
        step={1}
        value={clampedIndex}
        onChange={(e) => onScrub(Number(e.target.value))}
        style={{ flex: 1, minWidth: 60, margin: 0, cursor: 'pointer' }}
      />
      <span
        data-testid="scrubber-timestamp"
        style={{
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          color: theme.colors.text.primary,
        }}
      >
        {formattedTime}
      </span>
      <span
        data-testid="scrubber-frame-counter"
        style={{
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          color: theme.colors.text.secondary,
        }}
      >
        {`${clampedIndex + 1}/${total}`}
      </span>
      <select
        data-testid="scrubber-speed"
        aria-label="Playback speed"
        value={stepsPerSec}
        onChange={(e) => onSpeedChange(Number(e.target.value))}
        style={{
          height: 22,
          padding: '0 4px',
          border: `1px solid ${theme.colors.border.medium}`,
          borderRadius: 3,
          background: theme.colors.background.primary,
          color: theme.colors.text.primary,
          fontSize: 11,
        }}
      >
        {PLAYBACK_SPEEDS.map((speed) => (
          <option key={speed} value={speed}>
            {`${speed}/s`}
          </option>
        ))}
      </select>
      {isScrubbing && (
        <button
          type="button"
          data-testid="scrubber-reset-live"
          aria-label="Return to reduced view"
          onClick={onResetLive}
          style={{ ...buttonStyle, color: theme.colors.primary.text }}
        >
          Live
        </button>
      )}
    </div>
  );
};
