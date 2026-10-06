BEGIN;

-- Gateway Provider Health Audit Table
CREATE TABLE IF NOT EXISTS public.gateway_provider_health (
  provider text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'DOWN')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  total_attempts bigint NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
  successful_attempts bigint NOT NULL DEFAULT 0 CHECK (successful_attempts >= 0),
  failed_attempts bigint NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  circuit_open_until timestamptz,
  last_latency_ms integer,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gateway_provider_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_provider_health FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gateway_provider_health TO service_role;

-- Gateway Inference Attempts Ledger Table
CREATE TABLE IF NOT EXISTS public.gateway_inference_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  success boolean NOT NULL,
  http_status integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_inference_attempts_req_idx ON public.gateway_inference_attempts(request_id);
CREATE INDEX IF NOT EXISTS gateway_inference_attempts_user_idx ON public.gateway_inference_attempts(user_id, created_at);

ALTER TABLE public.gateway_inference_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_inference_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gateway_inference_attempts TO service_role;

COMMIT;
