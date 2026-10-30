BEGIN;

-- OIOP offers (Open Inference Offer Protocol; docs/OIOP.md, docs/PLATFORM_CONTRACT.md section
-- 12.1). An offer is one way the gateway can reach a provider's models: a free tier, a paid
-- account, a trial or a model the operator deployed, with the terms that decide whether it may
-- serve other people. Every catalog pool belongs to one offer (src/oiop/offers.js offerIdFor).
--
-- The gateway serves an offer's operator pools only while it is active or degraded and its
-- redistribution is 'permitted' ('unknown' counts as 'byok_only'); trust tier and training on
-- inputs are filtered per caller. Nothing here is decided by fetched page text: rows change only
-- through these functions, called by operator routes (src/routes/offers.js) and, from Phase 2,
-- by the discovery analyser, which may propose facts but never move an offer past
-- pending_approval.
--
-- Lifecycle (zerox_offer_can_transition): discovered -> analysed -> pending_approval ->
-- (rejected | awaiting_credentials | awaiting_deployment) -> probing -> active <-> degraded ->
-- (suspended | retired). A new terms hash moves an offer in service to review, which is not
-- served, and review goes back through pending_approval.

CREATE TABLE public.zerox_offers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  homepage text CHECK (homepage ~ '^https://' AND char_length(homepage) <= 2048),
  logo_url text CHECK (logo_url ~ '^https://' AND char_length(logo_url) <= 2048),
  -- NULL for offers reached through a binding (Cloudflare Workers AI).
  base_url text CHECK (base_url ~ '^https://' AND char_length(base_url) <= 2048),
  protocol text NOT NULL DEFAULT 'openai-chat' CHECK (protocol IN ('openai-chat', 'anthropic-messages', 'workers-ai')),
  access_kind text NOT NULL DEFAULT 'hosted' CHECK (access_kind IN ('hosted', 'self_deploy')),
  -- operator: the gateway's own keys or deployment; user: each caller's own key (BYOK).
  owner text NOT NULL DEFAULT 'operator' CHECK (owner IN ('operator', 'user')),
  trust_tier text NOT NULL DEFAULT 'T3' CHECK (trust_tier IN ('T0', 'T1', 'T2', 'T3')),
  redistribution text NOT NULL DEFAULT 'unknown'
    CHECK (redistribution IN ('permitted', 'byok_only', 'prohibited', 'unknown')),
  trains_on_inputs text NOT NULL DEFAULT 'unknown' CHECK (trains_on_inputs IN ('no', 'yes', 'varies_by_model', 'unknown')),
  commercial_use text NOT NULL DEFAULT 'unknown' CHECK (commercial_use IN ('allowed', 'prohibited', 'unknown')),
  expires_after_days integer CHECK (expires_after_days > 0),
  terms_url text CHECK (terms_url ~ '^https://' AND char_length(terms_url) <= 2048),
  terms_sha256 text CHECK (terms_sha256 ~ '^[0-9a-f]{64}$'),
  terms_fetched_at timestamptz,
  -- [{type, detail, amount, currency, unlocks, source:{url, quote}}] (docs/OIOP.md)
  prerequisites jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(prerequisites) = 'array' AND octet_length(prerequisites::text) <= 16384),
  -- [{scope, rpm, rpd, tpm, tpd, reset_tz}]
  limits jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(limits) = 'array' AND octet_length(limits::text) <= 16384),
  -- [{field, url, quote, note, source}]: where each term above comes from.
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 65536),
  lifecycle text NOT NULL DEFAULT 'discovered' CHECK (lifecycle IN ('discovered', 'analysed', 'pending_approval',
    'rejected', 'awaiting_credentials', 'awaiting_deployment', 'probing', 'active', 'degraded', 'review',
    'suspended', 'retired')),
  lifecycle_changed_at timestamptz NOT NULL DEFAULT now(),
  verified_by text CHECK (char_length(verified_by) BETWEEN 1 AND 64),
  verified_at timestamptz,
  -- Bumped by every change to the facts above; a stored manifest is for one version only.
  manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version > 0),
  manifest jsonb CHECK (manifest IS NULL OR (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 131072)),
  signature text CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  signed_at timestamptz,
  notes text CHECK (char_length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((manifest IS NULL) = (signature IS NULL) AND (signature IS NULL) = (signed_at IS NULL))
);

