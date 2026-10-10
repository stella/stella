SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Existing desktop credentials predate mandatory device binding. Disable the
-- entire prior configuration at rollout without decoding untrusted metadata.
UPDATE public.apikey
SET enabled = false
WHERE config_id = 'desktop-registry' AND enabled = true;
