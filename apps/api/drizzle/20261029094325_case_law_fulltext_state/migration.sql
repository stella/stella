SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE public.case_law_decisions ADD COLUMN text_state jsonb;--> statement-breakpoint

-- Install the stable default separately: existing rows stay NULL without a rewrite.
ALTER TABLE public.case_law_decisions ALTER COLUMN text_state SET DEFAULT
  jsonb_build_object('status', 'fetch_pending', 'attemptCount', 0,
    'nextAttemptAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastAttemptAt', NULL, 'recovery', jsonb_build_object('type', 'verify_storage'));--> statement-breakpoint

CREATE FUNCTION public.case_law_text_state_instant_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  stamp text;
  instant timestamptz;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  stamp := value #>> '{}';
  IF stamp !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN
    RETURN false;
  END IF;
  instant := stamp::timestamptz;
  RETURN instant >= TIMESTAMPTZ '0001-01-01T00:00:00Z'
    AND instant < TIMESTAMPTZ '10000-01-01T00:00:00Z'
    AND to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = stamp;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END
$function$;--> statement-breakpoint

CREATE FUNCTION public.case_law_decision_text_state_shape_valid(state jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  evidence jsonb;
  cause jsonb;
  recovery jsonb;
  recovery_valid boolean;
  cause_valid boolean;
  shape_valid boolean;
BEGIN
  IF jsonb_typeof(state) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF state ->> 'status' IN ('fetch_pending', 'fetch_failed') THEN
    recovery := state -> 'recovery';
    IF jsonb_typeof(recovery) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    CASE recovery ->> 'type'
      WHEN 'verify_storage', 'stored_raw_retry' THEN
        recovery_valid := recovery ? 'type' AND recovery - 'type' = '{}'::jsonb;
      WHEN 'publisher_listing' THEN
        recovery_valid := recovery ?& ARRAY['type', 'slice', 'page']
          AND recovery - ARRAY['type', 'slice', 'page'] = '{}'::jsonb
          AND jsonb_typeof(recovery -> 'slice') = 'string'
          AND length(recovery ->> 'slice') BETWEEN 1 AND 128
          AND jsonb_typeof(recovery -> 'page') = 'number'
          AND (recovery ->> 'page')::numeric >= 0
          AND trunc((recovery ->> 'page')::numeric) = (recovery ->> 'page')::numeric;
      ELSE
        RETURN false;
    END CASE;
    IF NOT coalesce(recovery_valid, false) THEN
      RETURN false;
    END IF;
  END IF;
  CASE state ->> 'status'
    WHEN 'stored' THEN
      shape_valid := state ?& ARRAY['status', 'storage', 'contentHash', 'verifiedAt']
        AND state - ARRAY['status', 'storage', 'contentHash', 'verifiedAt'] = '{}'::jsonb
        AND state ->> 'storage' IN ('postgres', 'corpus')
        AND jsonb_typeof(state -> 'contentHash') = 'string'
        AND state ->> 'contentHash' ~ '^[a-f0-9]{64}$'
        AND public.case_law_text_state_instant_valid(state -> 'verifiedAt');
    WHEN 'fetch_pending' THEN
      shape_valid := state ?& ARRAY['status', 'attemptCount', 'nextAttemptAt', 'lastAttemptAt', 'recovery']
        AND state - ARRAY['status', 'attemptCount', 'nextAttemptAt', 'lastAttemptAt', 'recovery'] = '{}'::jsonb
        AND jsonb_typeof(state -> 'attemptCount') = 'number'
        AND (state ->> 'attemptCount')::numeric >= 0
        AND trunc((state ->> 'attemptCount')::numeric) = (state ->> 'attemptCount')::numeric
        AND public.case_law_text_state_instant_valid(state -> 'nextAttemptAt')
        AND (state -> 'lastAttemptAt' = 'null'::jsonb
          OR public.case_law_text_state_instant_valid(state -> 'lastAttemptAt'));
    WHEN 'fetch_failed' THEN
      cause := state -> 'cause';
      IF jsonb_typeof(cause) IS DISTINCT FROM 'object' THEN
        RETURN false;
      END IF;
      CASE cause ->> 'kind'
        WHEN 'http' THEN
          cause_valid := cause ?& ARRAY['kind', 'status']
            AND cause - ARRAY['kind', 'status'] = '{}'::jsonb
            AND jsonb_typeof(cause -> 'status') = 'number'
            AND (cause ->> 'status')::numeric BETWEEN 100 AND 599
            AND trunc((cause ->> 'status')::numeric) = (cause ->> 'status')::numeric;
        WHEN 'size' THEN
          cause_valid := cause ?& ARRAY['kind', 'limitBytes']
            AND cause - ARRAY['kind', 'limitBytes'] = '{}'::jsonb
            AND jsonb_typeof(cause -> 'limitBytes') = 'number'
            AND (cause ->> 'limitBytes')::numeric >= 1
            AND trunc((cause ->> 'limitBytes')::numeric) = (cause ->> 'limitBytes')::numeric;
        WHEN 'timeout' THEN
          cause_valid := cause ?& ARRAY['kind', 'timeoutMs']
            AND cause - ARRAY['kind', 'timeoutMs'] = '{}'::jsonb
            AND jsonb_typeof(cause -> 'timeoutMs') = 'number'
            AND (cause ->> 'timeoutMs')::numeric >= 1
            AND trunc((cause ->> 'timeoutMs')::numeric) = (cause ->> 'timeoutMs')::numeric;
        WHEN 'parser_refusal', 'network', 'storage' THEN
          cause_valid := cause ?& ARRAY['kind', 'code']
            AND cause - ARRAY['kind', 'code'] = '{}'::jsonb
            AND jsonb_typeof(cause -> 'code') = 'string'
            AND length(cause ->> 'code') BETWEEN 1 AND 128;
        ELSE
          RETURN false;
      END CASE;
      shape_valid := state ?& ARRAY['status', 'attemptCount', 'lastAttemptAt', 'nextAttemptAt', 'cause', 'recovery']
        AND state - ARRAY['status', 'attemptCount', 'lastAttemptAt', 'nextAttemptAt', 'cause', 'recovery'] = '{}'::jsonb
        AND jsonb_typeof(state -> 'attemptCount') = 'number'
        AND (state ->> 'attemptCount')::numeric >= 1
        AND trunc((state ->> 'attemptCount')::numeric) = (state ->> 'attemptCount')::numeric
        AND public.case_law_text_state_instant_valid(state -> 'lastAttemptAt')
        AND public.case_law_text_state_instant_valid(state -> 'nextAttemptAt')
        AND cause_valid;
    WHEN 'publisher_has_no_text' THEN
      evidence := state -> 'evidence';
      IF jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN
        RETURN false;
      END IF;
      shape_valid := state ?& ARRAY['status', 'observedAt', 'evidence']
        AND state - ARRAY['status', 'observedAt', 'evidence'] = '{}'::jsonb
        AND public.case_law_text_state_instant_valid(state -> 'observedAt')
        AND evidence ?& ARRAY['recordUrl', 'sourceHash', 'field', 'kind']
        AND evidence - ARRAY['recordUrl', 'sourceHash', 'field', 'kind'] = '{}'::jsonb
        AND jsonb_typeof(evidence -> 'recordUrl') = 'string'
        AND evidence ->> 'recordUrl' ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?([/?#][^[:space:]]*)?$'
        AND jsonb_typeof(evidence -> 'sourceHash') = 'string'
        AND evidence ->> 'sourceHash' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(evidence -> 'field') = 'string'
        AND length(evidence ->> 'field') BETWEEN 1 AND 128
        AND evidence ->> 'kind' IN ('explicit_statement', 'empty_text_field', 'no_document_attachment');
    WHEN 'metadata_only_by_source' THEN
      shape_valid := state ?& ARRAY['status', 'observedAt', 'policy']
        AND state - ARRAY['status', 'observedAt', 'policy'] = '{}'::jsonb
        AND public.case_law_text_state_instant_valid(state -> 'observedAt')
        AND jsonb_typeof(state -> 'policy') = 'string'
        AND length(state ->> 'policy') BETWEEN 1 AND 128;
    ELSE
      RETURN false;
  END CASE;
  RETURN coalesce(shape_valid, false);
EXCEPTION WHEN data_exception THEN
  RETURN false;
END
$function$;--> statement-breakpoint

CREATE FUNCTION public.case_law_decision_pg_text_present(body text, sections jsonb, ast jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT coalesce(body ~ '[^[:space:]]', false)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sections) = 'array' THEN sections ELSE '[]'::jsonb END) section
      WHERE jsonb_typeof(section -> 'text') = 'string' AND section ->> 'text' ~ '[^[:space:]]'
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ast -> 'blocks') = 'array' THEN ast -> 'blocks' ELSE '[]'::jsonb END) block
      WHERE block ->> 'type' IN ('heading', 'paragraph', 'table')
        AND (coalesce(jsonb_typeof(block -> 'plainText') = 'string' AND block ->> 'plainText' ~ '[^[:space:]]', false)
          OR EXISTS (SELECT 1 FROM jsonb_path_query(block, '$.**.text') piece
            WHERE jsonb_typeof(piece) = 'string' AND piece #>> '{}' ~ '[^[:space:]]'))
    )
$function$;--> statement-breakpoint

CREATE FUNCTION public.case_law_decision_text_state_valid(
  state jsonb, redacted_at timestamptz, body text, sections jsonb, ast jsonb,
  content_hash text, text_key text, sections_key text, ast_key text
)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT coalesce(CASE WHEN redacted_at IS NOT NULL THEN state IS NULL ELSE
    public.case_law_decision_text_state_shape_valid(state)
    AND CASE WHEN state ->> 'status' = 'stored' THEN
      CASE state ->> 'storage'
        WHEN 'postgres' THEN public.case_law_decision_pg_text_present(body, sections, ast)
        WHEN 'corpus' THEN state ->> 'contentHash' = content_hash
          AND text_key ~ '[^[:space:]]' AND sections_key ~ '[^[:space:]]' AND ast_key ~ '[^[:space:]]'
        ELSE false
      END
    ELSE true END
  END, false)
$function$;--> statement-breakpoint

-- Only OLD-versus-NEW transitions belong here; the CHECK below owns row validity.
CREATE FUNCTION public.case_law_decision_text_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  payload_changed boolean;
  preserves_corpus_trim boolean;
  reset_required boolean;
BEGIN
  IF NEW.redacted_at IS NOT NULL THEN
    IF OLD.redacted_at IS DISTINCT FROM NEW.redacted_at THEN
      NEW.text_state := NULL;
    END IF;
    RETURN NEW;
  END IF;
  payload_changed := ROW(NEW.fulltext, NEW.sections, NEW.document_ast, NEW.content_hash,
    NEW.text_s3_key, NEW.normalized_s3_key, NEW.ast_s3_key)
    IS DISTINCT FROM ROW(OLD.fulltext, OLD.sections, OLD.document_ast, OLD.content_hash,
    OLD.text_s3_key, OLD.normalized_s3_key, OLD.ast_s3_key);
  preserves_corpus_trim := OLD.text_state ->> 'status' = 'stored'
    AND OLD.text_state ->> 'storage' = 'corpus'
    AND OLD.text_state ->> 'contentHash' = NEW.content_hash
    AND NEW.fulltext IS NULL AND NEW.sections IS NULL AND NEW.document_ast IS NULL
    AND ROW(NEW.content_hash, NEW.text_s3_key, NEW.normalized_s3_key, NEW.ast_s3_key)
      IS NOT DISTINCT FROM ROW(OLD.content_hash, OLD.text_s3_key, OLD.normalized_s3_key, OLD.ast_s3_key);
  reset_required := OLD.redacted_at IS DISTINCT FROM NEW.redacted_at
    OR (payload_changed AND NEW.text_state IS NOT DISTINCT FROM OLD.text_state
      AND NOT coalesce(preserves_corpus_trim, false))
    OR (NEW.text_state ->> 'status' IS DISTINCT FROM 'stored'
      AND NEW.text_state IS NOT DISTINCT FROM OLD.text_state
      AND ROW(NEW.source_hash, NEW.source_raw_s3_key)
        IS DISTINCT FROM ROW(OLD.source_hash, OLD.source_raw_s3_key));
  IF reset_required THEN
    NEW.text_state := jsonb_build_object('status', 'fetch_pending', 'attemptCount', 0,
      'nextAttemptAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lastAttemptAt', NULL, 'recovery', jsonb_build_object('type', 'verify_storage'));
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_decisions_text_state_guard
BEFORE UPDATE ON public.case_law_decisions
FOR EACH ROW EXECUTE FUNCTION public.case_law_decision_text_state_guard();--> statement-breakpoint

ALTER TABLE public.case_law_decisions ADD CONSTRAINT case_law_decisions_text_state_valid
CHECK (public.case_law_decision_text_state_valid(text_state, redacted_at, fulltext, sections,
  document_ast, content_hash, text_s3_key, normalized_s3_key, ast_s3_key)) NOT VALID;--> statement-breakpoint

CREATE OR REPLACE VIEW public.case_law_published_decisions AS
SELECT * FROM public.case_law_decisions
WHERE redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true';--> statement-breakpoint

CREATE OR REPLACE VIEW public.case_law_unredacted_decisions AS
SELECT * FROM public.case_law_decisions WHERE redacted_at IS NULL;--> statement-breakpoint

GRANT SELECT (text_state) ON TABLE public.case_law_decisions, public.case_law_published_decisions,
  public.case_law_unredacted_decisions TO stella_public_law_reader;