CREATE INDEX zerox_offers_lifecycle_idx ON public.zerox_offers (lifecycle, provider);

-- Every change to an offer, with who made it (audit log; never updated or deleted).
CREATE TABLE public.zerox_offer_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_id text NOT NULL REFERENCES public.zerox_offers (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 64),
  action text NOT NULL CHECK (action IN ('create', 'update', 'transition', 'terms_changed', 'sign')),
  from_state text,
  to_state text,
  note text CHECK (char_length(note) <= 2000),
  detail jsonb CHECK (detail IS NULL OR octet_length(detail::text) <= 8192)
);

CREATE INDEX zerox_offer_events_offer_idx ON public.zerox_offer_events (offer_id, at DESC, id DESC);

-- Discovery candidates can name the offer they belong to (set from Phase 2 on).
ALTER TABLE public.zerox_provider_candidates
  ADD COLUMN offer_id text REFERENCES public.zerox_offers (id) ON DELETE SET NULL;

ALTER TABLE public.zerox_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_offer_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zerox_offers, public.zerox_offer_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zerox_offers, public.zerox_offer_events TO service_role;

-- ── Lifecycle ──

-- The allowed lifecycle moves (src/oiop/offers.js TRANSITIONS mirrors this list).
CREATE FUNCTION public.zerox_offer_can_transition(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_from, p_to) IN (
    ('discovered', 'analysed'), ('discovered', 'pending_approval'), ('discovered', 'rejected'),
    ('analysed', 'pending_approval'), ('analysed', 'rejected'),
    ('pending_approval', 'awaiting_credentials'), ('pending_approval', 'awaiting_deployment'),
    ('pending_approval', 'rejected'),
    ('rejected', 'pending_approval'),
    ('awaiting_credentials', 'probing'), ('awaiting_credentials', 'rejected'), ('awaiting_credentials', 'retired'),
    ('awaiting_deployment', 'probing'), ('awaiting_deployment', 'rejected'), ('awaiting_deployment', 'retired'),
    ('probing', 'active'), ('probing', 'awaiting_credentials'), ('probing', 'awaiting_deployment'),
    ('probing', 'suspended'),
    ('active', 'degraded'), ('active', 'review'), ('active', 'suspended'), ('active', 'retired'),
    ('degraded', 'active'), ('degraded', 'review'), ('degraded', 'suspended'), ('degraded', 'retired'),
    ('review', 'pending_approval'), ('review', 'suspended'), ('review', 'retired'),
    ('suspended', 'probing'), ('suspended', 'review'), ('suspended', 'retired')
  );
$$;

-- Moves an offer to p_to. Raises invalid_transition for a move the list above does not allow
-- and offer_not_found for an unknown id. Leaving pending_approval for awaiting_* is the approval:
-- it records the actor as verified_by.
CREATE FUNCTION public.zerox_offer_transition(p_id text, p_to text, p_actor text, p_note text DEFAULT NULL)
RETURNS SETOF public.zerox_offers
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_offer public.zerox_offers;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_offer: p_actor is required'; END IF;
  SELECT * INTO v_offer FROM public.zerox_offers AS o WHERE o.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  IF NOT public.zerox_offer_can_transition(v_offer.lifecycle, p_to) THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', v_offer.lifecycle, coalesce(p_to, 'null');
  END IF;
  UPDATE public.zerox_offers AS o SET lifecycle = p_to, lifecycle_changed_at = now(), updated_at = now(),
    verified_by = CASE WHEN v_offer.lifecycle = 'pending_approval' AND p_to LIKE 'awaiting_%' THEN p_actor ELSE o.verified_by END,
    verified_at = CASE WHEN v_offer.lifecycle = 'pending_approval' AND p_to LIKE 'awaiting_%' THEN now() ELSE o.verified_at END
    WHERE o.id = p_id;
  INSERT INTO public.zerox_offer_events (offer_id, actor, action, from_state, to_state, note)
    VALUES (p_id, p_actor, 'transition', v_offer.lifecycle, p_to, left(p_note, 2000));
  RETURN QUERY SELECT * FROM public.zerox_offers AS o WHERE o.id = p_id;
