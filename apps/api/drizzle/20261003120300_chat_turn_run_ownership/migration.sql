SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The client-minted id of a turn's latest run, bound when the run starts.
-- Nullable with no default, so adding it rewrites no row.
ALTER TABLE "chat_turns" ADD COLUMN IF NOT EXISTS "run_id" text;
--> statement-breakpoint

-- A turn whose owner stopped producing (its lease expired, or its process
-- shut down) ends as `owner-lost`.
-- stella-migration-safety: reviewed drop-constraint - replaces the interruption reason CHECK with a strictly wider set in the same transaction; rollback restores the prior CHECK once no row holds 'owner-lost'
ALTER TABLE "chat_turns"
  DROP CONSTRAINT IF EXISTS "chat_turns_interruption_reason_values_check";
--> statement-breakpoint

ALTER TABLE "chat_turns"
  ADD CONSTRAINT "chat_turns_interruption_reason_values_check"
  CHECK ("interruption_reason" IS NULL OR "interruption_reason" IN ('client-disconnected', 'owner-lost', 'timeout')) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- the statement above added the constraint NOT VALID; the widened set rejects no row the prior one accepted
ALTER TABLE "chat_turns" VALIDATE CONSTRAINT "chat_turns_interruption_reason_values_check";
--> statement-breakpoint

-- The caller can check a run id before metered preflight even when another
-- member owns the turn. Return one bit only, for the caller's claimed turn.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; verifies the session organization, user, and execution before reading another turn's run id
CREATE OR REPLACE FUNCTION public.chat_turn_run_id_taken(
  p_turn_id uuid, p_execution_id uuid, p_run_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.chat_turns claimed
      JOIN public.chat_turns existing
        ON existing.organization_id = claimed.organization_id
       AND existing.run_id = p_run_id
       AND existing.id <> claimed.id
     WHERE claimed.id = p_turn_id
       AND claimed.execution_id = p_execution_id
       AND claimed.status = 'running'
       AND claimed.organization_id = pg_catalog.current_setting('app.organization_id', true)
       AND claimed.user_id = pg_catalog.current_setting('app.user_id', true)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chat_turn_run_id_taken(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.chat_turn_run_id_taken(uuid, uuid, text) TO stella;
--> statement-breakpoint

-- A run id names one turn in its organization. Built without blocking turn
-- writes while an existing deployment is upgraded.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- The online phase validates this index after the ledger update and repairs
-- an interrupted INVALID build. IF NOT EXISTS preserves an already-valid
-- uniqueness boundary across retries without rebuilding it.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "chat_turns_org_run_id_uidx"
  ON "chat_turns" ("organization_id", "run_id")
  WHERE "run_id" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
