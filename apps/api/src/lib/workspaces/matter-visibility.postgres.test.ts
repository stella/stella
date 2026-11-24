import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { MatterVisibility } from "@stll/api-contract/matter-visibility";
import { waitFor } from "@stll/test-kit";
import { dbClock } from "@stll/test-kit/db";

import { member, organization, user } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { MATTER_STEWARD_CONSTRAINT } from "@/api/lib/db/constraint-refusals";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { readAuthorizedWorkspaces } from "@/api/lib/workspaces/authorized-workspace-ids";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";

/**
 * The database side of matter visibility: who each level admits (including
 * external members and another organization's members), the stewardship
 * guard that keeps an assigned-only matter reachable on every removal path,
 * the previous release's writers, and the authorization functions' trusted
 * search path and grants.
 */

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const ROLES = ["owner", "admin", "member", "intern", "external"] as const;
const FIXTURE_TIME = new Date("2026-11-24T00:00:00.000Z");
type Role = (typeof ROLES)[number];

type Organization = {
  organizationId: SafeId<"organization">;
  clientId: SafeId<"contact">;
  users: Record<Role, SafeId<"user">>;
  memberIds: Record<Role, string>;
};

const seedOrganization = async (db: GatedTestDb): Promise<Organization> => {
  const organizationId = mintAuthProviderId<"organization">();
  const clientId = createSafeId<"contact">();
  const users = {
    owner: mintAuthProviderId<"user">(),
    admin: mintAuthProviderId<"user">(),
    member: mintAuthProviderId<"user">(),
    intern: mintAuthProviderId<"user">(),
    external: mintAuthProviderId<"user">(),
  } satisfies Record<Role, SafeId<"user">>;
  const memberIds = {
    owner: mintAuthProviderIdValue(),
    admin: mintAuthProviderIdValue(),
    member: mintAuthProviderIdValue(),
    intern: mintAuthProviderIdValue(),
    external: mintAuthProviderIdValue(),
  } satisfies Record<Role, string>;
  await db.insert(organization).values({
    id: organizationId,
    name: "Visibility fixture",
    slug: organizationId,
    createdAt: dbClock.now(),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: FIXTURE_TIME,
  });
  await db.insert(user).values(
    ROLES.map((role) => ({
      id: users[role],
      name: `Visibility ${role}`,
      email: `${users[role]}@example.test`,
    })),
  );
  await db.insert(member).values(
    ROLES.map((role) => ({
      id: memberIds[role],
      organizationId,
      userId: users[role],
      role,
      createdAt: dbClock.now(),
    })),
  );
  await insertOwnerContacts(db, [
    {
      id: clientId,
      organizationId,
      type: "person",
      displayName: "Visibility client",
    },
  ]);
  return { organizationId, clientId, users, memberIds };
};

type MatterSeed = {
  visibility: MatterVisibility | null;
  client: boolean;
  assigned: readonly SafeId<"user">[];
};

const insertMatter = async (
  db: GatedTestDb,
  org: Organization,
  { visibility, client, assigned }: MatterSeed,
) => {
  const id = createSafeId<"workspace">();
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id,
      organizationId: org.organizationId,
      clientId: client ? org.clientId : null,
      name: `Matter ${String(visibility)}`,
      reference: `VIS-${id}`,
      visibility,
    });
    if (assigned.length > 0) {
      await tx
        .insert(workspaceMembers)
        .values(assigned.map((userId) => ({ workspaceId: id, userId })));
    }
  });
  return id;
};

const readerSet = async (
  db: GatedTestDb,
  org: Organization,
  userId: SafeId<"user">,
) => {
  const outcome = await createMembershipScopedDb(markRlsDatabase(db), {
    organizationId: org.organizationId,
    serverValidatedWorkspaceIds: [],
    userId,
  })(
    async (tx) =>
      await readAuthorizedWorkspaces(tx, {
        organizationId: org.organizationId,
      }),
  );
  return outcome.isOk()
    ? new Set(outcome.value.workspaces.map(({ id }) => id))
    : panic("authorized read failed");
};

