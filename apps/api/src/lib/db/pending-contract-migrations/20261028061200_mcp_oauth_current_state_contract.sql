-- requires: 20261028061000_mcp_oauth_current_state
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- The expand release deletes superseded states before its new writer begins
-- replacing them atomically. Repeat the cleanup after older writers have been
-- retired, covering attempts they may have inserted during that rollout.
-- stella-migration-safety: reviewed delete-data - superseded OAuth attempts are ephemeral; rollback does not restore them, and users can restart authorization
DELETE FROM "mcp_oauth_state" AS older
USING "mcp_oauth_state" AS newer
WHERE older."organization_id" = newer."organization_id"
  AND older."connector_id" = newer."connector_id"
  AND older."user_id" = newer."user_id"
  AND (older."created_at", older."state") < (newer."created_at", newer."state");--> statement-breakpoint

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "mcp_oauth_state_org_connector_user_uidx"
  ON "mcp_oauth_state" ("organization_id", "connector_id", "user_id");
