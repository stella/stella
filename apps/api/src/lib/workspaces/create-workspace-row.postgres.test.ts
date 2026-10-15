import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  contacts,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipScopedDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { createWorkspaceInTransaction } from "@/api/lib/workspaces/create-workspace-row";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** The database's message, also when the driver wraps it as the cause. */
const errorText = (error: unknown): string =>
  error instanceof Error
    ? `${error.message} ${errorText(error.cause)}`
    : String(error ?? "");

type Fixture = {
  organizationId: SafeId<"organization">;
  otherOrganizationId: SafeId<"organization">;
  clientId: SafeId<"contact">;
  otherClientId: SafeId<"contact">;
  adminId: SafeId<"user">;
  memberId: SafeId<"user">;
  outsiderId: SafeId<"user">;
};

type Database = Parameters<typeof markRlsDatabase>[0];

const seed = async (db: Database): Promise<Fixture> => {
  const fixture: Fixture = {
    organizationId: mintAuthProviderId<"organization">(),
    otherOrganizationId: mintAuthProviderId<"organization">(),
    clientId: createSafeId<"contact">(),
    otherClientId: createSafeId<"contact">(),
    adminId: mintAuthProviderId<"user">(),
    memberId: mintAuthProviderId<"user">(),
    outsiderId: mintAuthProviderId<"user">(),
  };
  await db.insert(organization).values(
    [fixture.organizationId, fixture.otherOrganizationId].map((id) => ({
      id,
      name: "Create matter fixture",
      slug: id,
      createdAt: new Date(),
    })),
  );
  await db.insert(user).values(
    [fixture.adminId, fixture.memberId, fixture.outsiderId].map((id) => ({
      id,
      name: "Create matter fixture",
      email: `${id}@example.test`,
    })),
  );
  await db.insert(member).values([
    {
      id: mintAuthProviderIdValue(),
      organizationId: fixture.organizationId,
      userId: fixture.adminId,
      role: "admin",
      createdAt: new Date(),
    },
    {
      id: mintAuthProviderIdValue(),
      organizationId: fixture.organizationId,
      userId: fixture.memberId,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: mintAuthProviderIdValue(),
      organizationId: fixture.otherOrganizationId,
      userId: fixture.outsiderId,
      role: "owner",
      createdAt: new Date(),
    },
  ]);
  await db.insert(contacts).values([
    {
      id: fixture.clientId,
      organizationId: fixture.organizationId,
      type: "person",
      displayName: "Client",
    },
    {
      id: fixture.otherClientId,
      organizationId: fixture.otherOrganizationId,
      type: "person",
      displayName: "Other client",
    },
  ]);
  return fixture;
};

const asMember = (db: Database, fixture: Fixture, userId: SafeId<"user">) =>
  createMembershipScopedDb(markRlsDatabase(db), {
    organizationId: fixture.organizationId,
    serverValidatedWorkspaceIds: [],
    userId,
  });

const assignmentsOf = async (db: Database, workspaceId: SafeId<"workspace">) =>
  (
    await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
  ).map((row) => row.userId);

const withFixture = async (
  check: (db: Database, fixture: Fixture) => Promise<void>,
) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const fixture = await seed(db);
    try {
      await check(db, fixture);
    } finally {
      await db
        .delete(organization)
        .where(
          inArray(organization.id, [
            fixture.organizationId,
            fixture.otherOrganizationId,
          ]),
        );
      await db
        .delete(user)
        .where(
          inArray(user.id, [
            fixture.adminId,
            fixture.memberId,
            fixture.outsiderId,
          ]),
        );
    }
  });
};

describe.skipIf(!runPostgresTests)("creating a matter (postgres)", () => {
  test("a member's new personal matter is assigned to them and reachable in the same transaction", async () => {
    await withFixture(async (db, fixture) => {
      const workspaceId = createSafeId<"workspace">();
      const visible = await asMember(
        db,
        fixture,
        fixture.memberId,
      )(async (tx) => {
        await createWorkspaceInTransaction(tx, {
          id: workspaceId,
          clientId: null,
          name: "Personal matter",
          reference: "NEW-1",
        });
        // A dependent row passes the row policies through the access rule
        // alone; the transaction never names the matter in its pinned ids.
        await tx.insert(properties).values({
          workspaceId,
          name: "Files",
          content: { type: "file", version: 1 },
          tool: { version: 1, type: "manual-input" },
          status: "fresh",
          system: true,
          kinds: ["document"],
        });
        return await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
      });
      expect(visible).toEqual([{ id: workspaceId }]);
      expect(
        await db
          .select({ name: properties.name })
          .from(properties)
          .where(eq(properties.workspaceId, workspaceId)),
      ).toEqual([{ name: "Files" }]);
      expect(await assignmentsOf(db, workspaceId)).toEqual([fixture.memberId]);
      const [row] = await db
        .select({ organizationId: workspaces.organizationId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      expect(row?.organizationId).toBe(fixture.organizationId);
    });
  });

  test("an admin's new client matter adds no assignment, the role reaches it", async () => {
    await withFixture(async (db, fixture) => {
      const workspaceId = createSafeId<"workspace">();
      await asMember(
        db,
        fixture,
        fixture.adminId,
      )(async (tx) => {
        await createWorkspaceInTransaction(tx, {
          id: workspaceId,
          clientId: fixture.clientId,
          name: "Client matter",
          reference: "NEW-2",
        });
      });
      expect(await assignmentsOf(db, workspaceId)).toEqual([]);
    });
  });

  test("refuses a client or a lead from another organization", async () => {
    await withFixture(async (db, fixture) => {
      const create = asMember(db, fixture, fixture.adminId);
      expect(
        errorText(
          await rejectionOf(
            create(async (tx) => {
              await createWorkspaceInTransaction(tx, {
                id: createSafeId<"workspace">(),
                clientId: fixture.otherClientId,
                name: "Other client",
                reference: "NEW-3",
              });
            }),
          ),
        ),
      ).toContain("the client belongs to another organization");
      expect(
        errorText(
          await rejectionOf(
            create(async (tx) => {
              await createWorkspaceInTransaction(tx, {
                id: createSafeId<"workspace">(),
                clientId: null,
                name: "Other lead",
                reference: "NEW-4",
                leadUserId: fixture.outsiderId,
              });
            }),
          ),
        ),
      ).toContain("the matter lead is not an organization member");
    });
  });

  test("refuses a transaction without an organization member", async () => {
    await withFixture(async (db, fixture) => {
      const service = createScopedDb(
        markRlsDatabase(db),
        [],
        fixture.organizationId,
        null,
      );
      expect(
        errorText(
          await rejectionOf(
            service(async (tx) => {
              await createWorkspaceInTransaction(tx, {
                id: createSafeId<"workspace">(),
                clientId: null,
                name: "Service matter",
                reference: "NEW-5",
              });
            }),
          ),
        ),
      ).toContain("creating a matter requires an organization member");
      const outsider = createMembershipScopedDb(markRlsDatabase(db), {
        organizationId: fixture.organizationId,
        serverValidatedWorkspaceIds: [],
        userId: fixture.outsiderId,
      });
      expect(
        errorText(
          await rejectionOf(
            outsider(async (tx) => {
              await createWorkspaceInTransaction(tx, {
                id: createSafeId<"workspace">(),
                clientId: null,
                name: "Outsider matter",
                reference: "NEW-6",
              });
            }),
          ),
        ),
      ).toContain("creating a matter requires an organization member");
    });
  });
});
