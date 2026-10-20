-- requires: 20261020130000_cross_source_decision_aliases
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE public.case_law_decision_source_identities
  ADD COLUMN raw_owner_decision_id uuid;--> statement-breakpoint

UPDATE public.case_law_decision_source_identities
   SET raw_owner_decision_id = decision_id
 WHERE raw_owner_decision_id IS NULL;--> statement-breakpoint

ALTER TABLE public.case_law_decision_source_identities
  ALTER COLUMN raw_owner_decision_id SET NOT NULL;
