BEGIN;

CREATE TABLE IF NOT EXISTS public.gateway_providers (
  id text PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  base_url text NOT NULL,
  catalog_source text NOT NULL DEFAULT 'discovery' CHECK (catalog_source IN ('discovery', 'allowlist', 'database')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gateway_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_providers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gateway_providers TO service_role;

CREATE TABLE IF NOT EXISTS public.gateway_provider_models (
  public_model_id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES public.gateway_providers(id) ON DELETE CASCADE,
  provider_model_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  supports_streaming boolean NOT NULL DEFAULT true,
  supports_tools boolean NOT NULL DEFAULT true,
  supports_parallel_tools boolean NOT NULL DEFAULT true,
  supports_vision boolean NOT NULL DEFAULT false,
  supports_reasoning boolean NOT NULL DEFAULT false,
  context_window integer NOT NULL DEFAULT 128000 CHECK (context_window > 0),
  max_output_tokens integer NOT NULL DEFAULT 8192 CHECK (max_output_tokens > 0),
  input_cost_per_million numeric(10,4) NOT NULL DEFAULT 0.1000 CHECK (input_cost_per_million >= 0),
  output_cost_per_million numeric(10,4) NOT NULL DEFAULT 0.3000 CHECK (output_cost_per_million >= 0),
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
  routing_priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_provider_models_provider_idx ON public.gateway_provider_models(provider_id, enabled);
CREATE INDEX IF NOT EXISTS gateway_provider_models_priority_idx ON public.gateway_provider_models(routing_priority DESC);

ALTER TABLE public.gateway_provider_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_provider_models FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gateway_provider_models TO service_role;

-- Seed known providers
INSERT INTO public.gateway_providers (id, name, enabled, base_url, catalog_source)
VALUES
  ('groq', 'Groq Cloud', true, 'https://api.groq.com/openai/v1', 'discovery'),
  ('gemini', 'Google Gemini', true, 'https://generativelanguage.googleapis.com/v1beta/openai', 'discovery'),
  ('openrouter', 'OpenRouter', true, 'https://openrouter.ai/api/v1', 'discovery'),
  ('nvidia', 'NVIDIA NIM', true, 'https://integrate.api.nvidia.com/v1', 'discovery'),
  ('cloudflare', 'Cloudflare Workers AI', true, 'https://api.cloudflare.com/client/v4', 'allowlist')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  enabled = EXCLUDED.enabled,
  base_url = EXCLUDED.base_url,
  updated_at = now();

-- Seed known high-performance models
INSERT INTO public.gateway_provider_models (
  public_model_id, provider_id, provider_model_id, enabled,
  supports_streaming, supports_tools, supports_parallel_tools, supports_vision, supports_reasoning,
  context_window, max_output_tokens, input_cost_per_million, output_cost_per_million, tier, routing_priority
)
VALUES
  ('groq/openai/gpt-oss-120b', 'groq', 'openai/gpt-oss-120b', true, true, true, true, false, true, 131072, 8192, 0.15, 0.45, 'free', 120),
  ('groq/openai/gpt-oss-20b', 'groq', 'openai/gpt-oss-20b', true, true, true, true, false, false, 131072, 8192, 0.05, 0.15, 'free', 110),
  ('gemini-2.5-flash', 'gemini', 'gemini-2.5-flash', true, true, true, true, true, true, 1048576, 8192, 0.075, 0.30, 'free', 115),
  ('gemini-2.5-pro', 'gemini', 'gemini-2.5-pro', true, true, true, true, true, true, 2097152, 8192, 1.25, 5.00, 'pro', 90),
  ('nvidia/meta/llama-3.2-11b-vision-instruct', 'nvidia', 'meta/llama-3.2-11b-vision-instruct', true, true, true, true, true, false, 128000, 8192, 0.10, 0.20, 'free', 95),
  ('openrouter/cohere/north-mini-code:free', 'openrouter', 'cohere/north-mini-code:free', true, true, true, true, false, false, 128000, 8192, 0.00, 0.00, 'free', 80)
ON CONFLICT (public_model_id) DO UPDATE SET
  provider_id = EXCLUDED.provider_id,
  provider_model_id = EXCLUDED.provider_model_id,
  enabled = EXCLUDED.enabled,
  routing_priority = EXCLUDED.routing_priority,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.gateway_get_catalog(p_plan text DEFAULT 'free')
RETURNS TABLE (
  public_model_id text,
  provider_id text,
  provider_model_id text,
  supports_streaming boolean,
  supports_tools boolean,
  supports_parallel_tools boolean,
  supports_vision boolean,
  supports_reasoning boolean,
  context_window integer,
  max_output_tokens integer,
  input_cost_per_million numeric,
  output_cost_per_million numeric,
  tier text,
  routing_priority integer
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT
    m.public_model_id,
    m.provider_id,
    m.provider_model_id,
    m.supports_streaming,
    m.supports_tools,
    m.supports_parallel_tools,
    m.supports_vision,
    m.supports_reasoning,
    m.context_window,
    m.max_output_tokens,
    m.input_cost_per_million,
    m.output_cost_per_million,
    m.tier,
    m.routing_priority
  FROM public.gateway_provider_models m
  JOIN public.gateway_providers p ON m.provider_id = p.id
  WHERE m.enabled = true
    AND p.enabled = true
    AND (
      p_plan = 'pro' OR p_plan = 'ultrawork' OR m.tier = 'free'
    )
  ORDER BY m.routing_priority DESC;
$$;

REVOKE ALL ON FUNCTION public.gateway_get_catalog(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_get_catalog(text) TO service_role;

COMMIT;
