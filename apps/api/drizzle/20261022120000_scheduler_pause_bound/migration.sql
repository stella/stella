SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "scheduler_jobs"
  ADD COLUMN "paused_since" timestamp with time zone;
--> statement-breakpoint

-- Enforced for every new write; not validated, because rows written before the
-- bound may still hold an open-ended deadline. The application owns these rows
-- and bounds such pauses at boot before it updates any row
-- (boundSchedulerPauses in apps/api/src/lib/scheduler/jobs.ts).
ALTER TABLE "scheduler_jobs"
  ADD CONSTRAINT "scheduler_jobs_pause_finite_check" CHECK (
    paused_until IS NULL OR isfinite(paused_until)
  ) NOT VALID;
--> statement-breakpoint

-- The pause audit watches every pause, so it can never be paused itself. Its
-- row is created by this release, so no existing row can violate the check.
ALTER TABLE "scheduler_jobs"
  ADD CONSTRAINT "scheduler_jobs_pause_audit_unpausable_check" CHECK (
    id <> 'scheduler.pauseAudit.hourly' OR paused_until IS NULL
  ) NOT VALID;
--> statement-breakpoint

-- scheduler_jobs holds one row per declared job and scheduled flow, so the
-- build is short, and lock_timeout above bounds the wait for its lock.
-- squawk-ignore require-concurrent-index-creation
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
