import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FleetGridPanel } from './FleetGridPanel';
import { compactHostlist } from '../selection/hostlist';
import { syncMessage } from '../selection/variable';
import { CELL, frames, installPointerEvent, LABEL, levels, makeProps, panelUi, power } from '../testing/selectionPanel';

// Cell selection in the panel: the Shift gestures, what they leave untouched, the selection bar and
// what a selection is copied as. The variable sync has FleetGridPanel.sync.test.tsx, and the pure
// parts (selection state, statistics, export formats, hostlist, region hit test) have their own tests.

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
}));

// Grafana's Drawer needs ResizeObserver and IntersectionObserver, which jsdom does not have; the E2E
// tests open the real one. The stand-in keeps what matters to the panel: it renders in a portal on
// the body, outside the panel's DOM but inside its React tree. Sparkline depends on uPlot.
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
  Drawer: ({ title, subtitle, children, onClose }: any) =>
    jest.requireActual('react-dom').createPortal(
      <div role="dialog" aria-label={title}>
        <div>{subtitle}</div>
        <button onClick={onClose}>Close drawer</button>
        {children}
      </div>,
      document.body
    ),
}));

// Pass-through spies: syncMessage runs once per render of the selection bar, and compactHostlist
// only when a hostlist is built.
jest.mock('../selection/variable', () => {
  const actual = jest.requireActual('../selection/variable');
  return { ...actual, syncMessage: jest.fn(actual.syncMessage) };
});
jest.mock('../selection/hostlist', () => {
  const actual = jest.requireActual('../selection/hostlist');
  return { ...actual, compactHostlist: jest.fn(actual.compactHostlist) };
});

const { container, band, count, label, pointer, press, release, shiftClick, shiftDrag, ringsDrawn } = panelUi();
installPointerEvent();

