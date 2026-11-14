SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- Hold pending-authorization writes while the duplicate cleanup selects the
-- newest row for each user and connector. SHARE ROW EXCLUSIVE blocks inserts,
-- updates and deletes but not reads. The table holds only short-lived pending
-- OAuth attempts, so the write block is brief.
LOCK TABLE "mcp_oauth_state" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Keep the newest pending authorization for each user and connector before
-- making that current-generation rule structural. The tie-break on the state
-- key makes the kept row deterministic.
-- stella-migration-safety: reviewed delete-data - superseded OAuth attempts are ephemeral; rollback does not restore them, and users can restart authorization
DELETE FROM "mcp_oauth_state" AS older
USING "mcp_oauth_state" AS newer
WHERE older."organization_id" = newer."organization_id"
  AND older."connector_id" = newer."connector_id"
  AND older."user_id" = newer."user_id"
  AND (older."created_at", older."state") < (newer."created_at", newer."state");
