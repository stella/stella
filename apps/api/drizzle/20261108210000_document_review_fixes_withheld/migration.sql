SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- How many fixes a review run did not stage because its requester could not
-- open every matter its reference text came from. A constant default, so the
-- column is added without rewriting the table.
ALTER TABLE "document_review_runs" ADD COLUMN "fixes_withheld" integer DEFAULT 0 NOT NULL;
