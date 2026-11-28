// The legacy copy command is what these tests stand in for.
/* eslint-disable @typescript-eslint/no-deprecated */
import { copyText } from './clipboard';

describe('copyText', () => {
  const original = {
    clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
    secure: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
    execCommand: document.execCommand,
  };
  const setClipboard = (writeText: jest.Mock | undefined, secure: boolean) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText ? { writeText } : undefined });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
  };
  const setExecCommand = (result: boolean | (() => boolean)) => {
    const mock = jest.fn(typeof result === 'function' ? result : () => result);
    document.execCommand = mock as unknown as typeof document.execCommand;
    return mock;
  };

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
    document.execCommand = original.execCommand;
  });

  it('uses the Clipboard API in a secure context', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard(writeText, true);
    const execCommand = setExecCommand(true);
    await copyText('node-a[001-012]');
    expect(writeText).toHaveBeenCalledWith('node-a[001-012]');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to the copy command outside a secure context, with the text selected', async () => {
    const writeText = jest.fn();
    setClipboard(writeText, false);
    let selected: string | undefined;
    const execCommand = setExecCommand(() => {
      selected = (document.activeElement as HTMLTextAreaElement | null)?.value;
      return true;
    });
    await copyText('node-a1,node-a2');
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('node-a1,node-a2');
    // The helper element is gone again.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to the copy command when the Clipboard API is denied', async () => {
    setClipboard(jest.fn().mockRejectedValue(new Error('NotAllowedError')), true);
    const execCommand = setExecCommand(true);
    await copyText('x');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects when neither way copies, and leaves nothing behind', async () => {
    setClipboard(jest.fn().mockRejectedValue(new Error('NotAllowedError')), true);
    setExecCommand(false);
    await expect(copyText('x')).rejects.toThrow('refused');
    setClipboard(undefined, false);
    setExecCommand(() => {
      throw new Error('blocked');
    });
    await expect(copyText('x')).rejects.toThrow('blocked');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('gives the keyboard focus back to the element that had it', async () => {
    setClipboard(undefined, false);
    setExecCommand(true);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await copyText('x');
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
