// Copy buttons on command blocks: <button class="zx-copy" data-copy-target="ID" data-copy-label="...">
// copies the trimmed text of #ID, shows the check icon (data-state="copied") for two seconds and
// announces the result in the #copy-status live region. When the browser refuses the clipboard the
// command is selected instead (data-state="selected", with a keyboard hint in the title); without a clipboard API the button is hidden.
// Binding is idempotent, so pages may load this module and call copyButtons() from other scripts.

const RESET_MS = 2000;

function selectText(doc, win, node) {
  if (typeof doc.createRange !== 'function' || typeof win.getSelection !== 'function') return;
  const range = doc.createRange();
  range.selectNodeContents(node);
  const selection = win.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function copyButtons(doc, win) {
  const live = doc.getElementById('copy-status');
  const announce = text => { if (live) live.textContent = text; };
  const clipboard = win.navigator && win.navigator.clipboard;
  const canCopy = !!clipboard && typeof clipboard.writeText === 'function';
  for (const button of doc.querySelectorAll('button[data-copy-target]')) {
    if (button.getAttribute('data-copy-bound') === 'true') continue;
    const target = doc.getElementById(button.getAttribute('data-copy-target'));
    if (!target || !canCopy) { button.hidden = true; continue; }
    button.setAttribute('data-copy-bound', 'true');
    const label = button.getAttribute('data-copy-label') || 'command';
    const title = button.getAttribute('title') || 'Copy';
    let timer = 0;
    button.addEventListener('click', async () => {
      if (timer) win.clearTimeout(timer);
      try {
        await clipboard.writeText(target.textContent.trim());
        button.setAttribute('data-state', 'copied');
        button.setAttribute('title', title);
        announce(`Copied the ${label} to the clipboard.`);
      } catch {
        button.setAttribute('data-state', 'selected');
        button.setAttribute('title', 'Press Ctrl+C to copy');
        selectText(doc, win, target);
        announce(`Copying is blocked here. The ${label} is selected; press Ctrl+C, or Cmd+C on a Mac.`);
      }
      timer = win.setTimeout(() => { timer = 0; button.removeAttribute('data-state'); button.setAttribute('title', title); }, RESET_MS);
    });
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') copyButtons(document, window);
