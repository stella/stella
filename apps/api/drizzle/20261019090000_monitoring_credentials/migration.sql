-- requires: 20261019070000_monitoring_session
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "folio_collab_room_tokens" ADD COLUMN "source_session_id" text;--> statement-breakpoint
ALTER TABLE "folio_collab_room_tokens" ADD CONSTRAINT "folio_collab_room_tokens_source_session_id_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "session" ("id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
