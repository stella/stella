import type { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: PGlite;

beforeAll(async () => {
  client = await createTestPglite();
}, 120_000);

afterAll(async () => {
  await client.close();
});

const CONSTRAINT = "workspace_members_organization_member";

const VALIDATION_MIGRATION_SQL = readFileSync(
  nodePath.resolve(
    import.meta.dir,
    "../../drizzle/20261004001100_validate_matter_membership_organization_membership/migration.sql",
  ),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");

const observeFailure = async (operation: Promise<unknown>) =>
  (
    await Result.tryPromise({
      try: async () => await operation,
      catch: (error) => error,
    })
  ).match({ ok: () => undefined, err: (error) => error });

/** Two organizations, a matter in each, three users with no memberships yet. */
const fixture = async () => {
  const organizations = [Bun.randomUUIDv7(), Bun.randomUUIDv7()] as const;
  const matters = [Bun.randomUUIDv7(), Bun.randomUUIDv7()] as const;
  const users = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()];
  for (const id of users) {
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Matter member', $2)`,
      [id, `${id}@matter-membership.test`],
    );
  }
  for (const [index, organizationId] of organizations.entries()) {
    await client.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Matter membership', $1, now())`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO workspaces (id, organization_id, name, reference) VALUES ($1, $2, 'Matter', $3)`,
      [matters[index], organizationId, `matter-${String(matters[index])}`],
    );
  }
  const addMember = async (organizationId: string, userId: string) =>
    await client.query(
      `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'member', now())`,
      [Bun.randomUUIDv7(), organizationId, userId],
    );
  const addMatterMember = async (workspaceId: string, userId: string) =>
    await client.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id) VALUES ($1, $2, $3)`,
      [Bun.randomUUIDv7(), workspaceId, userId],
    );
  const matterMembers = async () =>
    (
      await client.query<{ workspaceId: string; userId: string }>(
        `SELECT workspace_id AS "workspaceId", user_id AS "userId"
         FROM workspace_members WHERE workspace_id = ANY($1::uuid[])
         ORDER BY workspace_id, user_id`,
        [[...matters]],
      )
    ).rows;
  const orphans = async () =>
    (
      await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.workspace_id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM member m
             WHERE m.organization_id = w.organization_id AND m.user_id = wm.user_id
           )`,
        [[...matters]],
      )
    ).rows.at(0)?.count;
  return {
    organizations,
    matters,
    users,
    addMember,
    addMatterMember,
    matterMembers,
    orphans,
    cleanUp: async () => {
      await client.query(
        `DELETE FROM organization WHERE id = ANY($1::text[])`,
        [[...organizations]],
      );
      await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
        users,
      ]);
    },
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

const applyStep = async (
  data: Fixture,
  kind: "join" | "grant" | "leave",
  ids: { organizationId: string; workspaceId: string; userId: string },
) => {
  if (kind === "join") {
    return await data.addMember(ids.organizationId, ids.userId);
  }
  if (kind === "grant") {
    return await data.addMatterMember(ids.workspaceId, ids.userId);
  }
  return await client.query(
    `DELETE FROM member WHERE organization_id = $1 AND user_id = $2`,
    [ids.organizationId, ids.userId],
  );
};

