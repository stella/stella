-- requires: 20260808014000_legal_lists
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legal_lists" ADD COLUMN "sample_case" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_lists_sample_workspace_uidx"
ON "legal_lists" ("workspace_id") WHERE "sample_case" IS NOT NULL;
