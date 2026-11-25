SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A run on the member's computer can now be sent the member's website
-- approvals while it runs. The command kind check gains run.site_grants; it
-- is replaced by a wider NOT VALID check and validated online.
-- stella-migration-safety: reviewed drop-constraint - the command kind check is immediately replaced by a wider NOT VALID check that also accepts run.site_grants; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "desktop_runner_commands" DROP CONSTRAINT IF EXISTS "desktop_runner_commands_kind_check";--> statement-breakpoint
ALTER TABLE "desktop_runner_commands" ADD CONSTRAINT "desktop_runner_commands_kind_check"
  CHECK ("kind" IN ('run.start','run.input','run.approval','run.answer','run.site_grants','run.interrupt','run.cancel')) NOT VALID;
