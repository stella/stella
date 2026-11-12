SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint

-- A reviewer may say why they decided a finding. The decide handler sets
-- the reason for the one change it makes, transaction-locally, and the
-- history trigger writes it onto that change's event; every other writer
-- sets none, so its events carry no reason. A baseline for a decision taken
-- before the history began never carries one: it was not given to this
-- change.
--
-- A finding's events sort in the order its decision changed. A decision's
-- moment comes from the application (`decided_at`), a reopening's from the
-- database clock, and the two can disagree, so an event stamped at or
-- before the finding's latest one moves just past it: the history read in
-- time order always ends at the row's own decision.
--
-- The decision words are read through the one shared map
-- (`REVIEW_STATUS_DECISION.finding` in @stll/api-contract/review-decision);
-- a Postgres test runs this function for every entry of that map, so the
-- CASE below cannot drift from it.
CREATE OR REPLACE FUNCTION public.stella_document_review_finding_decision_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $function$
DECLARE
  moment timestamptz;
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
  moment := CASE WHEN NEW.decision = 'open'
    THEN clock_timestamp()
    ELSE coalesce(NEW.decided_at, clock_timestamp()) END;
  SELECT greatest(moment, max(event.created_at) + interval '1 microsecond')
    INTO moment
    FROM public.document_review_finding_decisions AS event
   WHERE event.finding_id = NEW.id;
  INSERT INTO public.document_review_finding_decisions
    (id, workspace_id, finding_id, decision, reason, actor_id, created_at)
  VALUES (
    gen_random_uuid(), NEW.workspace_id, NEW.id,
    CASE NEW.decision WHEN 'accepted' THEN 'accepted' WHEN 'dismissed' THEN 'rejected' END,
    nullif(current_setting('app.review_decision_reason', true), ''),
    CASE WHEN NEW.decision = 'open'
      THEN nullif(current_setting('app.user_id', true), '')
      ELSE NEW.decided_by END,
    moment
  );
  RETURN NULL;
END
$function$;