describe("matter membership requires organization membership", () => {
  test("a matter membership without its organization membership is refused", async () => {
    const data = await fixture();
    try {
      const [userId] = data.users;
      if (!userId) {
        throw new Error("fixture user");
      }
      // A membership of another organization does not count.
      await data.addMember(data.organizations[1], userId);
      expect(
        await observeFailure(data.addMatterMember(data.matters[0], userId)),
      ).toMatchObject({ code: "23503", constraint: CONSTRAINT });
      await data.addMember(data.organizations[0], userId);
      await data.addMatterMember(data.matters[0], userId);
      expect(await data.matterMembers()).toEqual([
        { workspaceId: data.matters[0], userId },
      ]);
    } finally {
      await data.cleanUp();
    }
  });

  test("leaving an organization removes exactly that organization's matter memberships", async () => {
    const data = await fixture();
    try {
      const [userId, colleagueId] = data.users;
      if (!userId || !colleagueId) {
        throw new Error("fixture users");
      }
      for (const organizationId of data.organizations) {
        await data.addMember(organizationId, userId);
      }
      await data.addMember(data.organizations[0], colleagueId);
      for (const workspaceId of data.matters) {
        await data.addMatterMember(workspaceId, userId);
      }
      await data.addMatterMember(data.matters[0], colleagueId);
      await client.query(
        `DELETE FROM member WHERE organization_id = $1 AND user_id = $2`,
        [data.organizations[0], userId],
      );
      expect(await data.matterMembers()).toEqual(
        [
          { workspaceId: data.matters[0], userId: colleagueId },
          { workspaceId: data.matters[1], userId },
        ].toSorted(
          (left, right) =>
            compareCodeUnit(left.workspaceId, right.workspaceId) ||
            compareCodeUnit(left.userId, right.userId),
        ),
      );
    } finally {
      await data.cleanUp();
    }
  });

  test("a matter cannot move to an organization its members do not belong to", async () => {
    const data = await fixture();
    try {
      const [userId] = data.users;
      if (!userId) {
        throw new Error("fixture user");
      }
      await data.addMember(data.organizations[0], userId);
      await data.addMatterMember(data.matters[0], userId);
      expect(
        await observeFailure(
          client.query(
            `UPDATE workspaces SET organization_id = $1 WHERE id = $2`,
            [data.organizations[1], data.matters[0]],
          ),
        ),
      ).toMatchObject({ code: "23503", constraint: CONSTRAINT });
      const [, outsiderId] = data.users;
      expect(
        await observeFailure(
          client.query(
            `UPDATE workspace_members SET user_id = $1 WHERE workspace_id = $2`,
            [outsiderId, data.matters[0]],
          ),
        ),
      ).toMatchObject({ code: "23503", constraint: CONSTRAINT });
      expect(await data.matterMembers()).toEqual([
        { workspaceId: data.matters[0], userId },
      ]);
    } finally {
      await data.cleanUp();
    }
  });

  test("validation removes and audits memberships an earlier state left without an organization membership", async () => {
    const data = await fixture();
    try {
      const [leaverId, colleagueId] = data.users;
      if (!leaverId || !colleagueId) {
        throw new Error("fixture users");
      }
      for (const userId of [leaverId, colleagueId]) {
        await data.addMember(data.organizations[0], userId);
        await data.addMatterMember(data.matters[0], userId);
      }
      // A database from before the reference: the organization membership
      // went away without its matter membership.
      await client.exec(`SET session_replication_role = replica`);
      await client.query(
        `DELETE FROM member WHERE organization_id = $1 AND user_id = $2`,
        [data.organizations[0], leaverId],
      );
      await client.exec(`SET session_replication_role = origin`);
      expect(await data.orphans()).toBe(1);
      const [orphan] = (
        await client.query<{ id: string }>(
          `SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
          [data.matters[0], leaverId],
        )
      ).rows;
      if (!orphan) {
        throw new Error("fixture orphan");
      }

      await client.exec(VALIDATION_MIGRATION_SQL);
      await client.exec(`COMMIT`);
      await client.exec(`RESET lock_timeout; RESET statement_timeout`);

      expect(await data.orphans()).toBe(0);
      expect(await data.matterMembers()).toEqual([
        { workspaceId: data.matters[0], userId: colleagueId },
      ]);
      const audits = await client.query<{
        organizationId: string;
        workspaceId: string;
        action: string;
        resourceType: string;
        changes: unknown;
        metadata: unknown;
        performerType: string;
        triggerType: string;
        triggerSourceId: string;
        activityCategory: string;
      }>(
        `SELECT organization_id AS "organizationId",
                workspace_id AS "workspaceId",
                action,
                resource_type AS "resourceType",
                changes,
                metadata,
                performer_type AS "performerType",
                trigger_type AS "triggerType",
                trigger_source_id AS "triggerSourceId",
                activity_category AS "activityCategory"
         FROM audit_logs WHERE resource_id = $1`,
        [orphan.id],
      );
      expect(audits.rows).toEqual([
        {
          organizationId: data.organizations[0],
          workspaceId: data.matters[0],
          action: "delete",
          resourceType: "workspace_member",
          changes: {
            deleted: {
              old: { userId: leaverId, workspaceId: data.matters[0] },
              new: null,
            },
          },
          metadata: { cause: "organization_membership_missing" },
          performerType: "service",
          triggerType: "system",
          triggerSourceId:
            "20261004001100_validate_matter_membership_organization_membership",
          activityCategory: "team",
        },
      ]);
    } finally {
      await data.cleanUp();
    }
  });

  test("no sequence of membership changes leaves a matter member outside the organization", async () => {
    const operation = fc.oneof(
      fc.record({
        kind: fc.constantFrom("join", "leave"),
        organization: fc.integer({ min: 0, max: 1 }),
        user: fc.integer({ min: 0, max: 2 }),
      }),
      fc.record({
        kind: fc.constant("grant"),
        organization: fc.integer({ min: 0, max: 1 }),
        user: fc.integer({ min: 0, max: 2 }),
      }),
    );
    await assertProperty(
      "no sequence of membership changes leaves a matter member outside the organization",
      fc.asyncProperty(
        fc.array(operation, { minLength: 1, maxLength: 12 }),
        async (operations) => {
          const data = await fixture();
          try {
            for (const step of operations) {
              const organizationId = data.organizations[step.organization];
              const workspaceId = data.matters[step.organization];
              const userId = data.users.at(step.user);
              if (!organizationId || !workspaceId || !userId) {
                throw new Error("fixture index");
              }
              // db-await-in-loop: each step observes the previous one.
              const failure = await observeFailure(
                applyStep(data, step.kind, {
                  organizationId,
                  workspaceId,
                  userId,
                }),
              );
              // Refusals are the reference and the existing uniqueness rules.
              if (failure !== undefined) {
                expect(failure).toMatchObject({
                  code: expect.stringMatching(/^23(?:503|505)$/u),
                });
              }
              expect(await data.orphans()).toBe(0);
            }
          } finally {
            await data.cleanUp();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
