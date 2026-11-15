SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_rotation_revokes_check" CHECK ("rotated_at" IS NULL OR "revoked" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_replay_window_check" CHECK ("rotation_replay_expires_at" IS NULL OR "rotated_at" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_replay_response_check" CHECK ("rotation_replay_response" IS NULL OR "rotation_replay_expires_at" IS NOT NULL) NOT VALID;
