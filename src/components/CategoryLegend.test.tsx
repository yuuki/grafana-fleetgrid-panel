import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CategoryModel } from '../data/categories';
import { CategoryLegend, hoverablePointer } from './CategoryLegend';

describe('CategoryLegend', () => {
  it('renders one colored entry per category value', () => {
    const category: CategoryModel = {
      label: 'partition',
      values: ['a', 'b'],
      colorByValue: new Map([
        ['a', '#f00'],
        ['b', '#00f'],
      ]),
    };

    render(
      <CategoryLegend
        category={category}
        selectedValues={[]}
        onToggle={jest.fn()}
        onClear={jest.fn()}
        onHover={jest.fn()}
      />
    );

    expect(screen.getByTestId('category-legend-a')).toHaveTextContent('a');
    expect(screen.getByTestId('category-legend-a').firstElementChild).toHaveStyle({ background: '#f00' });
    expect(screen.getByTestId('category-legend-b').firstElementChild).toHaveStyle({ background: '#00f' });
  });

  it('toggles values and exposes the current selection', () => {
    const category: CategoryModel = { label: 'partition', values: ['a', 'b'], colorByValue: new Map([['a', '#f00'], ['b', '#00f']]) };
    const onToggle = jest.fn();
    render(
      <CategoryLegend
        category={category}
        selectedValues={['a']}
        onToggle={onToggle}
        onClear={jest.fn()}
        onHover={jest.fn()}
      />
    );

    expect(screen.getByTestId('category-legend-a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('category-legend-b')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('category-legend-b'));
    expect(onToggle).toHaveBeenCalledWith('b');
  });

  it('shows a clear button only for a non-empty selection and supports keyboard activation', () => {
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#f00']]) };
    const onToggle = jest.fn();
    const onClear = jest.fn();
    const { rerender } = render(
      <CategoryLegend
        category={category}
        selectedValues={[]}
        onToggle={onToggle}
        onClear={onClear}
        onHover={jest.fn()}
      />
    );
    expect(screen.queryByTestId('category-legend-clear')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('category-legend-a'), { key: 'Enter', code: 'Enter' });
    // Native buttons perform the click activation in the browser; fire it after the keyboard event in jsdom.
    fireEvent.click(screen.getByTestId('category-legend-a'));
    expect(onToggle).toHaveBeenCalledWith('a');

    rerender(
      <CategoryLegend
        category={category}
        selectedValues={['a']}
        onToggle={onToggle}
        onClear={onClear}
        onHover={jest.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('category-legend-clear'));
    expect(onClear).toHaveBeenCalled();
  });

  const twoValues: CategoryModel = {
    label: 'partition',
    values: ['a', 'b'],
    colorByValue: new Map([
      ['a', '#f00'],
      ['b', '#00f'],
    ]),
  };

  const chip = (v: string) => screen.getByTestId(`category-legend-${v}`);
  const renderLegend = (onHover: jest.Mock) =>
    render(<CategoryLegend category={twoValues} selectedValues={[]} onToggle={jest.fn()} onClear={jest.fn()} onHover={onHover} />);
  // Establish keyboard modality (focus-visible) before a focus, the way Tab navigation does.
  const tabKey = () => fireEvent.keyDown(document.body, { key: 'Tab' });

  it('reports the hovered value on pointer enter and clears it on leave', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    fireEvent.pointerEnter(chip('b'), { pointerType: 'mouse' });
    expect(onHover).toHaveBeenLastCalledWith('b');
    fireEvent.pointerLeave(chip('b'));
    expect(onHover).toHaveBeenLastCalledWith(undefined);
  });

  it('excludes touch from hover (mouse and pen hover, unknown falls back to hover)', () => {
    // The pointer-type predicate the enter handler uses. jsdom has no PointerEvent and drops pointerType on
    // synthetic pointer events, so the touch exclusion is verified here as a pure predicate.
    expect(hoverablePointer('touch')).toBe(false);
    expect(hoverablePointer('mouse')).toBe(true);
    expect(hoverablePointer('pen')).toBe(true);
    expect(hoverablePointer('')).toBe(true);
  });

  it('leaves no preview after a touch tap (pointerdown → pointerup → compatibility focus)', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    // The tap's pointerdown sets pointer modality, so the compatibility focus that follows is not previewed
    // (only keyboard focus is). Any transient hover from a touch enter is paired with a leave, so nothing sticks.
    fireEvent.pointerDown(chip('a'));
    fireEvent.pointerUp(chip('a'));
    fireEvent.focus(chip('a'));
    fireEvent.click(chip('a'));

    expect(onHover).not.toHaveBeenCalledWith('a');
  });

  it('previews a keyboard-focused chip (focus-visible) and clears it on blur', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    tabKey();
    fireEvent.focus(chip('a'));
    expect(onHover).toHaveBeenLastCalledWith('a');
    fireEvent.blur(chip('a'));
    expect(onHover).toHaveBeenLastCalledWith(undefined);
  });

  it('does not preview a chip focused by a mouse click (pointer modality)', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    // Click a chip without hovering first: focus arrives under pointer modality → no preview.
    fireEvent.pointerDown(chip('a'), { pointerType: 'mouse' });
    fireEvent.focus(chip('a'));
    fireEvent.pointerUp(chip('a'), { pointerType: 'mouse' });
    fireEvent.click(chip('a'));
    expect(onHover).not.toHaveBeenCalledWith('a');
  });

  it('releases the preview after a keyboard-focused chip is mouse-clicked and left (no new focus event)', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    // Tab to A → keyboard preview.
    tabKey();
    fireEvent.focus(chip('a'));
    expect(onHover).toHaveBeenLastCalledWith('a');
    // Now the mouse hovers and clicks the SAME chip. A already holds focus, so no new focus event fires and
    // focusValue stays 'a'; only lastModality flips to pointer.
    fireEvent.pointerEnter(chip('a'), { pointerType: 'mouse' });
    fireEvent.pointerDown(chip('a'), { pointerType: 'mouse' });
    fireEvent.pointerUp(chip('a'), { pointerType: 'mouse' });
    fireEvent.click(chip('a'));
    fireEvent.pointerLeave(chip('a'));
    // Pointer modality means the stale focusValue is no longer previewed → highlight released.
    expect(onHover).toHaveBeenLastCalledWith(undefined);
  });

  it('recovers the keyboard preview after a pointercancel (e.g. a scroll)', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    // A touch that turns into a scroll: pointerdown then pointercancel, no leave/blur.
    fireEvent.pointerDown(chip('a'), { pointerType: 'touch' });
    fireEvent.pointerCancel(chip('a'), { pointerType: 'touch' });
    // Later keyboard navigation must still preview.
    tabKey();
    fireEvent.focus(chip('b'));
    expect(onHover).toHaveBeenLastCalledWith('b');
  });

  it('lets the pointer take priority over a keyboard focus, then restores the focus preview on leave', () => {
    const onHover = jest.fn();
    renderLegend(onHover);

    tabKey();
    fireEvent.focus(chip('a'));
    expect(onHover).toHaveBeenLastCalledWith('a');
    fireEvent.pointerEnter(chip('b'), { pointerType: 'mouse' });
    expect(onHover).toHaveBeenLastCalledWith('b');
    // Leaving B does not cancel the still-focused A — the preview falls back to the focus value.
    fireEvent.pointerLeave(chip('b'));
    expect(onHover).toHaveBeenLastCalledWith('a');
  });
});
