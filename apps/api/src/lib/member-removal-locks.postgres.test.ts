import { Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { member, organization, user, verification } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  accountDeletionRequests,
  contacts,
  entities,
  taskAssignees,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createWorkspaceHandler } from "@/api/handlers/workspaces/create";
import { ACCOUNT_DELETION_ERROR_CODE } from "@/api/lib/account-deletion-steps";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { isPgConstraintError, isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  withGatedTestClients,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCK_OBSERVATION_TIMEOUT_MS = 10_000;
const BLOCK_OBSERVATION_INTERVAL_MS = 10;

setDefaultTimeout(120_000);

/** Polls lock state, never elapsed time: proceeds once Postgres reports the wait. */
const waitUntilBlocked = async (db: GatedTestDb, blockedPid: number) => {
  const deadline = performance.now() + BLOCK_OBSERVATION_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const [row] = await db.execute<{ blocked: boolean }>(
      sql`SELECT cardinality(pg_blocking_pids(${blockedPid})) > 0 AS blocked`,
    );
    if (row?.blocked === true) {
      return;
    }
    await Bun.sleep(BLOCK_OBSERVATION_INTERVAL_MS);
  }
  throw new Error("The transaction did not reach its lock wait");
};

/** Waits until any backend is blocked by `holderPid`. */
const waitUntilHolding = async (db: GatedTestDb, holderPid: number) => {
  const deadline = performance.now() + BLOCK_OBSERVATION_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const [row] = await db.execute<{ blocking: boolean }>(
      sql`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(pid))
      ) AS blocking`,
    );
    if (row?.blocking === true) {
      return;
    }
    await Bun.sleep(BLOCK_OBSERVATION_INTERVAL_MS);
  }
  throw new Error("Nothing reached the held lock");
};

const backendPid = async (tx: { execute: GatedTestDb["execute"] }) => {
  const [row] = await tx.execute<{ pid: number }>(
    sql`SELECT pg_backend_pid() AS pid`,
  );
  if (!row) {
    throw new Error("No backend pid");
  }
  return row.pid;
};

/**
 * Two owners of one organization; the departing one leads and works in a
 * matter there, so account erasure and organization removal both change it.
 */
const fixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const ownerId = mintAuthProviderId<"user">();
  const leaverId = brandPersistedUserId(mintAuthProviderId<"user">());
  const ownerMemberId = Bun.randomUUIDv7();
  const leaverMemberId = Bun.randomUUIDv7();
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const colleagueId = mintAuthProviderId<"user">();
  const colleagueMemberId = Bun.randomUUIDv7();
  const taskId = createSafeId<"entity">();
  const email = `${leaverId.toLowerCase()}@erasure.test`;
  await db.insert(user).values([
    {
      id: ownerId,
      name: "Owner",
      email: `${ownerId.toLowerCase()}@erasure.test`,
    },
    { id: leaverId, name: "Leaver", email },
    {
      id: colleagueId,
      name: "Colleague",
      email: `${colleagueId.toLowerCase()}@erasure.test`,
    },
  ]);
  await db.insert(organization).values({
    id: organizationId,
    name: "Erasure",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(member).values([
    {
      id: ownerMemberId,
      organizationId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: leaverMemberId,
      organizationId,
      userId: leaverId,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: colleagueMemberId,
      organizationId,
      userId: colleagueId,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  await db.insert(workspaces).values([
    {
      id: workspaceId,
      organizationId,
      name: "Erasure matter",
      reference: workspaceId,
      leadUserId: leaverId,
    },
    {
      id: otherWorkspaceId,
      organizationId,
      name: "Unrelated matter",
      reference: otherWorkspaceId,
    },
  ]);
  await db
    .insert(workspaceMembers)
    .values([
      ...[ownerId, leaverId].map((userId) => ({ workspaceId, userId })),
      { workspaceId: otherWorkspaceId, userId: ownerId },
    ]);
  await db.insert(entities).values({
    id: taskId,
    workspaceId,
    kind: "task",
    name: "Open work",
  });
  await db.insert(taskAssignees).values({
    entityId: taskId,
    workspaceId,
    userId: leaverId,
    role: "assignee",
  });
  const otp = await createConfirmationOtp({ purpose: "delete-account", email });
  if (Result.isError(otp)) {
    throw otp.error;
  }
  return {
    organizationId,
    ownerId,
    ownerMemberId,
    leaverId,
    leaverMemberId,
    workspaceId,
    otherWorkspaceId,
    colleagueId,
    colleagueMemberId,
    email,
    code: otp.value,
    otpRows: async () =>
      await db.$count(
        verification,
        eq(verification.identifier, `delete-account:${email}`),
      ),
    cleanUp: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.userId, leaverId));
      await db.delete(user).where(eq(user.id, ownerId));
      await db.delete(user).where(eq(user.id, leaverId));
      await db.delete(user).where(eq(user.id, colleagueId));
      await db
        .delete(verification)
        .where(eq(verification.identifier, `delete-account:${email}`));
    },
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Organization removal of the leaver that holds its transaction open. */
const heldRemoval = (db: GatedTestDb, data: Fixture) => {
  const pid = Promise.withResolvers<number>();
  const removed = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const done = db.transaction(async (tx) => {
    pid.resolve(await backendPid(tx));
    await removeOrganizationMemberInTransaction(asTestRaw<Transaction>(tx), {
      organizationId: data.organizationId,
      memberId: data.leaverMemberId,
      userId: data.leaverId,
      actorUserId: brandPersistedUserId(data.ownerId),
    });
    removed.resolve(undefined);
    await release.promise;
  });
  return { pid: pid.promise, removed: removed.promise, release, done };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("account erasure and organization removal (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests).toBe(true);
    });
  });
} else {
  describe("account erasure and organization removal (postgres)", () => {
    test("erasure arriving second waits for the removal and completes", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: removalDb } = openClient();
        const data = await fixture(db);
        const removal = heldRemoval(removalDb, data);
        try {
          await removal.removed;
          const removalPid = await removal.pid;
          const erasure = verifyAndDeleteUser(
            data.leaverId,
            data.email,
            data.code,
          );
          await waitUntilHolding(db, removalPid);
          removal.release.resolve(undefined);
          await removal.done;
          const erased = await erasure;
          expect(Result.isOk(erased)).toBe(true);
          const [erasedUser] = await db
            .select({ deletedAt: user.deletedAt })
            .from(user)
            .where(eq(user.id, data.leaverId));
          expect(erasedUser?.deletedAt).not.toBeNull();
          expect(
            await db.$count(member, eq(member.userId, data.leaverId)),
          ).toBe(0);
          expect(await data.otpRows()).toBe(0);
        } finally {
          removal.release.resolve(undefined);
          // The happy path already awaited it; this only drains a failed run.
          await Promise.allSettled([removal.done]);
          await data.cleanUp();
        }
      });
    });

    test("erasure holding the membership refuses the busy matter, keeps its code, and retries", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: blockerDb } = openClient();
        const { db: removalDb } = openClient();
        const data = await fixture(db);
        // A co-owner row share-lock pauses erasure after it holds the
        // leaver's own membership rows and before it reaches any matter.
        const blockerPid = Promise.withResolvers<number>();
        const releaseBlocker = Promise.withResolvers<undefined>();
        const blocker = blockerDb.transaction(async (tx) => {
          await tx
            .select({ id: member.id })
            .from(member)
            .where(eq(member.id, data.ownerMemberId))
            .for("share");
          blockerPid.resolve(await backendPid(tx));
          await releaseBlocker.promise;
        });
        let removal: ReturnType<typeof heldRemoval> | undefined;
        try {
          const heldBy = await blockerPid.promise;
          const erasure = verifyAndDeleteUser(
            data.leaverId,
            data.email,
            data.code,
          );
          await waitUntilHolding(db, heldBy);
          // Organization removal takes the matter, then waits on the
          // membership the erasure already holds.
          removal = heldRemoval(removalDb, data);
          await waitUntilBlocked(db, await removal.pid);
          releaseBlocker.resolve(undefined);
          await blocker;
          const refused = await erasure;
          expect(Result.isError(refused)).toBe(true);
          if (Result.isError(refused)) {
            expect(refused.error).toMatchObject({
              status: 409,
              code: "member_removal_busy",
              retryable: true,
            });
          }
          // The refusal released the membership; removal finishes.
          await removal.removed;
          removal.release.resolve(undefined);
          await removal.done;
          // The refused attempt never consumed the code.
          expect(await data.otpRows()).toBe(1);
          const retried = await verifyAndDeleteUser(
            data.leaverId,
            data.email,
            data.code,
          );
          expect(Result.isOk(retried)).toBe(true);
          expect(await data.otpRows()).toBe(0);
          expect(
            await db.$count(
              workspaceMembers,
              and(
                eq(workspaceMembers.workspaceId, data.workspaceId),
                eq(workspaceMembers.userId, data.leaverId),
              ),
            ),
          ).toBe(0);
        } finally {
          releaseBlocker.resolve(undefined);
          removal?.release.resolve(undefined);
          // The happy path already awaited both; this only drains a failed run.
          await Promise.allSettled([blocker, removal?.done]);
          await data.cleanUp();
        }
      });
    });

    test("a wrong code stays burned even though the deletion rolls back", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const data = await fixture(db);
        try {
          const wrong = await verifyAndDeleteUser(
            data.leaverId,
            data.email,
            data.code === "000000" ? "111111" : "000000",
          );
          expect(Result.isError(wrong)).toBe(true);
          if (Result.isError(wrong)) {
            expect(wrong.error).toMatchObject({
              status: 400,
              code: ACCOUNT_DELETION_ERROR_CODE.otpInvalid,
            });
          }
          expect(await data.otpRows()).toBe(0);
          const replay = await verifyAndDeleteUser(
            data.leaverId,
            data.email,
            data.code,
          );
          expect(Result.isError(replay)).toBe(true);
          if (Result.isError(replay)) {
            expect(replay.error).toMatchObject({
              code: ACCOUNT_DELETION_ERROR_CODE.otpInvalid,
            });
          }
          expect(
            await db.$count(member, eq(member.userId, data.leaverId)),
          ).toBe(1);
        } finally {
          await data.cleanUp();
        }
      });
    });
  });
}

