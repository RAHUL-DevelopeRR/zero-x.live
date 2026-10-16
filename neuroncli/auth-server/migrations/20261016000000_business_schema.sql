BEGIN;

-- Business platform schema (docs/PLATFORM_CONTRACT.md sections 1 and 4).
-- Every table is service_role only: RLS is enabled without policies and all
-- privileges are revoked from PUBLIC, anon and authenticated.

-- 1. Plans: add 'max' to the plan constraints on accounts and policies.
DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT rel.relname, con.conname
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS nsp ON nsp.oid = rel.relnamespace
    JOIN pg_catalog.pg_attribute AS att ON att.attrelid = rel.oid AND att.attname = 'plan'
    WHERE nsp.nspname = 'public' AND rel.relname IN ('zerox_accounts', 'zerox_plan_policy')
      AND con.contype = 'c' AND con.conkey = ARRAY[att.attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', constraint_row.relname, constraint_row.conname);
  END LOOP;
END;
$$;
ALTER TABLE public.zerox_plan_policy ADD CONSTRAINT zerox_plan_policy_plan_check
  CHECK (plan IN ('free', 'pro', 'max', 'ultrawork'));
ALTER TABLE public.zerox_accounts ADD CONSTRAINT zerox_accounts_plan_check
  CHECK (plan IN ('free', 'pro', 'max', 'ultrawork'));

ALTER TABLE public.zerox_plan_policy
  ADD COLUMN price_inr_paise bigint NOT NULL DEFAULT 0 CHECK (price_inr_paise >= 0),
  ADD COLUMN rpm_limit integer NOT NULL DEFAULT 10 CHECK (rpm_limit > 0),
  ADD COLUMN concurrency_limit integer NOT NULL DEFAULT 2 CHECK (concurrency_limit > 0),
  ADD COLUMN allowed_tiers text[] NOT NULL DEFAULT ARRAY['free']::text[]
    CHECK (cardinality(allowed_tiers) > 0 AND allowed_tiers <@ ARRAY['free', 'paid']::text[]),
  ADD COLUMN monthly_credit_microusd bigint NOT NULL DEFAULT 0 CHECK (monthly_credit_microusd >= 0),
  ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features) = 'array'),
  ADD COLUMN sort integer NOT NULL DEFAULT 100,
  ADD COLUMN public boolean NOT NULL DEFAULT true,
  ADD COLUMN highlighted boolean NOT NULL DEFAULT false,
  ADD COLUMN razorpay_plan_id_inr text CHECK (razorpay_plan_id_inr ~ '^plan_[A-Za-z0-9]{1,64}$'),
  ADD COLUMN razorpay_plan_id_usd text CHECK (razorpay_plan_id_usd ~ '^plan_[A-Za-z0-9]{1,64}$'),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Seeded exactly per contract section 1. Razorpay plan ids are created later by
-- scripts/razorpay-bootstrap.mjs and are preserved when this seed is re-applied.
INSERT INTO public.zerox_plan_policy AS policy (plan, name, price_usd, price_inr_paise, daily_requests,
  daily_tokens, rpm_limit, concurrency_limit, allowed_tiers, monthly_credit_microusd, features, sort, public, highlighted)
VALUES
  ('free', 'Free', 0, 0, 100, 500000, 10, 2, ARRAY['free'], 0,
    '["100 requests per day", "500K tokens per day", "Free-tier models (Groq, Gemini Flash, Workers AI)", "10 requests per minute, 2 concurrent", "Usage dashboard"]'::jsonb,
    10, true, false),
  ('pro', 'Pro', 10, 89900, 2000, 10000000, 30, 4, ARRAY['free', 'paid'], 8000000,
    '["2,000 requests per day", "10M tokens per day", "$8 of monthly credits for paid models", "Paid upstream capacity when free pools are busy", "30 requests per minute, 4 concurrent", "API keys for headless and CI runs", "Usage dashboard"]'::jsonb,
    20, true, true),
  ('max', 'Max', 40, 349900, 10000, 50000000, 60, 8, ARRAY['free', 'paid'], 35000000,
    '["10,000 requests per day", "50M tokens per day", "$35 of monthly credits for paid models", "Paid upstream capacity when free pools are busy", "60 requests per minute, 8 concurrent", "API keys for headless and CI runs", "Usage dashboard"]'::jsonb,
    30, true, false),
  ('ultrawork', 'Pro (legacy)', 10, 89900, 2000, 10000000, 30, 4, ARRAY['free', 'paid'], 8000000,
    '["2,000 requests per day", "10M tokens per day", "$8 of monthly credits for paid models", "Paid upstream capacity when free pools are busy", "30 requests per minute, 4 concurrent", "API keys for headless and CI runs", "Usage dashboard"]'::jsonb,
    90, false, false)
