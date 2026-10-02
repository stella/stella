import { APIError } from "better-auth/api";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { timeEntries, timeTimers } from "@/api/db/schema";
import { ACCOUNT_DELETION_ERROR_CODE } from "@/api/lib/account-deletion-steps";
import { getAuth } from "@/api/lib/auth";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import {
  mapMembershipInvariantError,
  OWNER_REQUIRED_ERROR_CODE,
} from "@/api/lib/membership-role-invariants";
import { cents } from "@/api/lib/money";
import { closeRemovedMemberActiveTimer } from "@/api/lib/time-entry-offboarding";
import {
  withGatedTestClients,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { signInHuman } from "@/api/tests/helpers/human-session";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCK_OBSERVATION_TIMEOUT_MS = 10_000;
const BLOCK_OBSERVATION_INTERVAL_MS = 10;

setDefaultTimeout(120_000);

const waitForMembershipBlock = async (observeBlock: () => Promise<boolean>) => {
  const deadline = performance.now() + BLOCK_OBSERVATION_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (await observeBlock()) {
      return;
    }
    await Bun.sleep(BLOCK_OBSERVATION_INTERVAL_MS);
  }
  throw new Error(
    "Membership mutation did not reach its database lock before the deadline",
  );
};

const fixture = async (db: GatedTestDb, ownerCount: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const owners = Array.from({ length: ownerCount }, () => ({
    userId: mintAuthProviderId<"user">(),
    memberId: Bun.randomUUIDv7(),
    entryId: createSafeId<"timeEntry">(),
    timerId: createSafeId<"timeTimer">(),
  }));
  const startedAt = new Date(Date.now() - 60_000);
  await db.insert(user).values(
    owners.map(({ userId }) => ({
      id: userId,
      name: "Membership",
      email: `${userId.toLowerCase()}@membership.test`,
    })),
  );
  await db.insert(organization).values({
    id: organizationId,
    name: "Membership",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(member).values(
    owners.map(({ userId, memberId }) => ({
      id: memberId,
      userId,
      organizationId,
      role: "owner",
      createdAt: new Date(),
    })),
  );
  await db.insert(timeEntries).values(
    owners.map(
      ({ userId, entryId }) =>
        ({
          id: entryId,
          userId,
          organizationId,
          activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
          dateWorked: startedAt.toISOString().slice(0, 10),
          timezoneId: "UTC",
          durationMinutes: 0,
          billedMinutes: 0,
          rateAtEntry: cents(0),
          currency: UNPRICED_TIME_ENTRY_CURRENCY,
          billable: false,
          narrative: "",
          source: "timer",
          timerStartedAt: startedAt,
        }) satisfies typeof timeEntries.$inferInsert,
    ),
  );
  await db.insert(timeTimers).values(
    owners.map(
      ({ userId, entryId, timerId }) =>
        ({
          id: timerId,
          userId,
          organizationId,
          legacyTimeEntryId: entryId,
          state: "running",
          startedAt,
          lastResumedAt: startedAt,
        }) satisfies typeof timeTimers.$inferInsert,
    ),
  );
  return {
    organizationId,
    owners,
    cleanUp: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(
        inArray(
          user.id,
          owners.map(({ userId }) => userId),
        ),
      );
    },
  };
};

type MembershipOperation = "remove" | "demote";

type ApplyOperationArgs = {
  tx: Transaction;
  operation: MembershipOperation;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberId: string;
};

const applyOperation = async ({
  tx,
  operation,
  organizationId,
  userId,
  memberId,
}: ApplyOperationArgs) => {
  switch (operation) {
    case "demote":
      await tx
        .update(member)
        .set({ role: "member" })
        .where(eq(member.id, memberId));
      return;
    case "remove": {
      const offboarding = await closeRemovedMemberActiveTimer({
        tx,
        organizationId,
        userId,
      });
      if (offboarding.isErr()) {
        throw offboarding.error;
      }
      await tx.delete(member).where(eq(member.id, memberId));
      return;
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("membership role invariants (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("membership role invariants (postgres)", () => {
    const schedules = [
      ["remove", "remove"],
      ["demote", "demote"],
      ["remove", "demote"],
    ] as const satisfies readonly (readonly [
      MembershipOperation,
      MembershipOperation,
    ])[];

    for (const operations of schedules) {
      for (const reversed of [false, true]) {
        test(`${operations.join(" / ")} retains an owner (${reversed ? "second" : "first"} arrives first)`, async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const setup = openClient();
            const first = openClient();
            const second = openClient();
            const data = await fixture(setup.db, 2);
            const targets = reversed ? data.owners.toReversed() : data.owners;
            const orderedOperations = reversed
              ? operations.toReversed()
              : operations;
            const firstTarget = targets.at(0);
            const secondTarget = targets.at(1);
            const firstOperation = orderedOperations.at(0);
            const secondOperation = orderedOperations.at(1);
            if (
              !firstTarget ||
              !secondTarget ||
              !firstOperation ||
              !secondOperation
            ) {
              throw new Error("Membership schedule fixture is incomplete");
            }
            const firstWritten = Promise.withResolvers<undefined>();
            const releaseFirst = Promise.withResolvers<undefined>();
            let firstChange: Promise<void> | undefined;
            let secondChange: Promise<unknown> | undefined;
            try {
              const [secondSession] = await second.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`;
              if (!secondSession) {
                throw new Error(
                  "Membership schedule has no second backend pid",
                );
              }
              firstChange = first.db
                .transaction(async (tx) => {
                  await applyOperation({
                    tx,
                    operation: firstOperation,
                    organizationId: data.organizationId,
                    ...firstTarget,
                  });
                  firstWritten.resolve(undefined);
                  await releaseFirst.promise;
                })
                .catch((error: unknown) => {
                  firstWritten.reject(error);
                  throw error;
                });
              await firstWritten.promise;
              secondChange = second.db
                .transaction(async (tx) => {
                  await applyOperation({
                    tx,
                    operation: secondOperation,
                    organizationId: data.organizationId,
                    ...secondTarget,
                  });
                })
                .then(
                  () => ({ status: "committed" as const }),
                  (error: unknown) => ({
                    status: "refused" as const,
                    error: mapMembershipInvariantError(error),
                  }),
                );

              // Query the real lock wait; no elapsed-time assumption chooses the schedule.
              await waitForMembershipBlock(async () => {
                const [row] = await setup.sql<{ blocked: boolean }[]>`
                  SELECT cardinality(pg_blocking_pids(${secondSession.pid})) > 0 AS blocked
                `;
                return row?.blocked === true;
              });
              releaseFirst.resolve(undefined);
              await firstChange;
              const outcome = await secondChange;
              expect(outcome).toMatchObject({
                status: "refused",
                error: { body: { code: OWNER_REQUIRED_ERROR_CODE } },
              });
              if (
                outcome &&
                typeof outcome === "object" &&
                "error" in outcome
              ) {
                expect(outcome.error).toBeInstanceOf(APIError);
              }
              const remaining = await setup.db
                .select({ id: member.id, role: member.role })
                .from(member)
                .where(eq(member.organizationId, data.organizationId));
              expect(remaining.filter(({ role }) => role === "owner")).toEqual([
                { id: secondTarget.memberId, role: "owner" },
              ]);
              const [entry] = await setup.db
                .select()
                .from(timeEntries)
                .where(eq(timeEntries.id, secondTarget.entryId));
              const [timer] = await setup.db
                .select()
                .from(timeTimers)
                .where(eq(timeTimers.id, secondTarget.timerId));
              expect(entry?.timerStartedAt).toBeInstanceOf(Date);
              expect(entry?.timerStoppedAt).toBeNull();
              expect(entry?.durationMinutes).toBe(0);
              expect(timer?.state).toBe("running");
              expect(timer?.lastResumedAt).toBeInstanceOf(Date);
            } finally {
              releaseFirst.resolve(undefined);
              try {
                await Promise.all([firstChange, secondChange]);
              } finally {
                await data.cleanUp();
              }
            }
          });
        });
      }
    }

    test("three owners permit two concurrent removals", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const first = openClient();
        const second = openClient();
        const data = await fixture(setup.db, 3);
        const firstWritten = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();
        let firstChange: Promise<void> | undefined;
        let secondChange: Promise<unknown> | undefined;
        try {
          const firstTarget = data.owners.at(0);
          const secondTarget = data.owners.at(1);
          const thirdTarget = data.owners.at(2);
          if (!firstTarget || !secondTarget || !thirdTarget) {
            throw new Error("Membership fixture requires three owners");
          }
          const [secondSession] = await second.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          if (!secondSession) {
            throw new Error("Membership schedule has no second backend pid");
          }
          firstChange = first.db
            .transaction(async (tx) => {
              await applyOperation({
                tx,
                operation: "remove",
                organizationId: data.organizationId,
                ...firstTarget,
              });
              firstWritten.resolve(undefined);
              await releaseFirst.promise;
            })
            .catch((error: unknown) => {
              firstWritten.reject(error);
              throw error;
            });
          await firstWritten.promise;
          secondChange = second.db
            .transaction(async (tx) => {
              await applyOperation({
                tx,
                operation: "remove",
                organizationId: data.organizationId,
                ...secondTarget,
              });
            })
            .then(
              () => ({ status: "committed" as const }),
              (error: unknown) => ({ status: "refused" as const, error }),
            );
          await waitForMembershipBlock(async () => {
            const [row] = await setup.sql<{ blocked: boolean }[]>`
              SELECT cardinality(pg_blocking_pids(${secondSession.pid})) > 0 AS blocked
            `;
            return row?.blocked === true;
          });
          releaseFirst.resolve(undefined);
          await firstChange;
          expect(await secondChange).toEqual({ status: "committed" });
          const remaining = await setup.db
            .select({ id: member.id, role: member.role })
            .from(member)
            .where(eq(member.organizationId, data.organizationId));
          expect(remaining).toEqual([
            { id: thirdTarget.memberId, role: "owner" },
          ]);
        } finally {
          releaseFirst.resolve(undefined);
          try {
            await Promise.all([firstChange, secondChange]);
          } finally {
            await data.cleanUp();
          }
        }
      });
    });

    for (const firstOperation of ["remove", "demote"] as const) {
      test(`real auth returns a typed refusal after concurrent ${firstOperation}`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const setup = openClient();
          const first = openClient();
          const data = await fixture(setup.db, 2);
          const firstTarget = data.owners.at(0);
          const secondTarget = data.owners.at(1);
          if (!firstTarget || !secondTarget) {
            throw new Error("Membership auth fixture requires two owners");
          }
          const firstWritten = Promise.withResolvers<number>();
          const releaseFirst = Promise.withResolvers<undefined>();
          let firstChange: Promise<void> | undefined;
          let secondChange: Promise<Response> | undefined;
          try {
            const secondBrowser = await signInHuman(
              `${secondTarget.userId.toLowerCase()}@membership.test`,
            );
            await secondBrowser.setActiveOrganization(data.organizationId);
            expect(secondBrowser.userId).toBe(secondTarget.userId);
            firstChange = first.db
              .transaction(async (tx) => {
                const rows = await tx.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                );
                const session = rows.at(0);
                if (!session) {
                  throw new Error(
                    "Membership auth schedule has no first backend pid",
                  );
                }
                await applyOperation({
                  tx,
                  operation: firstOperation,
                  organizationId: data.organizationId,
                  ...firstTarget,
                });
                firstWritten.resolve(session.pid);
                await releaseFirst.promise;
              })
              .catch((error: unknown) => {
                firstWritten.reject(error);
                throw error;
              });
            const firstPid = await firstWritten.promise;
            const auth = getAuth();
            secondChange =
              firstOperation === "remove"
                ? auth.api.updateMemberRole({
                    body: {
                      memberId: secondTarget.memberId,
                      organizationId: data.organizationId,
                      role: "member",
                    },
                    headers: secondBrowser.headers(),
                    asResponse: true,
                  })
                : auth.api.removeMember({
                    body: {
                      memberIdOrEmail: secondTarget.memberId,
                      organizationId: data.organizationId,
                    },
                    headers: secondBrowser.headers(),
                    asResponse: true,
                  });
            await waitForMembershipBlock(async () => {
              const [row] = await setup.sql<{ blocked: boolean }[]>`
                SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE ${firstPid} = ANY(pg_blocking_pids(pid))
                ) AS blocked
              `;
              return row?.blocked === true;
            });
            releaseFirst.resolve(undefined);
            await firstChange;
            const response = await secondChange;
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
              code: OWNER_REQUIRED_ERROR_CODE,
            });
            const remaining = await setup.db
              .select({ id: member.id, role: member.role })
              .from(member)
              .where(eq(member.organizationId, data.organizationId));
            expect(remaining.filter(({ role }) => role === "owner")).toEqual([
              { id: secondTarget.memberId, role: "owner" },
            ]);
            const [entry] = await setup.db
              .select()
              .from(timeEntries)
              .where(eq(timeEntries.id, secondTarget.entryId));
            const [timer] = await setup.db
              .select()
              .from(timeTimers)
              .where(eq(timeTimers.id, secondTarget.timerId));
            expect(entry?.timerStartedAt).toBeInstanceOf(Date);
            expect(entry?.timerStoppedAt).toBeNull();
            expect(entry?.durationMinutes).toBe(0);
            expect(timer?.state).toBe("running");
          } finally {
            releaseFirst.resolve(undefined);
            try {
              await Promise.all([firstChange, secondChange]);
            } finally {
              await data.cleanUp();
            }
          }
        });
      });
    }

    test("last-owner account deletion refuses while organization teardown cascades", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const data = await fixture(setup.db, 1);
        try {
          const owner = data.owners.at(0);
          if (!owner) {
            throw new Error("Membership fixture requires an owner");
          }
          const email = `${owner.userId.toLowerCase()}@membership.test`;
          const otp = await createConfirmationOtp({
            purpose: "delete-account",
            email,
          });
          expect(otp.isOk()).toBe(true);
          if (otp.isErr()) {
            throw otp.error;
          }
          const deletion = await verifyAndDeleteUser(
            owner.userId,
            email,
            otp.value,
          );
          expect(deletion.isErr()).toBe(true);
          if (deletion.isErr()) {
            expect(deletion.error).toMatchObject({
              status: 400,
              code: ACCOUNT_DELETION_ERROR_CODE.soleOwner,
            });
          }
          const [retainedUser] = await setup.db
            .select()
            .from(user)
            .where(eq(user.id, owner.userId));
          expect(retainedUser?.deletedAt).toBeNull();
          const [retainedMember] = await setup.db
            .select()
            .from(member)
            .where(eq(member.id, owner.memberId));
          expect(retainedMember?.role).toBe("owner");
          await setup.db.transaction(async (tx) => {
            await tx
              .delete(organization)
              .where(eq(organization.id, data.organizationId));
          });
          const rows = await setup.db.execute(
            sql`SELECT id FROM member WHERE organization_id = ${data.organizationId}`,
          );
          expect(rows).toHaveLength(0);
        } finally {
          await data.cleanUp();
        }
      });
    });
  });
}
