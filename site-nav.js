// The site header on phones (every page with the shared .zx-header): one row with the Zero-X mark
// and a Menu button that shows and hides the main navigation. The button is a disclosure
// (aria-expanded, aria-controls naming the nav); Escape closes the menu and puts focus back on the
// button, and following a link, clicking outside the header or moving focus out of it closes it.
// zx-tokens.css shows the button and hides the closed nav only below 720 px, so wider screens keep
// the full nav. Without this script the button stays hidden and phones get the wrapped nav in a
// header that does not stick (zx-tokens.css, .zx-header:not([data-nav])).

/** Wires the header of `doc`; returns { open, close, isOpen } or null when the page has no menu. */
export function installNav(doc) {
  const header = doc.querySelector('.zx-header');
  const button = header ? header.querySelector('.zx-nav-toggle') : null;
  const nav = button ? doc.getElementById(button.getAttribute('aria-controls') || '') : null;
  if (!nav) return null;
  const inside = node => {
    for (let current = node; current; current = current.parentNode) if (current === header) return true;
    return false;
  };
  const isOpen = () => button.getAttribute('aria-expanded') === 'true';
  const set = open => {
    button.setAttribute('aria-expanded', String(open));
    header.dataset.nav = open ? 'open' : 'closed';
  };
  const close = ({ focus = false } = {}) => {
    if (!isOpen()) return;
    set(false);
    if (focus) button.focus();
  };
  set(false);
  button.hidden = false;
  button.addEventListener('click', () => set(!isOpen()));
  header.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    event.preventDefault();
    close({ focus: true });
  });
  for (const link of nav.querySelectorAll('a')) link.addEventListener('click', () => close());
  header.addEventListener('focusout', event => {
    if (event.relatedTarget && !inside(event.relatedTarget)) close();
  });
  doc.addEventListener('click', event => {
    if (!inside(event.target)) close();
  });
  return { open: () => set(true), close, isOpen };
}

if (typeof document !== 'undefined') installNav(document);
