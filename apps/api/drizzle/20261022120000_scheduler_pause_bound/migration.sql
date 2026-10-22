SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "scheduler_jobs"
  ADD COLUMN "paused_since" timestamp with time zone;
--> statement-breakpoint

-- Bound existing pauses before the check: a row that keeps 'infinity' would
-- fail every later update of that row, including the boot upsert, and the
-- trigger below only sees future writes. Any pause ending beyond the 72-hour
-- maximum, 'infinity' included, ends at the maximum (its start stays NULL, so
-- the audit reports it at once); '-infinity' never paused anything.
UPDATE "scheduler_jobs"
  SET paused_until = CURRENT_TIMESTAMP + interval '72 hours'
  WHERE paused_until > CURRENT_TIMESTAMP + interval '72 hours';
--> statement-breakpoint

UPDATE "scheduler_jobs"
  SET paused_until = NULL
  WHERE paused_until = '-infinity';
--> statement-breakpoint

ALTER TABLE "scheduler_jobs"
  ADD CONSTRAINT "scheduler_jobs_pause_finite_check" CHECK (
    paused_until IS NULL OR isfinite(paused_until)
  );
--> statement-breakpoint

-- The pause audit watches every pause, so it can never be paused itself.
ALTER TABLE "scheduler_jobs"
  ADD CONSTRAINT "scheduler_jobs_pause_audit_unpausable_check" CHECK (
    id <> 'scheduler.pauseAudit.hourly' OR paused_until IS NULL
  );
--> statement-breakpoint

CREATE INDEX "scheduler_jobs_paused_until_idx" ON "scheduler_jobs" USING btree ("paused_until") WHERE "paused_until" IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.scheduler_job_pause_bound() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.paused_until > CURRENT_TIMESTAMP THEN
    IF NEW.paused_until > CURRENT_TIMESTAMP + interval '72 hours' THEN
      RAISE EXCEPTION 'Scheduler pauses have a 72-hour maximum; renew the pause by updating paused_until';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.paused_until > CURRENT_TIMESTAMP THEN
      NEW.paused_since = OLD.paused_since;
    ELSE
      NEW.paused_since = CURRENT_TIMESTAMP;
    END IF;
  ELSE
    NEW.paused_since = NULL;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER scheduler_job_pause_bound
BEFORE INSERT OR UPDATE OF paused_until ON "scheduler_jobs"
FOR EACH ROW
EXECUTE FUNCTION public.scheduler_job_pause_bound();
