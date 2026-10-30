import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import fc from "fast-check";

import { roles } from "@stll/permissions";
import { assertProperty, propertyConfig } from "@stll/property-testing";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import { canUseFolioCollabWorkspace } from "@/api/lib/folio-collab-rooms";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasCurrentTimerMatterAccess } from "@/api/lib/time-entry-timer-access";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  memberReachesMatterSql,
  readAuthorizedWorkspaces,
} from "@/api/lib/workspaces/authorized-workspace-ids";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

/**
 * Differential test: every app-side matter access decision agrees with the
 * database's own rule (the authorization view the row policies consult) on
 * randomly generated organizations. A world has members in every organization
 * role plus a removed member (no `member` row), client and personal matters,
 * matters being deleted and random matter assignments. For each (user,
 * matter) the view decides; each app helper is fed the live rows exactly as
 * its callers read them.
 */

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const ROLE_CHOICES = [
  "owner",
  "admin",
  "member",
  "intern",
  "external",
  "removed",
] as const;
type RoleChoice = (typeof ROLE_CHOICES)[number];

const USERS = 3;
const MATTERS = 4;

const worldArbitrary = fc.record({
  roles: fc.array(fc.constantFrom(...ROLE_CHOICES), {
    minLength: USERS,
    maxLength: USERS,
  }),
  matters: fc.array(
    fc.record({
      client: fc.boolean(),
      deleting: fc.boolean(),
    }),
    { minLength: MATTERS, maxLength: MATTERS },
  ),
  assigned: fc.array(fc.boolean(), {
    minLength: USERS * MATTERS,
    maxLength: USERS * MATTERS,
  }),
});
type World = typeof worldArbitrary extends fc.Arbitrary<infer T> ? T : never;

type SeededWorld = {
  organizationId: SafeId<"organization">;
  userIds: SafeId<"user">[];
  matterIds: SafeId<"workspace">[];
};

const insertOrganization = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  await tx.insert(organization).values({
    id: organizationId,
    name: "Matter access differential",
    slug: organizationId,
    createdAt: new Date(),
  });
  await recordNewOrganizationAccessState(tx, {
    organizationId,
    now: new Date(),
  });
  const clientId = createSafeId<"contact">();
  await tx.insert(contacts).values({
    id: clientId,
    organizationId,
    type: "person",
    displayName: "Matter access client",
  });
  return clientId;
};

const seedWorld = async (tx: Transaction, world: World) => {
  const seeded: SeededWorld = {
    organizationId: mintAuthProviderId<"organization">(),
    userIds: world.roles.map(() => mintAuthProviderId<"user">()),
    matterIds: world.matters.map(() => createSafeId<"workspace">()),
  };
  const clientId = await insertOrganization(tx, seeded.organizationId);
  await tx.insert(user).values(
    seeded.userIds.map((id) => ({
      id,
      name: "Matter access differential",
      email: `${id}@example.test`,
    })),
  );
  const members = world.roles.flatMap((role, index) => {
    const userId = seeded.userIds[index];
    return role === "removed" || userId === undefined
      ? []
      : [
          {
            id: mintAuthProviderIdValue(),
            organizationId: seeded.organizationId,
            userId,
            role,
            createdAt: new Date(),
          },
        ];
  });
  if (members.length > 0) {
    await tx.insert(member).values(members);
  }
  await tx.insert(workspaces).values(
    world.matters.map((matter, index) => ({
      id: seeded.matterIds[index] ?? panic("matter id"),
      organizationId: seeded.organizationId,
      clientId: matter.client ? clientId : null,
      name: `Matter ${String(index)}`,
      reference: `DIFF-${String(index)}`,
      status: matter.deleting ? ("deleting" as const) : ("active" as const),
    })),
  );
  // Matter membership requires organization membership (a trigger enforces
  // it), so a removed member holds no assignment.
  const assignments = seeded.userIds.flatMap((userId, userIndex) =>
    world.roles[userIndex] === "removed"
      ? []
      : seeded.matterIds.flatMap((workspaceId, matterIndex) =>
          world.assigned[userIndex * MATTERS + matterIndex] === true
            ? [{ workspaceId, userId }]
            : [],
        ),
  );
  if (assignments.length > 0) {
    await tx.insert(workspaceMembers).values(assignments);
  }
  return seeded;
};