ON CONFLICT (plan) DO UPDATE SET name = EXCLUDED.name, price_usd = EXCLUDED.price_usd,
  price_inr_paise = EXCLUDED.price_inr_paise, daily_requests = EXCLUDED.daily_requests,
  daily_tokens = EXCLUDED.daily_tokens, rpm_limit = EXCLUDED.rpm_limit,
  concurrency_limit = EXCLUDED.concurrency_limit, allowed_tiers = EXCLUDED.allowed_tiers,
  monthly_credit_microusd = EXCLUDED.monthly_credit_microusd, features = EXCLUDED.features,
  sort = EXCLUDED.sort, public = EXCLUDED.public, highlighted = EXCLUDED.highlighted,
  razorpay_plan_id_inr = policy.razorpay_plan_id_inr, razorpay_plan_id_usd = policy.razorpay_plan_id_usd,
  updated_at = now();

-- 2. Accounts: credits (micro-USD), suspension, caller country and who set the plan.
ALTER TABLE public.zerox_accounts
  ADD COLUMN credit_balance_microusd bigint NOT NULL DEFAULT 0 CHECK (credit_balance_microusd >= 0),
  ADD COLUMN suspended boolean NOT NULL DEFAULT false,
  ADD COLUMN country text CHECK (country ~ '^[A-Z]{2}$'),
  ADD COLUMN plan_source text NOT NULL DEFAULT 'default'
    CHECK (plan_source IN ('default', 'subscription', 'manual'));
-- Paid plans that exist before billing were granted by an operator.
UPDATE public.zerox_accounts SET plan_source = 'manual' WHERE plan <> 'free';
CREATE INDEX zerox_accounts_plan_source_idx ON public.zerox_accounts (plan_source) WHERE plan_source = 'subscription';
CREATE INDEX zerox_accounts_last_seen_idx ON public.zerox_accounts (last_seen_at);

-- 3. Quota reservations (one per upstream attempt) and shared upstream pool counters.
CREATE TABLE public.zerox_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  tier text NOT NULL CHECK (tier IN ('free', 'paid')),
  plan text NOT NULL,
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
  reserved_cost_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_microusd >= 0),
  usage_day date NOT NULL,
  pool_minute timestamptz NOT NULL,
  pool_day timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'released')),
  outcome text CHECK (outcome IN ('ok', 'error', 'refunded')),
  prompt_tokens bigint CHECK (prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens >= 0),
  cost_microusd bigint CHECK (cost_microusd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX zerox_reservations_user_created_idx ON public.zerox_reservations (user_id, created_at DESC);
CREATE INDEX zerox_reservations_active_idx ON public.zerox_reservations (created_at) WHERE status = 'active';
CREATE INDEX zerox_reservations_request_idx ON public.zerox_reservations (request_id);

CREATE TABLE public.zerox_pool_usage (
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  tier text NOT NULL CHECK (tier IN ('free', 'paid')),
  bucket text NOT NULL CHECK (bucket IN ('minute', 'day')),
  bucket_start timestamptz NOT NULL,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, tier, bucket, bucket_start)
);
CREATE INDEX zerox_pool_usage_bucket_idx ON public.zerox_pool_usage (bucket, bucket_start);

