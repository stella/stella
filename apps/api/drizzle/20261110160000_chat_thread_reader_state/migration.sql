SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- When the reader last had each chat open, and when they pinned it. A chat
-- reads unread while its latest answer settled after last_read_at. The
-- default is evaluated once for the existing rows, so every chat already
-- answered starts read and no row is rewritten; nothing reads either column
-- until this release.
ALTER TABLE "chat_threads" ADD COLUMN "last_read_at" timestamptz DEFAULT now();--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "pinned_at" timestamptz;

-- The pinned-chats index (chat_threads_org_user_pinned_idx) is built
-- concurrently after deploy by its online migration entry in
-- apps/api/src/db/online-migration-entries/.