const expectStewardRefusal = async (write: () => Promise<unknown>) => {
  const outcome = await Result.tryPromise(write);
  expect(
    outcome.isErr() &&
      isPgConstraintError(
        outcome.error,
        PG_ERROR.CHECK_VIOLATION,
        MATTER_STEWARD_CONSTRAINT,
      ),
  ).toBe(true);
};

const withOrganizations = async (
  check: (context: {
    db: GatedTestDb;
    openDb: () => GatedTestDb;
    a: Organization;
    b: Organization;
  }) => Promise<void>,
) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const a = await seedOrganization(db);
    const b = await seedOrganization(db);
    try {
      await check({ db, openDb: () => openClient().db, a, b });
    } finally {
      await deleteOrganizationsForTest(db, [
        a.organizationId,
        b.organizationId,
      ]);
      await db
        .delete(user)
        .where(
          inArray(user.id, [
            ...Object.values(a.users),
            ...Object.values(b.users),
          ]),
        );
    }
  });
};

describe.skipIf(!runPostgresTests)("matter visibility (postgres)", () => {
  test("each level admits exactly its readers, external members only by assignment, and never another organization", async () => {
    await withOrganizations(async ({ db, a, b }) => {
      const external = a.users.external;
      const matters = {
        all: await insertMatter(db, a, {
          visibility: "all_members",
          client: false,
          assigned: [],
        }),
        admins: await insertMatter(db, a, {
          visibility: "admins_and_assigned",
          client: false,
          assigned: [],
        }),
        walled: await insertMatter(db, a, {
          visibility: "assigned_only",
          client: true,
          assigned: [a.users.member],
        }),
        externalAssigned: await insertMatter(db, a, {
          visibility: "assigned_only",
          client: true,
          assigned: [a.users.intern, external],
        }),
        legacyClient: await insertMatter(db, a, {
          visibility: null,
          client: true,
          assigned: [],
        }),
        legacyPersonal: await insertMatter(db, a, {
          visibility: null,
          client: false,
          assigned: [a.users.member],
        }),
      };
      const foreign = await insertMatter(db, b, {
        visibility: "all_members",
        client: false,
        assigned: [],
      });

      const expected: Record<Role, (keyof typeof matters)[]> = {
        owner: ["all", "admins", "legacyClient"],
        admin: ["all", "admins", "legacyClient"],
        member: ["all", "walled", "legacyPersonal"],
        intern: ["all", "externalAssigned"],
        external: ["externalAssigned"],
      };
      for (const role of ROLES) {
        // db-await-in-loop: one scoped read per role, five roles
        const seen = await readerSet(db, a, a.users[role]);
        expect([...seen].toSorted(), role).toEqual(
          expected[role].map((name) => matters[name]).toSorted(),
        );
        expect(seen.has(foreign), role).toBe(false);
      }
      // Another organization's owner sees nothing of this one, and this
      // organization's owner nothing of the other's all-members matter.
      const foreignOwner = await readerSet(db, a, b.users.owner);
      expect(foreignOwner.size).toBe(0);
      expect((await readerSet(db, b, a.users.owner)).size).toBe(0);
      expect((await readerSet(db, b, b.users.intern)).has(foreign)).toBe(true);
    });
  });

  test("an assigned-only matter keeps an assigned internal member on every removal path", async () => {
    await withOrganizations(async ({ db, a }) => {
      const matter = await insertMatter(db, a, {
        visibility: "assigned_only",
        client: false,
        assigned: [a.users.member, a.users.external],
      });
      const assignment = (userId: SafeId<"user">) =>
        and(
          eq(workspaceMembers.workspaceId, matter),
          eq(workspaceMembers.userId, userId),
        );

      // The last internal member: removing the assignment, removing them
      // from the organization and making them external are all refused.
      await expectStewardRefusal(
        async () =>
          await db.delete(workspaceMembers).where(assignment(a.users.member)),
      );
      await expectStewardRefusal(
        async () =>
          await db.delete(member).where(eq(member.id, a.memberIds.member)),
      );
      await expectStewardRefusal(
        async () =>
          await db
            .update(member)
            .set({ role: "external" })
            .where(eq(member.id, a.memberIds.member)),
      );
      // An external member may leave; they never kept the matter reachable.
      await db.delete(workspaceMembers).where(assignment(a.users.external));

      // With another internal member assigned, the first may leave.
      await db
        .insert(workspaceMembers)
        .values({ workspaceId: matter, userId: a.users.intern });
      await db.delete(workspaceMembers).where(assignment(a.users.member));
      // A role change between internal roles keeps the matter reachable.
      await db
        .update(member)
        .set({ role: "member" })
        .where(eq(member.id, a.memberIds.intern));
      await db
        .update(member)
        .set({ role: "intern" })
        .where(eq(member.id, a.memberIds.intern));

      // Deleting the matter itself removes its assignments freely.
      await db.delete(workspaces).where(eq(workspaces.id, matter));
    });
  });

  test("narrowing to assigned only and creating an assigned-only matter need an assigned internal member", async () => {
    await withOrganizations(async ({ db, a }) => {
      const open = await insertMatter(db, a, {
        visibility: "admins_and_assigned",
        client: true,
        assigned: [a.users.external],
      });
      await expectStewardRefusal(
        async () =>
          await db
            .update(workspaces)
            .set({ visibility: "assigned_only" })
            .where(eq(workspaces.id, open)),
      );
      await db
        .insert(workspaceMembers)
        .values({ workspaceId: open, userId: a.users.admin });
      await db
        .update(workspaces)
        .set({ visibility: "assigned_only" })
        .where(eq(workspaces.id, open));

      // Checked at commit: a matter created without any internal member.
      await expectStewardRefusal(
        async () =>
          await insertMatter(db, a, {
            visibility: "assigned_only",
            client: false,
            assigned: [a.users.external],
          }),
      );
    });
  });

  test("two concurrent removals cannot each leave the other as the last internal member", async () => {
    await withOrganizations(async ({ db, openDb, a }) => {
      const matter = await insertMatter(db, a, {
        visibility: "assigned_only",
        client: false,
        assigned: [a.users.member, a.users.intern],
      });
      const firstDb = openDb();
      const secondDb = openDb();
      let releaseFirst: () => void = () => undefined;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstRemoved: () => void = () => undefined;
      const firstHasRemoved = new Promise<void>((resolve) => {
        firstRemoved = resolve;
      });
      const firstRemoval = firstDb.transaction(async (tx) => {
        await tx
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, matter),
              eq(workspaceMembers.userId, a.users.member),
            ),
          );
        firstRemoved();
        await firstMayCommit;
      });
      await firstHasRemoved;
      const secondRemoval = Result.tryPromise(
        async () =>
          await secondDb.transaction(async (tx) => {
            await tx
              .delete(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.workspaceId, matter),
                  eq(workspaceMembers.userId, a.users.intern),
                ),
              );
          }),
      );
      // The second removal waits for the matter's stewardship lock.
      await waitFor(
        async () =>
          executedRows(
            await db.execute(sql`
              SELECT 1 FROM pg_catalog.pg_locks
              WHERE locktype = 'advisory' AND classid = 1836282981 AND NOT granted
            `),
          ).length > 0
            ? true
            : undefined,
        { description: "the second removal to wait for the stewardship lock" },
      );
      releaseFirst();
      await firstRemoval;
      const second = await secondRemoval;
      expect(
        second.isErr() &&
          isPgConstraintError(
            second.error,
            PG_ERROR.CHECK_VIOLATION,
            MATTER_STEWARD_CONSTRAINT,
          ),
      ).toBe(true);
      const remaining = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, matter));
      expect(remaining).toEqual([{ userId: a.users.intern }]);
    });
  });

  test("the previous release's writers keep the client rule and stay unchecked", async () => {
    await withOrganizations(async ({ db, a }) => {
      // The previous release creates through the seven-argument function and
      // stores no visibility; its matters keep the rule they had.
      const created = createSafeId<"workspace">();
      await createMembershipScopedDb(markRlsDatabase(db), {
        organizationId: a.organizationId,
        serverValidatedWorkspaceIds: [],
        userId: a.users.member,
      })(async (tx) => {
        await tx.execute(
          sql`SELECT public.stella_create_workspace(${created}::uuid, NULL::uuid, 'Old writer', ${`OLD-${created}`}, NULL, NULL, NULL)`,
        );
      });
      const [row] = await db
        .select({ visibility: workspaces.visibility })
        .from(workspaces)
        .where(eq(workspaces.id, created));
      expect(row).toEqual({ visibility: null });
      expect((await readerSet(db, a, a.users.member)).has(created)).toBe(true);
      expect((await readerSet(db, a, a.users.owner)).has(created)).toBe(false);

      // Its member removals behave as before: a matter without a stored
      // visibility is not checked.
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, created));

      // Its client attachment still opens such a matter to admins.
      await db
        .update(workspaces)
        .set({ clientId: a.clientId })
        .where(eq(workspaces.id, created));
      expect((await readerSet(db, a, a.users.owner)).has(created)).toBe(true);
    });
  });

  test("the eight-argument creation assigns the creator and refuses an assigned-only matter for an external creator", async () => {
    await withOrganizations(async ({ db, a }) => {
      const create = async (
        userId: SafeId<"user">,
        visibility: MatterVisibility,
      ) => {
        const id = createSafeId<"workspace">();
        await createMembershipScopedDb(markRlsDatabase(db), {
          organizationId: a.organizationId,
          serverValidatedWorkspaceIds: [],
          userId,
        })(async (tx) => {
          await tx.execute(
            sql`SELECT public.stella_create_workspace(${id}::uuid, NULL::uuid, 'New writer', ${`NEW-${id}`}, NULL, NULL, NULL, ${visibility}::text)`,
          );
        });
        return id;
      };
      const walled = await create(a.users.member, "assigned_only");
      expect(
        await db
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, walled)),
      ).toEqual([{ userId: a.users.member }]);
      await expectStewardRefusal(
        async () => await create(a.users.external, "assigned_only"),
      );
    });
  });

  test("the authorization functions keep the trusted search path and their grants", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const rows = executedRows(
        await db.execute(sql`
          SELECT p.oid::regprocedure::text AS signature,
            p.prosecdef AS definer,
            p.proconfig AS config,
            pg_catalog.has_function_privilege('stella', p.oid, 'EXECUTE') AS stella,
            EXISTS (
              SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl
              WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ) AS public_execute
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN (
              'stella_authorized_workspace_ids',
              'stella_create_workspace',
              'stella_require_matter_steward',
              'stella_role_reaches_matter'
            )
          ORDER BY 1
        `),
      );
      const bySignature = new Map(
        rows.map((row) =>
          isRecord(row) && typeof row["signature"] === "string"
            ? [row["signature"], row]
            : panic("function row"),
        ),
      );
      const ids = bySignature.get("stella_authorized_workspace_ids(text,text)");
      expect(ids).toMatchObject({
        definer: true,
        stella: true,
        public_execute: false,
      });
      expect(ids?.["config"]).toEqual(
        expect.arrayContaining(["search_path=pg_catalog, pg_temp"]),
      );
      expect(JSON.stringify(ids?.["config"])).not.toContain("public");
      const correspondence = executedRows(
        await db.execute(sql`
          SELECT pg_catalog.has_function_privilege(
            'stella_correspondence_source',
            'public.stella_authorized_workspace_ids(text, text)',
            'EXECUTE'
          ) AS granted
        `),
      );
      expect(correspondence).toEqual([{ granted: true }]);
      for (const signature of [
        "stella_create_workspace(uuid,uuid,text,text,text,text,text)",
        "stella_create_workspace(uuid,uuid,text,text,text,text,text,text)",
      ]) {
        const row = bySignature.get(signature);
        expect(row, signature).toMatchObject({
          definer: true,
          stella: true,
          public_execute: false,
        });
        expect(row?.["config"], signature).toEqual([
          "search_path=pg_catalog, pg_temp",
        ]);
      }
      expect(
        bySignature.get("stella_require_matter_steward(uuid)"),
      ).toMatchObject({ definer: true, stella: false, public_execute: false });
      expect(
        bySignature.get("stella_role_reaches_matter(text,text,uuid)"),
      ).toMatchObject({ definer: false, stella: true, public_execute: false });
    });
  });
});
