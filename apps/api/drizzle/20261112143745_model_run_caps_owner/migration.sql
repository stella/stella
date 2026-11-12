-- requires: 20260811140000_document_review_runs
-- requires: 20261005120400_list_verification_run_caps
-- requires: 20261109190000_list_fact_extraction_runs
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- One counter table for every capped kind of model run, keyed by
-- organization and kind. The list counter keeps its rows in place as the
-- `list-run` kind: nothing is copied or re-derived, and a run in flight frees
-- the slot it took when it ends.

CREATE FUNCTION stella_model_run_day(instant timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT (instant AT TIME ZONE 'Europe/Prague')::date $$;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the list counter triggers are replaced below, in this transaction, by triggers that keep the same counter rows through the generic function
DROP TRIGGER legal_list_verification_budget_insert ON legal_list_verification_runs;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - the list counter triggers are replaced below, in this transaction, by triggers that keep the same counter rows through the generic function
DROP TRIGGER legal_list_verification_budget_update ON legal_list_verification_runs;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - the list counter triggers are replaced below, in this transaction, by triggers that keep the same counter rows through the generic function
DROP TRIGGER legal_list_verification_budget_delete ON legal_list_verification_runs;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - the list counter triggers are replaced below, in this transaction, by triggers that keep the same counter rows through the generic function
DROP TRIGGER legal_list_generation_budget_insert ON legal_list_generation_runs;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - the list counter triggers are replaced below, in this transaction, by triggers that keep the same counter rows through the generic function
DROP TRIGGER legal_list_generation_budget_update ON legal_list_generation_runs;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - the list counter triggers are replaced below, in this transaction, by triggers that keep the same counter rows through the generic function
DROP TRIGGER legal_list_generation_budget_delete ON legal_list_generation_runs;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - no trigger calls the list-only counter function any more; maintain_model_run_budget replaces it
DROP FUNCTION maintain_list_verification_budget();--> statement-breakpoint

-- stella-migration-safety: reviewed rename-table-or-column - the list counter becomes the counter of every model run kind; its rows stay in place and the API that reads it ships in the same release
ALTER TABLE "legal_list_verification_budgets" RENAME TO "model_run_budgets";--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - renames the counter's constraint after its table; the constraint itself is unchanged
ALTER TABLE "model_run_budgets" RENAME CONSTRAINT "legal_list_verification_budgets_org_fk" TO "model_run_budgets_org_fk";--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - renames the counter's constraint after its table; the constraint itself is unchanged
ALTER TABLE "model_run_budgets" RENAME CONSTRAINT "legal_list_verification_budgets_nonnegative" TO "model_run_budgets_nonnegative";--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - renames the counter's constraint after its table; the constraint itself is unchanged
ALTER TABLE "model_run_budgets" RENAME CONSTRAINT "legal_list_verification_budgets_limits" TO "model_run_budgets_limits";--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - renames the policy after its table; its role and expressions are unchanged
ALTER POLICY "legal_list_verification_budgets_owner_access" ON "model_run_budgets" RENAME TO "model_run_budgets_owner_access";--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - renames the policy after its table; its role and expressions are unchanged
ALTER POLICY "legal_list_verification_budgets_no_delete" ON "model_run_budgets" RENAME TO "model_run_budgets_no_delete";--> statement-breakpoint

ALTER TABLE "model_run_budgets" ALTER COLUMN "starts_day" SET DEFAULT stella_model_run_day(CURRENT_TIMESTAMP);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - the day function was renamed with the counter; no column default, function or trigger calls the old name any more
DROP FUNCTION stella_list_verification_day(timestamptz);--> statement-breakpoint

-- Every existing counter is the list counter. The default is a constant, so
-- adding the column rewrites no row.
ALTER TABLE "model_run_budgets" ADD COLUMN "run_kind" text DEFAULT 'list-run' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_run_budgets" ALTER COLUMN "run_kind" DROP DEFAULT;--> statement-breakpoint
-- The counter holds one row per organization and kind; every existing row
-- holds 'list-run', so the check passes as it is added.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "model_run_budgets" ADD CONSTRAINT "model_run_budgets_run_kind_check" CHECK ("run_kind" IN ('list-run', 'document-review'));--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint, add-unique-constraint - the counter key widens from the organization to the organization and kind in one statement, so the table is never without a key; every existing row is unique by organization alone
-- squawk-ignore disallowed-unique-constraint
ALTER TABLE "model_run_budgets" DROP CONSTRAINT "legal_list_verification_budgets_pkey", ADD CONSTRAINT "model_run_budgets_pkey" PRIMARY KEY ("organization_id", "run_kind");--> statement-breakpoint

-- Whether a document review counts against the document review caps: a
-- review a person starts on one document does; a playbook run over a table
-- of documents is admitted as one batch and does not. Existing runs predate
-- the caps and were never counted, so they stay out.
ALTER TABLE "document_review_runs" ADD COLUMN "org_capped" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Keeps one kind's counter (TG_ARGV[0]) for the run table it is attached to.
-- An insert of a queued or running run charges an active slot and a start
-- and is refused past either cap; a status change in or out of the active
-- statuses moves the slot; a delete frees it. The limits come from the
-- starting transaction's settings, falling back to those the counter
-- recorded at its latest start. Row order is run, then counter, for starts
-- and terminal writes alike.
CREATE FUNCTION maintain_model_run_budget()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text := TG_ARGV[0];
  v_setting text := replace(TG_ARGV[0], '-', '_');
  v_org varchar(128);
  v_delta integer;
  v_day date;
  v_budget public.model_run_budgets%ROWTYPE;
  v_active_limit integer;
  v_daily_limit integer;
  v_starts integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id THEN
      RAISE EXCEPTION 'model run organization is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'model_run_organization_immutable';
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

  -- AFTER INSERT: a document-conflict no-op consumes no budget.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.model_run_budgets (organization_id, run_kind)
      VALUES (v_org, v_kind) ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO v_budget FROM public.model_run_budgets
    WHERE organization_id = v_org AND run_kind = v_kind FOR UPDATE;
  IF NOT FOUND THEN
    -- Organization deletion may cascade its counter before its run rows.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.organization WHERE id = v_org) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'model run organization counter is unavailable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'model_run_budget_required';
  END IF;
  v_day := public.stella_model_run_day(clock_timestamp());
  v_active_limit := coalesce(nullif(current_setting('app.model_run_active_limit_' || v_setting, true), '')::integer, v_budget.active_limit);
  v_daily_limit := coalesce(nullif(current_setting('app.model_run_daily_limit_' || v_setting, true), '')::integer, v_budget.daily_limit);
  v_starts := CASE WHEN v_budget.starts_day = v_day THEN v_budget.starts_today ELSE 0 END;
  IF current_user = 'stella' AND v_delta > 0 AND v_budget.active_runs + v_delta > v_active_limit THEN
    RAISE EXCEPTION 'active model run limit reached'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'model_run_active_cap';
  END IF;
  IF current_user = 'stella' AND TG_OP = 'INSERT' AND v_starts >= v_daily_limit THEN
    RAISE EXCEPTION 'daily model run limit reached'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'model_run_daily_cap';
  END IF;
  UPDATE public.model_run_budgets SET
    active_runs = active_runs + v_delta,
    starts_day = CASE WHEN TG_OP = 'INSERT' THEN v_day ELSE starts_day END,
    starts_today = CASE WHEN TG_OP = 'INSERT' THEN v_starts + 1 ELSE starts_today END,
    active_limit = CASE WHEN TG_OP = 'INSERT' THEN v_active_limit ELSE active_limit END,
    daily_limit = CASE WHEN TG_OP = 'INSERT' THEN v_daily_limit ELSE daily_limit END
    WHERE organization_id = v_org AND run_kind = v_kind;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION maintain_model_run_budget() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER legal_list_verification_runs_model_run_budget_insert