-- 4. Usage history: one event per settled reservation plus a per-day, per-model rollup.
CREATE TABLE public.zerox_usage_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  reservation_id uuid UNIQUE,
  request_id text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL DEFAULT '',
  upstream_model text NOT NULL DEFAULT '',
  tier text NOT NULL CHECK (tier IN ('free', 'paid')),
  status text NOT NULL CHECK (status IN ('ok', 'error', 'refunded')),
  prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_microusd bigint NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  error_code text CHECK (length(error_code) <= 100),
  usage_day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zerox_usage_events_user_idx ON public.zerox_usage_events (user_id, id DESC);
CREATE INDEX zerox_usage_events_created_idx ON public.zerox_usage_events (created_at);

CREATE TABLE public.zerox_usage_daily (
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  day date NOT NULL,
  model text NOT NULL,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  errors bigint NOT NULL DEFAULT 0 CHECK (errors >= 0),
  prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_microusd bigint NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, model)
);
CREATE INDEX zerox_usage_daily_day_idx ON public.zerox_usage_daily (day);

-- 5. Personal API keys (only the SHA-256 hex digest of the secret is stored).
CREATE TABLE public.zerox_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  prefix text NOT NULL CHECK (prefix ~ '^nzx_[A-Za-z0-9_-]{0,28}$'),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX zerox_api_keys_user_idx ON public.zerox_api_keys (user_id, created_at DESC);

-- 6. Billing (provider-agnostic; Razorpay first).
CREATE TABLE public.zerox_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_subscription_id text NOT NULL CHECK (length(provider_subscription_id) BETWEEN 1 AND 100),
  plan text NOT NULL CHECK (plan IN ('pro', 'max')),
  status text NOT NULL CHECK (status IN ('created', 'authenticated', 'active', 'pending', 'halted',
    'paused', 'cancelled', 'completed', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX zerox_subscriptions_user_idx ON public.zerox_subscriptions (user_id, updated_at DESC);
CREATE INDEX zerox_subscriptions_status_idx ON public.zerox_subscriptions (status, current_period_end);

CREATE TABLE public.zerox_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_payment_id text NOT NULL CHECK (length(provider_payment_id) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('subscription', 'topup')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded')),
  invoice_url text CHECK (invoice_url ~ '^https://' AND length(invoice_url) <= 2048),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX zerox_payments_user_idx ON public.zerox_payments (user_id, created_at DESC);

CREATE TABLE public.zerox_credit_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  delta_microusd bigint NOT NULL,
  balance_after_microusd bigint NOT NULL CHECK (balance_after_microusd >= 0),
  shortfall_microusd bigint NOT NULL DEFAULT 0 CHECK (shortfall_microusd >= 0),
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  ref text NOT NULL UNIQUE CHECK (length(ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zerox_credit_ledger_user_idx ON public.zerox_credit_ledger (user_id, created_at DESC);

CREATE TABLE public.zerox_webhook_events (
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL DEFAULT '' CHECK (length(event_type) <= 100),
  payload_sha256 text CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX zerox_webhook_events_received_idx ON public.zerox_webhook_events (received_at);

-- 7. CLI session index (SHA-256 hex of session ids) so every session can be revoked.
CREATE TABLE public.zerox_session_index (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zerox_session_index_user_idx ON public.zerox_session_index (user_id);
CREATE INDEX zerox_session_index_expiry_idx ON public.zerox_session_index (expires_at);

-- 8. Row level security and service_role-only privileges.
ALTER TABLE public.zerox_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_pool_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_session_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_plan_policy ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.zerox_reservations, public.zerox_pool_usage, public.zerox_usage_events,
  public.zerox_usage_daily, public.zerox_api_keys, public.zerox_subscriptions, public.zerox_payments,
  public.zerox_credit_ledger, public.zerox_webhook_events, public.zerox_session_index,
  public.zerox_accounts, public.zerox_plan_policy
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_reservations, public.zerox_pool_usage,
  public.zerox_usage_events, public.zerox_usage_daily, public.zerox_api_keys, public.zerox_subscriptions,
  public.zerox_payments, public.zerox_credit_ledger, public.zerox_webhook_events, public.zerox_session_index
  TO service_role;
REVOKE ALL ON SEQUENCE public.zerox_usage_events_id_seq, public.zerox_credit_ledger_id_seq
  FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.zerox_usage_events_id_seq, public.zerox_credit_ledger_id_seq
  TO service_role;

COMMIT;
