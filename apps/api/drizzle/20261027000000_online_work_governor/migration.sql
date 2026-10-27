SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "online_work_state"
  ADD COLUMN "paused_by" text,
  ADD COLUMN "paused_since" timestamp with time zone,
  ADD COLUMN "paused_until" timestamp with time zone,
  ADD COLUMN "pause_reason" text;
--> statement-breakpoint

-- Existing foundation spellings are normalized by the transition owner at runtime.
-- stella-migration-safety: reviewed drop-constraint - replace the closed state check with the five-state domain below
ALTER TABLE "online_work_state" DROP CONSTRAINT "online_work_state_state_check";
--> statement-breakpoint
ALTER TABLE "online_work_state" ADD CONSTRAINT "online_work_state_state_check"
  CHECK (state IN ('pending', 'running', 'paused', 'done', 'failed')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "online_work_state" ADD CONSTRAINT "online_work_state_pause_check"
  CHECK (paused_until IS NULL OR (
    isfinite(paused_until) AND paused_by IS NOT NULL AND length(btrim(paused_by)) > 0
    AND pause_reason IS NOT NULL AND length(btrim(pause_reason)) >= 8
  )) NOT VALID;
--> statement-breakpoint

CREATE FUNCTION public.online_work_pause_bound() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.paused_until > CURRENT_TIMESTAMP THEN
    IF NEW.paused_until > CURRENT_TIMESTAMP + interval '72 hours' THEN
      RAISE EXCEPTION 'Online work pauses have a 72-hour maximum';
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
CREATE TRIGGER online_work_pause_bound
BEFORE INSERT OR UPDATE OF paused_until ON "online_work_state"
FOR EACH ROW EXECUTE FUNCTION public.online_work_pause_bound();
--> statement-breakpoint

CREATE FUNCTION public.online_work_pause_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE LOG '%', json_build_object(
    'event', CASE WHEN NEW.paused_until > CURRENT_TIMESTAMP
      THEN 'online_work.step.paused' ELSE 'online_work.step.resumed' END,
    'step', NEW.name, 'paused_by', NEW.paused_by,
    'pause_reason', NEW.pause_reason, 'paused_until', NEW.paused_until,
    'previous_paused_until', OLD.paused_until
  )::text;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER online_work_pause_log
AFTER UPDATE OF paused_until ON "online_work_state"
FOR EACH ROW WHEN (OLD.paused_until IS DISTINCT FROM NEW.paused_until)
EXECUTE FUNCTION public.online_work_pause_log();

--> statement-breakpoint
-- Concrete compatibility boundary: foundation-release tasks use these two
-- spellings until rollout finishes. Remove this trigger after they are gone.
CREATE FUNCTION public.online_work_legacy_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.paused_until > CURRENT_TIMESTAMP THEN
    IF NEW.state = 'building' THEN
      RAISE EXCEPTION 'Online work step is operator-paused';
    END IF;
    IF NEW.state IN ('finalized', 'failed') THEN
      RETURN OLD;
    END IF;
  END IF;
  IF NEW.state = 'building' THEN NEW.state = 'running'; END IF;
  IF NEW.state = 'finalized' THEN NEW.state = 'done'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER online_work_legacy_state
BEFORE INSERT OR UPDATE OF state ON "online_work_state"
FOR EACH ROW EXECUTE FUNCTION public.online_work_legacy_state();
