BEGIN;

-- Data-driven model catalog (docs/PLATFORM_CONTRACT.md section 2; src/catalog-db.js,
-- src/catalog-guardrails.js, src/catalog-types.js, src/routes/catalog-admin.js).
--
-- Model rows live here; provider types, base URLs, key slots, list prices, spend ceilings and the
-- markup stay in reviewed code. A row names a provider type and a key slot id, never a URL or an
-- environment variable, and the gateway checks every row against the code guardrails before it
-- serves (a failing pool is dropped, a failing model falls back to its code entry).
--
-- Lifecycle: a model starts as a draft with a pending revision; an operator approves the pending
-- revision on /admin/models (GATEWAY_ADMIN_TOKEN plus Cloudflare Access), which makes it the
-- active revision and the model active. Disabled models are not served (their code entry is
-- hidden too); models are never deleted. Revisions and their pools are immutable once written;
-- only the decision (approved_by/at or rejected_by/at) is set, once. A model can only point at an
-- approved revision (trigger). Every change to a model writes a row to the append-only audit log
-- zerox_catalog_events (trigger): the catalog functions label it with the operator and action,
-- and a change made any other way is still logged, as action 'direct'.
--
-- Money: upstream micro-USD per million tokens; daily spend caps in upstream micro-USD per UTC
-- day. No markup is stored or applied here (src/pricing.js MARKUP). The caps are enforced at
-- reservation time by zerox_reserve_v2 (p_pool.cpd).

-- ── Mirrors of code (src/catalog-types.js); check-catalog-db.mjs keeps them equal ──

CREATE FUNCTION public.zerox_catalog_provider_types()
RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['gemini', 'groq', 'nvidia', 'openrouter', 'omniroute', 'cloudflare', 'anthropic']::text[];
$$;

