import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { TimeScrubber } from './TimeScrubber';

describe('TimeScrubber', () => {
  const timestamps = Float64Array.from([1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000]);

  const baseProps = () => ({
    footerRef: React.createRef<HTMLDivElement>(),
    timestamps,
    activeIndex: 1,
    isScrubbing: false,
    isPlaying: false,
    stepsPerSec: 5,
    timeZone: 'utc',
    onTogglePlay: jest.fn(),
    onScrub: jest.fn(),
    onStep: jest.fn(),
    onSpeedChange: jest.fn(),
    onResetLive: jest.fn(),
  });

  it('renders controls, timestamp, and frame counter and fires callbacks', () => {
    const props = baseProps();
    render(<TimeScrubber {...props} />);

    expect(screen.getByTestId('scrubber-frame-counter')).toHaveTextContent('2/3');
    expect(screen.getByTestId('scrubber-timestamp')).toHaveTextContent('2023-11-14 22:14:20');
    expect(screen.queryByTestId('scrubber-reset-live')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('scrubber-play-toggle'));
    expect(props.onTogglePlay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('scrubber-step-back'));
    expect(props.onStep).toHaveBeenCalledWith(-1);

    fireEvent.click(screen.getByTestId('scrubber-step-forward'));
    expect(props.onStep).toHaveBeenCalledWith(1);

    fireEvent.change(screen.getByTestId('scrubber-slider'), { target: { value: '0' } });
    expect(props.onScrub).toHaveBeenCalledWith(0);

    fireEvent.change(screen.getByTestId('scrubber-speed'), { target: { value: '30' } });
    expect(props.onSpeedChange).toHaveBeenCalledWith(30);
  });

  it('shows the Live reset button while scrubbing and disables boundary step buttons', () => {
    const props = { ...baseProps(), activeIndex: 0, isScrubbing: true, isPlaying: true };
    render(<TimeScrubber {...props} />);

    expect(screen.getByRole('button', { name: 'Pause playback' })).toBeInTheDocument();
    expect(screen.getByTestId('scrubber-step-back')).toBeDisabled();
    expect(screen.getByTestId('scrubber-step-forward')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('scrubber-reset-live'));
    expect(props.onResetLive).toHaveBeenCalledTimes(1);
  });
});
