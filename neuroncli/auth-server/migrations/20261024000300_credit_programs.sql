BEGIN;

-- Free cloud and AI credit programs (docs/OIOP.md "Credits", docs/PLATFORM_CONTRACT.md section
-- 12.6). The weekly `credits` discovery job (src/discovery/credits.js) searches the web for
-- startup programs, trial credits, developer programs and subsidised compute, and stores each
-- program with verbatim quotes from the pages it read. Nothing here applies for anything:
-- applying stays with the operator, who moves a program new -> approved -> applied -> granted
-- (recording the amount and expiry) or rejects it. Every move is written to
-- zerox_credit_program_events.

CREATE TABLE public.zerox_credit_programs (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  vendor text NOT NULL CHECK (char_length(vendor) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('startup_credits', 'trial_credit', 'free_tier', 'grant',
    'subsidized_compute', 'developer_program', 'other')),
  url text CHECK (url ~ '^https://' AND char_length(url) <= 2048),
  amount_usd numeric(14, 2) CHECK (amount_usd >= 0 AND amount_usd <= 100000000),
  amount_text text CHECK (char_length(amount_text) <= 300),
  validity_days integer CHECK (validity_days BETWEEN 1 AND 3650),
  self_serve boolean,
  requires_funding boolean,
  requires_card boolean,
  india_eligible boolean,
  -- What the credits can pay for.
  usable_for text[] NOT NULL DEFAULT '{}'
    CHECK (usable_for <@ ARRAY['gpu', 'managed_llm_api', 'free_llm_api', 'cpu', 'storage', 'other']::text[]),
  gpu_access text NOT NULL DEFAULT 'unknown' CHECK (gpu_access IN ('yes', 'no', 'quota_gated', 'unknown')),
  eligibility text CHECK (char_length(eligibility) <= 1000),
  notes text CHECK (char_length(notes) <= 2000),
  -- [{field, source: page|operator, url, quote, note}]
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 32768),
  source text NOT NULL DEFAULT 'research' CHECK (source IN ('research', 'seed', 'operator')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'approved', 'applied', 'granted', 'rejected', 'expired', 'excluded')),
  granted_usd numeric(14, 2) CHECK (granted_usd >= 0),
  applied_at timestamptz,
  granted_at timestamptz,
  expires_at timestamptz,
  review_notes text CHECK (char_length(review_notes) <= 2000),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zerox_credit_programs_status_idx ON public.zerox_credit_programs (status, amount_usd DESC NULLS LAST);

CREATE TABLE public.zerox_credit_program_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id text NOT NULL REFERENCES public.zerox_credit_programs (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 64),
  action text NOT NULL CHECK (action IN ('create', 'update', 'transition', 'ended')),
  from_state text,
  to_state text,
  note text CHECK (char_length(note) <= 2000),
  detail jsonb CHECK (detail IS NULL OR octet_length(detail::text) <= 8192)
);

CREATE INDEX zerox_credit_program_events_idx ON public.zerox_credit_program_events (program_id, at DESC, id DESC);

ALTER TABLE public.zerox_credit_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_credit_program_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zerox_credit_programs, public.zerox_credit_program_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zerox_credit_programs, public.zerox_credit_program_events TO service_role;

-- The allowed status moves (src/discovery/credits.js CREDIT_TRANSITIONS mirrors this list).
CREATE FUNCTION public.zerox_credit_can_transition(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_from, p_to) IN (
    ('new', 'approved'), ('new', 'rejected'), ('new', 'excluded'),
    ('approved', 'applied'), ('approved', 'rejected'),
    ('applied', 'granted'), ('applied', 'rejected'),
    ('granted', 'expired'),
    ('rejected', 'new'), ('expired', 'new'), ('excluded', 'new')
  );
$$;

