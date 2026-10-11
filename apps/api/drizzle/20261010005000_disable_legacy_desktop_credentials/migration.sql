SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Disable desktop credentials during the device-binding rollout; desktops sign
-- in again. Matches by configuration, without decoding stored metadata.
UPDATE public.apikey
SET enabled = false
WHERE config_id = 'desktop-registry' AND enabled = true;