type LiveRow = {
  workspaceId: SafeId<"workspace">;
  status: string;
  /** The database access function's answer for this member. */
  reachesMatter: boolean;
};

const readLiveRows = async (
  tx: Transaction,
  seeded: SeededWorld,
  userId: SafeId<"user">,
): Promise<LiveRow[]> =>
  await tx
    .select({
      workspaceId: workspaces.id,
      status: workspaces.status,
      reachesMatter: memberReachesMatterSql(
        { organizationId: seeded.organizationId, userId },
        workspaces.id,
      ),
    })
    .from(workspaces)
    .where(inArray(workspaces.id, seeded.matterIds));

const readViewSet = async (
  db: GatedTestDb,
  seeded: SeededWorld,
  userId: SafeId<"user">,
  pinned: SafeId<"workspace">[],
) => {
  const scopedDb = createMembershipScopedDb(markRlsDatabase(db), {
    organizationId: seeded.organizationId,
    serverValidatedWorkspaceIds: pinned,
    userId,
  });
  const outcome = await scopedDb(
    async (tx) =>
      await readAuthorizedWorkspaces(tx, {
        organizationId: seeded.organizationId,
      }),
  );
  if (outcome.isErr()) {
    panic("Authorized workspace read failed");
  }
  return new Map(
    outcome.value.workspaces.map((workspace) => [
      workspace.id,
      workspace.status,
    ]),
  );
};

const roleOf = (role: RoleChoice) => (role === "removed" ? null : role);

const updatesEntities = (role: string | null) =>
  role !== null &&
  isMemberRole(role) &&
  roles[role].authorize({ entity: ["update"] }).success;

const withWorld = async (
  world: World,
  check: (context: { db: GatedTestDb; seeded: SeededWorld }) => Promise<void>,
) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const seeded = await db.transaction(
      async (tx) => await seedWorld(tx, world),
    );
    try {
      await check({ db, seeded });
    } finally {
      await db
        .delete(organization)
        .where(eq(organization.id, seeded.organizationId));
      await db.delete(user).where(inArray(user.id, seeded.userIds));
    }
  });
};

describe.skipIf(!runPostgresTests)(
  "matter access: app decisions equal the database rule (postgres)",
  () => {
    test("every app-side access helper agrees with the authorization view", async () => {
      await assertProperty(
        "every app-side access helper agrees with the authorization view",
        fc.asyncProperty(worldArbitrary, async (world) => {
          await withWorld(world, async ({ db, seeded }) => {
            for (const [index, userId] of seeded.userIds.entries()) {
              const role = roleOf(world.roles[index] ?? panic("role"));
              const view = await readViewSet(db, seeded, userId, []);
              const facts = await db.transaction(async (tx) => ({
                rows: await readLiveRows(tx, seeded, userId),
                hold: await holdMemberAccessOnTx(tx, {
                  organizationId: seeded.organizationId,
                  userId,
                  workspaceIds: seeded.matterIds,
                }),
                timer: await Promise.all(
                  seeded.matterIds.map(
                    async (workspaceId) =>
                      await hasCurrentTimerMatterAccess({
                        organizationId: seeded.organizationId,
                        tx,
                        userId,
                        workspaceId,
                      }),
                  ),
                ),
              }));
              const active = facts.rows
                .filter(
                  (row) => row.status === "active" && view.has(row.workspaceId),
                )
                .map((row) => row.workspaceId);
              for (const [matterIndex, row] of facts.rows.entries()) {
                const label = `${String(role)} on matter ${String(matterIndex)}`;
                const reaches = view.has(row.workspaceId);
                expect(row.reachesMatter, label).toBe(reaches);
                const input = {
                  organizationRole: role,
                  reachesMatter: row.reachesMatter,
                };
                expect(canUseFolioCollabWorkspace(input), label).toBe(reaches);
                expect(canWriteWorkspaceEntities(input), label).toBe(
                  reaches && updatesEntities(role),
                );
              }
              expect(facts.timer, String(role)).toEqual(
                seeded.matterIds.map((id) => active.includes(id)),
              );
              expect(facts.hold, String(role)).toEqual(
                role === null
                  ? { type: "not-member" }
                  : {
                      type: "held",
                      workspaceIds: seeded.matterIds.filter((id) =>
                        active.includes(id),
                      ),
                    },
              );
            }
          });
        }),
        propertyConfig({ numRuns: 12 }),
      );
    });
  },
);
