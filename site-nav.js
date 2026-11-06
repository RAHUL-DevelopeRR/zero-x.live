// The site header on phones (every page with the shared .zx-header): one row with the Zero-X mark
// and a Menu button that shows and hides the main navigation. The button is a disclosure
// (aria-expanded, aria-controls naming the nav); Escape closes the menu and puts focus back on the
// button, and following a link, clicking outside the header or moving focus out of it closes it.
// zx-tokens.css shows the button and hides the closed nav only below 720 px, so wider screens keep
// the full nav. Menu mode is chosen before first paint by a one-line inline script right after
// each page's </header> (it sets data-nav="closed" and shows the button), so the header never
// paints as three wrapped rows and then jumps; this module wires the events when it runs. Without
// JavaScript (or without module support) the button stays hidden and phones get the wrapped nav
// in a header that does not stick (zx-tokens.css, .zx-header:not([data-nav])).

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
  // On the document, not the header: Safari does not focus a button on click, so after a tap on
  // Menu the focus is still on the body, and Escape from a hardware keyboard must still close it.
  doc.addEventListener('keydown', event => {
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

/**
 * A table wider than its box scrolls sideways (zx-table-wrap), and a keyboard user can only scroll
 * it when it takes focus: such a wrap gets tabindex 0 and a region name taken from the heading
 * above it. Runs again on resize, because phones and desktops differ in which tables overflow.
 */
export function focusScrollableTables(doc) {
  const label = wrap => {
    for (let node = wrap; node; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const heading = /^H[1-6]$/.test(sib.tagName) ? sib : sib.querySelector && sib.querySelector("h1,h2,h3,h4");
        if (heading && heading.textContent.trim()) return heading.textContent.trim().slice(0, 80);
      }
    }
    return "Table";
  };
  const apply = () => {
    for (const wrap of doc.querySelectorAll(".zx-table-wrap")) {
      const scrolls = wrap.scrollWidth > wrap.clientWidth + 1;
      if (scrolls && !wrap.hasAttribute("tabindex")) {
        wrap.setAttribute("tabindex", "0");
        wrap.setAttribute("role", "region");
        wrap.setAttribute("aria-label", label(wrap));
        wrap.dataset.zxFocusable = "";
      } else if (!scrolls && wrap.dataset.zxFocusable !== undefined) {
        for (const name of ["tabindex", "role", "aria-label"]) wrap.removeAttribute(name);
        delete wrap.dataset.zxFocusable;
      }
    }
  };
  apply();
  if (doc.defaultView) doc.defaultView.addEventListener("resize", apply);
}

if (typeof document !== "undefined") {
  installNav(document);
  focusScrollableTables(document);
}
