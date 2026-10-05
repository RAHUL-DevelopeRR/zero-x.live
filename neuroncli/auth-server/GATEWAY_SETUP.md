# Gateway configuration and rollout

The deployed Cloudflare Worker and `npm start` use the same Hono application. `npm test` runs the gateway, website, login and Node adapter checks. Node development listens on 127.0.0.1:8787; AUTH_PORT overrides it.

Apply migrations/20261003_accounts.sql, then migrations/20261004_quota_reservations.sql to the account database before deploying these changes. The new quota RPCs reserve prompt plus maximum output atomically per account and reconcile provider usage. Interrupted streams retain their reservation when final usage is unavailable. Anonymous session creation is disabled by default; ALLOW_ANONYMOUS_SESSIONS=true is for explicit development/trial environments and lacks production cross-isolate atomic accounting.

Server configuration:

- SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are public identity configuration. SUPABASE_SECRET_KEY stays server-side for account RPC access.
- SESSIONS_KV persists gateway credentials. AI is the native Cloudflare Workers AI binding.
- OPENROUTER_API_KEY and OPENROUTER_MODELS configure OpenRouter. Session-owned OpenRouter keys remain server-side.
- GROQ_API_KEY + GROQ_MODELS, GEMINI_API_KEY + GEMINI_MODELS, NVIDIA_API_KEY + NVIDIA_MODELS configure optional OpenAI-compatible providers.
- AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT + AZURE_MODELS configure Azure.
- Model lists are comma-separated upstream IDs. Optional provider access requires credentials and model allowlists. Groq, Gemini and NVIDIA public IDs are provider-prefixed. CLOUDFLARE_MODELS/CLOUDFLARE_TOOL_MODELS override Cloudflare model/capability lists.
- Node can use CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN instead of the Worker binding. These are server secrets.

The public /v1/models catalog advertises configured providers. auto selects a tool-capable configured model. The router returns actionable errors for unavailable models and provider 429s; it does not silently fall back between models or promise unlimited free inference. Configure only models and entitlements appropriate for your account. No paid provider is provisioned automatically.

CLI login opens /neuroncli/login/, authenticates the Zero-X account, exchanges its identity for /auth/cli/session, and posts only the gateway token plus state to a random loopback port. The client sends this credential to https://zero-x.live/v1. DELETE /auth/session revokes it. Provider keys never need to be distributed with the client.

Before rollout: run npm test and npm audit --omit=dev, apply the SQL migration, configure provider secrets/allowlists, deploy the Worker, then test account login, model discovery and a tool-call canary with the matching Neuron build. These changes have not been deployed by the coding task.