END;
$$;

-- ── Facts ──

-- Creates an offer or updates its facts (never its lifecycle). p_offer: {id, provider, name,
-- homepage, logo_url, base_url, protocol, access_kind, owner, trust_tier, redistribution,
-- trains_on_inputs, commercial_use, expires_after_days, terms_url, terms_sha256, terms_fetched_at,
-- prerequisites, limits, evidence, notes}; missing keys keep the stored value (new rows: the
-- column default), JSON null clears a nullable fact. A new offer starts in p_offer.lifecycle,
-- one of discovered (default), analysed or pending_approval. Any change bumps manifest_version
-- and drops the stored manifest. A terms_sha256 that differs from the stored one moves an offer
-- that is being onboarded or served (awaiting_*, probing, active, degraded, suspended) to review.
CREATE FUNCTION public.zerox_offer_upsert(p_offer jsonb, p_actor text)
RETURNS SETOF public.zerox_offers
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_id text := p_offer->>'id';
  v_old public.zerox_offers;
  v_new public.zerox_offers;
  v_start text := coalesce(p_offer->>'lifecycle', 'discovered');
  v_terms_changed boolean;
BEGIN
  IF p_offer IS NULL OR jsonb_typeof(p_offer) <> 'object' THEN RAISE EXCEPTION 'invalid_offer: p_offer must be a JSON object'; END IF;
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_offer: p_actor is required'; END IF;
  IF v_id IS NULL THEN RAISE EXCEPTION 'invalid_offer: id is required'; END IF;
  SELECT * INTO v_old FROM public.zerox_offers AS o WHERE o.id = v_id FOR UPDATE;

  IF NOT FOUND THEN
    IF v_start NOT IN ('discovered', 'analysed', 'pending_approval') THEN
      RAISE EXCEPTION 'invalid_offer: a new offer starts as discovered, analysed or pending_approval';
    END IF;
    -- jsonb_populate_record fills the columns present in p_offer; defaults apply to the rest.
    v_new := jsonb_populate_record(NULL::public.zerox_offers, p_offer);
    INSERT INTO public.zerox_offers AS o (id, provider, name, homepage, logo_url, base_url, protocol, access_kind,
      owner, trust_tier, redistribution, trains_on_inputs, commercial_use, expires_after_days, terms_url,
      terms_sha256, terms_fetched_at, prerequisites, limits, evidence, lifecycle, notes)
    VALUES (v_id, v_new.provider, v_new.name, v_new.homepage, v_new.logo_url, v_new.base_url,
      coalesce(v_new.protocol, 'openai-chat'), coalesce(v_new.access_kind, 'hosted'), coalesce(v_new.owner, 'operator'),
      coalesce(v_new.trust_tier, 'T3'), coalesce(v_new.redistribution, 'unknown'),
      coalesce(v_new.trains_on_inputs, 'unknown'), coalesce(v_new.commercial_use, 'unknown'),
      v_new.expires_after_days, v_new.terms_url, v_new.terms_sha256, v_new.terms_fetched_at,
      coalesce(v_new.prerequisites, '[]'::jsonb), coalesce(v_new.limits, '[]'::jsonb),
      coalesce(v_new.evidence, '[]'::jsonb), v_start, v_new.notes);
    INSERT INTO public.zerox_offer_events (offer_id, actor, action, to_state)
      VALUES (v_id, p_actor, 'create', v_start);
    RETURN QUERY SELECT * FROM public.zerox_offers AS o WHERE o.id = v_id;
    RETURN;
  END IF;

  -- Existing offer: start from the stored row and overlay the keys present in p_offer.
  v_new := jsonb_populate_record(v_old, p_offer - 'id' - 'lifecycle' - 'lifecycle_changed_at' - 'verified_by'
    - 'verified_at' - 'manifest_version' - 'manifest' - 'signature' - 'signed_at' - 'created_at' - 'updated_at');
  IF (v_new.provider, v_new.name, v_new.homepage, v_new.logo_url, v_new.base_url, v_new.protocol, v_new.access_kind,
      v_new.owner, v_new.trust_tier, v_new.redistribution, v_new.trains_on_inputs, v_new.commercial_use,
      v_new.expires_after_days, v_new.terms_url, v_new.terms_sha256, v_new.terms_fetched_at, v_new.prerequisites,
      v_new.limits, v_new.evidence, v_new.notes)
    IS NOT DISTINCT FROM
     (v_old.provider, v_old.name, v_old.homepage, v_old.logo_url, v_old.base_url, v_old.protocol, v_old.access_kind,
      v_old.owner, v_old.trust_tier, v_old.redistribution, v_old.trains_on_inputs, v_old.commercial_use,
      v_old.expires_after_days, v_old.terms_url, v_old.terms_sha256, v_old.terms_fetched_at, v_old.prerequisites,
      v_old.limits, v_old.evidence, v_old.notes) THEN
    RETURN QUERY SELECT * FROM public.zerox_offers AS o WHERE o.id = v_id;
    RETURN;
  END IF;

  v_terms_changed := v_old.terms_sha256 IS NOT NULL AND v_new.terms_sha256 IS DISTINCT FROM v_old.terms_sha256
    AND v_old.lifecycle IN ('awaiting_credentials', 'awaiting_deployment', 'probing', 'active', 'degraded', 'suspended');
  UPDATE public.zerox_offers AS o SET
    provider = v_new.provider, name = v_new.name, homepage = v_new.homepage, logo_url = v_new.logo_url,
    base_url = v_new.base_url, protocol = v_new.protocol, access_kind = v_new.access_kind, owner = v_new.owner,
    trust_tier = v_new.trust_tier, redistribution = v_new.redistribution, trains_on_inputs = v_new.trains_on_inputs,
    commercial_use = v_new.commercial_use, expires_after_days = v_new.expires_after_days, terms_url = v_new.terms_url,
    terms_sha256 = v_new.terms_sha256, terms_fetched_at = v_new.terms_fetched_at,
    prerequisites = coalesce(v_new.prerequisites, '[]'::jsonb), limits = coalesce(v_new.limits, '[]'::jsonb),
    evidence = coalesce(v_new.evidence, '[]'::jsonb), notes = v_new.notes,
    lifecycle = CASE WHEN v_terms_changed THEN 'review' ELSE o.lifecycle END,
    lifecycle_changed_at = CASE WHEN v_terms_changed THEN now() ELSE o.lifecycle_changed_at END,
    manifest_version = o.manifest_version + 1, manifest = NULL, signature = NULL, signed_at = NULL,
    updated_at = now()
    WHERE o.id = v_id;
  IF v_terms_changed THEN
    INSERT INTO public.zerox_offer_events (offer_id, actor, action, from_state, to_state, note, detail)
      VALUES (v_id, p_actor, 'terms_changed', v_old.lifecycle, 'review', 'Terms hash changed; paused for review',
        jsonb_build_object('old_sha256', v_old.terms_sha256, 'new_sha256', v_new.terms_sha256));
  ELSE
    INSERT INTO public.zerox_offer_events (offer_id, actor, action, detail)
      VALUES (v_id, p_actor, 'update', jsonb_build_object('manifest_version', v_old.manifest_version + 1));
  END IF;
  RETURN QUERY SELECT * FROM public.zerox_offers AS o WHERE o.id = v_id;
