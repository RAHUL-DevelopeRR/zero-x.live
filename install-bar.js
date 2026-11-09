// The "Get Neuron" install bar: <div class="zx-getbar" data-install-bar>.
//
// The page holds every install command as plain text in the bar's list (.zx-getbar__list, one
// <li data-method> per method), which is what visitors without JavaScript see under the pill. This
// module turns the "Get Neuron" label into a menu button that picks the method, shows the chosen
// command in the pill (tinted: command word, flags, pipe and the program piped into), and keeps the
// copy button (copy-code.js, data-copy-target) copying exactly that text. The first choice comes from
// the visitor's earlier pick on this site, then their operating system (Windows: PowerShell; macOS
// and Linux: curl), then the page's own default. Every node is built with createElement and
// textContent.

export const INSTALL_METHODS = Object.freeze(['powershell', 'cmd', 'shell', 'npm', 'pip']);
const STORAGE_KEY = 'zx-install-method';

// The visitor's operating system, from the user agent (client hints first). Phones are told
// apart so no desktop installer is picked for them.
export function detectOs(userAgent = '', platform = '') {
  const text = `${platform} ${userAgent}`.toLowerCase();
  if (/android/.test(text)) return 'android';
  if (/iphone|ipad|ipod/.test(text)) return 'ios';
  if (/win/.test(text)) return 'windows';
  if (/mac/.test(text)) return 'macos';
  if (/linux|x11|cros/.test(text)) return 'linux';
  return null;
}

export function methodForOs(os) {
  if (os === 'windows') return 'powershell';
  if (os === 'macos' || os === 'linux') return 'shell';
  return null;
}

// [{ text, kind }] covering the whole command, where kind is "cmd" (the program run, and the first
// word of a quoted command), "op" (a pipe), "run" (the program piped into), "flag" (-x, --long),
// "space" or "text" (URLs, package names, arguments).
export function commandTokens(command) {
  const tokens = [];
  let afterPipe = false;
  let first = true;
  for (const [text] of String(command).matchAll(/\s+|[^\s]+/g)) {
    if (/^\s/.test(text)) { tokens.push({ text, kind: 'space' }); continue; }
    const bare = text.replace(/^"|"$/g, '');
    let kind = 'text';
    if (bare === '|') kind = 'op';
    else if (afterPipe) kind = 'run';
    else if (first || text.startsWith('"')) kind = 'cmd';
    else if (/^--?[A-Za-z]/.test(bare)) kind = 'flag';
    afterPipe = bare === '|';
    first = false;
    tokens.push({ text, kind });
  }
  return tokens;
}