-- Creates or refreshes programs. p_rows: [{id, vendor, name, kind, url, amount_usd, amount_text,
-- validity_days, self_serve, requires_funding, requires_card, india_eligible, usable_for,
-- gpu_access, eligibility, notes, evidence, ended}]. New rows start as new (expired when `ended`).
-- Existing rows get the fresh facts and keep every operator decision; a program reported as
-- ended moves from new or approved to expired. p_source: research | seed | operator.
CREATE FUNCTION public.zerox_credit_programs_upsert(p_rows jsonb, p_source text, p_actor text)
RETURNS TABLE (id text, status text, inserted boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_row jsonb;
  v_old public.zerox_credit_programs;
  v_ended boolean;
  v_status text;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'invalid_credits: p_rows must be a JSON array'; END IF;
  IF jsonb_array_length(p_rows) > 200 THEN RAISE EXCEPTION 'invalid_credits: at most 200 rows per call'; END IF;
  IF p_source IS NULL OR p_source NOT IN ('research', 'seed', 'operator') THEN RAISE EXCEPTION 'invalid_credits: p_source'; END IF;
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_credits: p_actor is required'; END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_ended := coalesce((v_row->>'ended')::boolean, false);
    SELECT * INTO v_old FROM public.zerox_credit_programs AS c WHERE c.id = v_row->>'id' FOR UPDATE;
    IF NOT FOUND THEN
      v_status := CASE WHEN v_ended THEN 'expired' ELSE 'new' END;
      INSERT INTO public.zerox_credit_programs AS c (id, vendor, name, kind, url, amount_usd, amount_text, validity_days,
        self_serve, requires_funding, requires_card, india_eligible, usable_for, gpu_access, eligibility, notes, evidence,
        source, status)
      VALUES (v_row->>'id', v_row->>'vendor', v_row->>'name', coalesce(v_row->>'kind', 'other'), v_row->>'url',
        (v_row->>'amount_usd')::numeric, v_row->>'amount_text', (v_row->>'validity_days')::integer,
        (v_row->>'self_serve')::boolean, (v_row->>'requires_funding')::boolean, (v_row->>'requires_card')::boolean,
        (v_row->>'india_eligible')::boolean,
        coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(v_row->'usable_for', '[]'::jsonb))), '{}'),
        coalesce(v_row->>'gpu_access', 'unknown'), v_row->>'eligibility', v_row->>'notes',
        coalesce(v_row->'evidence', '[]'::jsonb), p_source, v_status);
      INSERT INTO public.zerox_credit_program_events (program_id, actor, action, to_state)
        VALUES (v_row->>'id', p_actor, 'create', v_status);
      RETURN QUERY SELECT v_row->>'id', v_status, true;
    ELSE
      v_status := CASE WHEN v_ended AND v_old.status IN ('new', 'approved') THEN 'expired' ELSE v_old.status END;
      UPDATE public.zerox_credit_programs AS c SET
        vendor = coalesce(v_row->>'vendor', c.vendor), name = coalesce(v_row->>'name', c.name),
        kind = coalesce(v_row->>'kind', c.kind), url = coalesce(v_row->>'url', c.url),
        amount_usd = coalesce((v_row->>'amount_usd')::numeric, c.amount_usd),
        amount_text = coalesce(v_row->>'amount_text', c.amount_text),
        validity_days = coalesce((v_row->>'validity_days')::integer, c.validity_days),
        self_serve = coalesce((v_row->>'self_serve')::boolean, c.self_serve),
        requires_funding = coalesce((v_row->>'requires_funding')::boolean, c.requires_funding),
        requires_card = coalesce((v_row->>'requires_card')::boolean, c.requires_card),
        india_eligible = coalesce((v_row->>'india_eligible')::boolean, c.india_eligible),
        usable_for = CASE WHEN jsonb_array_length(coalesce(v_row->'usable_for', '[]'::jsonb)) > 0
          THEN ARRAY(SELECT jsonb_array_elements_text(v_row->'usable_for')) ELSE c.usable_for END,
        gpu_access = CASE WHEN coalesce(v_row->>'gpu_access', 'unknown') <> 'unknown' THEN v_row->>'gpu_access' ELSE c.gpu_access END,
        eligibility = coalesce(v_row->>'eligibility', c.eligibility), notes = coalesce(v_row->>'notes', c.notes),
        evidence = CASE WHEN jsonb_array_length(coalesce(v_row->'evidence', '[]'::jsonb)) > 0 THEN v_row->'evidence' ELSE c.evidence END,
        status = v_status, last_seen = now(), updated_at = now()
      WHERE c.id = v_old.id;
      IF v_status <> v_old.status THEN
        INSERT INTO public.zerox_credit_program_events (program_id, actor, action, from_state, to_state, note)
          VALUES (v_old.id, p_actor, 'ended', v_old.status, v_status, 'Reported as ended');
      END IF;
      RETURN QUERY SELECT v_old.id, v_status, false;
    END IF;
  END LOOP;