END;
$$;

-- Stores a signed manifest for the offer's current manifest_version (stale_manifest otherwise,
-- e.g. when the facts changed while it was being signed).
CREATE FUNCTION public.zerox_offer_store_manifest(p_id text, p_version integer, p_manifest jsonb, p_signature text,
  p_actor text)
RETURNS SETOF public.zerox_offers
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_offer public.zerox_offers;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_offer: p_actor is required'; END IF;
  SELECT * INTO v_offer FROM public.zerox_offers AS o WHERE o.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  IF v_offer.manifest_version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'stale_manifest'; END IF;
  UPDATE public.zerox_offers AS o SET manifest = p_manifest, signature = p_signature, signed_at = now()
    WHERE o.id = p_id;
  INSERT INTO public.zerox_offer_events (offer_id, actor, action, detail)
    VALUES (p_id, p_actor, 'sign', jsonb_build_object('manifest_version', p_version));
  RETURN QUERY SELECT * FROM public.zerox_offers AS o WHERE o.id = p_id;
END;
$$;

-- ── Reads ──

-- Every offer (the gateway caches this for 60 s; the admin API lists it).
CREATE FUNCTION public.zerox_offers_list()
RETURNS SETOF public.zerox_offers
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM public.zerox_offers AS o ORDER BY o.provider, o.id;
$$;