const lockNowait = async (
  db: GatedTestDb,
  workspaceId: Fixture["workspaceId"],
) =>
  await Result.tryPromise({
    try: async () =>
      await db.transaction(
        async (tx) =>
          await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .for("update", { noWait: true }),
      ),
    catch: (error) => error,
  });

const describeLocks =
  databaseUrl && runPostgresTests ? describe : describe.skip;

describeLocks("organization removal lock scope (postgres)", () => {
  test("removal holds the matters it changes and leaves the others writable", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const { db: removalDb } = openClient();
      const data = await fixture(db);
      const removal = heldRemoval(removalDb, data);
      try {
        await removal.removed;
        const unrelated = await lockNowait(db, data.otherWorkspaceId);
        expect(Result.isOk(unrelated)).toBe(true);
        const affected = await lockNowait(db, data.workspaceId);
        expect(Result.isError(affected)).toBe(true);
        if (Result.isError(affected)) {
          expect(isPgError(affected.error, PG_ERROR.LOCK_NOT_AVAILABLE)).toBe(
            true,
          );
        }
        removal.release.resolve(undefined);
        await removal.done;
      } finally {
        removal.release.resolve(undefined);
        // The happy path already awaited it; this only drains a failed run.
        await Promise.allSettled([removal.done]);
        await data.cleanUp();
      }
    });
  });
});

