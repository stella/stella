-- requires: 20261003122400_invoice_document_types
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_date" date;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_amount" bigint;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_note" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_reference" varchar(256);
--> statement-breakpoint
-- Existing paid documents keep their historical signed total; no refund state is invented.
UPDATE "invoices" SET "paid_at" = COALESCE("paid_at", "updated_at"), "paid_date" = (COALESCE("paid_at", "updated_at") AT TIME ZONE 'UTC')::date, "paid_amount" = "total_amount" WHERE "status" = 'paid';
--> statement-breakpoint
-- Nullable coherent metadata keeps old mark_paid/void tasks compatible during rollout.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_state_check" CHECK (("paid_date" IS NULL AND "paid_amount" IS NULL AND "payment_note" IS NULL AND "payment_reference" IS NULL) OR ("paid_date" IS NOT NULL AND "paid_amount" IS NOT NULL AND "paid_amount" = "total_amount")) NOT VALID;
--> statement-breakpoint
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_payment_state_check";
