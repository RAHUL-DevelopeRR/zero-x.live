// Preserved thinking for the native Claude adapter. OpenAI clients cannot echo Claude's
// thinking blocks or their signatures, so the gateway keeps the exact content of each assistant
// turn it produced and puts it back when the client sends that turn again in its history (the
// same pattern as Gemini's ThoughtSignatureCache in provider-request.js).
//
// Per isolate and best effort: a miss only means Claude answers without that turn's reasoning.
// Every replaying request sends thinking.block_binding drop_block, so a stale or mismatched
// block is dropped by the API, never a 400.
//
// Key: the caller plus the turn fingerprint (anthropic-request.js turnFingerprint). It is not
// scoped to the model: Opus 5.5 reads Sonnet 5.5 blocks, and the API drops what a model cannot
// read, unbilled.

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

export class ClaudeTurnCache {
  constructor({ maxEntries = DEFAULTS.maxEntries, maxBytes = DEFAULTS.maxBytes, maxEntryBytes = DEFAULTS.maxEntryBytes,
    ttlMs = DEFAULTS.ttlMs } = {}) {
    this.entries = new Map(); // insertion order is LRU order
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.ttlMs = ttlMs;
    this.totalBytes = 0;
  }

  key({ caller, fingerprint }) {
    if (caller === null || caller === undefined || caller === '' || typeof fingerprint !== 'string' || !fingerprint) return null;
    return `${String(caller)}\u0000${fingerprint}`;
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  // Freezes `blocks` in place and keeps them; false when they were not kept.
  remember({ caller, fingerprint, blocks }, now = Date.now()) {
    const key = this.key({ caller, fingerprint });
    if (!key || !Array.isArray(blocks) || !blocks.length) return false;
    const bytes = utf8Length(JSON.stringify(blocks)) + key.length;
    if (bytes > this.maxEntryBytes) return false;
    this.remove(key);
    this.entries.set(key, { blocks: deepFreeze(blocks), bytes, expires: now + this.ttlMs });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value);
    }
    return true;
  }

  // The frozen blocks, or null on a miss or an expired entry. A hit becomes the most recent.
  lookup({ caller, fingerprint }, now = Date.now()) {
    const key = this.key({ caller, fingerprint });
    const entry = key ? this.entries.get(key) : null;
    if (!entry) return null;
    if (entry.expires <= now) {
      this.remove(key);
      return null;
    }
    this.entries.delete(key);
    entry.expires = now + this.ttlMs; // an ongoing conversation keeps its turns
    this.entries.set(key, entry);
    return entry.blocks;
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size() {
    return this.entries.size;
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
