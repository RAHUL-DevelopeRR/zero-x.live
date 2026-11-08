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

/**
 * The dark/light switch in the shared header (.zx-theme-toggle). zx-tokens.css follows
 * prefers-color-scheme unless <html data-theme="dark|light"> overrides it. A click flips the theme
 * the page shows now; a choice that differs from the system is saved under localStorage 'zx-theme'
 * and one that matches it removes the key, so there are only two states and the page goes back to
 * following the system. The inline head script on every header page applies the saved value before
 * first paint (and adds html.zx-js, which shows the button). Storage may be missing or throw
 * (private windows, blocked site data): the switch then still works for the page. Returns
 * { theme, toggle } or null when the page has no switch.
 */
export const THEME_KEY = "zx-theme";
const THEME_COLORS = { light: "#FFFFFF", dark: "#141413" };

export function installThemeToggle(doc, options = {}) {
  const button = doc.querySelector(".zx-theme-toggle");
  if (!button) return null;
  const win = options.win || doc.defaultView || null;
  let storage = null;
  if ("storage" in options) storage = options.storage;
  else { try { storage = win ? win.localStorage : null; } catch { storage = null; } }
  let mql = null;
  try {
    const query = options.matchMedia || (win && win.matchMedia ? q => win.matchMedia(q) : null);
    mql = query ? query("(prefers-color-scheme: dark)") : null;
  } catch { mql = null; }
  const html = doc.documentElement;
  const valid = value => (value === "dark" || value === "light" ? value : null);
  const system = () => (mql && mql.matches ? "dark" : "light");
  // Both <meta name="theme-color"> tags (light and dark media): a forced theme sets both to its colour.
  const metas = Array.from(doc.querySelectorAll('meta[name="theme-color"]'));
  const original = metas.map(meta => meta.getAttribute("content"));
  // The saved choice; when storage cannot be read, what <html> already carries.
  const saved = () => {
    if (storage) {
      try { return valid(storage.getItem(THEME_KEY)); } catch { /* blocked: fall through */ }
    }
    return valid(html.getAttribute("data-theme"));
  };
  const theme = () => valid(html.getAttribute("data-theme")) || system();
  const sync = () => {
    const forced = valid(html.getAttribute("data-theme"));
    const dark = theme() === "dark";
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
    metas.forEach((meta, i) => meta.setAttribute("content", forced ? THEME_COLORS[forced] : original[i]));
  };
  const apply = value => {
    if (value) html.setAttribute("data-theme", value);
    else html.removeAttribute("data-theme");
    sync();
  };
  const toggle = () => {
    const next = theme() === "dark" ? "light" : "dark";
    const keep = next === system() ? null : next;
    if (storage) {
      try {
        if (keep) storage.setItem(THEME_KEY, keep);
        else storage.removeItem(THEME_KEY);
      } catch { /* blocked: this page still switches */ }
    }
    apply(keep);
  };
  apply(saved());
  button.addEventListener("click", toggle);
  if (win && win.addEventListener) {
    win.addEventListener("storage", event => {
      if (event.key === THEME_KEY || event.key === null) apply(saved());
    });
  }
  if (mql) {
    if (mql.addEventListener) mql.addEventListener("change", sync);
    else if (mql.addListener) mql.addListener(sync);
  }
  return { theme, toggle };
}

/**
 * The signed-in account in the header. Pages are static, so the session is read from the
 * JS-readable Supabase cookie that zerox-auth.js writes ('zerox-supabase-auth', split into
 * '.parts' + '.0'..'.N' when long), with no network call and for display only: nothing here is
 * trusted for access. The Dashboard button then shows a 20 px round avatar (an allowed https
 * image, else initials) in place of the generic user icon, keeps its visible text, and gets
 * aria-label "<text>, signed in as NAME", title = email and data-signed-in. Signed out, the
 * button is left as it is (and restored when a page comes back from the back/forward cache).
 */
export const AUTH_COOKIE = "zerox-supabase-auth";
// The image hosts the CSP allows (src/csp.js AVATAR_HOSTS); any other avatar falls back to initials.
export const AVATAR_HOSTS = ["lh3.googleusercontent.com", "avatars.githubusercontent.com"];
const ACCOUNT_HOST = "https://dashboard.zero-x.live/";
const accountLink = doc =>
  Array.from(doc.querySelectorAll(".zx-header .zx-nav a.zx-btn")).find(a => (a.getAttribute("href") || "").indexOf(ACCOUNT_HOST) === 0 || a.hasAttribute("data-account-link")) || null;

function readCookie(cookies, name) {
  const prefix = encodeURIComponent(name) + "=";
  for (const cookie of cookies ? String(cookies).split("; ") : []) {
    if (cookie.indexOf(prefix) === 0) {
      try { return decodeURIComponent(cookie.slice(prefix.length)); } catch { return null; }
    }
  }
  return null;
}

