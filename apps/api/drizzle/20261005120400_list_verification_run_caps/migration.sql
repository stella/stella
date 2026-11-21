-- requires: 20260925220000_legal_list_verifications
-- requires: 20261005120300_list_verification_access_revoked
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE FUNCTION stella_list_verification_day(instant timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT (instant AT TIME ZONE 'Europe/Prague')::date $$;--> statement-breakpoint

CREATE TABLE "legal_list_verification_budgets" (
  "organization_id" varchar(128) PRIMARY KEY,
  "active_runs" integer NOT NULL DEFAULT 0,
  "starts_day" date NOT NULL DEFAULT stella_list_verification_day(CURRENT_TIMESTAMP),
  "starts_today" integer NOT NULL DEFAULT 0,
  "active_limit" integer NOT NULL DEFAULT 2,
  "daily_limit" integer NOT NULL DEFAULT 20,
  CONSTRAINT "legal_list_verification_budgets_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_verification_budgets_nonnegative" CHECK (active_runs >= 0 AND starts_today >= 0),
  CONSTRAINT "legal_list_verification_budgets_limits" CHECK (active_limit BETWEEN 1 AND 100 AND daily_limit BETWEEN 1 AND 1000)
);--> statement-breakpoint
ALTER TABLE "legal_list_verification_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_verification_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_list_verification_budgets" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "legal_list_verification_budgets" FOR SELECT TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "legal_list_verification_budgets" FOR INSERT TO stella
  WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "legal_list_verification_budgets" FOR UPDATE TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "legal_list_verification_budgets" FOR DELETE TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "legal_list_verification_budgets_no_delete" ON "legal_list_verification_budgets"
  AS RESTRICTIVE FOR DELETE TO stella USING (false);--> statement-breakpoint
-- Scheduler terminal transitions maintain the organization counters.
CREATE POLICY "legal_list_verification_budgets_owner_access" ON "legal_list_verification_budgets"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_budgets'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_budgets'::regclass));--> statement-breakpoint

CREATE FUNCTION maintain_list_verification_budget()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org varchar(128);
  v_delta integer;
  v_day date;
  v_budget public.legal_list_verification_budgets%ROWTYPE;
  v_active_limit integer;
  v_daily_limit integer;
  v_starts integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id THEN
      RAISE EXCEPTION 'verification organization is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_list_verification_organization_immutable';
    END IF;
    v_delta := (NEW.status IN ('queued', 'running'))::integer - (OLD.status IN ('queued', 'running'))::integer;
    IF v_delta = 0 THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_delta := (NEW.status IN ('queued', 'running'))::integer;
  ELSE
    v_delta := -(OLD.status IN ('queued', 'running'))::integer;
    IF v_delta = 0 THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN v_org := OLD.organization_id;
  ELSE v_org := NEW.organization_id; END IF;

  -- Row order is run then organization for both starts and terminal writes.
  -- AFTER INSERT also means a document-conflict no-op consumes no budget.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.legal_list_verification_budgets (organization_id)
      VALUES (v_org) ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO v_budget FROM public.legal_list_verification_budgets
    WHERE organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    -- Organization deletion may cascade its counter before its run rows.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.organization WHERE id = v_org) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'verification organization counter is unavailable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_list_verification_budget_required';
  END IF;
  v_day := public.stella_list_verification_day(clock_timestamp());
  v_active_limit := coalesce(nullif(current_setting('app.list_verification_active_limit', true), '')::integer, v_budget.active_limit);
  v_daily_limit := coalesce(nullif(current_setting('app.list_verification_daily_limit', true), '')::integer, v_budget.daily_limit);
  v_starts := CASE WHEN v_budget.starts_day = v_day THEN v_budget.starts_today ELSE 0 END;
  IF current_user = 'stella' AND v_delta > 0 AND v_budget.active_runs + v_delta > v_active_limit THEN
    RAISE EXCEPTION 'active verification limit reached'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_list_verification_active_cap';
  END IF;
  IF current_user = 'stella' AND TG_OP = 'INSERT' AND v_starts >= v_daily_limit THEN
    RAISE EXCEPTION 'daily verification limit reached'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_list_verification_daily_cap';
  END IF;
  UPDATE public.legal_list_verification_budgets SET
    active_runs = active_runs + v_delta,
    starts_day = CASE WHEN TG_OP = 'INSERT' THEN v_day ELSE starts_day END,
    starts_today = CASE WHEN TG_OP = 'INSERT' THEN v_starts + 1 ELSE starts_today END,
    active_limit = CASE WHEN TG_OP = 'INSERT' THEN v_active_limit ELSE active_limit END,
    daily_limit = CASE WHEN TG_OP = 'INSERT' THEN v_daily_limit ELSE daily_limit END
    WHERE organization_id = v_org;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION maintain_list_verification_budget() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER legal_list_verification_budget_insert
AFTER INSERT ON legal_list_verification_runs
FOR EACH ROW EXECUTE FUNCTION maintain_list_verification_budget();--> statement-breakpoint
CREATE TRIGGER legal_list_verification_budget_update
AFTER UPDATE OF status, organization_id ON legal_list_verification_runs
FOR EACH ROW EXECUTE FUNCTION maintain_list_verification_budget();--> statement-breakpoint
CREATE TRIGGER legal_list_verification_budget_delete
AFTER DELETE ON legal_list_verification_runs
FOR EACH ROW EXECUTE FUNCTION maintain_list_verification_budget();--> statement-breakpoint

-- Trigger installation holds the run table's write lock through this seed.
-- stella-migration-safety: reviewed insert-select - initialize the new organization counters from existing verification rows while trigger installation serializes run writes
WITH existing_runs AS (
  SELECT organization_id, status,
    stella_list_verification_day(created_at) AS starts_day,
    max(stella_list_verification_day(created_at)) OVER (PARTITION BY organization_id) AS latest_day
  FROM legal_list_verification_runs
)
INSERT INTO legal_list_verification_budgets (organization_id, active_runs, starts_day, starts_today)
SELECT organization_id,
  count(*) FILTER (WHERE status IN ('queued', 'running'))::integer,
  max(latest_day),
  count(*) FILTER (WHERE starts_day = latest_day)::integer
FROM existing_runs GROUP BY organization_id;
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - extend the closed verification error-code domain for budget refusals; all existing values remain accepted
ALTER TABLE legal_list_verification_runs DROP CONSTRAINT legal_list_verification_runs_error_code_check;--> statement-breakpoint
ALTER TABLE legal_list_verification_runs ADD CONSTRAINT legal_list_verification_runs_error_code_check
CHECK ((status = 'failed') = (error_code IS NOT NULL)
  AND (error_code IS NULL OR error_code IN (
    'pin_unresolved', 'pin_content_changed', 'unsupported_format', 'no_text',
    'ai_unavailable', 'extraction_failed', 'grading_failed', 'enqueue_failed',
    'access_revoked', 'run_limit_reached', 'internal'
  ))) NOT VALID;