describeLocks(
  "matter membership reference under concurrency (postgres)",
  () => {
    for (const first of ["grant", "departure"] as const) {
      test(`${first} first: no matter membership outlives its organization membership`, async () => {
        if (!databaseUrl) {
          throw new Error("DATABASE_URL");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const { db: grantDb } = openClient();
          const { db: departureDb } = openClient();
          const data = await fixture(db);
          const held = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          const grant = async (hold: boolean) =>
            await grantDb.transaction(async (tx) => {
              if (hold) {
                await tx.insert(workspaceMembers).values({
                  workspaceId: data.workspaceId,
                  userId: data.colleagueId,
                });
                held.resolve(await backendPid(tx));
                await release.promise;
                return;
              }
              await tx.insert(workspaceMembers).values({
                workspaceId: data.workspaceId,
                userId: data.colleagueId,
              });
            });
          const departure = async (hold: boolean) =>
            await departureDb.transaction(async (tx) => {
              await tx
                .delete(member)
                .where(eq(member.id, data.colleagueMemberId));
              if (hold) {
                held.resolve(await backendPid(tx));
                await release.promise;
              }
            });
          try {
            const firstRun = first === "grant" ? grant(true) : departure(true);
            const holderPid = await held.promise;
            const secondRun = Result.tryPromise({
              try: async () =>
                first === "grant" ? await departure(false) : await grant(false),
              catch: (error) => error,
            });
            await waitUntilHolding(db, holderPid);
            release.resolve(undefined);
            await firstRun;
            const second = await secondRun;
            if (first === "grant") {
              // The departure waited for the grant, then took it away too.
              expect(Result.isOk(second)).toBe(true);
            } else {
              // The grant waited for the departure, then found nothing to reference.
              expect(Result.isError(second)).toBe(true);
              if (Result.isError(second)) {
                expect(
                  isPgConstraintError(
                    second.error,
                    PG_ERROR.FOREIGN_KEY_VIOLATION,
                    "workspace_members_organization_member",
                  ),
                ).toBe(true);
              }
            }
            expect(
              await db.$count(
                workspaceMembers,
                eq(workspaceMembers.userId, data.colleagueId),
              ),
            ).toBe(0);
            expect(
              await db.$count(member, eq(member.userId, data.colleagueId)),
            ).toBe(0);
          } finally {
            release.resolve(undefined);
            await data.cleanUp();
          }
        });
      });
    }
  },
);

describeLocks("matter creation against organization removal (postgres)", () => {
  for (const first of ["creation", "removal"] as const) {
    test(`${first} first: the new matter never keeps the departed member`, async () => {
      if (!databaseUrl) {
        throw new Error("DATABASE_URL");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: creationDb } = openClient();
        const { db: removalDb } = openClient();
        const data = await fixture(db);
        const clientId = createSafeId<"contact">();
        const newWorkspaceId = createSafeId<"workspace">();
        await db.insert(contacts).values({
          id: clientId,
          organizationId: data.organizationId,
          type: "person",
          displayName: "Matter client",
        });
        const creationPid = Promise.withResolvers<number>();
        const releaseCreation = Promise.withResolvers<undefined>();
        const create = async (hold: boolean) =>
          await Result.gen(() =>
            createWorkspaceHandler({
              userEmail: `${data.ownerId.toLowerCase()}@erasure.test`,
              safeDb: safeDbFromScoped(
                async (fn) =>
                  await creationDb.transaction(async (tx) => {
                    creationPid.resolve(await backendPid(tx));
                    const value = await fn(asTestRaw<Transaction>(tx));
                    if (hold) {
                      await releaseCreation.promise;
                    }
                    return value;
                  }),
              ),
              organizationId: brandPersistedOrganizationId(data.organizationId),
              userId: brandPersistedUserId(data.ownerId),
              recordAuditEvent: createBackgroundAuditRecorder({
                organizationId: brandPersistedOrganizationId(
                  data.organizationId,
                ),
                workspaceId: null,
                userId: brandPersistedUserId(data.ownerId),
                execution: {
                  performer: { type: "user", id: data.ownerId },
                  trigger: { type: "system", source: "fixture" },
                },
              }),
              body: {
                id: newWorkspaceId,
                name: "Concurrent matter",
                filePropertyName: "Files",
                clientId,
                memberUserIds: [data.leaverId],
              },
            }),
          );
        let removal: ReturnType<typeof heldRemoval> | undefined;
        try {
          if (first === "creation") {
            const creation = create(true);
            const holder = await creationPid.promise;
            removal = heldRemoval(removalDb, data);
            await waitUntilHolding(db, holder);
            releaseCreation.resolve(undefined);
            const created = await creation;
            expect(Result.isOk(created)).toBe(true);
            // The new matter's own follow-up writes may still hold it: the
            // removal either completes or refuses with the typed busy
            // conflict, and a caller's retry then completes.
            const held = removal;
            const attempt = await Result.tryPromise({
              try: async () => {
                await Promise.race([held.removed, held.done]);
                held.release.resolve(undefined);
                await held.done;
              },
              catch: (error) => error,
            });
            if (Result.isError(attempt)) {
              expect(attempt.error).toMatchObject({
                status: 409,
                code: "member_removal_busy",
                retryable: true,
              });
              let retried = false;
              for (let tries = 0; tries < 20 && !retried; tries += 1) {
                // db-await-in-loop: each retry is a fresh removal transaction.
                const retry = await Result.tryPromise({
                  try: async () =>
                    await removalDb.transaction(async (tx) => {
                      await removeOrganizationMemberInTransaction(
                        asTestRaw<Transaction>(tx),
                        {
                          organizationId: data.organizationId,
                          memberId: data.leaverMemberId,
                          userId: data.leaverId,
                          actorUserId: brandPersistedUserId(data.ownerId),
                        },
                      );
                    }),
                  catch: (error) => error,
                });
                if (Result.isError(retry)) {
                  expect(retry.error).toMatchObject({
                    code: "member_removal_busy",
                  });
                } else {
                  retried = true;
                }
              }
              expect(retried).toBe(true);
            }
          } else {
            removal = heldRemoval(removalDb, data);
            await removal.removed;
            const creation = create(false);
            await waitUntilHolding(db, await removal.pid);
            removal.release.resolve(undefined);
            await removal.done;
            const refused = await creation;
            expect(Result.isError(refused)).toBe(true);
            if (Result.isError(refused)) {
              expect(refused.error).toMatchObject({
                status: 400,
                message: "Some users are not members of this organization",
              });
            }
          }
          expect(
            await db.$count(
              workspaceMembers,
              and(
                eq(workspaceMembers.workspaceId, newWorkspaceId),
                eq(workspaceMembers.userId, data.leaverId),
              ),
            ),
          ).toBe(0);
          expect(
            await db.$count(workspaces, eq(workspaces.id, newWorkspaceId)),
          ).toBe(first === "creation" ? 1 : 0);
        } finally {
          releaseCreation.resolve(undefined);
          removal?.release.resolve(undefined);
          // The happy path already awaited it; this only drains a failed run.
          await Promise.allSettled([removal?.done]);
          await data.cleanUp();
        }
      });
    });
  }
});

