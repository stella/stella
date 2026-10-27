SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_coverage_summaries" (
  "key" text PRIMARY KEY,
  "source_policy" text NOT NULL,
  "answer" jsonb NOT NULL,
  "generated_at" timestamptz NOT NULL,
  CONSTRAINT "case_law_coverage_summaries_singleton" CHECK ("key" = 'current'),
  CONSTRAINT "case_law_coverage_summaries_policy_array" CHECK (jsonb_typeof("source_policy"::jsonb) = 'array')
);--> statement-breakpoint

-- stella-migration-safety: reviewed row-level-security - applies only to the empty table created in this transaction
ALTER TABLE "case_law_coverage_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed row-level-security - applies only to the empty table created in this transaction
ALTER TABLE "case_law_coverage_summaries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed create-policy - installs owner access on the empty table created in this transaction
CREATE POLICY "case_law_coverage_summary_owner_access" ON "case_law_coverage_summaries"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_coverage_summaries'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_coverage_summaries'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_coverage_summaries" FROM stella;--> statement-breakpoint

-- A narrow function preserves the public reader's column-grant attestation:
-- preceding releases reject new table grants during a rolling deployment.
-- The same statement checks redistribution before returning the stored answer.
-- stella-migration-safety: reviewed security-definer - fixed search path and qualified relations, PUBLIC execute revoked; returns only the singleton summary after checking the current redistribution policy
CREATE FUNCTION public.stella_case_law_coverage_summary() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $function$
    SELECT summary.answer
    FROM public.case_law_coverage_summaries AS summary
    WHERE summary.key = 'current'
      AND summary.source_policy::jsonb = (
        SELECT coalesce(jsonb_agg(source.id::text ORDER BY source.id), '[]'::jsonb)
        FROM public.case_law_sources AS source
        WHERE NOT (
          source.descriptor IS NULL
          OR (source.descriptor ->> 'allowsRedistribution') = 'true'
        )
      )
  $function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_case_law_coverage_summary() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_case_law_coverage_summary() TO stella_public_law_reader;
