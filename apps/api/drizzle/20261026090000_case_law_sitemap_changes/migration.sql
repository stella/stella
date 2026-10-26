-- requires: 20261025180000_search_history_entry_country
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- The sitemap months a write touched. The refresh recounts each logged month
-- and deletes the rows it consumed, so an hourly run reads what changed
-- instead of the whole corpus. A month of `*` asks for a whole country, and a
-- country of `*` for every country. One row per month per transaction: a bulk
-- write logs each month once, and two transactions never share an `xact`, so
-- the conflict a repeated month meets is always the transaction's own row.
CREATE TABLE "case_law_sitemap_changes" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "case_law_sitemap_changes_id_seq"),
  "country" text NOT NULL,
  "year" text NOT NULL,
  "month" text NOT NULL,
  "xact" xid8 DEFAULT pg_current_xact_id() NOT NULL,
  CONSTRAINT "case_law_sitemap_changes_xact_month_key" UNIQUE ("xact", "country", "year", "month")
);--> statement-breakpoint

ALTER TABLE "case_law_sitemap_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner-run refresh and the owner's trigger
-- functions are bound by policy too. The owner role is named per deployment,
-- so the policy cannot name it; table privileges decide who reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all and stella none (revoked below); no other role is granted
CREATE POLICY "case_law_sitemap_change_owner_access" ON "case_law_sitemap_changes"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_sitemap_changes" FROM stella;--> statement-breakpoint

-- The snapshot horizon of the count each sitemap month was written from. A
-- month is replaced only from a count at least as new, so an overlapping run
-- that counted earlier cannot overwrite a newer count; an emptied month keeps
-- its row here, with no shard row left to carry the horizon.
CREATE TABLE "case_law_sitemap_month_horizons" (
  "country" text NOT NULL,
  "year" text NOT NULL,
  "month" text NOT NULL,
  "counted_horizon" xid8 NOT NULL,
  CONSTRAINT "case_law_sitemap_month_horizons_pkey" PRIMARY KEY ("country", "year", "month")
);--> statement-breakpoint

ALTER TABLE "case_law_sitemap_month_horizons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_month_horizons" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all and stella none (revoked below); no other role is granted
CREATE POLICY "case_law_sitemap_month_horizon_owner_access" ON "case_law_sitemap_month_horizons"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_sitemap_month_horizons" FROM stella;--> statement-breakpoint

-- A decision's shard is its country and month, the bucket of its id, its
-- source (the redistribution gate), its updated_at (the shard's last
-- modification) and its publication. A write that changes any of these, for
-- a decision published before or after it, logs the month the decision left
-- and the month it entered. The function runs as its owner: the writers of
-- case_law_decisions hold no privilege on the log.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only appends the months of the decision row that fired it
CREATE FUNCTION "log_case_law_sitemap_decision_change"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'INSERT'
    AND public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
  THEN
    INSERT INTO public.case_law_sitemap_changes (country, year, month)
    VALUES (
      OLD.country,
      COALESCE(to_char(OLD.decision_date, 'YYYY'), 'undated'),
      COALESCE(to_char(OLD.decision_date, 'MM'), '00')
    )
    ON CONFLICT ON CONSTRAINT case_law_sitemap_changes_xact_month_key DO NOTHING;
  END IF;
  IF TG_OP <> 'DELETE'
    AND public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
  THEN
    INSERT INTO public.case_law_sitemap_changes (country, year, month)
    VALUES (
      NEW.country,
      COALESCE(to_char(NEW.decision_date, 'YYYY'), 'undated'),
      COALESCE(to_char(NEW.decision_date, 'MM'), '00')
    )
    ON CONFLICT ON CONSTRAINT case_law_sitemap_changes_xact_month_key DO NOTHING;
  END IF;
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "log_case_law_sitemap_decision_change"() FROM PUBLIC;--> statement-breakpoint

-- A source's redistribution gates every decision it holds. No index finds the
-- countries of one source's decisions, and the gate rarely changes, so a
-- change asks for every country; the refresh lists the countries itself.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only appends one every-country row to the sitemap change log
CREATE FUNCTION "log_case_law_sitemap_source_change"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.case_law_sitemap_changes (country, year, month)
  VALUES ('*', '*', '*')
  ON CONFLICT ON CONSTRAINT case_law_sitemap_changes_xact_month_key DO NOTHING;
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "log_case_law_sitemap_source_change"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_sitemap_insert"
AFTER INSERT ON "case_law_decisions"
FOR EACH ROW
WHEN (public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at))
EXECUTE FUNCTION "log_case_law_sitemap_decision_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_sitemap_delete"
AFTER DELETE ON "case_law_decisions"
FOR EACH ROW
WHEN (public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at))
EXECUTE FUNCTION "log_case_law_sitemap_decision_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_sitemap_update"
AFTER UPDATE OF "id", "country", "decision_date", "source_id", "updated_at", "metadata", "redacted_at" ON "case_law_decisions"
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
    OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    OR public.case_law_statute_citation_is_published(OLD.metadata, OLD.redacted_at)
      IS DISTINCT FROM public.case_law_statute_citation_is_published(NEW.metadata, NEW.redacted_at)
  )
)
EXECUTE FUNCTION "log_case_law_sitemap_decision_change"();--> statement-breakpoint

CREATE TRIGGER "case_law_sources_sitemap_redistribution"
AFTER UPDATE OF "descriptor" ON "case_law_sources"
FOR EACH ROW
WHEN (
  (OLD.descriptor IS NULL OR (OLD.descriptor ->> 'allowsRedistribution') = 'true')
    IS DISTINCT FROM (NEW.descriptor IS NULL OR (NEW.descriptor ->> 'allowsRedistribution') = 'true')
)
EXECUTE FUNCTION "log_case_law_sitemap_source_change"();--> statement-breakpoint

-- The first runs recount every country through the change log.
INSERT INTO "case_law_sitemap_changes" ("country", "year", "month")
VALUES ('*', '*', '*');--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the staged per-country counts served only the whole-corpus walk this change log replaces; nothing else reads them
DROP TABLE "case_law_sitemap_shard_counts";