/**
 * A second organization and a matter of the fixture organization with no
 * members yet, for races against a change of the matter's organization.
 */
const movableMatter = async (db: GatedTestDb, data: Fixture) => {
  const targetOrganizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: targetOrganizationId,
    name: "Target",
    slug: targetOrganizationId,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: data.organizationId,
    name: "Movable matter",
    reference: workspaceId,
  });
  return {
    targetOrganizationId,
    workspaceId,
    organizationOf: async () =>
      (
        await db
          .select({ organizationId: workspaces.organizationId })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
      ).at(0)?.organizationId,
    orphans: async () =>
      (
        await db.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count
          FROM workspace_members wm
          JOIN workspaces w ON w.id = wm.workspace_id
          WHERE wm.workspace_id = ${workspaceId}
            AND NOT EXISTS (
              SELECT 1 FROM member m
              WHERE m.organization_id = w.organization_id
                AND m.user_id = wm.user_id
            )`)
      ).at(0)?.count,
    cleanUp: async () => {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db
        .delete(organization)
        .where(eq(organization.id, targetOrganizationId));
    },
  };
};

const expectReferenceRefusal = (outcome: Result<unknown, unknown>) => {
  expect(Result.isError(outcome)).toBe(true);
  if (Result.isError(outcome)) {
    expect(
      isPgConstraintError(
        outcome.error,
        PG_ERROR.FOREIGN_KEY_VIOLATION,
        "workspace_members_organization_member",
      ),
    ).toBe(true);
  }
};

describeLocks(
  "matter membership against a change of the matter's organization (postgres)",
  () => {
    for (const first of ["grant", "move"] as const) {
      test(`${first} first: the matter never keeps a member of another organization`, async () => {
        if (!databaseUrl) {
          throw new Error("DATABASE_URL");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const { db: grantDb } = openClient();
          const { db: moveDb } = openClient();
          const data = await fixture(db);
          const matter = await movableMatter(db, data);
          const holderPid = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          const grant = async (hold: boolean) =>
            await grantDb.transaction(async (tx) => {
              await tx.insert(workspaceMembers).values({
                workspaceId: matter.workspaceId,
                userId: data.colleagueId,
              });
              if (hold) {
                holderPid.resolve(await backendPid(tx));
                await release.promise;
              }
            });
          const move = async (hold: boolean) =>
            await moveDb.transaction(async (tx) => {
              await tx
                .update(workspaces)
                .set({ organizationId: matter.targetOrganizationId })
                .where(eq(workspaces.id, matter.workspaceId));
              if (hold) {
                holderPid.resolve(await backendPid(tx));
                await release.promise;
              }
            });
          try {
            const firstRun = Result.tryPromise({
              try: async () =>
                first === "grant" ? await grant(true) : await move(true),
              catch: (error) => error,
            });
            const pid = await holderPid.promise;
            const secondRun = Result.tryPromise({
              try: async () =>
                first === "grant" ? await move(false) : await grant(false),
              catch: (error) => error,
            });
            await waitUntilHolding(db, pid);
            release.resolve(undefined);
            expect(Result.isOk(await firstRun)).toBe(true);
            // The second writer waited, then saw the first one's commit.
            expectReferenceRefusal(await secondRun);
            expect(await matter.organizationOf()).toBe(
              first === "grant"
                ? data.organizationId
                : matter.targetOrganizationId,
            );
            expect(
              await db.$count(
                workspaceMembers,
                eq(workspaceMembers.workspaceId, matter.workspaceId),
              ),
            ).toBe(first === "grant" ? 1 : 0);
            expect(await matter.orphans()).toBe(0);
          } finally {
            release.resolve(undefined);
            await matter.cleanUp();
            await data.cleanUp();
          }
        });
      });
    }

    for (const first of ["move", "departure"] as const) {
      test(`${first} first: a departure from the target organization never leaves the moved matter's member behind`, async () => {
        if (!databaseUrl) {
          throw new Error("DATABASE_URL");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const { db: moveDb } = openClient();
          const { db: departureDb } = openClient();
          const data = await fixture(db);
          const matter = await movableMatter(db, data);
          const targetMemberId = Bun.randomUUIDv7();
          await db.insert(member).values({
            id: targetMemberId,
            organizationId: matter.targetOrganizationId,
            userId: data.colleagueId,
            role: "member",
            createdAt: new Date(),
          });
          await db.insert(workspaceMembers).values({
            workspaceId: matter.workspaceId,
            userId: data.colleagueId,
          });
          const holderPid = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          const move = async (hold: boolean) =>
            await moveDb.transaction(async (tx) => {
              await tx
                .update(workspaces)
                .set({ organizationId: matter.targetOrganizationId })
                .where(eq(workspaces.id, matter.workspaceId));
              if (hold) {
                holderPid.resolve(await backendPid(tx));
                await release.promise;
              }
            });
          const departure = async (hold: boolean) =>
            await departureDb.transaction(async (tx) => {
              await tx.delete(member).where(eq(member.id, targetMemberId));
              if (hold) {
                holderPid.resolve(await backendPid(tx));
                await release.promise;
              }
            });
          try {
            const firstRun = Result.tryPromise({
              try: async () =>
                first === "move" ? await move(true) : await departure(true),
              catch: (error) => error,
            });
            const pid = await holderPid.promise;
            const secondRun = Result.tryPromise({
              try: async () =>
                first === "move" ? await departure(false) : await move(false),
              catch: (error) => error,
            });
            await waitUntilHolding(db, pid);
            release.resolve(undefined);
            expect(Result.isOk(await firstRun)).toBe(true);
            const second = await secondRun;
            if (first === "move") {
              // The departure waited for the move, then cascaded to the
              // moved matter's membership.
              expect(Result.isOk(second)).toBe(true);
              expect(await matter.organizationOf()).toBe(
                matter.targetOrganizationId,
              );
              expect(
                await db.$count(
                  workspaceMembers,
                  eq(workspaceMembers.workspaceId, matter.workspaceId),
                ),
              ).toBe(0);
            } else {
              // The move waited for the departure, then found its member gone.
              expectReferenceRefusal(second);
              expect(await matter.organizationOf()).toBe(data.organizationId);
              expect(
                await db.$count(
                  workspaceMembers,
                  eq(workspaceMembers.workspaceId, matter.workspaceId),
                ),
              ).toBe(1);
            }
            expect(await matter.orphans()).toBe(0);
          } finally {
            release.resolve(undefined);
            await matter.cleanUp();
            await data.cleanUp();
          }
        });
      });
    }
  },
);
