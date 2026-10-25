import { panic } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const describePostgres = describe.skipIf(!runPostgresTests);

const migrationStatements = readFileSync(
  path.resolve(
    import.meta.dir,
    "../../drizzle/20261023151000_mcp_oauth_current_state/migration.sql",
  ),
  "utf-8",
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const indexBuildPosition = migrationStatements.findIndex((statement) =>
  statement.includes("CREATE UNIQUE INDEX"),
);
if (indexBuildPosition < 1) {
  panic("The migration builds its unique index after deduplication");
}

const backendPid = async (session: ReservedSQL): Promise<number> => {
  const rows = await session<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return rows.at(0)?.pid ?? panic("Missing backend pid");
};

describePostgres("mcp OAuth current-state migration (postgres)", () => {
  test("a pending authorization written between deduplication and the index build waits and cannot duplicate", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const observer = openClient();
      const migration = await openClient().sql.reserve();
      const application = await openClient().sql.reserve();
      const schema = `mcp_oauth_current_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const organizationId = "oauth-current-org";
      const userId = "oauth-current-user";
      const connectorId = Bun.randomUUIDv7();
      const otherConnectorId = Bun.randomUUIDv7();
      const insertAttempt = async (
        session: ReservedSQL,
        attempt: { connectorId: string; createdAt: string; state: string },
      ) =>
        await session`INSERT INTO mcp_oauth_state (
            state, organization_id, connector_id, user_id, code_verifier,
            redirect_uri, resource_url, authorization_server_url, created_at
          ) VALUES (
            ${attempt.state}, ${organizationId}, ${attempt.connectorId},
            ${userId}, 'verifier', 'https://app.example.test/callback',
            'https://mcp.example.test', 'https://auth.example.test',
            ${attempt.createdAt}
          )`;
      let pendingWrite: Promise<unknown> | undefined;
      try {
        // LIKE derives the fixture's columns from the migrated schema without
        // its unique index; a private search path keeps the run isolated.
        await migration
          .unsafe(
            `
          CREATE SCHEMA ${schema};
          CREATE TABLE ${schema}.mcp_oauth_state (LIKE public.mcp_oauth_state INCLUDING DEFAULTS);
        `,
          )
          .simple();
        await migration.unsafe(`SET search_path TO ${schema}, public`);
        await application.unsafe(`SET search_path TO ${schema}, public`);
        // Read both identities first: a blocked session answers nothing.
        const migrationPid = await backendPid(migration);
        const applicationPid = await backendPid(application);

        // Two attempts share the newest timestamp; the larger state key wins.
        await insertAttempt(migration, {
          connectorId,
          createdAt: "2026-10-23T10:00:00Z",
          state: "state-oldest",
        });
        await insertAttempt(migration, {
          connectorId,
          createdAt: "2026-10-23T11:00:00Z",
          state: "state-tied-a",
        });
        await insertAttempt(migration, {
          connectorId,
          createdAt: "2026-10-23T11:00:00Z",
          state: "state-tied-b",
        });
        await insertAttempt(migration, {
          connectorId: otherConnectorId,
          createdAt: "2026-10-23T09:00:00Z",
          state: "state-other-connector",
        });

        await migration`BEGIN`;
        for (const statement of migrationStatements.slice(
          0,
          indexBuildPosition,
        )) {
          // db-await-in-loop: migration statements run in their file order.
          await migration.unsafe(statement);
        }

        // The running application starts another authorization for the
        // retained scope after deduplication and before the index exists.
        pendingWrite = rejectionOf(
          insertAttempt(application, {
            connectorId,
            createdAt: "2026-10-23T12:00:00Z",
            state: "state-during-migration",
          }),
        );
        await waitForBlockedPid(observer.sql, {
          holdingPid: migrationPid,
          waitingPid: applicationPid,
        });

        for (const statement of migrationStatements.slice(indexBuildPosition)) {
          // db-await-in-loop: migration statements run in their file order.
          await migration.unsafe(statement);
        }
        await migration`COMMIT`;

        expect(getPgErrorCode(await pendingWrite)).toBe("23505");
        const retained = await observer.sql.unsafe<
          { connector_id: string; state: string }[]
        >(
          `SELECT connector_id, state FROM ${schema}.mcp_oauth_state ORDER BY state`,
        );
        expect([...retained]).toEqual([
          { connector_id: otherConnectorId, state: "state-other-connector" },
          { connector_id: connectorId, state: "state-tied-b" },
        ]);
      } finally {
        await migration`ROLLBACK`;
        await Promise.allSettled(
          [pendingWrite].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        await migration
          .unsafe(
            `RESET search_path; RESET lock_timeout; RESET statement_timeout; DROP SCHEMA IF EXISTS ${schema} CASCADE`,
          )
          .simple();
        await application.release();
        await migration.release();
      }
    });
  });
});
