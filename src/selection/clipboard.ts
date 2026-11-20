/**
 * Copies text to the clipboard, or rejects when the browser does not allow it.
 *
 * The Clipboard API exists only in a secure context (HTTPS or localhost) and can be denied by a
 * permission policy. The legacy copy command works without either as long as it runs in a user
 * gesture, so it is the second attempt. Its return value is the only failure signal it gives.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Denied, or the document is not focused: try the legacy command.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // Off screen, but selectable: a hidden element cannot be copied from.
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  document.body.appendChild(textarea);
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    // execCommand is deprecated but is the only clipboard access outside a secure context.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  } finally {
    textarea.remove();
    focused?.focus({ preventScroll: true });
  }
  if (!copied) {
    throw new Error('The browser refused to copy to the clipboard');
  }
}
