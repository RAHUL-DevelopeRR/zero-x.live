# Zero-X house style (server layer)

The gateway adds one short, fixed preface to the start of the system prompt of
coding-agent requests. The code is `src/house-style.js`, the injection point is
`attempt()` in `src/chat-handler.js`, and the check is `check-house-style.mjs`.
The public text and the user-facing description are in `docs.html#house-style`.

Owner decision (2026-11-03): client-side enforcement is fine, and the server
enforces it too. The Neuron client keeps its bundled skills; the server layer
covers every other client of `/v1` (Claude Code, Codex, Cursor, opencode, SDK
agents) and old Neuron builds, and never doubles up on a request that already
carries a house style.

## What it is

- One constant string, version `v1`, about 1,400 bytes (about 350 tokens),
  plain ASCII. Three sections: Economy (shortest correct answer and code; check
  that it needs to exist and that the codebase, standard library or platform
  does not already cover it), Build discipline (small verified steps, run the
  tests, read before editing, do not invent APIs) and Design taste (a deliberate
  direction first, no default generic AI page patterns, real content, accessible
  and responsive).
- It starts by saying that the user's, the project's and any later system
  instruction always win. It is a default, not a control, and it adds no tool,
  permission or behaviour change beyond style.
- It is byte-identical in every request: no timestamp, user data or per-model
  variant, so provider prompt caching of what follows it is not broken. Changing
  a word is a release: bump `HOUSE_STYLE_VERSION`, update `docs.html` (the check
  compares them) and expect one cache miss per conversation.

## When it applies

`styleDecision()` is pure and uses only inputs that stay the same across the
turns of a conversation. In this order:

| Skip reason | Rule |
| --- | --- |
| `mode_off` | `HOUSE_STYLE=off` (the operator kill switch) |
| `opted_out` | request header `x-neuron-style: off` (beats `HOUSE_STYLE=on`) |
| `no_tools` | no `tools`: plain chat is never touched |
| `forced_tool`, `tool_choice_none` | `tool_choice` other than `auto` |
| `json_mode` | `response_format` json_object or json_schema |
| `tiny_max_tokens` | `max_tokens` or `max_completion_tokens` of 256 or less (title, summary, classifier calls) |
| `client_marker` | the request already carries a house style (below) |
| `rollout` | `HOUSE_STYLE=auto` and the caller's bucket is at or above `HOUSE_STYLE_PERCENT` |

Everything else gets the preface (`applied`). `x-neuron-style` on the response
is `v1` when the preface was sent upstream and absent otherwise.

### Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOUSE_STYLE` | `auto` | `auto`: eligible requests inside the percentage; `on`: ignore the percentage; `off`: kill switch. Anything else means `auto`. |
| `HOUSE_STYLE_PERCENT` | `100` | 0 to 100. The bucket is FNV-1a of the user id modulo 100, so a user is in or out for every turn. A bad value means 100. |

The operator view of `/health` shows `house_style: { mode, percent, version }`.

### The Neuron client marker

The Neuron client (neuron-v2) already sends the short form of the Ponytail and
AntiSlop rules in every system prompt, and a user can switch that off with
`{"defaultSkills": false}`. The server layer must not pay for the same rules
twice, and must not override that switch. A request counts as already styled
when any of these holds:

1. the request header `x-neuron-style: client` (what the client should send:
   one header, no prompt parsing);
2. a system or developer message contains `Neuron house style` (a marker line
   the client may add to its prompt instead) or `Zero-X house style` (our own
   text, for a request that already passed through a Zero-X gateway);
3. a system or developer message contains both `Ponytail:` and `AntiSlop:` (the
   always-on rules that current Neuron builds send, so old builds are covered
   without a client change).

User, assistant and tool messages are never read for the marker. A Neuron user
who set `defaultSkills: false` sends none of these and so gets the server
preface; they can send `x-neuron-style: off` to opt out. Sending the header from
the client's settings is a separate client change (not in this repository).

## How it is injected

After secret scrubbing and before every provider adapter builds its payload
(`buildUpstreamPayload`), for every attempt of a request, so a failover sends the
same prefix.

- First message is a system or developer message with a string: the preface and
  a blank line go in front of that string (still one system message, which some
  chat templates require; the client's text follows the preface).
- First message is a system or developer message with content parts: one text
  part is put in front.
- Otherwise: a new system message is put first.
- The input body is never mutated. Later messages are untouched, so Claude's
  thinking replay, Gemini thought signatures and sticky routing see the client's
  own history. The native Anthropic adapter turns the leading system message
  into the first top-level system block, which keeps its cache breakpoint.
- The scrubber has already run, so credentials are replaced first and the
  preface needs no scrubbing. Header and body values are never interpolated into
  the text.

## Accounting

The preface is not charged to the user's 5-hour window, daily caps or credits.
The provider's prompt count includes it, so `HOUSE_STYLE_TOKENS` (bytes divided
by four, about 350) come off the prompt side before settlement
(`creditPreface`, used by `settlementArgs` for the ledger and in
`finishAttempt` for session-KV allocations), never below 0, with the prompt-cache
split clamped. Usage that is only an estimate from the client's own messages (no
usage reported, a bare total, or a flagged `estimate`) never held the preface and
is not reduced. Reservations are sized from the client's messages and are
unchanged; only the context-window fit in the router counts the preface, so a
request just under a model's limit is not pushed over it.

Zero-X pays the preface upstream: about 350 tokens per request, mostly prompt
cache reads where a provider caches. The response `usage` still shows what the
provider counted. No style metadata is stored on the usage row (it would need a
`zerox_settle_v2` change); metadata-only logging is unchanged.

## Rollout

1. `HOUSE_STYLE_PERCENT=10`, watch tokens per request, requests per
   conversation, error rate and the share of `x-neuron-style: off`, then 50, then
   100. `HOUSE_STYLE=off` rolls back without a deploy of code.
2. The public evidence that a preface lowers tokens is small and self-reported.
   Run the A/B harness (`scripts/style-ab.mjs`, below) on a local or staging
   gateway before going past 10 percent, and state in public only what was
   measured.

## A/B harness

`scripts/style-ab.mjs` compares requests with and without the preface on the
coding task shapes in `scripts/style-ab-tasks.mjs` and reports tokens in and
out, lines of code and a check pass rate. It is a dry run unless `--execute` and
`--confirm <target>` are both given. Targets are names from a local file
(`scripts/style-ab-targets.local.json`, gitignored; see the `.example.json`)
that lists the allowed origin and the free models; a raw URL is never taken from
the command line, production hosts are refused, the request cap is a hard cap
that flags can only lower, only models the target's `/v1/models` lists as free
are used, and the token comes from `ZEROX_AB_TOKEN` (an `nzx_` key) or a hidden prompt, never argv. The
gateway under test needs `HOUSE_STYLE` set to `auto` or `on`; arm A sends
`x-neuron-style: off`, arm B sends nothing, and a run is invalid if the response
header does not match the arm.

The full coding eval (8 tasks, agent loop, the Neuron binary) lives in the
neuron repository (`evals/coding`); use arms there as: A control (client skills
off, `HOUSE_STYLE=off`), B server only (client skills off, `HOUSE_STYLE=on`),
C client skills only, D both (must equal C upstream, proving the dedupe).

## Credits

Written in Zero-X's own words, inspired by the public Ponytail (original
DietrichGebert/ponytail, fork dkfish/ponytail), gstack (garrytan/gstack) and
anti-slop UI design (Nutlope/hallmark and the anti-slop skill Neuron bundles)
projects, all MIT. See `NOTICE` in the repository root.
