ALTER TABLE "desktop_edit_sessions" ADD COLUMN "expiry_notification_published_at" timestamp;

CREATE INDEX "desktop_edit_sessions_expired_unnotified_idx" ON "desktop_edit_sessions" ("closed_at") WHERE "status" = 'expired' AND "expiry_notification_published_at" IS NULL;
