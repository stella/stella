import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const describePostgres = describe.skipIf(!runPostgresTests);
const validationSql = readFileSync(
  path.resolve(
    import.meta.dir,
    "../../drizzle/20261004001100_validate_matter_membership_organization_membership/migration.sql",
  ),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");

describePostgres("matter membership validation (postgres)", () => {
  test("repair audits converge across transaction replay and committed reruns", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const session = await openClient().sql.reserve();
      const schema = `membership_validation_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const workspaceId = Bun.randomUUIDv7();
      const orphanId = Bun.randomUUIDv7();
      const secondOrphanId = Bun.randomUUIDv7();
      const retainedId = Bun.randomUUIDv7();
      const migration = validationSql.replaceAll("public.", () => `${schema}.`);
      const readAudits = async () =>
        await session<
          Record<string, unknown>[]
        >`SELECT id, resource_id, changes, metadata,
          organization_id, workspace_id, user_id, action, resource_type,
          performer_type, trigger_type, trigger_source_id, activity_category
          FROM audit_logs ORDER BY user_id`;
      try {
        // LIKE derives the fixture's column types and defaults from the
        // migrated schema; a private search path keeps the repair isolated.
        await session
          .unsafe(`
          CREATE SCHEMA ${schema};
          SET search_path TO ${schema}, public;
          CREATE TABLE workspaces (LIKE public.workspaces INCLUDING DEFAULTS);
          CREATE TABLE workspace_members (LIKE public.workspace_members INCLUDING DEFAULTS);
          CREATE TABLE member (LIKE public.member INCLUDING DEFAULTS);
          CREATE TABLE audit_logs (LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
        `)
          .simple();
        await session`INSERT INTO workspaces (id, organization_id, name, reference)
          VALUES (${workspaceId}, 'validation-org', 'Matter', ${workspaceId})`;
        await session`INSERT INTO workspace_members (id, workspace_id, user_id)
          VALUES (${orphanId}, ${workspaceId}, 'departed-user'),
                 (${secondOrphanId}, ${workspaceId}, 'departed-user-2'),
                 (${retainedId}, ${workspaceId}, 'retained-user')`;
        await session`INSERT INTO member (id, organization_id, user_id, role, created_at)
          VALUES ('validation-member', 'validation-org', 'retained-user', 'member', '2026-10-04T00:00:00Z')`;

        await session.unsafe(migration).simple();
        const firstAudits = await readAudits();
        expect(firstAudits).toHaveLength(2);
        expect(firstAudits.at(0)).toMatchObject({
          resource_id: orphanId,
          organization_id: "validation-org",
          workspace_id: workspaceId,
          user_id: "departed-user",
          action: "delete",
          resource_type: "workspace_member",
          changes: {
            deleted: {
              old: { userId: "departed-user", workspaceId },
              new: null,
            },
          },
          metadata: { cause: "organization_membership_missing" },
          performer_type: "service",
          trigger_type: "system",
          trigger_source_id:
            "20261004001100_validate_matter_membership_organization_membership",
          activity_category: "team",
        });
        expect(firstAudits.at(1)).toMatchObject({
          resource_id: secondOrphanId,
          user_id: "departed-user-2",
        });
        await session`ROLLBACK`;
        const restoredMemberships = await session<
          { id: string }[]
        >`SELECT id FROM workspace_members`;
        expect(restoredMemberships).toHaveLength(3);
        const rolledBackAudits = await session<
          { id: string }[]
        >`SELECT id FROM audit_logs`;
        expect(rolledBackAudits).toHaveLength(0);

        await session.unsafe(migration).simple();
        await session`COMMIT`;
        const replayAudits = await readAudits();
        expect(replayAudits).toEqual(firstAudits);
        const remainingMemberships = await session<
          { id: string }[]
        >`SELECT id FROM workspace_members`;
        expect(remainingMemberships).toEqual([{ id: retainedId }]);
        const timestamps = await session<
          { recorded: boolean }[]
        >`SELECT bool_and(created_at IS NOT NULL) AS recorded FROM audit_logs`;
        expect(timestamps).toEqual([{ recorded: true }]);

        await session.unsafe(migration).simple();
        await session`COMMIT`;
        expect(await readAudits()).toEqual(firstAudits);
      } finally {
        await session`ROLLBACK`;
        await session
          .unsafe(`RESET search_path; DROP SCHEMA IF EXISTS ${schema} CASCADE`)
          .simple();
        session.release();
      }
    });
  }, 30_000);
});
