# Persistent account storage

Project: `norrtosjwcossxrhhtvd` (the existing ZeroX Supabase project).

Supabase Auth stores login identities. PostgreSQL `public.zerox_accounts` stores the
verified identity profile, plan, current UTC-day usage, lifetime counters and timestamps.
The `clerk_id` column retains the gateway's old naming for compatibility; its value is
now the Supabase `auth.users.id` UUID, with a foreign key to that user.

The Worker uses native HTTPS RPC requests with `SUPABASE_SECRET_KEY`. This key is an
encrypted GitHub Actions secret deployed as a Cloudflare Worker secret. It must never
be added to frontend configuration, a public environment variable or source control.
The schema migration is `neuroncli/auth-server/migrations/20261003_accounts.sql`.

Row-level security is enabled. Anonymous and authenticated browser roles have no table
access or RPC execution rights. Only the backend service role can use these RPCs. The
Worker verifies the Supabase identity before selecting its account; client-supplied
profile or plan overrides are ignored. Resync preserves an existing stored plan.

Authenticated gateway sessions load saved usage instead of starting at zero. Reads
reset daily counters on a new UTC day while retaining lifetime totals. Usage increments
are atomic in PostgreSQL. Legacy gateway sessions are not treated as verified accounts.

Token counting still follows the existing gateway implementation: some provider paths
use estimates and streaming does not consistently report token totals. These counters
are not a billing ledger. Concurrent request-limit reservation is not implemented.

Run `node neuroncli/auth-server/check-worker.mjs` for backend regression checks.
Live checks: `/health` reports `database_configured: true`; signed-in `/auth/sync`
and `/auth/me` must return `status: success`, with a matching PostgreSQL account row.
