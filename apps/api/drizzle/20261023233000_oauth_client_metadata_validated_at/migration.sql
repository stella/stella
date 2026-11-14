SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- When a discovery-owned client's metadata document last passed a fetch and
-- validation; bounds how long the stored client keeps resolving while the
-- document cannot be revalidated. Nullable without a default, so the column is
-- added without rewriting the table.
ALTER TABLE "oauth_client" ADD COLUMN "metadata_validated_at" timestamptz;
