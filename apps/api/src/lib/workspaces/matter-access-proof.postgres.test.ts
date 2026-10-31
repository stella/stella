import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withMatterAccess } from "@/api/lib/workspaces/matter-access-proof";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Two organizations; the member belongs to the first and is assigned to its
// `assigned` matter only. Each organization also holds a matter of its own.
const seed = async (db: GatedTestDb) => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "");
  const home = mintAuthProviderId<"organization">();
  const other = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const assigned = createSafeId<"workspace">();
  const unassigned = createSafeId<"workspace">();
  const foreign = createSafeId<"workspace">();
  await db.insert(organization).values([
    {
      id: home,
      name: "Kancelář Novák",
      slug: `proof-home-${suffix}`,
      createdAt: new Date(),
    },
    {
      id: other,
      name: "Advokátní kancelář Černá",
      slug: `proof-other-${suffix}`,
      createdAt: new Date(),
    },
  ]);
  await db.insert(user).values({
    id: userId,
    name: "Jiří Dvořák",
    email: `proof-member-${suffix}@example.test`,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId: home,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values([
    {
      id: assigned,
      organizationId: home,
      name: "Smlouva o dílo",
      reference: `a-${suffix}`,
    },
    {
      id: unassigned,
      organizationId: home,
      name: "Spor o nájem",
      reference: `u-${suffix}`,
    },
    {
      id: foreign,
      organizationId: other,
      name: "Cizí věc",
      reference: `f-${suffix}`,
    },
  ]);
  await db.insert(workspaceMembers).values({ workspaceId: assigned, userId });
  const cleanUp = async () => {
    await db.delete(organization).where(eq(organization.id, home));
    await db.delete(organization).where(eq(organization.id, other));
    await db.delete(user).where(eq(user.id, userId));
  };
  return { assigned, cleanUp, foreign, home, unassigned, userId };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("matter access evidence (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  test("evidence is issued only for a matter the member reaches in the named organization", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const seeded = await seed(db);
      try {
        const attempt = async (workspaceId: typeof seeded.assigned) => {
          let ran = false;
          const outcome = await db.transaction(
            async (tx) =>
              await withMatterAccess(
                {
                  tx: asTestRaw<Transaction>(tx),
                  organizationId: seeded.home,
                  userId: seeded.userId,
                  workspaceId,
                  need: "read",
                  role: sessionMemberRole("member"),
                },
                async () => {
                  ran = true;
                  return Result.ok("ran");
                },
              ),
          );
          return { outcome, ran };
        };

        const reachable = await attempt(seeded.assigned);
        expect(reachable.ran).toBe(true);
        expect(reachable.outcome.unwrap()).toBe("ran");

        // An existing matter of another organization, and an unassigned
        // matter of the member's own organization, are both refused before
        // the continuation runs.
        for (const workspaceId of [seeded.foreign, seeded.unassigned]) {
          const refused = await attempt(workspaceId);
          expect(refused.ran).toBe(false);
          expect(Result.isError(refused.outcome)).toBe(true);
          expect(refused.outcome).toMatchObject({ error: { status: 403 } });
        }
      } finally {
        await seeded.cleanUp();
      }
    });
  });
}
