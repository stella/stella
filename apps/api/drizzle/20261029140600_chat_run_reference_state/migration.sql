SET lock_timeout = '3s';
SET statement_timeout = '30s';

ALTER TABLE "chat_run_logs" ADD COLUMN "reference_summary" jsonb DEFAULT '{"type":"legacy"}'::jsonb NOT NULL;
ALTER TABLE "chat_run_logs" ADD CONSTRAINT "chat_run_logs_reference_summary_size_check" CHECK (octet_length("reference_summary"::text) <= 65536) NOT VALID;