AFTER INSERT ON legal_list_verification_runs
FOR EACH ROW EXECUTE FUNCTION maintain_model_run_budget('list-run');--> statement-breakpoint
CREATE TRIGGER legal_list_verification_runs_model_run_budget_update
AFTER UPDATE OF status, organization_id ON legal_list_verification_runs
FOR EACH ROW EXECUTE FUNCTION maintain_model_run_budget('list-run');--> statement-breakpoint
CREATE TRIGGER legal_list_verification_runs_model_run_budget_delete
AFTER DELETE ON legal_list_verification_runs
FOR EACH ROW EXECUTE FUNCTION maintain_model_run_budget('list-run');--> statement-breakpoint

-- Only runs stella produces spend model calls; external runs are never
-- counted.
CREATE TRIGGER legal_list_generation_runs_model_run_budget_insert
AFTER INSERT ON legal_list_generation_runs
FOR EACH ROW WHEN (NEW.producer = 'stella')
EXECUTE FUNCTION maintain_model_run_budget('list-run');--> statement-breakpoint
CREATE TRIGGER legal_list_generation_runs_model_run_budget_update
AFTER UPDATE OF status, organization_id ON legal_list_generation_runs
FOR EACH ROW WHEN (NEW.producer = 'stella')
EXECUTE FUNCTION maintain_model_run_budget('list-run');--> statement-breakpoint
CREATE TRIGGER legal_list_generation_runs_model_run_budget_delete
AFTER DELETE ON legal_list_generation_runs
FOR EACH ROW WHEN (OLD.producer = 'stella')
EXECUTE FUNCTION maintain_model_run_budget('list-run');--> statement-breakpoint

CREATE TRIGGER document_review_runs_model_run_budget_insert
AFTER INSERT ON document_review_runs
FOR EACH ROW WHEN (NEW.org_capped)
EXECUTE FUNCTION maintain_model_run_budget('document-review');--> statement-breakpoint
CREATE TRIGGER document_review_runs_model_run_budget_update
AFTER UPDATE OF status, organization_id ON document_review_runs
FOR EACH ROW WHEN (NEW.org_capped)
EXECUTE FUNCTION maintain_model_run_budget('document-review');--> statement-breakpoint
CREATE TRIGGER document_review_runs_model_run_budget_delete
AFTER DELETE ON document_review_runs
FOR EACH ROW WHEN (OLD.org_capped)
EXECUTE FUNCTION maintain_model_run_budget('document-review');
