SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legislation_documents"
  VALIDATE CONSTRAINT "legislation_documents_slug_shape";
