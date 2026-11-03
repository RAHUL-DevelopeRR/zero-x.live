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