END;
$$;

-- Operator moves (raises invalid_transition / program_not_found). `granted` records the amount
-- and expiry; `applied` the date.
CREATE FUNCTION public.zerox_credit_program_transition(p_id text, p_to text, p_actor text, p_note text DEFAULT NULL,
  p_granted_usd numeric DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL)
RETURNS SETOF public.zerox_credit_programs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_program public.zerox_credit_programs;
BEGIN
  IF coalesce(p_actor, '') = '' THEN RAISE EXCEPTION 'invalid_credits: p_actor is required'; END IF;
  SELECT * INTO v_program FROM public.zerox_credit_programs AS c WHERE c.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'program_not_found'; END IF;
  IF NOT public.zerox_credit_can_transition(v_program.status, p_to) THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', v_program.status, coalesce(p_to, 'null');
  END IF;
  UPDATE public.zerox_credit_programs AS c SET status = p_to, updated_at = now(),
    review_notes = coalesce(left(p_note, 2000), c.review_notes),
    applied_at = CASE WHEN p_to = 'applied' THEN now() ELSE c.applied_at END,
    granted_at = CASE WHEN p_to = 'granted' THEN now() ELSE c.granted_at END,
    granted_usd = CASE WHEN p_to = 'granted' THEN p_granted_usd ELSE c.granted_usd END,
    expires_at = CASE WHEN p_to = 'granted' THEN p_expires_at ELSE c.expires_at END
    WHERE c.id = p_id;
  INSERT INTO public.zerox_credit_program_events (program_id, actor, action, from_state, to_state, note, detail)
    VALUES (p_id, p_actor, 'transition', v_program.status, p_to, left(p_note, 2000),
      CASE WHEN p_to = 'granted' THEN jsonb_build_object('granted_usd', p_granted_usd, 'expires_at', p_expires_at) END);
  RETURN QUERY SELECT * FROM public.zerox_credit_programs AS c WHERE c.id = p_id;
END;
$$;

-- Programs, the actionable ones first; p_status narrows to one status.
CREATE FUNCTION public.zerox_credit_programs_list(p_status text DEFAULT NULL)
RETURNS SETOF public.zerox_credit_programs
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM public.zerox_credit_programs AS c
  WHERE p_status IS NULL OR c.status = p_status
  ORDER BY array_position(ARRAY['granted', 'applied', 'approved', 'new', 'expired', 'rejected', 'excluded'], c.status),
    c.amount_usd DESC NULLS LAST, c.vendor, c.id;
$$;

