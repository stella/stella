SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "scheduler_jobs"
  ADD COLUMN "paused_by" text,
  ADD COLUMN "paused_until" timestamp with time zone,
  ADD COLUMN "pause_reason" text;
--> statement-breakpoint

CREATE FUNCTION public.scheduler_job_pause_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE LOG '%', json_build_object(
    'event', CASE
      WHEN NEW.paused_until > CURRENT_TIMESTAMP THEN 'scheduler.job.paused'
      ELSE 'scheduler.job.resumed'
    END,
    'job', NEW.id,
    'paused_by', NEW.paused_by,
    'pause_reason', NEW.pause_reason,
    'paused_until', NEW.paused_until,
    'previous_paused_until', OLD.paused_until
  )::text;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER scheduler_job_pause_log
AFTER UPDATE OF paused_until ON "scheduler_jobs"
FOR EACH ROW
WHEN (OLD.paused_until IS DISTINCT FROM NEW.paused_until)
EXECUTE FUNCTION public.scheduler_job_pause_log();
