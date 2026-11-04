SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A local run's blocking question can now be answered from chat. The command
-- kind check gains run.answer, and the request id is also recorded on the
-- event whose chunk pauses the run for a question, so an answer is matched to
-- the question as an approval is to its request. Both checks are replaced by
-- wider NOT VALID checks and validated online.
-- stella-migration-safety: reviewed drop-constraint - the command kind check is immediately replaced by a wider NOT VALID check that also accepts run.answer; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "desktop_runner_commands" DROP CONSTRAINT IF EXISTS "desktop_runner_commands_kind_check";--> statement-breakpoint
ALTER TABLE "desktop_runner_commands" ADD CONSTRAINT "desktop_runner_commands_kind_check"
  CHECK ("kind" IN ('run.start','run.input','run.approval','run.answer','run.interrupt','run.cancel')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the request check is immediately replaced by a wider NOT VALID check that also lets a run.event carry the request id of a question; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "desktop_runner_events" DROP CONSTRAINT IF EXISTS "desktop_runner_events_request_check";--> statement-breakpoint
ALTER TABLE "desktop_runner_events" ADD CONSTRAINT "desktop_runner_events_request_check"
  CHECK (("type" <> 'run.approval_request' OR "request_id" IS NOT NULL) AND ("type" <> 'run.finished' OR "request_id" IS NULL)) NOT VALID;--> statement-breakpoint
-- A chat turn can now wait on a local run's blocking question, a turn
-- interaction of its own ('harness-question'): the answer is the resume
-- payload of the question's interrupt, not a change to the call.
-- stella-migration-safety: reviewed drop-constraint - the interaction type check is immediately replaced by a wider NOT VALID check that also accepts harness-question; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "chat_turns" DROP CONSTRAINT IF EXISTS "chat_turns_interaction_values_check";--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_interaction_values_check"
  CHECK ("interaction_type" IS NULL OR "interaction_type" IN ('ask-user', 'approval', 'client-tool', 'harness-question')) NOT VALID;
