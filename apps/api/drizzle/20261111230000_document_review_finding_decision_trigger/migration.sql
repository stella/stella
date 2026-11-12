SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint

-- The decision history is written by the database, not by each writer: every
-- path that changes a finding's decision (the decide handler, a staged
-- suggestion, a carried-over decision, a script) gets its event, so no writer
-- can leave a decided finding without one.
--
-- A finding decided before its history began gets that earlier decision as
-- its baseline first, keyed by the finding's own id exactly as the online
-- backfill keys it, so the two add it at most once between them. A decision
-- event carries its decider and moment from the row; a reopening clears both,
-- so it takes the acting user from the transaction's scope and the moment it
-- happened.
CREATE FUNCTION public.stella_document_review_finding_decision_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.decision <> 'open' THEN
    INSERT INTO public.document_review_finding_decisions
      (id, workspace_id, finding_id, decision, reason, actor_id, created_at)
    SELECT OLD.id, OLD.workspace_id, OLD.id,
           CASE OLD.decision WHEN 'accepted' THEN 'accepted' WHEN 'dismissed' THEN 'rejected' END,
           NULL, OLD.decided_by, coalesce(OLD.decided_at, clock_timestamp())
     WHERE NOT EXISTS (
       SELECT 1 FROM public.document_review_finding_decisions AS event
        WHERE event.finding_id = OLD.id
     )
    ON CONFLICT ON CONSTRAINT document_review_finding_decisions_pkey DO NOTHING;
  END IF;
  INSERT INTO public.document_review_finding_decisions
    (id, workspace_id, finding_id, decision, reason, actor_id, created_at)
  VALUES (
    gen_random_uuid(), NEW.workspace_id, NEW.id,
    CASE NEW.decision WHEN 'accepted' THEN 'accepted' WHEN 'dismissed' THEN 'rejected' END,
    NULL,
    CASE WHEN NEW.decision = 'open'
      THEN nullif(current_setting('app.user_id', true), '')
      ELSE NEW.decided_by END,
    CASE WHEN NEW.decision = 'open'
      THEN clock_timestamp()
      ELSE coalesce(NEW.decided_at, clock_timestamp()) END
  );
  RETURN NULL;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER document_review_findings_decision_history
AFTER UPDATE OF decision ON public.document_review_findings
FOR EACH ROW WHEN (OLD.decision IS DISTINCT FROM NEW.decision)
EXECUTE FUNCTION public.stella_document_review_finding_decision_history();
--> statement-breakpoint

CREATE TRIGGER document_review_findings_decision_history_insert
AFTER INSERT ON public.document_review_findings
FOR EACH ROW WHEN (NEW.decision <> 'open')
EXECUTE FUNCTION public.stella_document_review_finding_decision_history();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_document_review_finding_decision_history() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_document_review_finding_decision_history() TO stella;
--> statement-breakpoint

-- While a deploy rolls, tasks of the previous release still append the event
-- for a decision they change, after the trigger above has already written it
-- from the same UPDATE. Their event has its own random id, so the conflict on
-- id cannot catch it: a second event for the same finding, decision and actor
-- from the same transaction is that same change written twice, and is
-- dropped. (Their baseline already collides on the finding's id.) No writer
-- of this release appends an event itself, so outside a rolling deploy this
-- drops nothing.
CREATE FUNCTION public.stella_document_review_finding_decision_once() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.document_review_finding_decisions AS event
     WHERE event.finding_id = NEW.finding_id
       AND event.decision IS NOT DISTINCT FROM NEW.decision
       AND event.actor_id IS NOT DISTINCT FROM NEW.actor_id
       AND event.xmin::text = (txid_current() % 4294967296)::text
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER document_review_finding_decisions_once
BEFORE INSERT ON public.document_review_finding_decisions
FOR EACH ROW EXECUTE FUNCTION public.stella_document_review_finding_decision_once();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_document_review_finding_decision_once() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_document_review_finding_decision_once() TO stella;
