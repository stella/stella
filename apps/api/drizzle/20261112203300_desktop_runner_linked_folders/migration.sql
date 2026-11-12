SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The folders a member linked on a computer, as its runner reports them (id,
-- name and state; never a path), and the ones the member let runs work in.
-- Constant defaults, so adding them rewrites no row.
ALTER TABLE "desktop_runners" ADD COLUMN "linked_folders" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_runners" ADD COLUMN "approved_folder_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint

-- The linked folder a run works in, so an undo of its files restores that
-- folder; null for runs in the chat's own folder.
ALTER TABLE "desktop_runner_runs" ADD COLUMN "linked_folder_id" uuid;
