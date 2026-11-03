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
  that it is needed at all and that the platform, the language's library or the
  codebase does not already cover it), Build discipline (small verified steps,
  run the tests, never shorten away input validation, data-loss handling,
  security or accessibility, do not make up APIs) and Design taste (a deliberate
  direction first, no default generic AI page patterns, real content, accessible
  and responsive).
- It starts by saying that the user's, the project's and any later system
  instruction always win. It is a default, not a control, and it adds no tool,
  permission or behaviour change beyond style.
- It is byte-identical in every request: no timestamp, user data or per-model
  variant, so provider prompt caching of what follows it is not broken. Changing
  a word is a release: bump `HOUSE_STYLE_VERSION`, update `docs.html` (the check
  compares them) and expect one cache miss per conversation.
- It is Zero-X's own wording, not a paraphrase that tracks the credited
  projects' structure: it has no ladder of steps and its order differs from
  theirs. `scripts/check-style-originality.mjs <bundled-skills dir>` fails on any
  four-word run shared with the skill files the Neuron client bundles (Ponytail,
  gstack, anti-slop). It is a local script, not part of `npm test` or CI, because
  those files live in the neuron repository; `ZEROX_BUNDLED_SKILLS=<dir> node
  check-house-style.mjs` runs it inside the check. It passed against the bundled
  copies for the v1 text. Hallmark and other upstream versions were not
  compared: run it again with every wording change.

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
usage reported, a bare total, or a usage block flagged `estimate` or `estimated`:
the first spelling is the abort and failed-attempt fallback in `chat-handler.js`,
the second is `normalizeCompletion`'s fallback for a reply with no usage block;
`usageCountsPreface` reads both) never held the preface and is not reduced. The
Workers AI adapter builds its own estimate from the payload it sent, which does
hold the preface, so a styled non-streaming reply's estimate is pinned back to
the client's prompt (`clientEstimate`): a request with no usage block upstream is
billed the same with and without the preface.

Reservations are sized from the client's messages and are unchanged; only the
context-window fit in the router counts the preface, so a request that fits a
model only without it is refused (or, with `auto`, routed to a larger model)
instead of being sent over the model's limit. A caller who needs the old
behaviour sends `x-neuron-style: off`.

### Shared pool budgets drift (open issue)

The user-side numbers (window, daily caps, credits, session KV) leave the preface
out. The shared pool counters do not: the reservation holds the client's prompt,
and `zerox_settle_v2` reconciles the per-pool minute and day token counters
(`zerox_pool_usage`, the `tpm` and `tpd` buckets of Groq, Gemini and vault-key
pools) with the same credited prompt it settles for the user, because both come
from one `p_prompt_tokens`. Each styled request is therefore counted about
`HOUSE_STYLE_TOKENS` (about 350) tokens below what the provider metered, so the
gateway's own pool budgets run out later than the provider's. On an 8K TPM key
that is several percent per request, and the gateway finds out through upstream
429s and failover rather than `pool_exhausted`. Only the router's fit check
(`fitMaxTokens`) counts the preface. Pool budgets are not unaffected.

Separating the two needs a migration: a new optional `p_pool_extra_tokens`
argument on `zerox_settle_v2` that is added to the pool delta only (the old
function must be replaced, not overloaded, so PostgREST can choose; apply the
migration before the gateway starts sending the argument). It is not part of this
change because it touches settlement for every request and cannot be verified
against a production database from here. Until it lands: roll out with
`HOUSE_STYLE_PERCENT`, watch upstream 429s on the Groq and Gemini pools, and if
they rise lower those pools' limits in the catalog or set `HOUSE_STYLE=off`.

Zero-X pays the preface upstream: about 350 tokens per request, mostly prompt
cache reads where a provider caches. The response `usage` still shows what the
provider counted. No style metadata is stored on the usage row (it would need a
`zerox_settle_v2` change); metadata-only logging is unchanged.

## Rollout

1. `HOUSE_STYLE_PERCENT=10`, watch tokens per request, requests per
   conversation, error rate and the share of `x-neuron-style: off`, then 50, then
   100. `HOUSE_STYLE=off` rolls back without a deploy of code.
2. The public evidence that a preface lowers tokens is small and self-reported.
   Run the A/B harness (`scripts/style-ab.mjs`, below; read cost from its
   `loop` shape, output length from `single`) on a local or staging gateway
   before going past 10 percent, and state in public only what was measured.
   The harness cannot confirm a cost saving on its own; the agent-loop evals can.

## A/B harness

`scripts/style-ab.mjs` compares requests with and without the preface on the
coding task shapes in `scripts/style-ab-tasks.mjs` and reports tokens in and
out, lines of code and a check pass rate. It has two shapes, and what it can say
depends on which one you read:

- `single` (default): one short request per task, a few hundred prompt tokens.
  Read output length and the pass rate only. The preface roughly doubles such a
  prompt, so its `cost_tokens` ratio says nothing about real agent loops, and its
  `billed_tokens` ratio leaves the preface out of arm B by construction, so it is
  a completion-length comparison.
- `loop` (`--shapes loop` or `--shapes single,loop`): the same task after a long,
  fixed prior conversation (`--context-tokens`, 5,000 to 20,000, a deterministic
  transcript of file reads), with the preface as the first bytes of the system
  prompt as in a real agent step. Read cost here: `cost_tokens` (provider counts,
  preface included: what Zero-X pays) and `billed_tokens` (preface left out: what
  the user is charged) separately; `cached_tokens` shows what the provider
  reported as cache reads. The context is synthetic, so it is an indication, not
  the cost of real agent traffic.

No pass or fail gate is computed and the two cost bases are never combined into
one. A pair whose arm A produced no code stays in the comparison (a failed pass
and a `no_code` count; only the lines ratio leaves it out). This harness cannot
confirm that the preface saves tokens: the owner's condition for keeping it is an
A/B on real agent-loop coding evals (below), and a cost claim in public needs
that. It is a dry run unless `--execute` and
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

Written in Zero-X's own words (see "What it is" for the originality check). The
ideas were inspired by public projects:

- Ponytail (original DietrichGebert/ponytail, fork dkfish/ponytail), MIT: the
  Economy section and the never-shorten-away rule in Build discipline.
- gstack (garrytan/gstack), MIT: the small, verified steps of Build discipline.
  Its role-based pipeline is not part of the preface.
- anti-slop (miqdadbadjuber/anti-slop, the skill Neuron bundles, commit 388cbe3),
  MIT per the Neuron client's SOURCES.json: Design taste.
- Hallmark (Nutlope/hallmark): Design taste. MIT according to its project page;
  its LICENSE file and copyright line were not confirmed.

See `NOTICE` in the repository root.
