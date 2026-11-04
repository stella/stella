SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Case-law decisions whose ranking signals may have moved since their
-- projection was derived (apps/api/src/lib/legal-search/case-law-ranking-signals.ts).
-- A generation that stores the signals on every passage fingerprints them, so
-- such a decision needs its desired state reconciled; the projection append
-- cycle drains this table and does that. One row per decision: a change while
-- the row waits bumps `change_count` and releases a claim, so a drain that read
-- the older count leaves the row for the next one. No foreign key, so the
-- trigger never waits on the decision row and a deleted decision is simply
-- dropped by the drain.
CREATE TABLE "case_law_ranking_signal_changes" (
  "decision_id" uuid NOT NULL,
  "change_count" bigint DEFAULT 1 NOT NULL,
  "enqueued_at" timestamptz DEFAULT now() NOT NULL,
  "claimed_until" timestamptz,
  CONSTRAINT "case_law_ranking_signal_changes_pkey" PRIMARY KEY ("decision_id"),
  CONSTRAINT "case_law_ranking_signal_changes_count_positive" CHECK ("change_count" > 0)
);--> statement-breakpoint

-- The drain reads the oldest rows first.
CREATE INDEX "case_law_ranking_signal_changes_enqueued_idx"
  ON "case_law_ranking_signal_changes" USING btree ("enqueued_at", "decision_id");--> statement-breakpoint

ALTER TABLE "case_law_ranking_signal_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_ranking_signal_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner's trigger functions are bound by policy
-- too. The owner role is named per deployment, so the policy cannot name it;
-- table privileges decide who reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: only the owner's trigger functions insert, the ingestion role's drain reads and deletes, and the request role is granted nothing
CREATE POLICY "case_law_ranking_signal_changes_owner_access" ON "case_law_ranking_signal_changes"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_ranking_signal_changes"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_ranking_signal_changes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_ranking_signal_changes" FROM stella;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "case_law_ranking_signal_changes" TO stella_ingestion;--> statement-breakpoint
GRANT UPDATE ("claimed_until") ON TABLE "case_law_ranking_signal_changes" TO stella_ingestion;--> statement-breakpoint

-- `citationAuthorityBucket` in SQL, rendered from `citationAuthorityBucketSql`
-- (case-law-ranking-signals.ts); `case-law-ranking-signal-changes.db.test.ts`
-- proves this function and the TypeScript bucket agree on every bucket edge.
-- Changing the bucket count is a new generation and a new function.
CREATE FUNCTION "case_law_citation_authority_bucket"(authority double precision)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT (CASE
  WHEN authority IS NULL
    OR NOT (authority > 0)
    OR authority IN ('Infinity'::double precision, 'NaN'::double precision)
  THEN 0
  ELSE least(
    1 + floor(64::double precision * (authority / (authority + 1)))::integer,
    64
  )
END) $function$;--> statement-breakpoint

-- An authority write that moved the decision's bucket. Runs as its owner, so
-- the writers of case_law_decisions (both citation-authority sweeps) need no
-- privileges on the change table.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only upserts the updated decision's id into the ranking-signal change table
CREATE FUNCTION "log_case_law_ranking_signal_authority_change"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.case_law_ranking_signal_changes (decision_id)
  VALUES (NEW.id)
  ON CONFLICT ON CONSTRAINT case_law_ranking_signal_changes_pkey DO UPDATE
    SET change_count = case_law_ranking_signal_changes.change_count + 1,
        enqueued_at = now(),
        claimed_until = NULL;
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "log_case_law_ranking_signal_authority_change"() FROM PUBLIC;--> statement-breakpoint

-- A decision entered or left a language group, or its publication changed:
-- whether each member of the group it left and of the group it entered shares
-- its group may have changed. Every member is enqueued, the decision itself
-- included, bounded per group; a reconcile that finds the same fingerprint
-- writes nothing.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only upserts the ids of the decisions sharing the old and new language group key into the ranking-signal change table
CREATE FUNCTION "log_case_law_ranking_signal_group_change"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.language_group_key IS NOT NULL THEN
    INSERT INTO public.case_law_ranking_signal_changes (decision_id)
    SELECT member.id
    FROM public.case_law_decisions member
    WHERE member.language_group_key = OLD.language_group_key
    ORDER BY member.id
    LIMIT 256
    ON CONFLICT ON CONSTRAINT case_law_ranking_signal_changes_pkey DO UPDATE
      SET change_count = case_law_ranking_signal_changes.change_count + 1,
          enqueued_at = now(),
          claimed_until = NULL;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.language_group_key IS NOT NULL THEN
    INSERT INTO public.case_law_ranking_signal_changes (decision_id)
    SELECT member.id
    FROM public.case_law_decisions member
    WHERE member.language_group_key = NEW.language_group_key
    ORDER BY member.id
    LIMIT 256
    ON CONFLICT ON CONSTRAINT case_law_ranking_signal_changes_pkey DO UPDATE
      SET change_count = case_law_ranking_signal_changes.change_count + 1,
          enqueued_at = now(),
          claimed_until = NULL;
  END IF;
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "log_case_law_ranking_signal_group_change"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_ranking_signal_authority"
AFTER UPDATE OF "citation_authority" ON "case_law_decisions"
FOR EACH ROW
WHEN (
  public.case_law_citation_authority_bucket(OLD.citation_authority)
    IS DISTINCT FROM public.case_law_citation_authority_bucket(NEW.citation_authority)
)
EXECUTE FUNCTION "log_case_law_ranking_signal_authority_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_ranking_signal_group_insert"
AFTER INSERT ON "case_law_decisions"
FOR EACH ROW
WHEN (
  NEW.language_group_key IS NOT NULL
  AND public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
)
EXECUTE FUNCTION "log_case_law_ranking_signal_group_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_ranking_signal_group_delete"
AFTER DELETE ON "case_law_decisions"
FOR EACH ROW
WHEN (
  OLD.language_group_key IS NOT NULL
  AND public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
)
EXECUTE FUNCTION "log_case_law_ranking_signal_group_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_ranking_signal_group_update"
AFTER UPDATE OF "language_group_key", "metadata", "redacted_at" ON "case_law_decisions"
FOR EACH ROW
WHEN (
  OLD.language_group_key IS DISTINCT FROM NEW.language_group_key
  OR public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
    IS DISTINCT FROM public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
)
EXECUTE FUNCTION "log_case_law_ranking_signal_group_change"();