function decodeBase64Url(value, atobImpl) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atobImpl(base64 + "===".slice((base64.length + 3) % 4));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The session object stored in the cookie string, or null (same reader as zerox-auth.js). */
export function readSessionCookie(cookies, options = {}) {
  const atobImpl = options.atob || (typeof atob === "function" ? atob : null);
  try {
    const count = parseInt(readCookie(cookies, AUTH_COOKIE + ".parts") || "0", 10);
    if (!(count >= 0 && count <= 64)) return null;
    let raw = "";
    if (!count) raw = readCookie(cookies, AUTH_COOKIE) || "";
    for (let i = 0; i < count; i += 1) {
      const part = readCookie(cookies, AUTH_COOKIE + "." + i);
      if (part === null) return null;
      raw += part;
    }
    if (!raw) return null;
    if (raw.indexOf("base64-") === 0) {
      if (!atobImpl) return null;
      raw = decodeBase64Url(raw.slice(7), atobImpl);
    }
    const session = JSON.parse(raw);
    return session && typeof session === "object" ? session : null;
  } catch {
    return null;
  }
}

const text = (value, max) => (value == null ? "" : String(value).trim().slice(0, max));
const first = values => values.map(v => text(v, 120)).find(Boolean) || "";

/** An https avatar URL on an allowed host, else "". */
export function safeAvatar(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && AVATAR_HOSTS.includes(url.hostname) ? url.href : "";
  } catch {
    return "";
  }
}

/** Two letters for a name ("Ada Lovelace" -> "AL", "ada" -> "AD"). */
export function initialsFor(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "ZX";
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[1])[0]];
  return letters.join("").toUpperCase();
}

/** { name, email, image } from a session (session.user, else the access token claims), or null. */
export function accountFromSession(session, options = {}) {
  if (!session || typeof session !== "object") return null;
  let user = session.user && typeof session.user === "object" ? session.user : null;
  if (!user && typeof session.access_token === "string") {
    const atobImpl = options.atob || (typeof atob === "function" ? atob : null);
    try {
      const payload = JSON.parse(decodeBase64Url(session.access_token.split(".")[1] || "", atobImpl));
      if (payload && typeof payload === "object" && payload.sub) user = payload;
    } catch { user = null; }
  }
  if (!user) return null;
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const email = text(user.email || meta.email, 254);
  const name = first([meta.full_name, meta.name, meta.user_name, email.split("@")[0]]) || "your account";
  return { name, email, image: safeAvatar(meta.avatar_url) || safeAvatar(meta.picture) };
}

/** Fills `box` with the account's avatar image (initials if it fails to load) or its initials. */
export function fillAvatar(box, account) {
  const doc = box.ownerDocument;
  const initials = () => box.replaceChildren(doc.createTextNode(account.initials || initialsFor(account.name)));
  if (!account.image) { initials(); return; }
  const img = doc.createElement("img");
  img.setAttribute("alt", "");
  img.setAttribute("width", "20");
  img.setAttribute("height", "20");
  img.setAttribute("referrerpolicy", "no-referrer");
  img.setAttribute("decoding", "async");
  img.addEventListener("error", initials);
  img.setAttribute("src", account.image);
  box.replaceChildren(img);
}

/** Shows `account` (or, with null, the signed-out button) on the header's Dashboard button. */
export function renderAccountChip(doc, account) {
  const link = accountLink(doc);
  if (!link) return null;
  const old = link.querySelector(".zx-nav-avatar");
  if (old) old.remove();
  if (!account) {
    if (link.hasAttribute("data-signed-in")) {
      for (const name of ["data-signed-in", "aria-label", "title"]) link.removeAttribute(name);
    }
    return link;
  }
  const label = (link.textContent || "").trim() || "Dashboard";
  const box = doc.createElement("span");
  box.setAttribute("class", "zx-nav-avatar");
  box.setAttribute("aria-hidden", "true");
  fillAvatar(box, account);
  link.insertBefore(box, link.firstChild);
  link.setAttribute("aria-label", label + ", signed in as " + account.name);
  if (account.email) link.setAttribute("title", account.email);
  else link.removeAttribute("title");
  link.setAttribute("data-signed-in", "");
  return link;
}

/**
 * True when a stored session can still be refreshed: it carries a refresh token, as supabase-js
 * requires before it keeps a stored session. One without (cleared, or never complete) shows as
 * signed out even while the 14-day cookie lingers. An expired access token with a refresh token
 * still counts, since the next page that talks to Supabase refreshes it.
 */
export function isLiveSession(session) {
  return !!session && typeof session === "object" && typeof session.refresh_token === "string" && session.refresh_token.length > 0;
}

/**
 * Reads the session cookie of `doc` and renders the header chip; returns the account or null.
 * Display only, with no network call: a refresh token revoked on the server (signed out on another
 * device, or "Sign out everywhere") still shows as signed in until the cookie is next rewritten.
 */
export function installAccountChip(doc, options = {}) {
  let cookies = "";
  try { cookies = "cookie" in options ? options.cookie : doc.cookie || ""; } catch { cookies = ""; }
  const session = readSessionCookie(cookies, options);
  const account = isLiveSession(session) ? accountFromSession(session, options) : null;
  renderAccountChip(doc, account);
  return account;
}

/** True when the page draws its own account chip (the dashboard, from the profile it loads). */
export const pageOwnsAccountChip = doc => {
  const link = accountLink(doc);
  return !!link && link.hasAttribute("data-account-link");
};

if (typeof document !== "undefined") {
  installNav(document);
  installThemeToggle(document);
  if (!pageOwnsAccountChip(document)) installAccountChip(document);
  focusScrollableTables(document);
  // A page restored from the back/forward cache may predate a sign-in or sign-out elsewhere.
  window.addEventListener("pageshow", event => { if (event.persisted && !pageOwnsAccountChip(document)) installAccountChip(document); });
}
