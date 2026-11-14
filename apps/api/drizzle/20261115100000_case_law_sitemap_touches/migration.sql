SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Decisions whose newer updated_at is the only sitemap-relevant change of a
-- write. Such a write leaves every decision in its shard and every shard's
-- size unchanged, so the refresh folds it into the shard's last modification
-- and deletes the row, instead of recounting the decision's month.
CREATE TABLE "case_law_sitemap_touches" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "decision_id" uuid NOT NULL
);--> statement-breakpoint

ALTER TABLE "case_law_sitemap_touches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_touches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner-run refresh and the owner's trigger
-- function are bound by policy too. As on case_law_sitemap_changes, table
-- privileges decide who reaches the rows, and a constant policy leaves the
-- planner's row estimates for the ordered batch read intact.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: only the owner and the owner's trigger function write the queue; no role is granted
CREATE POLICY "case_law_sitemap_touch_owner_access" ON "case_law_sitemap_touches"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_sitemap_touches" FROM stella;--> statement-breakpoint

-- The function runs as its owner, so the writers of case_law_decisions need
-- no privilege on the touch queue.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only appends the updated decision's id to the sitemap touch queue
CREATE FUNCTION "log_case_law_sitemap_decision_touch"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.case_law_sitemap_touches (decision_id) VALUES (NEW.id);
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "log_case_law_sitemap_decision_touch"() FROM PUBLIC;--> statement-breakpoint

-- A write that can move a decision between shards, or lower a shard's last
-- modification, still logs its months for a recount: the publication gate,
-- the identity, country, date, source, language and language group, or an
-- updated_at that went back. A published decision that stays published with
-- all of those equal and a later updated_at only touches its shard.
-- stella-migration-safety: reviewed drop-object - replace the sitemap update trigger atomically so a later updated_at alone is folded rather than recounted; its function and privileges remain unchanged
DROP TRIGGER "case_law_decisions_sitemap_update" ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER "case_law_decisions_sitemap_update"
AFTER UPDATE OF "id", "country", "decision_date", "source_id", "language", "language_group_key", "updated_at", "metadata", "redacted_at" ON "case_law_decisions"
FOR EACH ROW
WHEN (
  (
    public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
    OR public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
  )
  AND (
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.country IS DISTINCT FROM NEW.country
    OR OLD.decision_date IS DISTINCT FROM NEW.decision_date
    OR OLD.source_id IS DISTINCT FROM NEW.source_id
    OR OLD.language IS DISTINCT FROM NEW.language
    OR OLD.language_group_key IS DISTINCT FROM NEW.language_group_key
    OR NEW.updated_at < OLD.updated_at
    OR public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
      IS DISTINCT FROM public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
  )
)
EXECUTE FUNCTION "log_case_law_sitemap_decision_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_sitemap_touch"
AFTER UPDATE OF "updated_at" ON "case_law_decisions"
FOR EACH ROW
WHEN (
  public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
  AND public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
  AND OLD.id IS NOT DISTINCT FROM NEW.id
  AND OLD.country IS NOT DISTINCT FROM NEW.country
  AND OLD.decision_date IS NOT DISTINCT FROM NEW.decision_date
  AND OLD.source_id IS NOT DISTINCT FROM NEW.source_id
  AND OLD.language IS NOT DISTINCT FROM NEW.language
  AND OLD.language_group_key IS NOT DISTINCT FROM NEW.language_group_key
  AND NEW.updated_at > OLD.updated_at
)
EXECUTE FUNCTION "log_case_law_sitemap_decision_touch"();
