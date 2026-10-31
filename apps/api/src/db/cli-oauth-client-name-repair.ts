import {
  CLI_CLIENT_DISPLAY_NAME,
  CLI_LOOPBACK_REGISTRATION_METADATA_JSON,
  CLI_LOOPBACK_REGISTRATION_PREDICATE_SQL,
} from "../lib/auth/cli-client-registration";
import type {
  CodeOwnedOnlineStep,
  OnlineRepair,
} from "./online-migration-connection";

// DCR clients retain their IDs: replacing a registration would orphan its
// existing consents and refresh tokens. Only the CLI's released public native
// registration shape is eligible; this does not grant a verified identity.
const LEGACY_CLI_CLIENT = `name = 'stella-cli'
  AND registration_origin IN ('historical', 'open-client')
  AND client_discovery_id IS NULL
  AND jsonb_build_object(${CLI_LOOPBACK_REGISTRATION_PREDICATE_SQL}) = $1::text::jsonb`;
const BATCH_SIZE = 200;
const REPAIR_NAME = "cli-oauth-client-display-name";
const RETRY_AFTER_MS = 1000;

export const CLI_OAUTH_CLIENT_NAME_REPAIR = {
  name: REPAIR_NAME,
  introducedBy: {
    type: "code",
    owner: "src/db/cli-oauth-client-name-repair.ts",
  },
  readCompletion: async (connection) => {
    const pending = await connection.query(
      `SELECT 1 FROM oauth_client WHERE ${LEGACY_CLI_CLIENT} LIMIT 1`,
      [CLI_LOOPBACK_REGISTRATION_METADATA_JSON],
    );
    return pending.length === 0
      ? { type: "complete" }
      : { type: "incomplete", reason: "CLI client display names are pending" };
  },
  repair: async (connection) => {
    await connection.execute("BEGIN");
    try {
      await connection.execute("SET LOCAL lock_timeout = '1s'");
      await connection.execute("SET LOCAL statement_timeout = '10s'");
      const updated = await connection.query(
        `WITH batch AS (
            SELECT id FROM oauth_client WHERE ${LEGACY_CLI_CLIENT}
            ORDER BY id LIMIT $2
          )
          UPDATE oauth_client target SET name = $3, updated_at = now()
          FROM batch WHERE target.id = batch.id AND ${LEGACY_CLI_CLIENT}
          RETURNING target.id`,
        [
          CLI_LOOPBACK_REGISTRATION_METADATA_JSON,
          BATCH_SIZE,
          CLI_CLIENT_DISPLAY_NAME,
        ],
      );
      await connection.execute("COMMIT");
      if (updated.length === 0) {
        return { type: "complete" };
      }
      process.stderr.write(
        `${JSON.stringify({ event: "oauth_cli_display_name_updated", count: updated.length })}\n`,
      );
      // Each migration pass commits at most one batch before yielding.
      return {
        type: "deferred",
        step: REPAIR_NAME,
        retryAfterMs: RETRY_AFTER_MS,
      };
    } catch (error: unknown) {
      // Raw transaction boundary: keep the reserved migration session usable.
      await connection.execute("ROLLBACK");
      throw error;
    }
  },
} satisfies OnlineRepair & { introducedBy: CodeOwnedOnlineStep };