-- The public model id of an upstream id (PROVIDER_TYPES[type].id_prefix + upstream).
CREATE FUNCTION public.zerox_catalog_public_id(p_type text, p_upstream text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_type
    WHEN 'gemini' THEN 'gemini/' || p_upstream
    WHEN 'groq' THEN 'groq/' || p_upstream
    WHEN 'nvidia' THEN 'nvidia/' || p_upstream
    WHEN 'omniroute' THEN 'omniroute/' || p_upstream
    WHEN 'anthropic' THEN 'anthropic/' || p_upstream
    WHEN 'cloudflare' THEN p_upstream
    WHEN 'openrouter' THEN p_upstream
  END;
$$;

-- The upstream id grammar per provider type (PROVIDER_TYPES[type].upstream).
CREATE FUNCTION public.zerox_catalog_upstream_ok(p_type text, p_upstream text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(p_upstream IS NOT NULL AND char_length(p_upstream) <= 200 AND position('..' IN p_upstream) = 0 AND CASE p_type
    WHEN 'gemini' THEN p_upstream ~ '^gemini-[a-z0-9][a-z0-9.-]{0,60}$'
    WHEN 'groq' THEN p_upstream ~ '^([a-z0-9][a-z0-9._-]{0,40}/)?[a-z0-9][a-z0-9._-]{0,80}$'
    WHEN 'nvidia' THEN p_upstream ~ '^[a-z0-9][a-z0-9._-]{0,40}/[a-z0-9][a-z0-9._-]{0,80}$'
    WHEN 'openrouter' THEN p_upstream ~ '^[a-z0-9][a-z0-9._-]{0,40}/[a-z0-9][a-z0-9._-]{0,80}:free$'
    WHEN 'omniroute' THEN p_upstream ~ '^[a-z0-9][a-z0-9._:/-]{0,120}$'
    WHEN 'cloudflare' THEN p_upstream ~ '^@cf/[a-z0-9][a-z0-9_-]{0,40}/[a-z0-9][a-z0-9._-]{0,80}$'
    WHEN 'anthropic' THEN p_upstream ~ '^claude-[a-z0-9][a-z0-9-]{0,60}$'
    ELSE false
  END, false);
$$;

-- Key slots allowed per provider type and tier (PROVIDER_TYPES[type].slots).
CREATE FUNCTION public.zerox_catalog_slot_ok(p_type text, p_tier text, p_slot text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce((p_type, p_tier, p_slot) IN (
    ('gemini', 'free', 'gemini.free'), ('gemini', 'paid', 'gemini.paid'),
    ('groq', 'free', 'groq.free'), ('groq', 'paid', 'groq.paid'),
    ('nvidia', 'free', 'nvidia.free'),
    ('openrouter', 'free', 'openrouter.free'),
    ('omniroute', 'free', 'omniroute.free'),
    ('cloudflare', 'free', 'cloudflare.binding'), ('cloudflare', 'paid', 'cloudflare.binding'),
    ('anthropic', 'paid', 'anthropic.paid')
  ), false);
$$;

-- Highest daily spend cap of a paid pool, upstream micro-USD (catalog-types.js typeMaxCapMicrousd:
-- min(type maximum, MAX_DAILY_SPEND_CAP_USD $100)); 0 for types without paid pools.
CREATE FUNCTION public.zerox_catalog_type_max_cap_microusd(p_type text)
RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_type
    WHEN 'anthropic' THEN 50000000::bigint
    WHEN 'gemini' THEN 100000000::bigint
    WHEN 'groq' THEN 100000000::bigint
    WHEN 'cloudflare' THEN 100000000::bigint
    ELSE 0::bigint
  END;
$$;

-- Allowed lifecycle actions per model status (catalog-types.js CATALOG_ACTIONS).
CREATE FUNCTION public.zerox_catalog_can(p_status text, p_action text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce((p_status, p_action) IN (
    ('draft', 'propose'), ('active', 'propose'), ('disabled', 'propose'),
    ('draft', 'approve'), ('active', 'approve'), ('disabled', 'approve'),
    ('draft', 'reject'), ('active', 'reject'), ('disabled', 'reject'),
    ('draft', 'disable'), ('active', 'disable'), ('disabled', 'enable')
  ), false);
$$;

CREATE FUNCTION public.zerox_catalog_aliases_ok(p_aliases text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(cardinality(p_aliases) <= 8 AND NOT EXISTS (
    SELECT 1 FROM unnest(p_aliases) AS a(alias)
    WHERE a.alias IS NULL OR a.alias !~ '^[a-z0-9][a-z0-9./:_-]{0,99}$' OR a.alias IN ('auto', 'default')), false);
$$;

CREATE FUNCTION public.zerox_catalog_geo_ok(p_codes text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(cardinality(p_codes) <= 64 AND NOT EXISTS (
    SELECT 1 FROM unnest(p_codes) AS g(code) WHERE g.code IS NULL OR g.code !~ '^(EEA|[A-Z]{2})$'), false);
$$;

CREATE FUNCTION public.zerox_catalog_efforts_ok(p_efforts text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(cardinality(p_efforts) <= 6
    AND p_efforts <@ ARRAY['none', 'minimal', 'low', 'medium', 'high', 'default']::text[]
    AND cardinality(p_efforts) = (SELECT count(DISTINCT e.effort) FROM unnest(p_efforts) AS e(effort)), false);
$$;

-- ── Tables ──

-- Model identity and lifecycle. Never deleted (trigger): disabled instead.
CREATE TABLE public.zerox_catalog_models (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9@][a-z0-9@./:_-]{0,199}$' AND position('..' IN id) = 0),
  provider_type text NOT NULL CHECK (provider_type = ANY (public.zerox_catalog_provider_types())),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled')),
  active_revision_id bigint,
  pending_revision_id bigint,
  source text NOT NULL DEFAULT 'operator' CHECK (source IN ('seed', 'operator', 'discovery')),
  candidate_id bigint UNIQUE REFERENCES public.zerox_provider_candidates (id) ON DELETE SET NULL,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR active_revision_id IS NOT NULL),
  CHECK (status <> 'draft' OR active_revision_id IS NULL),
  CHECK (active_revision_id IS NULL OR pending_revision_id IS NULL OR active_revision_id <> pending_revision_id)
);

-- One immutable row per proposed change; the decision columns are set once.
CREATE TABLE public.zerox_catalog_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id text NOT NULL REFERENCES public.zerox_catalog_models (id),
  revision integer NOT NULL CHECK (revision > 0),
  upstream_model text NOT NULL CHECK (char_length(upstream_model) BETWEEN 1 AND 200
    AND position('..' IN upstream_model) = 0 AND upstream_model ~ '^[a-z0-9@][a-z0-9@._:/-]*$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]<>]'),
  context_window integer NOT NULL CHECK (context_window BETWEEN 1024 AND 10000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 1000000),
  default_max_tokens integer CHECK (default_max_tokens >= 256),
  supports_tools boolean NOT NULL DEFAULT true,
  supports_vision boolean NOT NULL DEFAULT false,
  reasoning_efforts text[] NOT NULL DEFAULT '{}' CHECK (public.zerox_catalog_efforts_ok(reasoning_efforts)),
  reasoning_effort_map jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(reasoning_effort_map) = 'object' AND octet_length(reasoning_effort_map::text) <= 512),
  default_reasoning_effort text CHECK (default_reasoning_effort IS NULL OR default_reasoning_effort = ANY (reasoning_efforts)),
  aliases text[] NOT NULL DEFAULT '{}' CHECK (public.zerox_catalog_aliases_ok(aliases)),
  geo_block_free text[] NOT NULL DEFAULT '{}' CHECK (public.zerox_catalog_geo_ok(geo_block_free)),
  auto_rank integer CHECK (auto_rank BETWEEN 1 AND 1000),
  position integer NOT NULL DEFAULT 1000 CHECK (position BETWEEN 0 AND 100000),
  default_enabled boolean NOT NULL DEFAULT true,
  author text NOT NULL CHECK (char_length(author) BETWEEN 1 AND 64),
  note text CHECK (char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text CHECK (char_length(approved_by) BETWEEN 1 AND 64),
  approved_at timestamptz,
  rejected_by text CHECK (char_length(rejected_by) BETWEEN 1 AND 64),
  rejected_at timestamptz,
  UNIQUE (model_id, revision),
  CHECK (max_output_tokens <= context_window),
  CHECK (default_max_tokens IS NULL OR default_max_tokens <= max_output_tokens),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((rejected_by IS NULL) = (rejected_at IS NULL)),
  CHECK (approved_at IS NULL OR rejected_at IS NULL)
);

CREATE INDEX zerox_catalog_revisions_model_idx ON public.zerox_catalog_revisions (model_id, revision DESC);

-- Pools of a revision, at most one per tier. Prices: upstream micro-USD per million tokens.
CREATE TABLE public.zerox_catalog_revision_pools (
  revision_id bigint NOT NULL REFERENCES public.zerox_catalog_revisions (id),
  tier text NOT NULL CHECK (tier IN ('free', 'paid')),
  key_slot text NOT NULL CHECK (key_slot ~ '^[a-z0-9]+\.[a-z0-9_]+$'),
  input_microusd_per_mtok bigint CHECK (input_microusd_per_mtok BETWEEN 0 AND 1000000000),
  output_microusd_per_mtok bigint CHECK (output_microusd_per_mtok BETWEEN 0 AND 1000000000),
  cache_read_microusd_per_mtok bigint CHECK (cache_read_microusd_per_mtok BETWEEN 0 AND 1000000000),
  cache_write_microusd_per_mtok bigint CHECK (cache_write_microusd_per_mtok BETWEEN 0 AND 1000000000),
  cache_write_1h_microusd_per_mtok bigint CHECK (cache_write_1h_microusd_per_mtok BETWEEN 0 AND 1000000000),
  long_context_threshold integer CHECK (long_context_threshold BETWEEN 1024 AND 10000000),
  long_input_microusd_per_mtok bigint CHECK (long_input_microusd_per_mtok BETWEEN 1 AND 1000000000),
  long_output_microusd_per_mtok bigint CHECK (long_output_microusd_per_mtok BETWEEN 1 AND 1000000000),
  rpm integer CHECK (rpm >= 0),
  rpd integer CHECK (rpd >= 0),
  tpm integer CHECK (tpm >= 0),
  tpd bigint CHECK (tpd >= 0),
  -- Upstream micro-USD per UTC day; never above the code maximum ($100, zerox_catalog_pools_guard
  -- applies the provider type's lower maximum).
  daily_spend_cap_microusd bigint CHECK (daily_spend_cap_microusd BETWEEN 1 AND 100000000),
  PRIMARY KEY (revision_id, tier),
  CHECK (tier = 'paid' OR (input_microusd_per_mtok IS NULL AND output_microusd_per_mtok IS NULL
    AND cache_read_microusd_per_mtok IS NULL AND cache_write_microusd_per_mtok IS NULL
    AND cache_write_1h_microusd_per_mtok IS NULL AND long_context_threshold IS NULL AND daily_spend_cap_microusd IS NULL)),
  CHECK (tier = 'free' OR (input_microusd_per_mtok > 0 AND output_microusd_per_mtok > 0 AND daily_spend_cap_microusd IS NOT NULL)),
  CHECK ((long_context_threshold IS NULL) = (long_input_microusd_per_mtok IS NULL)
    AND (long_input_microusd_per_mtok IS NULL) = (long_output_microusd_per_mtok IS NULL))
);

ALTER TABLE public.zerox_catalog_models
  ADD CONSTRAINT zerox_catalog_models_active_fk FOREIGN KEY (active_revision_id) REFERENCES public.zerox_catalog_revisions (id),
  ADD CONSTRAINT zerox_catalog_models_pending_fk FOREIGN KEY (pending_revision_id) REFERENCES public.zerox_catalog_revisions (id);

-- Audit log (same shape as zerox_offer_events): every change to a model, with who made it.
CREATE TABLE public.zerox_catalog_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id text NOT NULL REFERENCES public.zerox_catalog_models (id),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 64),
  action text NOT NULL CHECK (action IN ('seed', 'import', 'propose', 'approve', 'reject', 'disable', 'enable', 'direct')),
  from_status text,
  to_status text,
  revision_id bigint REFERENCES public.zerox_catalog_revisions (id),
  note text CHECK (char_length(note) <= 2000),
  detail jsonb CHECK (detail IS NULL OR octet_length(detail::text) <= 16384)
);

CREATE INDEX zerox_catalog_events_model_idx ON public.zerox_catalog_events (model_id, at DESC, id DESC);
CREATE INDEX zerox_catalog_events_at_idx ON public.zerox_catalog_events (at DESC, id DESC);

-- ── Guards and audit (triggers) ──

-- Labels the audit rows the triggers write for the rest of this transaction (the catalog
-- functions call it; a change made without it is logged as 'direct').
CREATE FUNCTION public.zerox_catalog_context(p_actor text, p_action text, p_note text DEFAULT NULL,
  p_detail jsonb DEFAULT NULL, p_revision_id bigint DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_detail jsonb := p_detail;
BEGIN
  IF v_detail IS NOT NULL AND octet_length(v_detail::text) > 16000 THEN
    v_detail := jsonb_build_object('truncated', true, 'bytes', octet_length(p_detail::text));
  END IF;
  PERFORM set_config('zerox.catalog_actor', left(coalesce(p_actor, ''), 64), true),
    set_config('zerox.catalog_action', coalesce(p_action, ''), true),
    set_config('zerox.catalog_note', left(coalesce(p_note, ''), 2000), true),
    set_config('zerox.catalog_detail', coalesce(v_detail::text, ''), true),
    set_config('zerox.catalog_revision', coalesce(p_revision_id::text, ''), true);
END;
$$;

CREATE FUNCTION public.zerox_catalog_models_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_rev public.zerox_catalog_revisions;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog_immutable: catalog models are disabled, never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'catalog_immutable: a model keeps its id and provider type';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_changed_at := now(); END IF;
    NEW.updated_at := now();
  END IF;
  -- A model only ever serves an approved revision of its own.
  IF NEW.active_revision_id IS NOT NULL THEN
    SELECT * INTO v_rev FROM public.zerox_catalog_revisions AS r WHERE r.id = NEW.active_revision_id;
    IF NOT FOUND OR v_rev.model_id <> NEW.id THEN
      RAISE EXCEPTION 'invalid_catalog: the active revision belongs to another model';
    END IF;
    IF v_rev.approved_at IS NULL OR v_rev.approved_by IS NULL OR v_rev.rejected_at IS NOT NULL THEN
      RAISE EXCEPTION 'catalog_unapproved: revision % has no approver', NEW.active_revision_id;
    END IF;
  END IF;
  IF NEW.pending_revision_id IS NOT NULL THEN
    SELECT * INTO v_rev FROM public.zerox_catalog_revisions AS r WHERE r.id = NEW.pending_revision_id;
    IF NOT FOUND OR v_rev.model_id <> NEW.id THEN
      RAISE EXCEPTION 'invalid_catalog: the pending revision belongs to another model';
    END IF;
    IF v_rev.approved_at IS NOT NULL OR v_rev.rejected_at IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_catalog: a pending revision is one nobody decided on yet';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.zerox_catalog_models_audit()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_action text := nullif(current_setting('zerox.catalog_action', true), '');
  v_actor text := coalesce(nullif(current_setting('zerox.catalog_actor', true), ''), left('sql:' || session_user, 64));
  v_note text := nullif(current_setting('zerox.catalog_note', true), '');
  v_detail jsonb := nullif(current_setting('zerox.catalog_detail', true), '')::jsonb;
  v_revision bigint := nullif(current_setting('zerox.catalog_revision', true), '')::bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Inside a catalog function the insert is followed by the update that logs it.
    IF v_action IS NULL THEN
      INSERT INTO public.zerox_catalog_events (model_id, actor, action, to_status, revision_id, note)
        VALUES (NEW.id, v_actor, 'direct', NEW.status, coalesce(NEW.active_revision_id, NEW.pending_revision_id),
          'Model row inserted outside the catalog functions');
    END IF;
    RETURN NULL;
  END IF;
  IF (NEW.status, NEW.active_revision_id, NEW.pending_revision_id)
      IS DISTINCT FROM (OLD.status, OLD.active_revision_id, OLD.pending_revision_id) THEN
    INSERT INTO public.zerox_catalog_events (model_id, actor, action, from_status, to_status, revision_id, note, detail)
      VALUES (NEW.id, v_actor, coalesce(v_action, 'direct'), OLD.status, NEW.status,
        coalesce(v_revision, NEW.pending_revision_id, NEW.active_revision_id),
        CASE WHEN v_action IS NULL THEN coalesce(v_note, 'Model row changed outside the catalog functions') ELSE v_note END,
        v_detail);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.zerox_catalog_revisions_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_type text;
  v_decision text[] := ARRAY['approved_by', 'approved_at', 'rejected_by', 'rejected_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog_immutable: revisions are kept forever';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL OR NEW.rejected_at IS NOT NULL OR NEW.rejected_by IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_catalog: a revision starts undecided';
    END IF;
    SELECT m.provider_type INTO v_type FROM public.zerox_catalog_models AS m WHERE m.id = NEW.model_id;
    IF NOT public.zerox_catalog_upstream_ok(v_type, NEW.upstream_model) THEN
      RAISE EXCEPTION 'invalid_catalog: upstream_model is not a valid % model id', coalesce(v_type, 'unknown');
    END IF;
    IF public.zerox_catalog_public_id(v_type, NEW.upstream_model) IS DISTINCT FROM NEW.model_id THEN
      RAISE EXCEPTION 'invalid_catalog: the model id must be the public id of its upstream model';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - v_decision) IS DISTINCT FROM (to_jsonb(OLD) - v_decision) THEN
    RAISE EXCEPTION 'catalog_immutable: a revision never changes; propose a new one';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'catalog_immutable: an approval is final';
  END IF;
  IF OLD.rejected_at IS NOT NULL AND (NEW.rejected_by, NEW.rejected_at) IS DISTINCT FROM (OLD.rejected_by, OLD.rejected_at) THEN
    RAISE EXCEPTION 'catalog_immutable: a rejection is final';
  END IF;
  IF NEW.approved_at IS NOT NULL AND OLD.approved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.zerox_catalog_revision_pools AS p WHERE p.revision_id = NEW.id) THEN
    RAISE EXCEPTION 'invalid_catalog: a revision without pools cannot be approved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.zerox_catalog_revisions_audit()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF nullif(current_setting('zerox.catalog_action', true), '') IS NULL
      AND (NEW.approved_at, NEW.rejected_at) IS DISTINCT FROM (OLD.approved_at, OLD.rejected_at) THEN
    INSERT INTO public.zerox_catalog_events (model_id, actor, action, revision_id, note)
      VALUES (NEW.model_id, left('sql:' || session_user, 64), 'direct', NEW.id,
        CASE WHEN NEW.approved_at IS NOT NULL THEN 'Revision approved outside the catalog functions'
          ELSE 'Revision rejected outside the catalog functions' END);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.zerox_catalog_pools_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_type text;
  v_decided boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'catalog_immutable: revision pools never change';
  END IF;
  SELECT m.provider_type, (r.approved_at IS NOT NULL OR r.rejected_at IS NOT NULL) INTO v_type, v_decided
    FROM public.zerox_catalog_revisions AS r JOIN public.zerox_catalog_models AS m ON m.id = r.model_id
    WHERE r.id = NEW.revision_id;
  IF v_decided THEN
    RAISE EXCEPTION 'catalog_immutable: a decided revision keeps its pools';
  END IF;
  IF NOT public.zerox_catalog_slot_ok(v_type, NEW.tier, NEW.key_slot) THEN
    RAISE EXCEPTION 'invalid_catalog: key slot % is not allowed for % % pools', NEW.key_slot, coalesce(v_type, 'unknown'), NEW.tier;
  END IF;
  IF NEW.daily_spend_cap_microusd > public.zerox_catalog_type_max_cap_microusd(v_type) THEN
    RAISE EXCEPTION 'invalid_catalog: the daily spend cap is above the % maximum', v_type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.zerox_catalog_append_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'catalog_immutable: % is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER zerox_catalog_models_guard BEFORE INSERT OR UPDATE OR DELETE ON public.zerox_catalog_models
  FOR EACH ROW EXECUTE FUNCTION public.zerox_catalog_models_guard();
CREATE TRIGGER zerox_catalog_models_audit AFTER INSERT OR UPDATE ON public.zerox_catalog_models
  FOR EACH ROW EXECUTE FUNCTION public.zerox_catalog_models_audit();
CREATE TRIGGER zerox_catalog_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.zerox_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION public.zerox_catalog_revisions_guard();
CREATE TRIGGER zerox_catalog_revisions_audit AFTER UPDATE ON public.zerox_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION public.zerox_catalog_revisions_audit();
CREATE TRIGGER zerox_catalog_pools_guard BEFORE INSERT OR UPDATE OR DELETE ON public.zerox_catalog_revision_pools
  FOR EACH ROW EXECUTE FUNCTION public.zerox_catalog_pools_guard();
CREATE TRIGGER zerox_catalog_events_append_only BEFORE UPDATE OR DELETE ON public.zerox_catalog_events
  FOR EACH ROW EXECUTE FUNCTION public.zerox_catalog_append_only();
CREATE TRIGGER zerox_catalog_models_no_truncate BEFORE TRUNCATE ON public.zerox_catalog_models
  FOR EACH STATEMENT EXECUTE FUNCTION public.zerox_catalog_append_only();
CREATE TRIGGER zerox_catalog_revisions_no_truncate BEFORE TRUNCATE ON public.zerox_catalog_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.zerox_catalog_append_only();
CREATE TRIGGER zerox_catalog_pools_no_truncate BEFORE TRUNCATE ON public.zerox_catalog_revision_pools
  FOR EACH STATEMENT EXECUTE FUNCTION public.zerox_catalog_append_only();
CREATE TRIGGER zerox_catalog_events_no_truncate BEFORE TRUNCATE ON public.zerox_catalog_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.zerox_catalog_append_only();

ALTER TABLE public.zerox_catalog_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_catalog_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_catalog_revision_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_catalog_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zerox_catalog_models, public.zerox_catalog_revisions, public.zerox_catalog_revision_pools,
  public.zerox_catalog_events FROM PUBLIC, anon, authenticated;
-- The same grants as every other service_role table; the triggers above refuse every delete
-- (models are disabled, revisions and the audit log are kept).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zerox_catalog_models, public.zerox_catalog_revisions,
  public.zerox_catalog_revision_pools, public.zerox_catalog_events TO service_role;

-- ── Writes ──

-- Inserts revision max+1 of p_model_id with its pools from a spec (src/catalog-guardrails.js shape:
-- upstream micro-USD, pools [{tier, key_slot, price:{input, output, cache_read, cache_write,
-- cache_write_1h, long:{threshold, input, output}}, limits:{rpm, rpd, tpm, tpd},
-- daily_spend_cap_microusd}]). Undecided; nothing points at it yet. Returns the revision id.
CREATE FUNCTION public.zerox_catalog_insert_revision(p_model_id text, p_spec jsonb, p_author text, p_note text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_id bigint;
  v_revision integer;
  v_pool jsonb;
  v_tiers text[] := '{}';
  v_key text;
BEGIN
  IF p_spec IS NULL OR jsonb_typeof(p_spec) <> 'object' THEN
    RAISE EXCEPTION 'invalid_catalog: the spec must be a JSON object';
  END IF;
  IF jsonb_typeof(p_spec -> 'pools') IS DISTINCT FROM 'array' OR jsonb_array_length(p_spec -> 'pools') NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'invalid_catalog: a model has one or two pools';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['reasoning_efforts', 'aliases', 'geo_block_free'] LOOP
    IF p_spec ? v_key AND jsonb_typeof(p_spec -> v_key) <> 'array' THEN
      RAISE EXCEPTION 'invalid_catalog: % must be an array', v_key;
    END IF;
  END LOOP;
  IF p_spec ? 'reasoning_effort_map' AND jsonb_typeof(p_spec -> 'reasoning_effort_map') <> 'object' THEN
    RAISE EXCEPTION 'invalid_catalog: reasoning_effort_map must be an object';
  END IF;
  SELECT coalesce(max(r.revision), 0) + 1 INTO v_revision FROM public.zerox_catalog_revisions AS r WHERE r.model_id = p_model_id;
  INSERT INTO public.zerox_catalog_revisions (model_id, revision, upstream_model, display_name, context_window,
    max_output_tokens, default_max_tokens, supports_tools, supports_vision, reasoning_efforts, reasoning_effort_map,
    default_reasoning_effort, aliases, geo_block_free, auto_rank, position, default_enabled, author, note)
  VALUES (p_model_id, v_revision, p_spec ->> 'upstream_model', p_spec ->> 'display_name',
    (p_spec ->> 'context_window')::integer, (p_spec ->> 'max_output_tokens')::integer,
    (p_spec ->> 'default_max_tokens')::integer, coalesce((p_spec ->> 'supports_tools')::boolean, true),
    coalesce((p_spec ->> 'supports_vision')::boolean, false),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_spec -> 'reasoning_efforts', '[]'::jsonb))),
    coalesce(p_spec -> 'reasoning_effort_map', '{}'::jsonb), p_spec ->> 'default_reasoning_effort',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_spec -> 'aliases', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_spec -> 'geo_block_free', '[]'::jsonb))),
    (p_spec ->> 'auto_rank')::integer, coalesce((p_spec ->> 'position')::integer, 1000),
    coalesce((p_spec ->> 'default_enabled')::boolean, true), left(p_author, 64), left(p_note, 2000))
  RETURNING id INTO v_id;
  FOR v_pool IN SELECT value FROM jsonb_array_elements(p_spec -> 'pools') LOOP
    IF jsonb_typeof(v_pool) <> 'object' THEN RAISE EXCEPTION 'invalid_catalog: a pool must be a JSON object'; END IF;
    IF (v_pool ->> 'tier') = ANY (v_tiers) THEN RAISE EXCEPTION 'invalid_catalog: one pool per tier'; END IF;
    v_tiers := v_tiers || (v_pool ->> 'tier');
    INSERT INTO public.zerox_catalog_revision_pools (revision_id, tier, key_slot, input_microusd_per_mtok,
      output_microusd_per_mtok, cache_read_microusd_per_mtok, cache_write_microusd_per_mtok,
      cache_write_1h_microusd_per_mtok, long_context_threshold, long_input_microusd_per_mtok,
      long_output_microusd_per_mtok, rpm, rpd, tpm, tpd, daily_spend_cap_microusd)
    VALUES (v_id, v_pool ->> 'tier', v_pool ->> 'key_slot', (v_pool #>> '{price,input}')::bigint,
      (v_pool #>> '{price,output}')::bigint, (v_pool #>> '{price,cache_read}')::bigint,
      (v_pool #>> '{price,cache_write}')::bigint, (v_pool #>> '{price,cache_write_1h}')::bigint,
      (v_pool #>> '{price,long,threshold}')::integer, (v_pool #>> '{price,long,input}')::bigint,
      (v_pool #>> '{price,long,output}')::bigint, (v_pool #>> '{limits,rpm}')::integer,
      (v_pool #>> '{limits,rpd}')::integer, (v_pool #>> '{limits,tpm}')::integer, (v_pool #>> '{limits,tpd}')::bigint,
      (v_pool ->> 'daily_spend_cap_microusd')::bigint);
  END LOOP;
  RETURN v_id;
END;
$$;

-- Proposes a model revision (the gateway validated it against the code guardrails first). A new
-- model starts as a draft; an existing one keeps its status and active revision, and an older
-- pending revision is replaced (kept as history). The id is derived from the provider type and
-- upstream id. p_source 'discovery' with p_candidate_id: a verified discovery candidate.
CREATE FUNCTION public.zerox_catalog_propose(p_spec jsonb, p_actor text, p_note text DEFAULT NULL,
  p_detail jsonb DEFAULT NULL, p_source text DEFAULT 'operator', p_candidate_id bigint DEFAULT NULL)
RETURNS TABLE (model_id text, revision_id bigint, revision integer, status text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_type text := p_spec ->> 'provider_type';
  v_upstream text := p_spec ->> 'upstream_model';
  v_id text;
  v_model public.zerox_catalog_models;
  v_revision bigint;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_catalog: p_actor is required'; END IF;
  IF p_source IS NULL OR p_source NOT IN ('operator', 'discovery') THEN
    RAISE EXCEPTION 'invalid_catalog: p_source must be operator or discovery';
  END IF;
  IF p_spec IS NULL OR jsonb_typeof(p_spec) <> 'object' THEN RAISE EXCEPTION 'invalid_catalog: the spec must be a JSON object'; END IF;
  IF v_type IS NULL OR NOT (v_type = ANY (public.zerox_catalog_provider_types())) THEN
    RAISE EXCEPTION 'invalid_catalog: unknown provider type %', coalesce(v_type, 'null');
  END IF;
  IF NOT public.zerox_catalog_upstream_ok(v_type, v_upstream) THEN
    RAISE EXCEPTION 'invalid_catalog: upstream_model is not a valid % model id', v_type;
  END IF;
  IF p_candidate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.zerox_provider_candidates AS c
      WHERE c.id = p_candidate_id AND c.status = 'verified') THEN
    RAISE EXCEPTION 'candidate_not_verified: only verified candidates can be proposed';
  END IF;
  v_id := public.zerox_catalog_public_id(v_type, v_upstream);
  IF p_candidate_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.zerox_catalog_models AS m
      WHERE m.candidate_id = p_candidate_id AND m.id <> v_id) THEN
    RAISE EXCEPTION 'invalid_catalog: candidate % already belongs to another catalog model', p_candidate_id;
  END IF;
  PERFORM public.zerox_catalog_context(p_actor, 'propose', p_note);
  INSERT INTO public.zerox_catalog_models AS m (id, provider_type, source, candidate_id)
    VALUES (v_id, v_type, p_source, p_candidate_id) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v_model FROM public.zerox_catalog_models AS m WHERE m.id = v_id FOR UPDATE;
  IF v_model.provider_type <> v_type THEN RAISE EXCEPTION 'invalid_catalog: % belongs to another provider type', v_id; END IF;
  v_revision := public.zerox_catalog_insert_revision(v_id, p_spec, p_actor, p_note);
  PERFORM public.zerox_catalog_context(p_actor, 'propose', p_note,
    coalesce(p_detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('source', p_source, 'candidate_id', p_candidate_id,
      'replaced_pending_revision_id', v_model.pending_revision_id)), v_revision);
  UPDATE public.zerox_catalog_models AS m SET pending_revision_id = v_revision WHERE m.id = v_id;
  RETURN QUERY SELECT m.id, r.id, r.revision, m.status
    FROM public.zerox_catalog_models AS m JOIN public.zerox_catalog_revisions AS r ON r.id = v_revision
    WHERE m.id = v_id;
END;
$$;

-- Approves the pending revision the operator reviewed: it must still be pending and the active
-- revision must still be the one the review compared against (stale_revision otherwise). The
-- revision records its approver; the model serves it and becomes active.
CREATE FUNCTION public.zerox_catalog_approve(p_model_id text, p_revision_id bigint, p_expected_active bigint,
  p_actor text, p_note text DEFAULT NULL, p_detail jsonb DEFAULT NULL)
RETURNS SETOF public.zerox_catalog_models
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_model public.zerox_catalog_models;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_catalog: p_actor is required'; END IF;
  SELECT * INTO v_model FROM public.zerox_catalog_models AS m WHERE m.id = p_model_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_model_not_found'; END IF;
  IF NOT public.zerox_catalog_can(v_model.status, 'approve') THEN
    RAISE EXCEPTION 'invalid_transition: % -> approve', v_model.status;
  END IF;
  IF p_revision_id IS NULL OR v_model.pending_revision_id IS DISTINCT FROM p_revision_id
      OR v_model.active_revision_id IS DISTINCT FROM p_expected_active THEN
    RAISE EXCEPTION 'stale_revision: the pending or active revision changed; reload and review again';
  END IF;
  PERFORM public.zerox_catalog_context(p_actor, 'approve', p_note,
    coalesce(p_detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('replaced_revision_id', v_model.active_revision_id)),
    p_revision_id);
  UPDATE public.zerox_catalog_revisions AS r SET approved_by = left(p_actor, 64), approved_at = now() WHERE r.id = p_revision_id;
  UPDATE public.zerox_catalog_models AS m SET active_revision_id = p_revision_id, pending_revision_id = NULL, status = 'active'
    WHERE m.id = p_model_id;
  RETURN QUERY SELECT * FROM public.zerox_catalog_models AS m WHERE m.id = p_model_id;
END;
$$;

-- Rejects the pending revision (kept as history); the model's status does not change.
CREATE FUNCTION public.zerox_catalog_reject(p_model_id text, p_revision_id bigint, p_actor text, p_note text DEFAULT NULL)
RETURNS SETOF public.zerox_catalog_models
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_model public.zerox_catalog_models;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_catalog: p_actor is required'; END IF;
  SELECT * INTO v_model FROM public.zerox_catalog_models AS m WHERE m.id = p_model_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_model_not_found'; END IF;
  IF p_revision_id IS NULL OR v_model.pending_revision_id IS DISTINCT FROM p_revision_id THEN
    RAISE EXCEPTION 'stale_revision: revision % is not pending', coalesce(p_revision_id::text, 'null');
  END IF;
  PERFORM public.zerox_catalog_context(p_actor, 'reject', p_note, NULL, p_revision_id);
  UPDATE public.zerox_catalog_revisions AS r SET rejected_by = left(p_actor, 64), rejected_at = now() WHERE r.id = p_revision_id;
  UPDATE public.zerox_catalog_models AS m SET pending_revision_id = NULL WHERE m.id = p_model_id;
  RETURN QUERY SELECT * FROM public.zerox_catalog_models AS m WHERE m.id = p_model_id;
END;
$$;

-- Disables a model (draft or active) or enables a disabled one that has an approved revision.
CREATE FUNCTION public.zerox_catalog_set_status(p_model_id text, p_to text, p_actor text, p_note text DEFAULT NULL)
RETURNS SETOF public.zerox_catalog_models
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_model public.zerox_catalog_models;
  v_action text := CASE p_to WHEN 'disabled' THEN 'disable' WHEN 'active' THEN 'enable' END;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_catalog: p_actor is required'; END IF;
  SELECT * INTO v_model FROM public.zerox_catalog_models AS m WHERE m.id = p_model_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_model_not_found'; END IF;
  IF v_action IS NULL OR NOT public.zerox_catalog_can(v_model.status, v_action) THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', v_model.status, coalesce(p_to, 'null');
  END IF;
  IF p_to = 'active' AND v_model.active_revision_id IS NULL THEN
    RAISE EXCEPTION 'invalid_transition: disabled -> active needs an approved revision';
  END IF;
  PERFORM public.zerox_catalog_context(p_actor, v_action, p_note, NULL, v_model.active_revision_id);
  UPDATE public.zerox_catalog_models AS m SET status = p_to WHERE m.id = p_model_id;
  RETURN QUERY SELECT * FROM public.zerox_catalog_models AS m WHERE m.id = p_model_id;
END;
$$;

-- ── Reads ──

-- The spec of one revision (src/catalog-guardrails.js shape), or NULL.
CREATE FUNCTION public.zerox_catalog_revision_spec(p_revision_id bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'provider_type', m.provider_type, 'upstream_model', r.upstream_model, 'display_name', r.display_name,
    'context_window', r.context_window, 'max_output_tokens', r.max_output_tokens,
    'default_max_tokens', r.default_max_tokens, 'supports_tools', r.supports_tools, 'supports_vision', r.supports_vision,
    'reasoning_efforts', to_jsonb(r.reasoning_efforts), 'reasoning_effort_map', r.reasoning_effort_map,
    'default_reasoning_effort', r.default_reasoning_effort, 'aliases', to_jsonb(r.aliases),
    'geo_block_free', to_jsonb(r.geo_block_free), 'auto_rank', r.auto_rank, 'position', r.position,
    'default_enabled', r.default_enabled,
    'pools', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'tier', p.tier, 'key_slot', p.key_slot,
        'price', CASE WHEN p.input_microusd_per_mtok IS NULL AND p.output_microusd_per_mtok IS NULL THEN NULL
          ELSE jsonb_build_object('input', p.input_microusd_per_mtok, 'output', p.output_microusd_per_mtok,
            'cache_read', p.cache_read_microusd_per_mtok, 'cache_write', p.cache_write_microusd_per_mtok,
            'cache_write_1h', p.cache_write_1h_microusd_per_mtok,
            'long', CASE WHEN p.long_context_threshold IS NULL THEN NULL
              ELSE jsonb_build_object('threshold', p.long_context_threshold, 'input', p.long_input_microusd_per_mtok,
                'output', p.long_output_microusd_per_mtok) END) END,
        'limits', jsonb_build_object('rpm', p.rpm, 'rpd', p.rpd, 'tpm', p.tpm, 'tpd', p.tpd),
        'daily_spend_cap_microusd', p.daily_spend_cap_microusd) ORDER BY p.tier)
      FROM public.zerox_catalog_revision_pools AS p WHERE p.revision_id = r.id), '[]'::jsonb))
  FROM public.zerox_catalog_revisions AS r JOIN public.zerox_catalog_models AS m ON m.id = r.model_id
  WHERE r.id = p_revision_id;
$$;

-- One revision with its decision and spec, or NULL.
CREATE FUNCTION public.zerox_catalog_revision_json(p_revision_id bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object('revision_id', r.id, 'revision', r.revision, 'author', r.author, 'note', r.note,
    'created_at', r.created_at, 'approved_by', r.approved_by, 'approved_at', r.approved_at,
    'rejected_by', r.rejected_by, 'rejected_at', r.rejected_at, 'spec', public.zerox_catalog_revision_spec(r.id))
  FROM public.zerox_catalog_revisions AS r WHERE r.id = p_revision_id;
$$;

-- What the gateway loads (src/catalog-db.js, every 45 s): every model, with the spec of its active
-- revision when it is active.
CREATE FUNCTION public.zerox_catalog_snapshot()
RETURNS TABLE (id text, provider_type text, status text, revision_id bigint, revision integer, spec jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT m.id, m.provider_type, m.status, r.id, r.revision,
    CASE WHEN r.id IS NULL THEN NULL ELSE public.zerox_catalog_revision_spec(r.id) END
  FROM public.zerox_catalog_models AS m
  LEFT JOIN public.zerox_catalog_revisions AS r ON r.id = m.active_revision_id AND m.status = 'active'
  ORDER BY coalesce(r.position, 100000), m.id
  LIMIT 1000;
$$;

-- Admin listing: every model with its active and pending revision.
CREATE FUNCTION public.zerox_catalog_list()
RETURNS TABLE (id text, provider_type text, status text, source text, candidate_id bigint, status_changed_at timestamptz,
  created_at timestamptz, updated_at timestamptz, active jsonb, pending jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT m.id, m.provider_type, m.status, m.source, m.candidate_id, m.status_changed_at, m.created_at, m.updated_at,
    public.zerox_catalog_revision_json(m.active_revision_id), public.zerox_catalog_revision_json(m.pending_revision_id)
  FROM public.zerox_catalog_models AS m
  ORDER BY coalesce((SELECT r.position FROM public.zerox_catalog_revisions AS r
    WHERE r.id = coalesce(m.active_revision_id, m.pending_revision_id)), 100000), m.id
  LIMIT 1000;
$$;

-- One model: its row, its newest 50 revisions and its newest 100 events.
CREATE FUNCTION public.zerox_catalog_model(p_id text)
RETURNS TABLE (model jsonb, revisions jsonb, events jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT to_jsonb(m),
    coalesce((SELECT jsonb_agg(public.zerox_catalog_revision_json(x.id) ORDER BY x.revision DESC)
      FROM (SELECT r.id, r.revision FROM public.zerox_catalog_revisions AS r WHERE r.model_id = m.id
        ORDER BY r.revision DESC LIMIT 50) AS x), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.at DESC, e.id DESC)
      FROM (SELECT * FROM public.zerox_catalog_events AS ev WHERE ev.model_id = m.id
        ORDER BY ev.at DESC, ev.id DESC LIMIT 100) AS e), '[]'::jsonb)
  FROM public.zerox_catalog_models AS m WHERE m.id = p_id;
$$;

-- Newest catalog events, of one model or of all.
CREATE FUNCTION public.zerox_catalog_events_list(p_id text DEFAULT NULL, p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL)
RETURNS SETOF public.zerox_catalog_events
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM public.zerox_catalog_events AS e
  WHERE (p_id IS NULL OR e.model_id = p_id) AND (p_before IS NULL OR e.at < p_before)
  ORDER BY e.at DESC, e.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- One operator audit feed: OIOP offer events and catalog model events.
CREATE VIEW public.zerox_operator_audit WITH (security_invoker = true) AS
  SELECT 'offer'::text AS subject_kind, o.offer_id AS subject_id, o.id, o.at, o.actor, o.action,
    o.from_state, o.to_state, NULL::bigint AS revision_id, o.note, o.detail
  FROM public.zerox_offer_events AS o
  UNION ALL
  SELECT 'model'::text, c.model_id, c.id, c.at, c.actor, c.action, c.from_status, c.to_status, c.revision_id, c.note, c.detail
  FROM public.zerox_catalog_events AS c;

REVOKE ALL ON public.zerox_operator_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.zerox_operator_audit TO service_role;

CREATE FUNCTION public.zerox_operator_audit_list(p_limit integer DEFAULT 100, p_before timestamptz DEFAULT NULL)
RETURNS SETOF public.zerox_operator_audit
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM public.zerox_operator_audit AS a WHERE p_before IS NULL OR a.at < p_before
  ORDER BY a.at DESC, a.id DESC LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

REVOKE ALL ON FUNCTION
  public.zerox_catalog_provider_types(),
  public.zerox_catalog_public_id(text, text),
  public.zerox_catalog_upstream_ok(text, text),
  public.zerox_catalog_slot_ok(text, text, text),
  public.zerox_catalog_type_max_cap_microusd(text),
  public.zerox_catalog_can(text, text),
  public.zerox_catalog_aliases_ok(text[]),
  public.zerox_catalog_geo_ok(text[]),
  public.zerox_catalog_efforts_ok(text[]),
  public.zerox_catalog_context(text, text, text, jsonb, bigint),
  public.zerox_catalog_models_guard(),
  public.zerox_catalog_models_audit(),
  public.zerox_catalog_revisions_guard(),
  public.zerox_catalog_revisions_audit(),
  public.zerox_catalog_pools_guard(),
  public.zerox_catalog_append_only(),
  public.zerox_catalog_insert_revision(text, jsonb, text, text),
  public.zerox_catalog_propose(jsonb, text, text, jsonb, text, bigint),
  public.zerox_catalog_approve(text, bigint, bigint, text, text, jsonb),
  public.zerox_catalog_reject(text, bigint, text, text),
  public.zerox_catalog_set_status(text, text, text, text),
  public.zerox_catalog_revision_spec(bigint),
  public.zerox_catalog_revision_json(bigint),
  public.zerox_catalog_snapshot(),
  public.zerox_catalog_list(),
  public.zerox_catalog_model(text),
  public.zerox_catalog_events_list(text, integer, timestamptz),
  public.zerox_operator_audit_list(integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_catalog_provider_types(),
  public.zerox_catalog_public_id(text, text),
  public.zerox_catalog_upstream_ok(text, text),
  public.zerox_catalog_slot_ok(text, text, text),
  public.zerox_catalog_type_max_cap_microusd(text),
  public.zerox_catalog_can(text, text),
  public.zerox_catalog_aliases_ok(text[]),
  public.zerox_catalog_geo_ok(text[]),
  public.zerox_catalog_efforts_ok(text[]),
  public.zerox_catalog_context(text, text, text, jsonb, bigint),
  public.zerox_catalog_models_guard(),
  public.zerox_catalog_models_audit(),
  public.zerox_catalog_revisions_guard(),
  public.zerox_catalog_revisions_audit(),
  public.zerox_catalog_pools_guard(),
  public.zerox_catalog_append_only(),
  public.zerox_catalog_insert_revision(text, jsonb, text, text),
  public.zerox_catalog_propose(jsonb, text, text, jsonb, text, bigint),
  public.zerox_catalog_approve(text, bigint, bigint, text, text, jsonb),
  public.zerox_catalog_reject(text, bigint, text, text),
  public.zerox_catalog_set_status(text, text, text, text),
  public.zerox_catalog_revision_spec(bigint),
  public.zerox_catalog_revision_json(bigint),
  public.zerox_catalog_snapshot(),
  public.zerox_catalog_list(),
  public.zerox_catalog_model(text),
  public.zerox_catalog_events_list(text, integer, timestamptz),
  public.zerox_operator_audit_list(integer, timestamptz)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
