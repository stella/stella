SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate outside the DDL transaction so the scans do not retain the locks
-- taken while replacing the constraints. Restore bounded timeouts before
-- reopening a transaction for the migrator's bookkeeping row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

ALTER TABLE "corpus_index_projection_intents"
  -- squawk-ignore prefer-robust-stmts -- Validates the additive intent check outside the DDL transaction.
  VALIDATE CONSTRAINT "corpus_projection_intents_append_request_count_positive";
--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  -- squawk-ignore prefer-robust-stmts -- Validates the additive state check outside the DDL transaction.
  VALIDATE CONSTRAINT "corpus_index_projection_states_append_mode_values";
--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  -- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID check from the preceding migration outside the DDL transaction.
  VALIDATE CONSTRAINT "corpus_index_projection_states_failure_kind_values";
--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  -- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID check from the preceding migration outside the DDL transaction.
  VALIDATE CONSTRAINT "corpus_index_projection_states_work_shape";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
