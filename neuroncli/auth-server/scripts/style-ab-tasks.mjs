// Task shapes for scripts/style-ab.mjs: small coding and UI requests that mirror the shapes of the
// neuron repository's evals/coding tasks (a pagination fix, a rename, a CLI flag, de-duplicating
// twin methods, a tiny edit in a longer file, a unit bug, a small new function), plus three UI
// pages. Each is one chat request with tools, so the gateway treats it as a coding-agent request
// and the house style applies. The checks are static (text and patterns on the code the model
// returns): model-written code is never executed here. They say whether the answer has the shape
// asked for, not whether it passes a real test suite; use evals/coding in the neuron repository for
// that. Nothing in this file names a vendor or contains house-style text.

export const AGENT_SYSTEM = 'You are a coding agent working in a repository. Deliver your answer by calling write_file with the full new content of the file (path and content). Keep any explanation to a few lines.';

export const TOOLS = Object.freeze([
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the repository.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write the full content of a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
]);

const has = pattern => code => pattern.test(code);
const lacks = pattern => code => !pattern.test(code);
const count = (pattern, atLeast) => code => (code.match(pattern) || []).length >= atLeast;

// [name, predicate(code)] lists.
export const TASKS = Object.freeze([
  { id: 'py-pagination', kind: 'code', prompt: 'File pagination.py has a bug: page numbers start at 1 but the slice starts at page * per_page. Fix it, and make page < 1 raise ValueError.\n\n```python\ndef paginate(items, page, per_page):\n    start = page * per_page\n    return items[start:start + per_page]\n```',
    checks: [['defines paginate', has(/def paginate\(/)], ['offsets by page - 1', has(/page\s*-\s*1/)], ['raises ValueError', has(/ValueError/)]] },
  { id: 'js-rename', kind: 'code', prompt: 'Rename getUser to fetchUser everywhere in users.js and keep behaviour the same.\n\n```js\nexport function getUser(id) { return db.find(id); }\nexport function getUserName(id) { return getUser(id).name; }\nexport function getUserEmail(id) { return getUser(id).email; }\n```',
    checks: [['no getUser( left', lacks(/\bgetUser\(/)], ['fetchUser used 3 times', count(/\bfetchUser\b/g, 3)], ['other names kept', has(/getUserName/)]] },
  { id: 'py-cli-json', kind: 'code', prompt: 'Add a --json flag to this CLI that prints the result as JSON instead of text.\n\n```python\nimport argparse\n\ndef main():\n    parser = argparse.ArgumentParser()\n    parser.add_argument("name")\n    args = parser.parse_args()\n    print("hello " + args.name)\n\nmain()\n```',
    checks: [['adds --json', has(/--json/)], ['uses json.dumps', has(/json\.dumps/)], ['keeps argparse', has(/argparse/)]] },
  { id: 'py-twin-methods', kind: 'code', prompt: 'The two methods in registry.py duplicate each other. Remove the duplication but keep both public methods.\n\n```python\nclass Registry:\n    def __init__(self):\n        self.items = []\n\n    def add_user(self, name):\n        name = name.strip().lower()\n        if not name:\n            raise ValueError("empty")\n        self.items.append(("user", name))\n\n    def add_admin(self, name):\n        name = name.strip().lower()\n        if not name:\n            raise ValueError("empty")\n        self.items.append(("admin", name))\n```',
    checks: [['keeps add_user', has(/def add_user\(/)], ['keeps add_admin', has(/def add_admin\(/)], ['one append', code => (code.match(/\.append\(/g) || []).length === 1]] },
  { id: 'js-long-file', kind: 'code', prompt: 'In client.js change the default timeout from 3000 ms to 5000 ms. Change nothing else.\n\n```js\nconst DEFAULTS = { retries: 2, timeout: 3000, base: "/api" };\n\nexport function request(path, options = {}) {\n  const config = { ...DEFAULTS, ...options };\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(), config.timeout);\n  return fetch(config.base + path, { signal: controller.signal })\n    .finally(() => clearTimeout(timer));\n}\n\nexport function get(path) { return request(path); }\nexport function post(path, body) {\n  return request(path, { method: "POST", body: JSON.stringify(body) });\n}\n```',
    checks: [['uses 5000', has(/\b5000\b/)], ['3000 gone', lacks(/\b3000\b/)], ['keeps post', has(/function post\(/)]] },
  { id: 'py-timeout-units', kind: 'code', prompt: 'fetch_report takes timeout in seconds but client.get expects milliseconds, so requests time out 1000 times too early. Fix it.\n\n```python\ndef fetch_report(client, url, timeout=5):\n    return client.get(url, timeout=timeout)\n```',
    checks: [['converts units', has(/\*\s*1000|1000\s*\*/)], ['keeps the signature', has(/def fetch_report\(client, url, timeout=5\)/)]] },
  { id: 'go-reverse', kind: 'code', prompt: 'Write a Go function Reverse(s string) string in reverse.go that reverses a string and is correct for non-ASCII text.',
    checks: [['defines Reverse', has(/func Reverse\(s string\) string/)], ['works on runes', has(/\[\]rune/)]] },
  { id: 'py-format-duration', kind: 'code', prompt: 'Write format_duration(seconds) in duration.py returning text like "1h 02m 05s" (hours without padding, minutes and seconds padded to 2 digits). 0 seconds returns "0h 00m 00s".',
    checks: [['defines format_duration', has(/def format_duration\(/)], ['splits hours', has(/3600/)], ['pads to 2 digits', has(/:02d|%02d|zfill\(2\)|\{[^}]*:0?2/)]] },
  { id: 'ui-landing', kind: 'ui', prompt: 'Write index.html, a single-file landing page for Trailhead, a service that repairs trail-running shoes by post. Include what it does, how it works, prices (resole 45 EUR, patch 15 EUR) and a way to book.',
    checks: [['has html and lang', has(/<html[^>]*\blang=/i)], ['viewport meta', has(/name=["']viewport["']/i)], ['no lorem ipsum', lacks(/lorem ipsum/i)], ['mentions both prices', code => /45/.test(code) && /15/.test(code)]] },
  { id: 'ui-pricing', kind: 'ui', prompt: 'Write pricing.html, a single-file pricing page for Notepad Lite, a note app with Free (0 EUR) and Pro (6 EUR a month) plans. Use only those facts.',
    checks: [['has html and lang', has(/<html[^>]*\blang=/i)], ['viewport meta', has(/name=["']viewport["']/i)], ['no lorem ipsum', lacks(/lorem ipsum/i)], ['both plans', code => /Free/.test(code) && /Pro/.test(code)]] },
  { id: 'ui-settings-form', kind: 'ui', prompt: 'Write settings.html, a single-file account settings form with display name, email, a newsletter checkbox and a Save button. Labels must be tied to their inputs and the form must submit with a real method and action.',
    checks: [['has a form with action', has(/<form[^>]*\baction=/i)], ['labels for inputs', count(/<label[^>]*\bfor=/gi, 2)], ['email input', has(/type=["']email["']/i)], ['no lorem ipsum', lacks(/lorem ipsum/i)]] },
]);

// Default-AI-page phrases and patterns, counted in UI answers (reported, never gated).
const SLOP = [/lorem ipsum/gi, /\b(?:revolutioni[sz]e|unlock the power|seamless(?:ly)?|elevate your|cutting-edge|next-generation|game-changer)\b/gi,
  /linear-gradient\(/gi, /★{3,}|&#9733;{3,}/g, /\bTrusted by\b/gi];
export const slopCount = text => SLOP.reduce((sum, pattern) => sum + (String(text).match(pattern) || []).length, 0);

// Non-blank lines that are not whole-line comments.
export const countLines = code => String(code).split('\n').filter(line => {
  const text = line.trim();
  return text && !/^(?:#|\/\/|\/\*|\*|<!--)/.test(text);
}).length;

// The code an answer carries: write_file contents, else the fenced blocks, else the plain text.
export function extractCode(message) {
  const parts = [];
  for (const call of message?.tool_calls || []) {
    try {
      const parsed = JSON.parse(call.function?.arguments || '{}');
      for (const key of ['content', 'contents', 'code', 'text']) if (typeof parsed[key] === 'string') { parts.push(parsed[key]); break; }
    } catch { /* an unparsable call carries no code */ }
  }
  if (parts.length) return parts.join('\n');
  const text = typeof message?.content === 'string' ? message.content : '';
  const fenced = [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map(match => match[1]);
  return fenced.length ? fenced.join('\n') : text;
}

export function buildRequest(task, model, { maxTokens = 2048 } = {}) {
  return { model, max_tokens: maxTokens, messages: [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: task.prompt }],
    tools: TOOLS, tool_choice: 'auto' };
}

export function grade(task, message) {
  const code = extractCode(message);
  const failed = task.checks.filter(([, test]) => !test(code)).map(([name]) => name);
  return { pass: Boolean(code.trim()) && failed.length === 0, failed, lines: countLines(code), slop: task.kind === 'ui' ? slopCount(code) : 0 };
}

// ── The loop shape: a long, fixed prior conversation ──
// A real agent step re-sends 5K to 20K tokens of earlier turns and file contents, with the preface
// (when present) as the first bytes of the system prompt, so a provider caches it with the rest of
// the prefix. The single-shot tasks above cannot show that: their prompts are a few hundred tokens,
// which the preface roughly doubles. The loop shape puts the same task after a deterministic
// transcript of file reads (generated filler code, byte-identical in every request, no vendor name
// and no style text), so the cost of the preface can be read against a realistic prompt size.
export const LOOP_MIN_TOKENS = 5000;
export const LOOP_MAX_TOKENS = 20000;
export const LOOP_DEFAULT_TOKENS = 8000;
const BYTES_PER_TOKEN = 3.5; // the gateway's own prompt estimate (src/pricing.js estimatePromptTokens)
const FILE_BYTES = 3000;

export function fillerFile(index, bytes) {
  const parts = [`// module ${index}: fixed filler text for the cost measurement`];
  let size = parts[0].length;
  for (let n = 0; size < bytes; n++) {
    const text = `export function helper${index}x${n}(value, limit = ${(n * 7 + index) % 97}) {\n  const next = Number(value) + ${n};\n  return next > limit ? limit : next;\n}`;
    parts.push(text);
    size += text.length + 1;
  }
  return parts.join('\n');
}

// The same task after about `contextTokens` tokens of earlier turns: file reads and their results.
export function buildLoopRequest(task, model, { contextTokens = LOOP_DEFAULT_TOKENS, maxTokens = 2048 } = {}) {
  if (!Number.isInteger(contextTokens) || contextTokens < LOOP_MIN_TOKENS || contextTokens > LOOP_MAX_TOKENS) {
    throw new Error(`contextTokens must be a whole number from ${LOOP_MIN_TOKENS} to ${LOOP_MAX_TOKENS}`);
  }
  const build = fillerBytes => {
    const files = Math.max(1, Math.ceil(fillerBytes / FILE_BYTES));
    const messages = [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: 'Before the next task, read the modules you may need.' }];
    for (let index = 0; index < files; index++) {
      const id = `call_${index}`;
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/module${index}.js` }) } }] });
      messages.push({ role: 'tool', tool_call_id: id, content: fillerFile(index, Math.floor(fillerBytes / files)) });
    }
    messages.push({ role: 'assistant', content: 'I have read the modules.' });
    messages.push({ role: 'user', content: task.prompt });
    return { model, max_tokens: maxTokens, messages, tools: TOOLS, tool_choice: 'auto' };
  };
  // The JSON of the conversation and the tool schemas is what a provider counts (about 3.5 bytes a
  // token): size the filler so that, escapes and message framing included, it lands on the target.
  const tokensOf = request => (JSON.stringify(request.messages).length + JSON.stringify(request.tools).length) / BYTES_PER_TOKEN;
  let fillerBytes = Math.round(contextTokens * BYTES_PER_TOKEN);
  let request = build(fillerBytes);
  for (let pass = 0; pass < 4; pass++) {
    fillerBytes = Math.max(FILE_BYTES, Math.round(fillerBytes - (tokensOf(request) - contextTokens) * BYTES_PER_TOKEN));
    request = build(fillerBytes);
  }
  return request;
}
