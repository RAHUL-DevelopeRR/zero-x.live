// /changelog: release notes from /api/changelog.json (the Neuron GitHub releases). Notes are a
// small Markdown subset turned into plain DOM nodes: headings, bullet lists, paragraphs, inline
// code and https links. Nothing is parsed as HTML.
import { apiFetch } from './billing-checkout.js';

export const PRODUCT_LABELS = Object.freeze({ cli: 'CLI and terminal UI', desktop: 'Desktop app', mobile: 'Mobile app' });

// Inline Markdown: `code`, [text](https://…), **bold** (kept as plain text) — anything else is text.
export function inlineParts(text) {
  const parts = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1] !== undefined) parts.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined) parts.push({ type: 'link', text: match[2], href: match[3] });
    else parts.push({ type: 'strong', text: match[4] });
    last = match.index + match[0].length;
  }
  if (last < String(text).length) parts.push({ type: 'text', text: String(text).slice(last) });
  return parts;
}

// Blocks: {type:'heading', level 3-4, parts} | {type:'list', items:[parts]} | {type:'paragraph', parts}.
export function markdownBlocks(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', parts: inlineParts(paragraph.join(' ')) });
    paragraph = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of String(markdown || '').split('\n').slice(0, 400)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length <= 2 ? 3 : 4, parts: inlineParts(heading[2]) }); }
    else if (item) {
      if (paragraph.length) { blocks.push({ type: 'paragraph', parts: inlineParts(paragraph.join(' ')) }); paragraph = []; }
      list ||= { type: 'list', items: [] };
      list.items.push(inlineParts(item[1]));
    } else {
      if (list) { blocks.push(list); list = null; }
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

// Release links point at GitHub release pages, over https, without credentials.
function githubLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function changelogView(payload) {
  const data = payload && Array.isArray(payload.data) ? payload.data : null;
  if (!data) return null;
  return data.filter(entry => entry && PRODUCT_LABELS[entry.product] && typeof entry.version === 'string' &&
    typeof entry.url === 'string' && githubLink(entry.url)).slice(0, 50).map(entry => ({
    product: entry.product, version: entry.version.slice(0, 40), title: String(entry.title || '').slice(0, 200) || `Neuron ${entry.version}`,
    published: Number.isFinite(Date.parse(entry.published_at))
      ? new Date(entry.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '',
    prerelease: entry.prerelease === true, url: entry.url, blocks: markdownBlocks(entry.notes),
  }));
}

function renderParts(doc, parts) {
  return parts.map(part => {
    if (part.type === 'code') { const node = doc.createElement('code'); node.textContent = part.text; return node; }
    if (part.type === 'strong') { const node = doc.createElement('strong'); node.textContent = part.text; return node; }
    if (part.type === 'link') { const node = doc.createElement('a'); node.href = part.href; node.textContent = part.text; return node; }
    return doc.createTextNode(part.text);
  });
}

function renderEntry(doc, entry) {
  const article = doc.createElement('article');
  article.className = 'zx-card zx-mb';
  const heading = doc.createElement('h2');
  heading.textContent = entry.title;
  const meta = doc.createElement('p');
  meta.className = 'zx-muted';
  const badge = doc.createElement('span');
  badge.className = 'zx-badge' + (entry.prerelease ? ' zx-badge--warning' : ' zx-badge--accent');
  badge.textContent = entry.prerelease ? `${PRODUCT_LABELS[entry.product]} · beta` : PRODUCT_LABELS[entry.product];
  const source = doc.createElement('a');
  source.href = entry.url;
  source.textContent = `v${entry.version} on GitHub`;
  meta.append(badge, ` ${entry.published ? entry.published + ' · ' : ''}`, source);
  article.append(heading, meta);
  for (const block of entry.blocks) {
    if (block.type === 'heading') {
      const node = doc.createElement(`h${block.level}`);
      node.append(...renderParts(doc, block.parts));
      article.append(node);
    } else if (block.type === 'list') {
      const list = doc.createElement('ul');
      for (const item of block.items) {
        const li = doc.createElement('li');
        li.append(...renderParts(doc, item));
        list.append(li);
      }
      article.append(list);
    } else {
      const paragraph = doc.createElement('p');
      paragraph.append(...renderParts(doc, block.parts));
      article.append(paragraph);
    }
  }
  return article;
}

async function hydrate(doc) {
  const list = doc.getElementById('changelog-list');
  const status = doc.getElementById('changelog-status');
  try {
    const entries = changelogView(await apiFetch('/api/changelog.json?limit=30', { timeoutMs: 8000 }));
    if (!entries) throw new Error('unexpected answer');
    if (!entries.length) { status.textContent = 'No Neuron release has been published yet. The first one will appear here.'; return; }
    status.textContent = '';
    list.replaceChildren(...entries.map(entry => renderEntry(doc, entry)));
  } catch {
    status.textContent = 'Release notes could not be loaded right now. They are also on GitHub.';
  }
}

if (typeof document !== 'undefined' && document.querySelector('[data-changelog]')) hydrate(document);
