// The dismissible announcement bar (.zx-announce[data-announce="id"]): its close button is hidden
// until this runs, so without JavaScript the bar is simply always there. Dismissing hides the bar
// and remembers the id in localStorage when the browser allows it, so the next announcement (a new
// id) shows again. Storage can be missing, blocked or full; the bar then comes back next visit.

export const DISMISSED_KEY = 'zx-announce-dismissed';

const read = storage => {
  try { return storage ? storage.getItem(DISMISSED_KEY) : null; }
  catch { return null; }
};
const write = (storage, value) => {
  try { if (storage) storage.setItem(DISMISSED_KEY, value); }
  catch { /* A bar that cannot be remembered reappears on the next visit. */ }
};

/** Wires the bar of `doc`; returns { dismiss, isHidden } or null when the page has none. */
export function installAnnounce(doc, storage) {
  const bar = doc.querySelector('.zx-announce[data-announce]');
  const button = bar ? bar.querySelector('.zx-announce__close') : null;
  if (!bar || !button) return null;
  const id = bar.dataset.announce;
  const dismiss = () => {
    bar.hidden = true;
    write(storage, id);
  };
  if (read(storage) === id) bar.hidden = true;
  else button.hidden = false;
  button.addEventListener('click', dismiss);
  return { dismiss, isHidden: () => bar.hidden };
}

if (typeof document !== 'undefined') {
  let storage = null;
  try { storage = window.localStorage; } catch { /* blocked */ }
  installAnnounce(document, storage);
}
