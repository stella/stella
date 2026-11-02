SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A data-box message records its envelope; email rows keep it null, so the
-- previous release's inserts stay valid during the rollout.
ALTER TABLE "correspondence" ADD COLUMN IF NOT EXISTS "data_box_envelope" jsonb;--> statement-breakpoint
-- The organization's own data boxes decide a filed message's direction. The
-- constant default needs no table rewrite.
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "data_box_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- The registered online phase builds contacts_data_box_ids_idx through its
-- contention gate after these catalog-only changes commit.
-- squawk-ignore ban-drop-not-null -- Data-box direction is derived on reads; the replacement CHECK still requires a valid direction on every email row.
ALTER TABLE "correspondence" ALTER COLUMN "direction" DROP NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - email retains its existing direction domain; data-box direction is derived on reads
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_direction_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_direction_check" CHECK ((("channel" = 'email' and "direction" in ('in', 'out')) or ("channel" = 'data_box' and "direction" is null)) is true) NOT VALID;--> statement-breakpoint
-- The checks are added NOT VALID; the registered online repairs validate
-- them through the canonical contention gate.
-- stella-migration-safety: reviewed drop-constraint - replaced in this transaction by a check that admits every existing email row and adds the data-box channel
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_channel_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_channel_check" CHECK ("channel" in ('email', 'data_box')) NOT VALID;--> statement-breakpoint
-- Data-box envelopes contain only the uploaded file's assertions. Direction
-- and its basis are derived from current organization settings on reads.
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_data_box_check" CHECK ((("channel" = 'data_box') = ("data_box_envelope" is not null) and ("channel" <> 'data_box' or ("source" = 'upload' and "message_id" is not null and jsonb_typeof("data_box_envelope") = 'object' and "data_box_envelope"->>'messageId' = "message_id" and not ("data_box_envelope" ? 'directionBasis')))) is true) NOT VALID;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_data_box_ids_check" CHECK (jsonb_typeof("data_box_ids") = 'array' AND jsonb_array_length("data_box_ids") <= 20) NOT VALID;
