SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "invoice_lines"
  ADD COLUMN "exemption_reason" text;
