import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import type { MemberAccessHold } from "@/api/lib/db/member-access-hold";
import {
  withGatedTestClients,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCK_OBSERVATION_ATTEMPTS = 500;

const seedMember = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const ownerId = mintAuthProviderId<"user">();
  const memberId = mintAuthProviderIdValue();
  const workspaceId = createSafeId<"workspace">();
  const suffix = Bun.randomUUIDv7().replaceAll("-", "");
  await db.insert(organization).values({
    id: organizationId,
    name: "Member access hold",
    slug: `member-access-hold-${suffix}`,
    createdAt: new Date(),
  });
  await db.insert(user).values([
    { id: userId, name: "Member", email: `member-${suffix}@example.test` },
    { id: ownerId, name: "Owner", email: `owner-${suffix}@example.test` },
  ]);
  await db.insert(member).values([
    {
      id: memberId,
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    },
  ]);
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Held matter",
    reference: suffix,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  const cleanUp = async () => {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(user).where(eq(user.id, ownerId));
  };
  return { cleanUp, memberId, organizationId, userId, workspaceId };
};

type Seeded = Awaited<ReturnType<typeof seedMember>>;

const REMOVALS = {
  organization: async (db: GatedTestDb, seeded: Seeded) => {
    await db.delete(member).where(eq(member.id, seeded.memberId));
  },
  matter: async (db: GatedTestDb, seeded: Seeded) => {
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, seeded.workspaceId));
  },
} as const;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("member access hold (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("member access hold (postgres)", () => {
    test.each(Object.entries(REMOVALS))(
      "a %s membership removal waits for the transaction holding it",
      async (_removal, remove) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: holderDb } = openClient({ max: 1 });
          const { db: removerDb } = openClient({ max: 1 });
          const { db: observerDb } = openClient({ max: 1 });
          const seeded = await seedMember(observerDb);
          const release = Promise.withResolvers<undefined>();
          const held = Promise.withResolvers<number>();
          try {
            const safeDb = createMembershipSafeDb(markRlsDatabase(holderDb), {
              organizationId: seeded.organizationId,
              serverValidatedWorkspaceIds: [],
              userId: seeded.userId,
            });
            const holding = safeDb(async (tx) => {
              const hold = await holdMemberAccessOnTx(
                asTestRaw<Transaction>(tx),
                {
                  organizationId: seeded.organizationId,
                  userId: seeded.userId,
                  workspaceIds: [seeded.workspaceId],
                },
              );
              const pid = await tx.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`,
              );
              held.resolve(pid.at(0)?.pid ?? -1);
              await release.promise;
              return hold;
            });
            const holderPid = await held.promise;
            let removed = false;
            const removing = (async () => {
              await remove(removerDb, seeded);
              removed = true;
            })();

            let blocked = false;
            for (
              let attempt = 0;
              attempt < BLOCK_OBSERVATION_ATTEMPTS && !blocked;
              attempt += 1
            ) {
              const rows = await observerDb.execute<{ blocked: boolean }>(sql`
                SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE ${holderPid} = ANY(pg_blocking_pids(pid))
                ) AS blocked
              `);
              blocked = rows.at(0)?.blocked === true;
              if (!blocked) {
                await Bun.sleep(10);
              }
            }
            expect(blocked).toBe(true);
            expect(removed).toBe(false);

            release.resolve(undefined);
            const hold = await holding;
            await removing;
            expect(hold.unwrap()).toEqual({
              type: "held",
              workspaceIds: [seeded.workspaceId],
            } satisfies MemberAccessHold);
            expect(removed).toBe(true);
          } finally {
            release.resolve(undefined);
            await seeded.cleanUp();
          }
        });
      },
    );

    test("a removal committed first is reported by the hold", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const seeded = await seedMember(db);
        try {
          const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
            organizationId: seeded.organizationId,
            serverValidatedWorkspaceIds: [],
            userId: seeded.userId,
          });
          const hold = async () =>
            await safeDb(
              async (tx) =>
                await holdMemberAccessOnTx(asTestRaw<Transaction>(tx), {
                  organizationId: seeded.organizationId,
                  userId: seeded.userId,
                  workspaceIds: [seeded.workspaceId],
                }),
            );

          await REMOVALS.matter(db, seeded);
          expect((await hold()).unwrap()).toEqual({
            type: "held",
            workspaceIds: [],
          } satisfies MemberAccessHold);

          await REMOVALS.organization(db, seeded);
          expect((await hold()).unwrap()).toEqual({
            type: "not-member",
          } satisfies MemberAccessHold);
        } finally {
          await seeded.cleanUp();
        }
      });
    });
  });
}
