import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  contacts,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { addWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/add";
import { createSafeId } from "@/api/lib/branded-types";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import type { MemberAccessHold } from "@/api/lib/db/member-access-hold";
import { hasCurrentTimerMatterAccess } from "@/api/lib/time-entry-timer-access";
import { executeAuthorizedWorkspaceDeletion } from "@/api/lib/workspace-deletion";
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
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
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
  return { cleanUp, memberId, organizationId, ownerId, userId, workspaceId };
};

const seedAdminClientMatter = async (
  db: GatedTestDb,
  assignment: "assigned" | "unassigned",
) => {
  const seeded = await seedMember(db);
  const clientId = createSafeId<"contact">();
  await db.insert(contacts).values({
    id: clientId,
    organizationId: seeded.organizationId,
    type: "person",
    displayName: "Matter lock client",
  });
  await db
    .update(member)
    .set({ role: "admin" })
    .where(eq(member.id, seeded.memberId));
  await db
    .update(workspaces)
    .set({ clientId })
    .where(eq(workspaces.id, seeded.workspaceId));
  if (assignment === "unassigned") {
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, seeded.workspaceId));
  }
  return seeded;
};

const expectTransactionToBlockClient = async (
  tx: Transaction,
  waiterPid: number,
) => {
  for (let attempt = 0; attempt < BLOCK_OBSERVATION_ATTEMPTS; attempt += 1) {
    const rows = await tx.execute<{ blocked: boolean }>(sql`
      SELECT pg_backend_pid() = ANY(pg_blocking_pids(${waiterPid}::integer)) AS blocked
    `);
    if (rows.at(0)?.blocked === true) {
      return;
    }
    await Bun.sleep(10);
  }
  expect.unreachable(
    "The contender must wait behind the held transaction before the barrier opens",
  );
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

const ACCESS_READERS = {
  timer: async (tx: Transaction, seeded: Seeded) =>
    await hasCurrentTimerMatterAccess({ tx, ...seeded }),
  hold: async (tx: Transaction, seeded: Seeded) => {
    const hold = await holdMemberAccessOnTx(tx, {
      ...seeded,
      workspaceIds: [seeded.workspaceId],
    });
    return (
      hold.type === "held" && hold.workspaceIds.includes(seeded.workspaceId)
    );
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

    test.each(Object.entries(ACCESS_READERS))(
      "%s observes an assignment removal committed during its member lock wait",
      async (_reader, readAccess) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: writerDb } = openClient({ max: 1 });
          const { db: readerDb } = openClient({ max: 1 });
          const { db: observerDb } = openClient({ max: 1 });
          const seeded = await seedMember(observerDb);
          const locked = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          const writing = writerDb.transaction(async (tx) => {
            // An UPDATE holds the member while assignment removal shares its commit.
            await tx
              .update(member)
              .set({ role: "member" })
              .where(eq(member.id, seeded.memberId));
            const rows = await tx.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            locked.resolve(rows.at(0)?.pid ?? panic("Missing writer pid"));
            await release.promise;
            await tx
              .delete(workspaceMembers)
              .where(eq(workspaceMembers.workspaceId, seeded.workspaceId));
          });
          let reading: Promise<boolean> | undefined;
          try {
            const writerPid = await locked.promise;
            reading = readerDb.transaction(
              async (tx) => await readAccess(tx, seeded),
            );
            let blocked = false;
            for (
              let attempt = 0;
              attempt < BLOCK_OBSERVATION_ATTEMPTS && !blocked;
              attempt += 1
            ) {
              const rows = await observerDb.execute<{ blocked: boolean }>(sql`
                SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE ${writerPid} = ANY(pg_blocking_pids(pid))
                ) AS blocked
              `);
              blocked = rows.at(0)?.blocked === true;
              if (!blocked) {
                await Bun.sleep(10);
              }
            }
            expect(blocked).toBe(true);
            release.resolve(undefined);
            await writing;
            expect(await reading).toBe(false);
          } finally {
            release.resolve(undefined);
            await writing;
            await reading;
            await seeded.cleanUp();
          }
        });
      },
    );

    test("an assigned admin timer and a member grant serialize on the client matter", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: grantDb } = openClient({
          max: 1,
          connection: { lock_timeout: 5000, statement_timeout: 10_000 },
        });
        const { db: timerDb } = openClient({
          max: 1,
          connection: { lock_timeout: 5000, statement_timeout: 10_000 },
        });
        const seeded = await seedAdminClientMatter(grantDb, "assigned");
        const matterLocked = Promise.withResolvers<undefined>();
        const timerStarted = Promise.withResolvers<number>();
        // The actor is already assigned; the grant targets a different member.
        expect(
          await grantDb
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.workspaceId, seeded.workspaceId)),
        ).toEqual([{ userId: seeded.userId }]);
        const safeDb = safeDbFromScoped(
          async (fn) =>
            await grantDb.transaction(async (tx) => {
              // Pause the real handler at its existing matter-lock prefix.
              await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, seeded.workspaceId))
                .for("update");
              matterLocked.resolve(undefined);
              const timerPid = await timerStarted.promise;
              await expectTransactionToBlockClient(tx, timerPid);
              return await fn(asTestRaw<Transaction>(tx));
            }),
        );
        const granting = Result.gen(() =>
          addWorkspaceMemberHandler({
            safeDb,
            organizationId: seeded.organizationId,
            workspaceId: seeded.workspaceId,
            body: { userId: seeded.ownerId },
            recordAuditEvent: async () => await Promise.resolve(),
          }),
        );
        const timing = (async () => {
          await matterLocked.promise;
          return await timerDb.transaction(async (tx) => {
            const rows = await tx.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            timerStarted.resolve(rows.at(0)?.pid ?? panic("Missing timer pid"));
            return await hasCurrentTimerMatterAccess({ tx, ...seeded });
          });
        })();
        try {
          const [granted, accessible] = await Promise.all([granting, timing]);
          expect(granted.unwrap().userId).toBe(seeded.ownerId);
          expect(accessible).toBe(true);
          const assignments = await grantDb
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.workspaceId, seeded.workspaceId));
          expect(assignments.map((row) => row.userId).toSorted()).toEqual(
            [seeded.userId, seeded.ownerId].toSorted(),
          );
        } finally {
          matterLocked.resolve(undefined);
          timerStarted.resolve(-1);
          await Promise.allSettled([granting, timing]);
          await seeded.cleanUp();
        }
      });
    }, 15_000);

    test.each(["assigned", "unassigned"] as const)(
      "matter deletion waits for a member-first hold by an %s client-matter admin",
      async (assignment) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: holdingDb } = openClient({
            max: 1,
            connection: { lock_timeout: 5000, statement_timeout: 10_000 },
          });
          const { db: deletionDb } = openClient({
            max: 1,
            connection: { lock_timeout: 5000, statement_timeout: 10_000 },
          });
          const seeded = await seedAdminClientMatter(holdingDb, assignment);
          const holdPrefix = Promise.withResolvers<undefined>();
          const deletionStarted = Promise.withResolvers<number>();
          let attempts = 0;
          try {
            const holding = holdingDb.transaction(async (tx) => {
              await tx
                .select({ id: member.id })
                .from(member)
                .where(eq(member.id, seeded.memberId))
                .for("share");
              holdPrefix.resolve(undefined);
              const deletionPid = await deletionStarted.promise;
              await expectTransactionToBlockClient(tx, deletionPid);
              return await holdMemberAccessOnTx(tx, {
                organizationId: seeded.organizationId,
                userId: seeded.userId,
                workspaceIds: [seeded.workspaceId],
              });
            });
            const deleting = (async () => {
              await holdPrefix.promise;
              return await executeAuthorizedWorkspaceDeletion(
                {
                  actorUserId: seeded.userId,
                  organizationId: seeded.organizationId,
                  workspaceId: seeded.workspaceId,
                  recordAuditEvent: async () => await Promise.resolve(),
                },
                {
                  database: {
                    transaction: async (run) =>
                      await deletionDb.transaction(async (tx) => {
                        attempts += 1;
                        const rows = await tx.execute<{ pid: number }>(
                          sql`SELECT pg_backend_pid() AS pid`,
                        );
                        deletionStarted.resolve(
                          rows.at(0)?.pid ?? panic("Missing deletion pid"),
                        );
                        return await run(tx);
                      }),
                  },
                  enqueueCleanup: async () => await Promise.resolve(),
                },
              );
            })();
            try {
              const [hold, deletion] = await Promise.all([holding, deleting]);
              expect(hold).toEqual({
                type: "held",
                workspaceIds: [seeded.workspaceId],
              });
              expect(deletion.unwrap()).toEqual({ status: "deleted" });
              expect(attempts).toBe(1);
              expect(
                await holdingDb
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, seeded.workspaceId)),
              ).toEqual([]);
            } finally {
              holdPrefix.resolve(undefined);
              deletionStarted.resolve(-1);
              await Promise.allSettled([holding, deleting]);
            }
          } finally {
            await seeded.cleanUp();
          }
        });
      },
      20_000,
    );

    test("matter deletion lets a matter-first path read the deleting member without a deadlock", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: matterFirstDb } = openClient({
          max: 1,
          connection: { lock_timeout: 5000, statement_timeout: 10_000 },
        });
        const { db: deletionDb } = openClient({
          max: 1,
          connection: { lock_timeout: 5000, statement_timeout: 10_000 },
        });
        const seeded = await seedAdminClientMatter(matterFirstDb, "assigned");
        const matterLocked = Promise.withResolvers<undefined>();
        const deletionStarted = Promise.withResolvers<number>();
        // Deletion retries a deadlock victim, so a lost first attempt would
        // still delete the matter; one attempt proves there was no cycle.
        let attempts = 0;
        try {
          // Adding a member locks the matter row, then the added user's
          // organization member row FOR KEY SHARE. Here the added user is the
          // admin deleting the same matter, who already holds that member row
          // and waits for the matter row.
          const matterFirst = matterFirstDb.transaction(async (tx) => {
            await tx
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, seeded.workspaceId))
              .for("update");
            matterLocked.resolve(undefined);
            const deletionPid = await deletionStarted.promise;
            await expectTransactionToBlockClient(tx, deletionPid);
            const members = await tx
              .select({ id: member.id })
              .from(member)
              .where(eq(member.id, seeded.memberId))
              .for("key share");
            return members.length;
          });
          const deleting = (async () => {
            await matterLocked.promise;
            return await executeAuthorizedWorkspaceDeletion(
              {
                actorUserId: seeded.userId,
                organizationId: seeded.organizationId,
                workspaceId: seeded.workspaceId,
                recordAuditEvent: async () => await Promise.resolve(),
              },
              {
                database: {
                  transaction: async (run) =>
                    await deletionDb.transaction(async (tx) => {
                      attempts += 1;
                      const rows = await tx.execute<{ pid: number }>(
                        sql`SELECT pg_backend_pid() AS pid`,
                      );
                      deletionStarted.resolve(
                        rows.at(0)?.pid ?? panic("Missing deletion pid"),
                      );
                      return await run(tx);
                    }),
                },
                enqueueCleanup: async () => await Promise.resolve(),
              },
            );
          })();
          try {
            const [members, deletion] = await Promise.all([
              matterFirst,
              deleting,
            ]);
            expect(members).toBe(1);
            expect(deletion.unwrap()).toEqual({ status: "deleted" });
            expect(attempts).toBe(1);
          } finally {
            matterLocked.resolve(undefined);
            deletionStarted.resolve(-1);
            await Promise.allSettled([matterFirst, deleting]);
          }
        } finally {
          await seeded.cleanUp();
        }
      });
    }, 20_000);

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
