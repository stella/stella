SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A certified email (Italian PEC) records its certification data as stated
-- in its uploaded file; email and data-box rows keep it null, so the previous
-- release's inserts stay valid during the rollout.
ALTER TABLE "correspondence" ADD COLUMN IF NOT EXISTS "certified_email_envelope" jsonb;--> statement-breakpoint

-- The checks are added NOT VALID; the registered online repairs validate
-- them through the canonical contention gate.
-- stella-migration-safety: reviewed drop-constraint - replaced in this transaction by a check that admits every existing email and data-box row and adds the pec channel with an email direction
-- squawk-ignore ban-drop-constraint
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_direction_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_direction_check" CHECK ((("channel" <> 'data_box' and "direction" in ('in', 'out')) or ("channel" = 'data_box' and "direction" is null)) is true) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - replaced in this transaction by a check that admits every existing email and data-box row and adds the pec channel
-- squawk-ignore ban-drop-constraint
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_channel_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_channel_check" CHECK ("channel" in ('email', 'data_box', 'pec')) NOT VALID;--> statement-breakpoint
-- Only an uploaded file files a certified email, and only that channel
-- carries certification data.
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_certified_email_check" CHECK ((("channel" = 'pec') = ("certified_email_envelope" is not null) and ("channel" <> 'pec' or ("source" = 'upload' and jsonb_typeof("certified_email_envelope") = 'object' and "certified_email_envelope"->>'system' = 'pec'))) is true) NOT VALID;
