// Preserved thinking for the native Claude adapter. OpenAI clients cannot echo Claude's
// thinking blocks or their signatures, so the gateway keeps the exact content of each assistant
// turn it produced and puts it back when the client sends that turn again in its history (the
// same pattern as Gemini's ThoughtSignatureCache in provider-request.js).
//
// Per isolate and best effort: a miss only means Claude answers without that turn's reasoning.
// The mapper (anthropic-request.js mapMessages) splices only the record's thinking blocks into
// the turn it rebuilds from the client's echo, so a found and a missing record differ by those
// blocks alone: the text and tool_use bytes, and so every later turn's thinking binding, are the
// same in either case (another isolate, an evicted entry). Every replaying request sends
// thinking.block_binding drop_block, so a stale or mismatched block is dropped by the API, never
// a 400.
//
// Key: the caller plus the turn fingerprint (anthropic-request.js turnFingerprint). It is not
// scoped to the model: Opus 5.5 reads Sonnet 5.5 blocks, and the API drops what a model cannot
// read, unbilled.
//
// Eviction is per caller: when the cache is full, the caller used least recently loses all of its
// turns at once, so an active conversation never keeps turns 2..N while turn 1 was evicted (the
// oldest turn of a conversation is always its least recently used entry). Only a single caller
// over the caps alone loses its own oldest turns.

const DEFAULTS = Object.freeze({ maxEntries: 4000, maxBytes: 24 * 2 ** 20, maxEntryBytes: 512 * 1024, ttlMs: 2 * 3600_000 });

function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && index + 1 < text.length) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const validKey = (caller, fingerprint) =>
  caller !== null && caller !== undefined && caller !== '' && typeof fingerprint === 'string' && fingerprint.length > 0;

export class ClaudeTurnCache {
  constructor({ maxEntries = DEFAULTS.maxEntries, maxBytes = DEFAULTS.maxBytes, maxEntryBytes = DEFAULTS.maxEntryBytes,
    ttlMs = DEFAULTS.ttlMs } = {}) {
    // caller -> { entries: Map<fingerprint, entry>, bytes }. Both maps keep LRU order by insertion:
    // callers by their last use, a caller's entries by theirs.
    this.callers = new Map();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.ttlMs = ttlMs;
    this.totalBytes = 0;
    this.count = 0;
  }

  // The caller's group, made the most recently used.
  touch(caller) {
    const id = String(caller);
    let group = this.callers.get(id);
    if (group) this.callers.delete(id);
    else group = { entries: new Map(), bytes: 0 };
    this.callers.set(id, group);
    return group;
  }

  removeEntry(id, group, fingerprint) {
    const entry = group.entries.get(fingerprint);
    if (!entry) return;
    group.entries.delete(fingerprint);
    group.bytes -= entry.bytes;
    this.totalBytes -= entry.bytes;
    this.count -= 1;
    if (!group.entries.size) this.callers.delete(id);
  }

  removeCaller(id) {
    const group = this.callers.get(id);
    if (!group) return;
    this.callers.delete(id);
    this.totalBytes -= group.bytes;
    this.count -= group.entries.size;
  }

  full() {
    return this.count > this.maxEntries || this.totalBytes > this.maxBytes;
  }

  // Freezes `blocks` in place and keeps them; false when they were not kept.
  remember({ caller, fingerprint, blocks }, now = Date.now()) {
    if (!validKey(caller, fingerprint) || !Array.isArray(blocks) || !blocks.length) return false;
    const id = String(caller);
    const bytes = utf8Length(JSON.stringify(blocks)) + id.length + fingerprint.length;
    if (bytes > this.maxEntryBytes) return false;
    const group = this.touch(id);
    this.removeEntry(id, group, fingerprint);
    if (!this.callers.has(id)) this.callers.set(id, group); // removeEntry dropped the emptied group
    group.entries.set(fingerprint, { blocks: deepFreeze(blocks), bytes, expires: now + this.ttlMs });
    group.bytes += bytes;
    this.totalBytes += bytes;
    this.count += 1;
    // Whole callers first, least recently used first; never this one while another is left.
    for (const other of this.callers.keys()) {
      if (!this.full()) break;
      if (other !== id) this.removeCaller(other);
    }
    // Alone over the caps: this caller's own least recently used turns.
    while (this.full() && group.entries.size) this.removeEntry(id, group, group.entries.keys().next().value);
    return true;
  }

  // The frozen blocks, or null on a miss or an expired entry. A hit makes its caller (and itself
  // within the caller) the most recent.
  lookup({ caller, fingerprint }, now = Date.now()) {
    if (!validKey(caller, fingerprint)) return null;
    const id = String(caller);
    const group = this.callers.get(id);
    const entry = group?.entries.get(fingerprint);
    if (!entry) return null;
    if (entry.expires <= now) {
      this.removeEntry(id, group, fingerprint);
      return null;
    }
    this.touch(id);
    group.entries.delete(fingerprint);
    entry.expires = now + this.ttlMs; // an ongoing conversation keeps its turns
    group.entries.set(fingerprint, entry);
    return entry.blocks;
  }

  clear() {
    this.callers.clear();
    this.totalBytes = 0;
    this.count = 0;
  }

  get size() {
    return this.count;
  }

  get bytes() {
    return this.totalBytes;
  }
}

export const globalClaudeTurnCache = new ClaudeTurnCache();

// The `turns` hooks the adapter takes in its per-request context: lookup(fingerprint) and
// remember(fingerprint, blocks), scoped to one caller.
export function claudeTurnHooks(cache, caller) {
  if (!cache || caller === null || caller === undefined || caller === '') return null;
  return {
    lookup: fingerprint => cache.lookup({ caller, fingerprint }),
    remember: (fingerprint, blocks) => cache.remember({ caller, fingerprint, blocks }),
  };
}
