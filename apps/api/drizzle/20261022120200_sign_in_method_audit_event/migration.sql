SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replace the check atomically with its expanded set; existing event values remain valid for running tasks, and transaction rollback restores the original constraint.
ALTER TABLE "account_audit_logs" DROP CONSTRAINT "account_audit_logs_event_type_check";--> statement-breakpoint
ALTER TABLE "account_audit_logs" ADD CONSTRAINT "account_audit_logs_event_type_check"
  CHECK ("event_type" IN ('account.data_export.requested', 'account.data_export.ready', 'account.data_export.downloaded', 'account.data_export.expired', 'account.sign_in_method.disconnected'));
