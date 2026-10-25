SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- Hold new pending authorizations from the running application until the
-- unique index exists, so none can land between deduplication and the build.
-- SHARE ROW EXCLUSIVE blocks inserts, updates and deletes but not reads, and
-- the index build's SHARE lock fits under it. The table holds only short-lived
-- pending OAuth attempts, so the write block is brief.
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
--> statement-breakpoint
-- The uniqueness must hold over the rows this transaction just deduplicated
-- under the table lock above; a concurrent build outside it would race new
-- pending attempts.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "mcp_oauth_state_org_connector_user_uidx"
  ON "mcp_oauth_state" ("organization_id", "connector_id", "user_id");
