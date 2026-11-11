SET lock_timeout = '3s';
SET statement_timeout = '30s';

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
    ON CONFLICT (id) DO NOTHING;
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

CREATE TRIGGER document_review_findings_decision_history
AFTER UPDATE OF decision ON public.document_review_findings
FOR EACH ROW WHEN (OLD.decision IS DISTINCT FROM NEW.decision)
EXECUTE FUNCTION public.stella_document_review_finding_decision_history();

CREATE TRIGGER document_review_findings_decision_history_insert
AFTER INSERT ON public.document_review_findings
FOR EACH ROW WHEN (NEW.decision <> 'open')
EXECUTE FUNCTION public.stella_document_review_finding_decision_history();

REVOKE ALL ON FUNCTION public.stella_document_review_finding_decision_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stella_document_review_finding_decision_history() TO stella;