describe('FleetGridPanel cell selection', () => {
  it('shows no selection controls and draws no ring until something is selected', () => {
    render(<FleetGridPanel {...makeProps()} />);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(band()).toHaveStyle({ display: 'none' });
    expect(ringsDrawn()).toBe(false);
  });

  it('Shift+click toggles a cell, without opening the drilldown or following a data link', () => {
    const series = frames();
    const getLinks = jest.fn(() => [{ href: 'https://example.com', title: 'X', target: '_self', origin: {} }]);
    series[0].fields[1].getLinks = getLinks as any;
    render(<FleetGridPanel {...makeProps(series)} />);

    shiftClick(CELL.a1);
    expect(count()).toBe('1 cell selected');
    expect(ringsDrawn()).toBe(true);
    expect(getLinks).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    shiftClick(CELL.a2);
    expect(count()).toBe('2 cells selected');

    // Shift+click on a selected cell takes it out again.
    shiftClick(CELL.a1);
    expect(count()).toBe('1 cell selected');
    shiftClick(CELL.a2);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(ringsDrawn()).toBe(false);
  });

  it('leaves a plain click as it was: it drills down and does not change the selection', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(CELL.a1);

    press(CELL.b1, { shiftKey: false });
    release(CELL.b1, { shiftKey: false });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(count()).toBe('1 cell selected');

    // Also on empty space: it closes the popover and keeps the selection.
    press([300, 200], { shiftKey: false });
    release([300, 200], { shiftKey: false });
    expect(count()).toBe('1 cell selected');
  });

  it('keeps the layout when the selection bar appears: the grid loses height and scrolls instead', () => {
    const props = makeProps();
    // Header 32px + 120px: the two zones (116px at 40px cells) just fit.
    props.height = 152;
    render(<FleetGridPanel {...props} />);
    const canvas = document.querySelector('canvas')!;
    expect(container()).toHaveStyle({ height: '120px', overflowY: 'hidden' });
    expect(canvas).toHaveStyle({ width: '122px', height: '120px' });

    shiftClick(CELL.a1);
    // The bar takes its height from the grid's box. The cells keep their 40px and their places, so the
    // canvas is as large as before and its last rows are reached by scrolling.
    expect(container()).toHaveStyle({ height: '88px', overflowY: 'auto' });
    expect(canvas).toHaveStyle({ width: '122px', height: '116px' });
    shiftClick(CELL.b2);
    expect(count()).toBe('2 cells selected');

    fireEvent.click(screen.getByTestId('selection-clear'));
    expect(container()).toHaveStyle({ height: '120px', overflowY: 'hidden' });
  });

  it('Shift+click on empty space selects nothing and drills nowhere', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick([300, 200]);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('Shift+click on a group label toggles the cells of the group as one unit', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(LABEL.a);
    expect(count()).toBe('3 cells selected');
    // All of the group is selected: the same gesture removes it.
    shiftClick(LABEL.a);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    // Part of the group is selected: the gesture completes it.
    shiftClick(CELL.b2);
    shiftClick(LABEL.b);
    expect(count()).toBe('2 cells selected');
    shiftClick(LABEL.a);
    expect(count()).toBe('5 cells selected');
  });

  it('Shift+drag adds the cells the rectangle overlaps and shows the band while dragging', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press([50, 30]);
    expect(band()).toHaveStyle({ display: 'none' });
    fireEvent.pointerMove(container(), pointer([110, 100]));
    // From inside node-a002 to inside node-a003 and down into zone-b's second cell.
    expect(band()).toHaveStyle({ display: 'block', left: '50px', top: '30px', width: '60px', height: '70px' });
    expect(band()).toHaveTextContent('3 cells');
    // Nothing is selected before the button is released.
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    release([110, 100]);
    expect(band()).toHaveStyle({ display: 'none' });
    expect(count()).toBe('3 cells selected');
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    // A second drag adds to the selection; cells that are selected already stay selected.
    shiftDrag([10, 90], [50, 100]);
    expect(count()).toBe('4 cells selected');
    // A drag in the opposite direction selects the same.
    shiftDrag([30, 50], [5, 20]);
    expect(count()).toBe('5 cells selected');
  });

  it('counts a press that moves less than the threshold as a click', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press(CELL.a1);
    fireEvent.pointerMove(container(), pointer([CELL.a1[0] + 2, CELL.a1[1] + 2]));
    expect(band()).toHaveStyle({ display: 'none' });
    release([CELL.a1[0] + 2, CELL.a1[1] + 2]);
    expect(count()).toBe('1 cell selected');
  });

  it('reads Shift when the button goes down, not when it comes up', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // Shift released during the drag: still a selection.
    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([50, 50], { shiftKey: false }));
    release([50, 50], { shiftKey: false });
    expect(count()).toBe('2 cells selected');
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    // Shift pressed after the button went down: a plain click.
    press(CELL.b1, { shiftKey: false });
    release(CELL.b1);
    expect(count()).toBe('2 cells selected');
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('keeps the browser from extending a text selection on a Shift press only', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // fireEvent returns false when the handler called preventDefault.
    expect(press(CELL.a1)).toBe(false);
    release(CELL.a1);
    expect(press(CELL.a1, { shiftKey: false })).toBe(true);
  });

  it('ignores touch and the other mouse buttons', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press(CELL.a1, { pointerType: 'touch' });
    fireEvent.pointerUp(container(), pointer(CELL.a1, { pointerType: 'touch' }));
    press(CELL.a1, { button: 2 });
    fireEvent.pointerUp(container(), pointer(CELL.a1, { button: 2 }));
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
  });

  it('abandons the drag on Escape and on a cancelled pointer, selecting nothing', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([110, 100]));
    expect(band()).toHaveStyle({ display: 'block' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(band()).toHaveStyle({ display: 'none' });
    // The button comes up later: that click still belongs to the abandoned gesture.
    release([110, 100]);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([110, 100]));
    fireEvent.pointerCancel(container(), pointer([110, 100]));
    expect(band()).toHaveStyle({ display: 'none' });
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
  });

  it('shows no hover tooltip while a Shift press is in progress', () => {
    render(<FleetGridPanel {...makeProps()} />);
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    press(CELL.a1);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseMove(container(), { clientX: CELL.a2[0], clientY: CELL.a2[1] });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    release(CELL.a2);
    fireEvent.mouseMove(container(), { clientX: CELL.a2[0], clientY: CELL.a2[1] });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  // In a small panel there is no room beside the pointer, and the tooltip is placed over it. The
  // press of a Shift+click then lands on the tooltip, not on the canvas.
  it('selects the cell under the tooltip when the tooltip lies under the pointer', () => {
    render(<FleetGridPanel {...makeProps()} />);
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    const tooltip = screen.getByRole('tooltip');
    fireEvent.pointerDown(tooltip, pointer(CELL.a1, { shiftKey: true }));
    fireEvent.pointerUp(container(), pointer(CELL.a1, { shiftKey: true }));
    expect(count()).toBe('1 cell selected');
    expect(label()).toBe('1 host value:');
  });

  it('keeps a plain press on the tooltip to the tooltip', () => {
    render(<FleetGridPanel {...makeProps()} />);
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    fireEvent.pointerDown(screen.getByRole('tooltip'), pointer(CELL.a1, { shiftKey: false }));
    fireEvent.pointerUp(container(), pointer(CELL.a1, { shiftKey: false }));
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    // The tooltip is still there: its text can be selected and it can be scrolled.
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  // In a large panel the tooltip is placed beside the pointer and covers other cells and labels. The
  // viewer sees the tooltip of one cell there, not what lies under it.
  it('selects nothing when a Shift press on the tooltip is over another cell, a group label or no cell', () => {
    render(<FleetGridPanel {...makeProps()} />);
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    const tooltip = screen.getByRole('tooltip');
    for (const covered of [CELL.a2, CELL.b1, LABEL.a, LABEL.b, [300, 250] as const]) {
      fireEvent.pointerDown(tooltip, pointer(covered));
      fireEvent.pointerUp(tooltip, pointer(covered));
      fireEvent.click(tooltip, pointer(covered));
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    }
    // A press over the cell that the tooltip shows still selects that cell.
    fireEvent.pointerDown(tooltip, pointer(CELL.a1));
    fireEvent.pointerUp(container(), pointer(CELL.a1));
    expect(count()).toBe('1 cell selected');
    expect(label()).toBe('1 host value:');
  });

  it('holds back every press on the tooltip that does not select its cell', () => {
    const onPointerDown = jest.fn();
    render(
      <div onPointerDown={onPointerDown}>
        <FleetGridPanel {...makeProps()} />
      </div>
    );
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    const tooltip = screen.getByRole('tooltip');
    fireEvent.pointerDown(tooltip, pointer(CELL.a1, { shiftKey: false }));
    fireEvent.pointerDown(tooltip, pointer(CELL.a2, { shiftKey: false }));
    fireEvent.pointerDown(tooltip, pointer(CELL.a2));
    expect(onPointerDown).not.toHaveBeenCalled();
    // The press that selects the tooltip's cell is a press on the grid, and goes on like one.
    fireEvent.pointerDown(tooltip, pointer(CELL.a1));
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('still selects the cell of a tooltip that stayed open over a data update', () => {
    const { rerender } = render(<FleetGridPanel {...makeProps()} />);
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    // The update replaces every cell object; the tooltip keeps the one it was opened with.
    rerender(<FleetGridPanel {...makeProps(frames())} />);
    fireEvent.pointerDown(screen.getByRole('tooltip'), pointer(CELL.a1));
    fireEvent.pointerUp(container(), pointer(CELL.a1));
    expect(count()).toBe('1 cell selected');
  });

  it('leaves the selection bar alone while the pointer only moves over the grid', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(LABEL.a);
    const barRenders = (syncMessage as jest.Mock).mock.calls.length;
    (compactHostlist as jest.Mock).mockClear();
    // Every move over another cell renders the panel for the tooltip.
    for (const point of [CELL.a1, CELL.a2, CELL.b1, CELL.b2]) {
      fireEvent.mouseMove(container(), { clientX: point[0], clientY: point[1] });
    }
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    // The bar is not rendered again, and no copy text is built before a copy button is used.
    expect(syncMessage).toHaveBeenCalledTimes(barRenders);
    expect(compactHostlist).not.toHaveBeenCalled();
  });

  it('keeps the start of the band on the grid when the panel scrolls during the drag', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([30, 50]));
    expect(band()).toHaveStyle({ top: '20px', height: '30px' });
    expect(band()).toHaveTextContent('1 cell');
    // The wheel scrolls the grid by 40px under a pointer that does not move.
    Object.defineProperty(container(), 'scrollTop', { configurable: true, value: 40 });
    fireEvent.scroll(container());
    expect(band()).toHaveStyle({ top: '20px', height: '70px' });
    expect(band()).toHaveTextContent('2 cells');
    release([30, 50]);
    // The rectangle reaches y = 90 in content coordinates now: zone-b's first cell is in it.
    expect(count()).toBe('2 cells selected');
  });

  it('takes a Shift+click on the pinned top label of a scrolled panel as a click on that group', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // Scrolled by 30px, zone-a's label is drawn pinned over y 30..46, where its cells are laid out.
    Object.defineProperty(container(), 'scrollTop', { configurable: true, value: 30 });
    fireEvent.scroll(container());
    shiftClick([20, 5]);
    expect(count()).toBe('3 cells selected');
  });

  describe('clearing', () => {
    it('clears with the Clear button', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.a);
      fireEvent.click(screen.getByTestId('selection-clear'));
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
      expect(ringsDrawn()).toBe(false);
    });

    it('moves the focus to the selection bar after a gesture, where Escape clears the selection', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      expect(screen.getByTestId('selection-bar')).toHaveFocus();
      // The key press is used up: it does not reach listeners outside the panel (Grafana's shortcuts).
      const outside = jest.fn();
      document.addEventListener('keydown', outside);
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
      document.removeEventListener('keydown', outside);
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
      expect(outside).not.toHaveBeenCalled();
    });

    it('does not clear on Escape pressed outside the panel, or on another key', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Enter' });
      expect(count()).toBe('1 cell selected');
    });

    it('lets an open drilldown popover take the first Escape', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      press(CELL.b1, { shiftKey: false });
      release(CELL.b1, { shiftKey: false });
      expect(screen.getByLabelText('Close')).toBeInTheDocument();
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
      expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
      expect(count()).toBe('1 cell selected');
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
  });

  describe('when the data or the layout changes', () => {
    it('keeps the same cells selected through a refresh, a new order and a resize', () => {
      const view = render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a2);
      shiftClick(CELL.b1);

      // New frames in reverse order, and a panel so narrow that the cells shrink and move.
      const next = makeProps(frames([...power].reverse()));
      next.width = 60;
      next.data.request.requestId = 'Q2';
      view.rerender(<FleetGridPanel {...next} />);
      expect(count()).toBe('2 cells selected');
      expect(ringsDrawn()).toBe(true);
      expect(label()).toBe('2 host values:');
    });

    it('keeps a cell selected, and its host name in the copy, while it is missing from the data', () => {
      const view = render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      shiftClick(CELL.a2);

      // node-a002 stops reporting. It is what was selected, so its name stays in what is copied.
      const without = makeProps(frames(power.filter(([, host]) => host !== 'node-a002')));
      view.rerender(<FleetGridPanel {...without} />);
      expect(count()).toBe('1 cell selected (+1 not in the current data)');
      expect(label()).toBe('2 host values (1 from cells not in the current data):');

      // Every selected cell gone: the bar stays so the selection can be seen, copied and cleared.
      const none = makeProps(frames(power.filter(([zone]) => zone === 'zone-b')));
      view.rerender(<FleetGridPanel {...none} />);
      expect(count()).toBe('0 cells selected (+2 not in the current data)');
      expect(label()).toBe('2 host values (2 from cells not in the current data):');
      expect(screen.getByTestId('selection-compare')).toBeDisabled();
      expect(screen.getByTestId('selection-copy-list')).toBeEnabled();
      expect(ringsDrawn()).toBe(false);

      view.rerender(<FleetGridPanel {...makeProps()} />);
      expect(count()).toBe('2 cells selected');
      expect(label()).toBe('2 host values:');
    });

    it('keeps the label that was chosen when the selection began, whatever the data shows later', () => {
      // zone → host → gpu, two GPUs per host. The label is not configured.
      const gpuLevels = [...levels, { ...levels[1], label: 'gpu' }];
      const gpuFrames = (hosts: string[]) =>
        hosts.flatMap((host) =>
          ['gpu0', 'gpu1'].map((gpu) => {
            const f = frames([['zone-a', host, 1]])[0];
            f.fields[1].labels = { zone: 'zone-a', host, gpu };
            return f;
          })
        );
      const view = render(
        <FleetGridPanel {...makeProps(gpuFrames(['node-a001', 'node-a002']), { levels: gpuLevels })} />
      );
      // Cells in a row: node-a001/gpu0, node-a001/gpu1, node-a002/gpu0, node-a002/gpu1.
      shiftClick([102, 36]);
      shiftClick([143, 36]);
      expect(count()).toBe('2 cells selected');
      // gpu0 exists under both hosts, so the host is what identifies the selection.
      expect(label()).toBe('1 host value:');

      // The dashboard is narrowed to node-a002. On this grid alone gpu would be the unique label, and
      // the selection would turn from one host into two GPUs.
      view.rerender(<FleetGridPanel {...makeProps(gpuFrames(['node-a002']), { levels: gpuLevels })} />);
      expect(count()).toBe('2 cells selected');
      expect(label()).toBe('1 host value:');

      // A selection that begins on the narrowed grid is another selection: it says what it is copied by.
      fireEvent.click(screen.getByTestId('selection-clear'));
      shiftClick(CELL.a1);
      expect(label()).toBe('1 gpu value:');
    });

    it('clears the selection when the hierarchy levels change, because the cell paths change meaning', () => {
      const view = render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      // The same levels in a new array are no change.
      view.rerender(<FleetGridPanel {...makeProps(frames(), { levels: levels.map((l) => ({ ...l })) })} />);
      expect(count()).toBe('1 cell selected');
      view.rerender(<FleetGridPanel {...makeProps(frames(), { levels: [levels[1]] })} />);
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
  });

  describe('copying', () => {
    const writeText = jest.fn();
    const original = {
      clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
      secure: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
    };
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    });
    afterEach(() => {
      for (const [target, key, descriptor] of [
        [navigator, 'clipboard', original.clipboard],
        [window, 'isSecureContext', original.secure],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(target, key, descriptor);
        } else {
          delete (target as unknown as Record<string, unknown>)[key];
        }
      }
    });
    const copy = async (format: string) => {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`selection-copy-${format}`));
        // Let the copy settle inside act: the Clipboard API first, then the legacy command.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return writeText.mock.calls[writeText.mock.calls.length - 1]?.[0];
    };

    it('copies the selected host names as a regular expression, a list and a hostlist', async () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.a);
      shiftClick(CELL.b2);
      expect(screen.getByTestId('selection-label')).toHaveTextContent('4 host values:');
      expect(await copy('regex')).toBe('^(node-a001|node-a002|node-a003|node-b002)$');
      expect(await copy('list')).toBe('node-a001,node-a002,node-a003,node-b002');
      expect(await copy('hostlist')).toBe('node-a[001-003],node-b002');
    });

    it('copies the values of the configured selection label', async () => {
      render(<FleetGridPanel {...makeProps(frames(), { selectionLabel: 'zone' })} />);
      shiftClick(CELL.a1);
      shiftClick(CELL.b1);
      expect(screen.getByTestId('selection-label')).toHaveTextContent('2 zone values:');
      expect(await copy('list')).toBe('zone-a,zone-b');
    });

    it('shows the text to copy by hand when the browser refuses', async () => {
      writeText.mockRejectedValue(new Error('NotAllowedError'));
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.b);
      await copy('hostlist');
      const alert = within(screen.getByTestId('selection-bar')).getByRole('alert');
      expect(alert).toHaveTextContent('did not allow copying');
      expect(within(alert).getByRole('textbox')).toHaveValue('node-b[001-002]');
      // A copy that works afterwards removes the notice.
      writeText.mockResolvedValue(undefined);
      await copy('list');
      expect(within(screen.getByTestId('selection-bar')).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('removes the text to copy by hand when the selection changes: it is no longer what would be copied', async () => {
      writeText.mockRejectedValue(new Error('NotAllowedError'));
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.b);
      await copy('hostlist');
      expect(within(screen.getByTestId('selection-bar')).getByRole('textbox')).toHaveValue('node-b[001-002]');
      shiftClick(CELL.a1);
      expect(screen.getByTestId('selection-label')).toHaveTextContent('3 host values:');
      expect(within(screen.getByTestId('selection-bar')).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('selection-bar')).queryByRole('alert')).not.toBeInTheDocument();
      // The next refused copy shows the text of the selection as it is now.
      await copy('hostlist');
      expect(within(screen.getByTestId('selection-bar')).getByRole('textbox')).toHaveValue('node-a001,node-b[001-002]');
    });

    it('takes the mark of a finished copy away when the selection changes', async () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.b);
      await copy('list');
      // The button of a finished copy is drawn as a success, unlike the button next to it.
      const look = (format: string) => screen.getByTestId(`selection-copy-${format}`).className;
      expect(look('list')).not.toBe(look('regex'));
      shiftClick(CELL.a1);
      expect(look('list')).toBe(look('regex'));
    });
  });

  it('opens the cohort comparison of the selected cells against the others', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(LABEL.b);
    fireEvent.click(screen.getByTestId('selection-compare'));
    const comparison = screen.getByTestId('cohort-comparison');
    expect(screen.getByText('2 selected cells against 3 other cells')).toBeInTheDocument();
    // power: 100, 200 against 10, 20, 30. Every selected cell is higher.
    const cells = (testId: string) =>
      within(within(comparison).getByTestId(testId))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('cohort-selected-A')).toEqual(['2', '0', '100', '150', '195', '200', '+1.00']);
    expect(cells('cohort-rest-A')).toEqual(['3', '0', '10', '20', '29', '30']);
    // temp has no series for node-a003: one of the others has no value, and is not counted as 0.
    expect(cells('cohort-rest-B')).toEqual(['2', '1', '1', '1.50', '1.95', '2']);
    expect(within(comparison).getByTestId('cohort-delta-B')).toHaveTextContent('+1.00');

    // A click inside the drawer, which React bubbles to the panel through the portal, is not a cell click,
    // and Escape inside it does not clear the selection.
    fireEvent.click(comparison);
    fireEvent.keyDown(comparison, { key: 'Escape' });
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    expect(count()).toBe('2 cells selected');
    fireEvent.click(screen.getByText('Close drawer'));
    expect(screen.queryByTestId('cohort-comparison')).not.toBeInTheDocument();
  });
});
