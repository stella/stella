-- requires: 20261005120400_list_verification_run_caps
-- requires: 20261109180000_list_generation_fact_details
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A generation run stella produces spends model calls like a verification,
-- so it counts against the same organization budget: the verification
-- counter's trigger function maintains it for these runs too. Runs an
-- external client produces spend nothing here and are never counted. Every
-- existing run is external, so no counter needs seeding.
CREATE TRIGGER legal_list_generation_budget_insert
AFTER INSERT ON legal_list_generation_runs
FOR EACH ROW WHEN (NEW.producer = 'stella')
EXECUTE FUNCTION maintain_list_verification_budget();--> statement-breakpoint
CREATE TRIGGER legal_list_generation_budget_update
AFTER UPDATE OF status, organization_id ON legal_list_generation_runs
FOR EACH ROW WHEN (NEW.producer = 'stella')
EXECUTE FUNCTION maintain_list_verification_budget();--> statement-breakpoint
CREATE TRIGGER legal_list_generation_budget_delete
AFTER DELETE ON legal_list_generation_runs
FOR EACH ROW WHEN (OLD.producer = 'stella')
EXECUTE FUNCTION maintain_list_verification_budget();
