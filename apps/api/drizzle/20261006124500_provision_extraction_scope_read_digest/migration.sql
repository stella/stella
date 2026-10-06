SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - exposes only a scope-generation digest; the owner-only admission table stays unreadable to application roles.
CREATE FUNCTION public.case_law_provision_extraction_scope_generation_digest(requested_country varchar)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(coalesce(
    jsonb_agg(jsonb_build_array(scope.language, scope.generation::text) ORDER BY scope.language)::text,
    '[]'
  ), 'UTF8')), 'hex')
  FROM public.case_law_provision_extraction_scopes AS scope
  WHERE scope.country = requested_country
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.case_law_provision_extraction_scope_generation_digest(varchar) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.case_law_provision_extraction_scope_generation_digest(varchar) TO stella_public_law_reader;