-- The newest events of one offer.
CREATE FUNCTION public.zerox_offer_events_list(p_id text, p_limit integer DEFAULT 50)
RETURNS SETOF public.zerox_offer_events
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM public.zerox_offer_events AS e WHERE e.offer_id = p_id
  ORDER BY e.at DESC, e.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION
  public.zerox_offer_can_transition(text, text),
  public.zerox_offer_transition(text, text, text, text),
  public.zerox_offer_upsert(jsonb, text),
  public.zerox_offer_store_manifest(text, integer, jsonb, text, text),
  public.zerox_offers_list(),
  public.zerox_offer_events_list(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_offer_can_transition(text, text),
  public.zerox_offer_transition(text, text, text, text),
  public.zerox_offer_upsert(jsonb, text),
  public.zerox_offer_store_manifest(text, integer, jsonb, text, text),
  public.zerox_offers_list(),
  public.zerox_offer_events_list(text, integer)
  TO service_role;

-- ── Backfill: the offers behind the code catalog (src/catalog.js), in service today ──
-- Operator decision (2026-10-24): every pool that serves today keeps serving, so these offers
-- are active with redistribution 'permitted'. Where docs/PROVIDER_TERMS.md records terms that
-- say otherwise (NVIDIA trial, OpenRouter resale), the evidence says this is an operator
-- override; the hosted flags (NVIDIA_HOSTED, OPENROUTER_HOSTED) still gate those pools.
-- src/oiop/offers.js BUILTIN_OFFERS holds the same rows for deployments without a database.

INSERT INTO public.zerox_offers (id, provider, name, homepage, logo_url, base_url, protocol, owner, trust_tier,
  redistribution, trains_on_inputs, commercial_use, terms_url, prerequisites, limits, evidence, lifecycle,
  verified_by, verified_at)
VALUES
  ('gemini.free', 'gemini', 'Google Gemini API (free tier)', 'https://ai.google.dev',
   'https://models.dev/logos/google.svg', 'https://generativelanguage.googleapis.com/v1beta/openai', 'openai-chat',
   'operator', 'T0', 'permitted', 'yes', 'allowed', 'https://ai.google.dev/gemini-api/terms',
   '[{"type": "account", "detail": "Google account and an AI Studio API key"}]',
   '[{"scope": "model", "rpm": 5, "rpd": 250, "tpm": 120000, "tpd": 5000000, "reset_tz": "America/Los_Angeles"}]',
   '[{"field": "trains_on_inputs", "source": "operator", "url": "https://ai.google.dev/gemini-api/terms", "note": "docs/PROVIDER_TERMS.md: free-tier prompts may train and be human-reviewed"},
     {"field": "redistribution", "source": "operator", "url": "https://ai.google.dev/gemini-api/terms", "note": "docs/PROVIDER_TERMS.md: allowed for API clients; paid services only for users in the EEA, UK and CH (the free pool is geo-blocked there)"}]',
   'active', 'operator', now()),
  ('gemini.paid', 'gemini', 'Google Gemini API (paid)', 'https://ai.google.dev',
   'https://models.dev/logos/google.svg', 'https://generativelanguage.googleapis.com/v1beta/openai', 'openai-chat',
   'operator', 'T0', 'permitted', 'no', 'allowed', 'https://ai.google.dev/gemini-api/terms',
   '[{"type": "billing", "detail": "Cloud Billing linked project"}]', '[]',
   '[{"field": "trains_on_inputs", "source": "operator", "url": "https://ai.google.dev/gemini-api/terms", "note": "Paid Services prompts are not used to improve Google products"}]',
   'active', 'operator', now()),
  ('groq.free', 'groq', 'GroqCloud (free tier)', 'https://groq.com',
   'https://models.dev/logos/groq.svg', 'https://api.groq.com/openai/v1', 'openai-chat',
   'operator', 'T1', 'permitted', 'unknown', 'allowed', 'https://console.groq.com/docs/legal/services-agreement',
   '[{"type": "account", "detail": "GroqCloud organization and API key"}]',
   '[{"scope": "model", "rpm": 30, "rpd": 1000, "tpm": 8000, "tpd": 200000}]',
   '[{"field": "redistribution", "source": "operator", "url": "https://console.groq.com/docs/legal/services-agreement", "note": "docs/PROVIDER_TERMS.md: Services Agreement §3.1 allows End Users via Customer Applications; §6.3(c) bars resale without approval"}]',
   'active', 'operator', now()),
  ('groq.paid', 'groq', 'GroqCloud (Developer plan)', 'https://groq.com',
   'https://models.dev/logos/groq.svg', 'https://api.groq.com/openai/v1', 'openai-chat',
   'operator', 'T1', 'permitted', 'unknown', 'allowed', 'https://console.groq.com/docs/legal/services-agreement',
   '[{"type": "billing", "detail": "Developer plan"}]', '[]', '[]', 'active', 'operator', now()),
  ('cloudflare.free', 'cloudflare', 'Cloudflare Workers AI (free allocation)', 'https://developers.cloudflare.com/workers-ai/',
   'https://models.dev/logos/cloudflare-workers-ai.svg', NULL, 'workers-ai',
   'operator', 'T1', 'permitted', 'no', 'allowed', 'https://www.cloudflare.com/service-specific-terms-developer-platform/',
   '[{"type": "account", "detail": "Cloudflare account with the Workers AI binding"}]',
   '[{"scope": "account", "neurons_per_day": 10000, "reset_tz": "UTC"}]',
   '[{"field": "trains_on_inputs", "source": "operator", "url": "https://developers.cloudflare.com/workers-ai/platform/pricing", "note": "docs/PROVIDER_TERMS.md: no training on customer content"}]',
   'active', 'operator', now()),
  ('cloudflare.paid', 'cloudflare', 'Cloudflare Workers AI (Workers Paid)', 'https://developers.cloudflare.com/workers-ai/',
   'https://models.dev/logos/cloudflare-workers-ai.svg', NULL, 'workers-ai',
   'operator', 'T1', 'permitted', 'no', 'allowed', 'https://www.cloudflare.com/service-specific-terms-developer-platform/',
   '[{"type": "billing", "detail": "Workers Paid plan"}]', '[]', '[]', 'active', 'operator', now()),
  ('nvidia.free', 'nvidia', 'NVIDIA API Catalog (trial)', 'https://build.nvidia.com',
   'https://models.dev/logos/nvidia.svg', 'https://integrate.api.nvidia.com/v1', 'openai-chat',
   'operator', 'T1', 'permitted', 'unknown', 'prohibited',
   'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf',
   '[{"type": "account", "detail": "NVIDIA developer account and an API catalog key"}]',
   '[{"scope": "key", "rpm": 40, "rpd": 10000}]',
   '[{"field": "redistribution", "source": "operator", "note": "Operator override (2026-10-24) to keep the alpha catalog serving. docs/PROVIDER_TERMS.md records Trial Terms §1.2/§1.4 (trial and internal evaluation only) and §4.2 (no making Generated Content available to others). Served only with NVIDIA_HOSTED=true."}]',
   'active', 'operator', now()),
  ('openrouter.free', 'openrouter', 'OpenRouter (free models)', 'https://openrouter.ai',
   'https://models.dev/logos/openrouter.svg', 'https://openrouter.ai/api/v1', 'openai-chat',
   'operator', 'T1', 'permitted', 'no', 'allowed', 'https://openrouter.ai/terms',
   '[{"type": "account", "detail": "OpenRouter account and API key"},
     {"type": "wallet_balance", "amount": 10, "currency": "USD", "unlocks": "1,000 free-model requests per day instead of 50", "source": {"url": "https://openrouter.ai/docs/api-reference/limits"}}]',
   '[{"scope": "account", "rpm": 20, "rpd": 50}]',
   '[{"field": "redistribution", "source": "operator", "url": "https://openrouter.ai/terms", "note": "Operator override (2026-10-24) to keep the alpha catalog serving. docs/PROVIDER_TERMS.md records Terms §7.4 (no reselling API access to Models). Served only with OPENROUTER_HOSTED=true."},
     {"field": "trains_on_inputs", "source": "operator", "note": "The gateway sends provider.data_collection deny on every OpenRouter request (src/provider-adapter.js)"}]',
   'active', 'operator', now()),
  ('openrouter.byok', 'openrouter', 'OpenRouter (your own key)', 'https://openrouter.ai',
   'https://models.dev/logos/openrouter.svg', 'https://openrouter.ai/api/v1', 'openai-chat',
   'user', 'T1', 'byok_only', 'no', 'allowed', 'https://openrouter.ai/terms',
   '[{"type": "account", "detail": "The caller''s own OpenRouter account, connected with OAuth"}]', '[]',
   '[{"field": "trains_on_inputs", "source": "operator", "note": "The gateway sends provider.data_collection deny on every OpenRouter request (src/provider-adapter.js)"}]',
   'active', 'operator', now()),
  ('zai.free', 'zai', 'Z.ai API (free GLM Flash models)', 'https://z.ai',
   'https://models.dev/logos/zai.svg', 'https://api.z.ai/api/paas/v4', 'openai-chat',
   'operator', 'T0', 'permitted', 'no', 'allowed', 'https://docs.z.ai/legal-agreement/terms-of-use',
   '[{"type": "account", "detail": "Z.ai account and an API key"}]', '[]',
   '[{"field": "redistribution", "source": "operator", "url": "https://docs.z.ai/legal-agreement/terms-of-use", "note": "docs/PROVIDER_TERMS.md: the API terms allow integrating the service into applications for your own end users"},
     {"field": "trains_on_inputs", "source": "operator", "url": "https://docs.z.ai/legal-agreement/terms-of-use", "note": "docs/PROVIDER_TERMS.md: API content is not used for training by default; processing in Singapore"}]',
   'active', 'operator', now());

INSERT INTO public.zerox_offer_events (offer_id, actor, action, to_state, note)
SELECT o.id, 'migration', 'create', 'active',
  'Backfilled from the code catalog (2026-10-24); redistribution permitted by operator decision so existing pools keep serving'
FROM public.zerox_offers AS o;

NOTIFY pgrst, 'reload schema';

COMMIT;
