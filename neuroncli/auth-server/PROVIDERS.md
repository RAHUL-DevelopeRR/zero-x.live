# Provider configuration and health

The backend selects and invokes the provider. The client receives public model IDs from `GET /v1/models` and never receives shared provider credentials. Without an explicit model allowlist, configured HTTP providers fetch their live `/models` catalogs, cached for 60 seconds per credential in each Worker isolate. Discovery failures do not publish invented models. Cloudflare uses its configured binding and allowlist.

| Provider | Server secret | Additional configuration |
| --- | --- | --- |
| Groq | `GROQ_API_KEY` | Optional `GROQ_MODELS` |
| OpenRouter | `OPENROUTER_API_KEY` | Optional `OPENROUTER_MODELS`; includes `openrouter/free` by default |
| NVIDIA NIM | `NVIDIA_API_KEY` | Optional `NVIDIA_MODELS` |
| Gemini | `GEMINI_API_KEY` | Optional `GEMINI_MODELS` |
| OmniRoute | `OMNIROUTE_API_KEY` | Required `OMNIROUTE_BASE_URL`, including `/v1`; optional `OMNIROUTE_MODELS` |
| AWS Bedrock | `BEDROCK_API_KEY` | Required `BEDROCK_REGION` or `AWS_REGION`; optional `BEDROCK_MODELS` |

Store secrets in Worker secrets, not `wrangler.toml`. `*_MODELS` is a comma-separated operator allowlist and suppresses automatic discovery. Discovered models advertise tools only when the provider metadata confirms support or the operator adds their upstream IDs to `*_TOOL_MODELS`. For an explicit allowlist, Groq/OpenRouter/Gemini/NVIDIA tool support retains the existing default unless `*_TOOL_MODELS` is set; OmniRoute and Bedrock require an explicit tool allowlist. OpenRouter discovery publishes only zero-priced models by default; set `OPENROUTER_FREE_ONLY=false` to enable paid discovered models. Explicit `OPENROUTER_MODELS` can intentionally allow paid models. Prefer explicit allowlists for hosted/shared credentials to select chat models, control costs and restrict access. A provider catalog can include non-chat models; catalog reachability does not certify inference compatibility.

Groq, Gemini, NVIDIA, OmniRoute and Bedrock model IDs have a provider prefix, for example `groq/llama-3.3-70b-versatile`. OpenRouter and Cloudflare retain their upstream IDs. `auto` chooses the first tool-capable configured model, then the first configured model. Session-owned OpenRouter keys remain restricted to OpenRouter and have separate discovery caches.

Bedrock uses its API-key OpenAI-compatible interface. Its default `bedrock-mantle` endpoint supports `/models`. Set `BEDROCK_ENDPOINT=runtime` for the recommended `bedrock-runtime` inference endpoint and provide `BEDROCK_MODELS`: runtime does not support OpenAI model discovery. This gateway does not implement IAM SigV4 or native Converse requests; configure only model IDs supporting Chat Completions on the chosen endpoint. This does not grant model access or establish a free tier.

`GET /health` checks gateway configuration. `GET /v1/providers/health` requires the server operator's `GATEWAY_ADMIN_TOKEN`, not a user gateway session, and checks HTTP catalog endpoints with a five-second timeout, returning `reachable`, `unauthorized`, `rate_limited`, `unavailable`, `configured`, `allowlist_required`, or `not_configured`. Bedrock runtime and Azure report `configured` when their allowlist exists, otherwise `allowlist_required`; neither state checks inference. Cloudflare reports `binding_configured`. It never reports catalog checks as successful inference. Catalog results are cached for up to 60 seconds; checks for unavailable providers are also bounded by that cache. Discovery and completion requests reject redirects.

`POST /v1/models/health` with `{"model":"auto"}` (or a catalog model ID) runs a short real completion. It requires the same gateway session, applies the normal request/token quota, and reports `healthy` only for a non-empty completion. This consumes provider tokens; it is an explicit probe, not a free public inference endpoint.

References: [Groq API](https://console.groq.com/docs/api-reference), [OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/get-models), [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [NVIDIA models](https://docs.api.nvidia.com/nim/reference/models-1), [OmniRoute](https://github.com/diegosouzapw/OmniRoute), [Bedrock Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html).