function storedMethod(win) {
  try { return win.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function storeMethod(win, method) {
  try { win.localStorage.setItem(STORAGE_KEY, method); } catch { /* private window or blocked storage */ }
}

export function visitorOs(win) {
  const nav = win.navigator || {};
  const hinted = nav.userAgentData && typeof nav.userAgentData.platform === 'string' ? nav.userAgentData.platform : '';
  return detectOs(nav.userAgent || '', hinted || nav.platform || '');
}

function renderCommand(doc, code, command) {
  code.replaceChildren(...commandTokens(command).map(({ text, kind }) => {
    if (kind === 'space' || kind === 'text') return doc.createTextNode(text);
    const span = doc.createElement('span');
    span.className = 'zx-tok-' + kind;
    span.textContent = text;
    return span;
  }));
}

let barCount = 0;

const inside = (node, root) => {
  for (let at = node; at; at = at.parentNode) if (at === root) return true;
  return false;
};

// Wires one bar; returns { set(method) } or null when the bar is incomplete.
function wireBar(doc, win, bar, onPick) {
  const list = bar.querySelector('.zx-getbar__list');
  const code = bar.querySelector('.zx-getbar__cmd');
  const label = bar.querySelector('.zx-getbar__pick');
  if (!list || !code || !label) return null;
  const methods = Array.from(list.querySelectorAll('li[data-method]')).map(item => ({
    id: item.dataset.method,
    name: (item.querySelector('.zx-getbar__name') || item).textContent.trim(),
    command: (item.querySelector('code') || item).textContent.trim(),
  })).filter(method => method.id && method.command);
  if (!methods.length) return null;

  const id = 'zx-getbar-' + (++barCount);
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = label.className;
  button.id = id + '-button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id + '-menu');
  button.append(doc.createTextNode(label.textContent.trim()));
  const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('class', 'zx-icon zx-icon--sm zx-getbar__chevron');
  chevron.setAttribute('aria-hidden', 'true');
  const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/icons.svg#chevron-down');
  chevron.append(use);
  button.append(chevron);

  const menu = doc.createElement('div');
  menu.className = 'zx-getbar__menu';
  menu.id = id + '-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Install method');
  menu.hidden = true;
  const items = methods.map(method => {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'zx-getbar__item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.setAttribute('tabindex', '-1');
    item.dataset.method = method.id;
    const check = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'zx-icon zx-icon--sm zx-getbar__check');
    check.setAttribute('aria-hidden', 'true');
    const checkUse = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    checkUse.setAttribute('href', '/icons.svg#check');
    check.append(checkUse);
    const text = doc.createElement('span');
    text.textContent = method.name;
    item.append(check, text);
    menu.append(item);
    return item;
  });

  const wrap = doc.createElement('div');
  wrap.className = 'zx-getbar__picker';
  label.parentNode.insertBefore(wrap, label);
  label.remove();
  wrap.append(button, menu);
  bar.dataset.enhanced = 'true';

  let current = null;
  const set = methodId => {
    const method = methods.find(entry => entry.id === methodId) || methods[0];
    current = method;
    renderCommand(doc, code, method.command);
    code.setAttribute('data-method', method.id);
    bar.dataset.method = method.id;
    button.setAttribute('aria-label', `${button.textContent.trim()}, install method: ${method.name}`);
    const scroller = code.closest('.zx-getbar__scroll');
    if (scroller) {
      scroller.setAttribute('aria-label', `${method.name} install command`);
      scroller.scrollLeft = 0;
    }
    items.forEach(item => item.setAttribute('aria-checked', String(item.dataset.method === method.id)));
  };

  const isOpen = () => !menu.hidden;
  const close = focusButton => {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };
  const open = focusIndex => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const checked = items.findIndex(item => item.getAttribute('aria-checked') === 'true');
    const index = focusIndex === 'last' ? items.length - 1 : focusIndex === 'first' ? 0 : Math.max(0, checked);
    items[index].focus();
  };

  button.addEventListener('click', () => (isOpen() ? close(false) : open()));
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowUp' ? 'last' : undefined);
    }
  });
  items.forEach((item, index) => {
    item.addEventListener('click', () => {
      onPick(item.dataset.method);
      close(true);
    });
    item.addEventListener('keydown', event => {
      const next = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[event.key];
      if (next !== undefined) { event.preventDefault(); items[next].focus(); return; }
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key === 'Tab') close(false);
    });
  });
  doc.addEventListener('click', event => {
    if (isOpen() && !inside(event.target, wrap)) close(false);
  });
  bar.addEventListener('focusout', event => {
    if (isOpen() && event.relatedTarget && !inside(event.relatedTarget, wrap)) close(false);
  });

  return { set, get method() { return current && current.id; } };
}

export function installBars(doc, win) {
  const roots = Array.from(doc.querySelectorAll('[data-install-bar]')).filter(bar => bar.dataset.enhanced !== 'true');
  const bars = [];
  const pick = method => {
    storeMethod(win, method);
    bars.forEach(({ bar }) => bar.set(method));
  };
  for (const root of roots) {
    // The page's own default, read before the bar is rebuilt.
    const fallback = root.querySelector('.zx-getbar__cmd')?.getAttribute('data-method') || 'powershell';
    const bar = wireBar(doc, win, root, pick);
    if (bar) bars.push({ bar, fallback });
  }
  if (!bars.length) return [];
  const saved = storedMethod(win);
  const chosen = (INSTALL_METHODS.includes(saved) && saved) || methodForOs(visitorOs(win));
  bars.forEach(({ bar, fallback }) => bar.set(chosen || fallback));
  return bars.map(({ bar }) => bar);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') installBars(document, window);
