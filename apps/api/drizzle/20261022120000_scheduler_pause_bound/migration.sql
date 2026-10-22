SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "scheduler_jobs"
  ADD COLUMN "paused_since" timestamp with time zone;
--> statement-breakpoint

-- Bound existing open-ended pauses before the check: a row that keeps
-- 'infinity' would fail every later update of that row, including the boot
-- upsert. An indefinite pause becomes the 72-hour maximum (its start stays
-- NULL, so the audit reports it at once); '-infinity' never paused anything.
UPDATE "scheduler_jobs"
  SET paused_until = CURRENT_TIMESTAMP + interval '72 hours'
  WHERE paused_until = 'infinity';
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
