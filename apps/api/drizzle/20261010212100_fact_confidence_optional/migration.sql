-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '5s';
SET statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "legal_list_fact_details" ALTER COLUMN "confidence" DROP NOT NULL;