CREATE FUNCTION public.zerox_credit_program_events_list(p_id text, p_limit integer DEFAULT 50)
RETURNS SETOF public.zerox_credit_program_events
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM public.zerox_credit_program_events AS e WHERE e.program_id = p_id
  ORDER BY e.at DESC, e.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION
  public.zerox_credit_can_transition(text, text),
  public.zerox_credit_programs_upsert(jsonb, text, text),
  public.zerox_credit_program_transition(text, text, text, text, numeric, timestamptz),
  public.zerox_credit_programs_list(text),
  public.zerox_credit_program_events_list(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_credit_can_transition(text, text),
  public.zerox_credit_programs_upsert(jsonb, text, text),
  public.zerox_credit_program_transition(text, text, text, text, numeric, timestamptz),
  public.zerox_credit_programs_list(text),
  public.zerox_credit_program_events_list(text, integer)
  TO service_role;

-- ── Seed: programs found on 2026-10-24 (third-party roundups and official pages) ──
-- Amounts and rules vary between sources; the evidence says so, and the weekly job replaces
-- these facts with quoted ones from the vendors' pages.
SELECT public.zerox_credit_programs_upsert($seed$[
  {"id": "google-for-startups-cloud", "vendor": "Google Cloud", "name": "Google for Startups Cloud Program", "kind": "startup_credits",
   "url": "https://cloud.google.com/startup", "amount_usd": 2000,
   "amount_text": "$2,000 (Start tier, self-serve); up to $200,000, or $350,000 for AI startups (Scale tier)",
   "self_serve": true, "requires_funding": false, "usable_for": ["gpu", "managed_llm_api", "cpu", "storage"], "gpu_access": "quota_gated",
   "eligibility": "Scale tiers need equity funding (pre-seed or later); GPU use needs paid billing and a quota grant",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://fin.ai/learn/startup-credit-programs", "note": "Third-party roundup, 2026-10-24; confirm on the official page"}]},
  {"id": "microsoft-for-startups", "vendor": "Microsoft", "name": "Microsoft for Startups (Azure credits)", "kind": "startup_credits",
   "url": "https://www.microsoft.com/en-us/startups", "amount_usd": 5000,
   "amount_text": "$200 to start; up to $5,000 self-serve; up to $150,000 with milestones",
   "self_serve": true, "requires_funding": false, "usable_for": ["managed_llm_api", "gpu", "cpu", "storage"], "gpu_access": "quota_gated",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://fin.ai/learn/startup-credit-programs", "note": "Third-party roundup, 2026-10-24; confirm on the official page"}]},
  {"id": "aws-activate-founders", "vendor": "AWS", "name": "AWS Activate Founders", "kind": "startup_credits",
   "url": "https://aws.amazon.com/startups/credits", "amount_usd": 1000,
   "amount_text": "$1,000 (Founders, self-serve); up to $100,000 or more through a partner (Portfolio)",
   "self_serve": true, "requires_funding": false, "usable_for": ["managed_llm_api", "gpu", "cpu", "storage"], "gpu_access": "quota_gated",
   "eligibility": "Company under 10 years old, no earlier Activate credits",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://fin.ai/learn/startup-credit-programs", "note": "Third-party roundup, 2026-10-24; confirm on the official page"}]},
  {"id": "runpod-startup-program", "vendor": "RunPod", "name": "RunPod Startup Program (Starter)", "kind": "startup_credits",
   "url": "https://www.runpod.io", "amount_usd": 1000, "amount_text": "$1,000 (Starter); Growth tier adds $25,000 to a $50,000 commitment",
   "usable_for": ["gpu"], "gpu_access": "yes",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://modal.com/resources/best-gpu-cloud-credit-programs-startups", "note": "Third-party roundup, 2026-10-24; confirm on the official page"}]},
  {"id": "modal-starter", "vendor": "Modal", "name": "Modal Starter plan free compute", "kind": "free_tier",
   "url": "https://modal.com/pricing", "amount_usd": 30, "amount_text": "$30 of compute every month, no card", "self_serve": true,
   "requires_card": false, "usable_for": ["gpu", "cpu"], "gpu_access": "yes",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://modal.com/resources/best-gpu-cloud-credit-programs-startups", "note": "2026-10-24"}]},
  {"id": "nvidia-inception", "vendor": "NVIDIA", "name": "NVIDIA Inception", "kind": "developer_program",
   "url": "https://www.nvidia.com/en-us/startups/", "amount_text": "Free to join; partner credits and DGX Cloud discounts vary",
   "self_serve": true, "requires_funding": false, "usable_for": ["gpu"], "gpu_access": "unknown",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://www.getaiperks.com/en/ai/free-nvidia-inception-credits", "note": "Third-party page, 2026-10-24"}]},
  {"id": "akamai-cloud-rise", "vendor": "Akamai", "name": "Akamai Cloud Rise", "kind": "startup_credits",
   "url": "https://www.linode.com/rise", "amount_usd": 500, "amount_text": "$500 on acceptance, up to $120,000 in the first year",
   "self_serve": false, "requires_funding": false, "usable_for": ["gpu", "cpu", "storage"], "gpu_access": "unknown",
   "eligibility": "Under seven years old, already using Akamai Cloud, plans to grow; reviewed within two weeks",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://www.linode.com/rise", "note": "Official page summary, 2026-10-24"}]},
  {"id": "akamai-new-account-credit", "vendor": "Akamai", "name": "Akamai Cloud (Linode) new-account credit", "kind": "trial_credit",
   "url": "https://www.linode.com", "amount_usd": 100, "amount_text": "$100 for 60 days (referral sign-up, payment method needed)",
   "validity_days": 60, "self_serve": true, "requires_card": true, "usable_for": ["cpu", "storage"], "gpu_access": "unknown",
   "evidence": [{"field": "amount_usd", "source": "operator", "url": "https://costbench.com/software/cloud-infrastructure/linode/free-plan/", "note": "Third-party page, 2026-10-24"}]},
  {"id": "cloudflare-for-startups", "vendor": "Cloudflare", "name": "Cloudflare for Startups", "kind": "startup_credits",
   "url": "https://www.cloudflare.com/forstartups/", "amount_text": "Up to $250,000 for Cloudflare products (Workers AI included; AI Gateway excluded since May 2026)",
   "usable_for": ["managed_llm_api", "cpu", "storage"], "gpu_access": "no",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://agentdeals.dev/startup-credits", "note": "Third-party roundup, 2026-10-24"}]},
  {"id": "digitalocean-hatch", "vendor": "DigitalOcean", "name": "DigitalOcean Hatch", "kind": "startup_credits",
   "url": "https://www.digitalocean.com/hatch", "amount_text": "Up to $100,000 over 12 months; GPU Droplets excluded from credits since May 2026",
   "requires_funding": true, "usable_for": ["cpu", "storage"], "gpu_access": "no",
   "eligibility": "Through an approved accelerator, incubator or VC",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://betterstack.com/community/comparisons/best-startup-cloud-credit-programs/", "note": "Third-party roundup, 2026-10-24"}]},
  {"id": "ovhcloud-startup-program", "vendor": "OVHcloud", "name": "OVHcloud Startup Program", "kind": "startup_credits",
   "url": "https://startup.ovhcloud.com", "amount_text": "EUR 10,000 (Start); up to EUR 100,000 (Scale, Series A and later)",
   "usable_for": ["gpu", "cpu", "storage"], "gpu_access": "unknown",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://betterstack.com/community/comparisons/digitalocean-vs-ovhcloud-startups/", "note": "Third-party roundup, 2026-10-24"}]},
  {"id": "scaleway-startup-program", "vendor": "Scaleway", "name": "Scaleway Startup Program", "kind": "startup_credits",
   "url": "https://www.scaleway.com/en/startup-program/", "amount_text": "EUR 1,000-36,000 for EU startups", "india_eligible": false,
   "usable_for": ["gpu", "cpu", "storage"], "gpu_access": "unknown",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://betterstack.com/community/comparisons/best-startup-cloud-credit-programs/", "note": "Third-party roundup, 2026-10-24"}]},
  {"id": "amd-ai-developer-program", "vendor": "AMD", "name": "AMD AI Developer Program cloud credits", "kind": "developer_program",
   "url": "https://www.amd.com/en/developer/resources/technical-articles/2026/how-to-claim-amd-cloud-credits.html",
   "amount_text": "Free cloud credits for AMD Instinct GPUs or managed LLM inference (amount not confirmed)",
   "usable_for": ["gpu", "managed_llm_api"], "gpu_access": "yes",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://www.amd.com/en/developer/resources/technical-articles/2026/how-to-claim-amd-cloud-credits.html", "note": "Official article (not read in full), 2026-10-24"}]},
  {"id": "indiaai-compute", "vendor": "IndiaAI Mission (MeitY)", "name": "IndiaAI subsidised GPU compute", "kind": "subsidized_compute",
   "url": "https://indiaai.gov.in", "amount_text": "About INR 65-150 per GPU-hour after subsidy; up to 40% more for approved projects",
   "self_serve": false, "india_eligible": true, "usable_for": ["gpu"], "gpu_access": "yes",
   "eligibility": "Indian startups and researchers; projects are reviewed and approved",
   "evidence": [{"field": "amount_text", "source": "operator", "url": "https://huggingface.co/blog/daya-shankar/nvidia-h100-price-india", "note": "Secondary sources disagree on the rate, 2026-10-24"}]}
]$seed$::jsonb, 'seed', 'migration');

NOTIFY pgrst, 'reload schema';

COMMIT;
