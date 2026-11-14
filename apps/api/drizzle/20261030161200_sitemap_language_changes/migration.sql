SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - replace the sitemap update trigger atomically to enqueue language-only changes; its existing function and privileges remain unchanged
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
    OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    OR public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
      IS DISTINCT FROM public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
  )
)
EXECUTE FUNCTION "log_case_law_sitemap_decision_change"();--> statement-breakpoint
