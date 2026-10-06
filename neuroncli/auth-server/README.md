# Neuron server

This directory is the standalone server project. It provisions accounts and sessions, owns provider credentials, selects models and enforces allocation across every client session. Users sign in to Zero-X and receive a gateway token; they do not configure Groq, Bedrock or other provider keys.

Production currently runs on Cloudflare Workers, its AI binding, Supabase Auth/Postgres and Cloudflare KV. Cloudflare supplies the default coding model. Additional providers are operator-managed capacity, not prerequisites for user sign-in. The same API can run in a Node container with Postgres-backed sessions and an operator-configured HTTP provider.

## Provisioning and policy

First verified sign-in calls `zerox_sync_account`, creates the Free account and persists a gateway session. Existing accounts retain their assigned plan. Request bodies and editable identity metadata cannot change plans. `GET /auth/me` also provisions a missing verified account.

Postgres `zerox_plan_policy` is the authoritative allocation policy. The server returns remaining tokens, request limits and UTC reset information; clients do not allocate quotas. `zerox_reserve_usage` locks the account and reserves prompt/output capacity before inference. `zerox_settle_usage` reconciles reported usage afterward. Unknown or interrupted usage retains its reservation. Limits apply across devices and sessions. Operator policy edits affect enforcement immediately; displayed policy refreshes within 60 seconds.

Change a plan's allocation through the private policy table, for example:

```sql
UPDATE public.zerox_plan_policy
SET daily_tokens = 256000, daily_requests = 2000
WHERE plan = 'free';
```

Assign plans through an authorized administrative database operation. These tables and RPCs are restricted to `service_role`, with RLS enabled. Never put the secret key in a client. Prices in policy are descriptive; this server does not implement payments.

## Operator deployment

1. Apply the SQL files in `migrations/` in chronological order to the selected Supabase project.
2. Configure Supabase Auth and its allowed Zero-X login redirects. Supply the project URL, public publishable key and private secret key to the server.
3. For the existing website deployment, use `wrangler.toml`; it binds KV and Cloudflare AI. Provider keys are Worker secrets. For an independent API Worker, use `wrangler.api.toml`, set its identity variables and add the existing/new KV namespace binding, or use the Postgres session store automatically.
4. Run `npm ci`, `npm test`, and `npm audit --omit=dev`, then deploy. Verify `/ready`, signed-in account allocation, streaming and a real model probe before routing clients to it.

The independent Worker config has no website assets or repository-wide static files. `npm run deploy:api` publishes it separately; set its domain and the client's `NEURON_API_BASE` when adopting it. The current website deployment retains its existing domain and login pages.

For a standalone Node process, copy `.env.example` to an untracked `.env`, supply operator configuration, and run `npm start`. `NEURON_API_ONLY=true` prevents website-asset serving. For containers:

```sh
docker build -t neuron-server .
docker run --env-file .env -p 8787:8787 neuron-server
```

Use a TLS reverse proxy for remote Node access. Sessions persist in Postgres when KV is absent; token keys are hashed before storage and records expire. Production does not fall back to in-memory sessions. `ALLOW_ANONYMOUS_SESSIONS=true` is an explicit development mode with local test allocations.

## Operations

`GET /health` is process/configuration liveness. `GET /ready` verifies quota policy, session storage and an available tool-capable catalog; it does not certify provider inference. `POST /v1/models/health` is an authenticated, quota-accounted real inference probe.

`GET /v1/providers/health` requires the operator's `GATEWAY_ADMIN_TOKEN` (at least 32 characters), not a user session. It reports missing credentials, catalog health and configuration for operators only. Supply it using `wrangler secret put GATEWAY_ADMIN_TOKEN` or the container's secret store. Provider rejection details remain in server logs; user responses contain service availability and allocation messages.

See [PROVIDERS.md](PROVIDERS.md) for all six provider configurations. Missing optional credentials remove those models from the catalog. Operators are responsible for provider access, capacity and billing; users receive the service's included models. No architecture can manufacture provider credentials or guarantee unlimited capacity.

Database checks use an isolated PGlite install: set `PGLITE_ENTRY` to its `dist/index.js` and run `npm run check:database`.
