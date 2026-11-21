-- requires: 20261003122900_sanctions_monitoring_marks
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.sanctions_contact_marks
 ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
 ADD CONSTRAINT sanctions_contact_marks_attempt_count_check CHECK (attempt_count >= 0) NOT VALID;--> statement-breakpoint
CREATE FUNCTION public.reset_sanctions_mark_retry() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.generation IS DISTINCT FROM OLD.generation THEN
  NEW.attempt_count := 0;
  NEW.next_attempt_at := TIMESTAMPTZ '1970-01-01 00:00:00+00';
 END IF;
 RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER sanctions_mark_retry_generation BEFORE UPDATE ON public.sanctions_contact_marks
 FOR EACH ROW EXECUTE FUNCTION public.reset_sanctions_mark_retry();
