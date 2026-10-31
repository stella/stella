import { panic, Result } from "better-result";
import type { ReservedSQL, SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { MEMBER_REMOVAL_BUSY_CODE } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";
import { deferred, settledWithin } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { runChatThreadCompaction } from "@/api/lib/chat/thread-compaction";
import type { ChatCompactionOutcome } from "@/api/lib/chat/thread-compaction";
import {
  lockChatOwnerStoredContentTransitionOnTx,
  lockThreadStoredContentTransitionOnTx,
} from "@/api/lib/chat/thread-stored-content-egress";
import type { WithThreadStoredContentEgress } from "@/api/lib/chat/thread-stored-content-egress";
import {
  withAggregateLock,
  withChatStoredContentEgressSessionLock,
} from "@/api/lib/db/aggregate-lock";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import { tryLockAccountMemberCleanup } from "@/api/lib/member-assignment-offboarding";
import { getPgErrorCode } from "@/api/lib/pg-error";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const SUMMARY_MARKDOWN = [
  "## Goal",
  "Continue the matter.",
  "",
  "## Constraints",
  "- None",
  "",
  "## Progress",
  "### Done",
  "- Reviewed the transcript",
  "### In Progress",
  "- None",
  "### Blocked",
  "- None",
  "",
  "## Key Decisions",
  "- None",
  "",
  "## Next Steps",
  "- Continue",
  "",
  "## Critical Context",
  "- None",
  "",
  "<read-files>",
  "</read-files>",
  "<modified-files>",
  "</modified-files>",
].join("\n");

type EgressFixture = {
  memberId: string;
  organizationId: SafeId<"organization">;
  ownerId: SafeId<"user">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  workspaceMemberId: SafeId<"workspaceMember">;
};

const seedEgressFixture = async (db: GatedTestDb): Promise<EgressFixture> => {
  const fixture: EgressFixture = {
    memberId: mintAuthProviderIdValue(),
    organizationId: mintAuthProviderId<"organization">(),
    ownerId: mintAuthProviderId<"user">(),
    userId: mintAuthProviderId<"user">(),
    workspaceId: createSafeId<"workspace">(),
    workspaceMemberId: createSafeId<"workspaceMember">(),
  };
  const { memberId, organizationId, ownerId, userId, workspaceId } = fixture;
  await db.insert(user).values([
    { email: `${userId}@example.test`, id: userId, name: "Egress lane test" },
    {
      email: `${ownerId}@example.test`,
      id: ownerId,
      name: "Egress lane owner",
    },
  ]);
  await db.insert(organization).values({
    createdAt: new Date(),
    id: organizationId,
    name: "Egress lane test",
    slug: organizationId,
  });
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  await db.insert(member).values([
    {
      createdAt: new Date(),
      id: memberId,
      organizationId,
      role: "member",
      userId,
    },
    {
      createdAt: new Date(),
      id: mintAuthProviderIdValue(),
      organizationId,
      role: "owner",
      userId: ownerId,
    },
  ]);
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "Egress lane test",
    organizationId,
    reference: `egress-${workspaceId}`,
  });
  await db.insert(workspaceMembers).values({
    id: fixture.workspaceMemberId,
    userId,
    workspaceId,
  });
  return fixture;
};

const seedThread = async (
  db: GatedTestDb,
  fixture: EgressFixture,
  messageCount: number,
): Promise<SafeId<"chatThread">> => {
  const threadId = createSafeId<"chatThread">();
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId: fixture.organizationId,
    title: "Egress lane test",
    userId: fixture.userId,
  });
  if (messageCount > 0) {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    await db.insert(chatMessages).values(
      Array.from({ length: messageCount }, (_, index) => ({
        content: toPersistedChatMessageContentV3({
          data: [{ content: `message ${index}`, type: "text" as const }],
        }),
        createdAt: new Date(base + index),
        id: createSafeId<"chatMessage">(),
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        threadId,
        userId: fixture.userId,
      })),
    );
  }
  return threadId;
};

const removeEgressFixture = async (db: GatedTestDb, fixture: EgressFixture) => {
  await db
    .delete(chatThreads)
    .where(eq(chatThreads.organizationId, fixture.organizationId));
  await db
    .delete(organization)
    .where(eq(organization.id, fixture.organizationId));
  await db.delete(user).where(eq(user.id, fixture.userId));
  await db.delete(user).where(eq(user.id, fixture.ownerId));
};

const backendPid = async (client: SQL | ReservedSQL): Promise<number> => {
  const rows = await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return rows.at(0)?.pid ?? panic("Missing backend pid");
};

/** The database backstop refuses at once instead of waiting with the row. */
const expectEgressRefusal = async (
  write: PromiseLike<unknown>,
  description: string,
): Promise<void> => {
  const refusal = rejectionOf(write);
  await settledWithin(refusal, { description });
  expect(getPgErrorCode(await refusal)).toBe("55P03");
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat stored-content egress (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("chat stored-content egress (postgres)", () => {
    test("fenced transitions wait for raw provider egress and unfenced row writers are refused", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient();
        const observer = openClient();
        const egress = openClient();
        const fixture = await seedEgressFixture(setup.db);
        const { memberId, organizationId, userId, workspaceMemberId } = fixture;
        const threadId = await seedThread(setup.db, fixture, 0);
        const deletedThreadId = await seedThread(setup.db, fixture, 0);
        const reserved = await egress.sql.reserve();
        const egressPid = await backendPid(reserved);
        const writerPid = await backendPid(writer.sql);

        type FencedTransitionOptions = {
          assertUnchanged: () => Promise<void>;
          fenced: (tx: Transaction) => Promise<unknown>;
          threadId: SafeId<"chatThread">;
          unfenced: () => PromiseLike<unknown>;
        };
        // The unfenced write is a raw statement, as a cascade or a future
        // writer would issue it. The fenced write takes the egress fence
        // before any row lock, as every application path does.
        const runFencedTransition = async ({
          assertUnchanged,
          fenced,
          threadId: transitionedThreadId,
          unfenced,
        }: FencedTransitionOptions) => {
          const releaseProvider = deferred();
          const providerEntered = deferred();
          let dispatch: Promise<void> | undefined;
          let mutation: Promise<unknown> | undefined;
          try {
            dispatch = withChatStoredContentEgressSessionLock({
              connection: reserved,
              organizationId,
              threadId: transitionedThreadId,
              userId,
              work: async () => {
                providerEntered.resolve();
                await releaseProvider.promise;
              },
            });
            await settledWithin(providerEntered.promise, {
              description: "the provider egress lane to be held",
            });
            await expectEgressRefusal(
              unfenced(),
              "the unfenced writer to be refused",
            );
            await assertUnchanged();
            mutation = writer.db.transaction(fenced);
            await waitForBlockedPid(observer.sql, {
              holdingPid: egressPid,
              waitingPid: writerPid,
            });
            await assertUnchanged();
            releaseProvider.resolve();
            await dispatch;
            await mutation;
          } finally {
            releaseProvider.resolve();
            await Promise.allSettled(
              [dispatch, mutation].filter(
                (pending): pending is Promise<unknown> => pending !== undefined,
              ),
            );
          }
        };

        const usedAnonymization = async () =>
          (
            await observer.db.query.chatThreads.findFirst({
              columns: { usedAnonymization: true },
              where: { id: { eq: threadId } },
            })
          )?.usedAnonymization;

        try {
          await runFencedTransition({
            assertUnchanged: async () => {
              expect(await usedAnonymization()).toBe(false);
            },
            fenced: async (tx) => {
              await lockThreadStoredContentTransitionOnTx(tx, threadId);
              await tx
                .update(chatThreads)
                .set({ usedAnonymization: true })
                .where(eq(chatThreads.id, threadId));
            },
            threadId,
            unfenced: () =>
              writer.db
                .update(chatThreads)
                .set({ usedAnonymization: true })
                .where(eq(chatThreads.id, threadId)),
          });
          expect(await usedAnonymization()).toBe(true);

          await runFencedTransition({
            assertUnchanged: async () => {
              expect(
                await observer.db.$count(
                  chatThreads,
                  eq(chatThreads.id, deletedThreadId),
                ),
              ).toBe(1);
            },
            fenced: async (tx) => {
              await lockThreadStoredContentTransitionOnTx(tx, deletedThreadId);
              await tx
                .delete(chatThreads)
                .where(eq(chatThreads.id, deletedThreadId));
            },
            threadId: deletedThreadId,
            unfenced: () =>
              writer.db
                .delete(chatThreads)
                .where(eq(chatThreads.id, deletedThreadId)),
          });
          expect(
            await observer.db.$count(
              chatThreads,
              eq(chatThreads.id, deletedThreadId),
            ),
          ).toBe(0);

          await runFencedTransition({
            assertUnchanged: async () => {
              expect(
                await observer.db.$count(
                  workspaceMembers,
                  eq(workspaceMembers.id, workspaceMemberId),
                ),
              ).toBe(1);
            },
            fenced: async (tx) => {
              await lockChatOwnerStoredContentTransitionOnTx(tx, {
                organizationId,
                userId,
              });
              await tx
                .delete(workspaceMembers)
                .where(eq(workspaceMembers.id, workspaceMemberId));
            },
            threadId,
            unfenced: () =>
              writer.db
                .delete(workspaceMembers)
                .where(eq(workspaceMembers.id, workspaceMemberId)),
          });
          expect(
            await observer.db.$count(
              workspaceMembers,
              eq(workspaceMembers.id, workspaceMemberId),
            ),
          ).toBe(0);

          await runFencedTransition({
            assertUnchanged: async () => {
              expect(
                await observer.db.$count(member, eq(member.id, memberId)),
              ).toBe(1);
            },
            fenced: async (tx) => {
              await lockChatOwnerStoredContentTransitionOnTx(tx, {
                organizationId,
                userId,
              });
              await tx.delete(member).where(eq(member.id, memberId));
            },
            threadId,
            unfenced: () =>
              writer.db.delete(member).where(eq(member.id, memberId)),
          });
          expect(
            await observer.db.$count(member, eq(member.id, memberId)),
          ).toBe(0);
        } finally {
          await reserved.release();
          await removeEgressFixture(setup.db, fixture);
        }
      });
    });

    test("a workspace deletion is refused while a member's compaction holds the owner fence, and its cascade keeps the membership", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient();
        const observer = openClient();
        const egress = openClient();
        const fixture = await seedEgressFixture(setup.db);
        const { organizationId, userId, workspaceId, workspaceMemberId } =
          fixture;
        const threadId = await seedThread(setup.db, fixture, 0);
        const reserved = await egress.sql.reserve();
        const releaseProvider = deferred();
        const providerEntered = deferred();
        let dispatch: Promise<void> | undefined;
        const membershipCount = async () =>
          await observer.db.$count(
            workspaceMembers,
            eq(workspaceMembers.id, workspaceMemberId),
          );
        try {
          dispatch = withChatStoredContentEgressSessionLock({
            connection: reserved,
            organizationId,
            threadId,
            userId,
            work: async () => {
              providerEntered.resolve();
              await releaseProvider.promise;
            },
          });
          await settledWithin(providerEntered.promise, {
            description: "the provider egress lane to be held",
          });
          // The membership leaves only through the workspace's cascade, which
          // runs after the workspace row is gone.
          await expectEgressRefusal(
            writer.db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
            "the workspace deletion to be refused",
          );
          expect(await membershipCount()).toBe(1);
          expect(
            await observer.db.$count(
              workspaces,
              eq(workspaces.id, workspaceId),
            ),
          ).toBe(1);
          releaseProvider.resolve();
          await dispatch;

          await writer.db
            .delete(workspaces)
            .where(eq(workspaces.id, workspaceId));
          expect(await membershipCount()).toBe(0);
        } finally {
          releaseProvider.resolve();
          await Promise.allSettled(
            [dispatch].filter(
              (pending): pending is Promise<void> => pending !== undefined,
            ),
          );
          await reserved.release();
          await removeEgressFixture(setup.db, fixture);
        }
      });
    });

    test("account erasure is a busy refusal, holding no membership row, while a compaction holds the owner fence", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient();
        const observer = openClient();
        const egress = openClient();
        const fixture = await seedEgressFixture(setup.db);
        const { memberId, organizationId, userId } = fixture;
        const threadId = await seedThread(setup.db, fixture, 0);
        const reserved = await egress.sql.reserve();
        const releaseProvider = deferred();
        const providerEntered = deferred();
        let dispatch: Promise<void> | undefined;
        try {
          dispatch = withChatStoredContentEgressSessionLock({
            connection: reserved,
            organizationId,
            threadId,
            userId,
            work: async () => {
              providerEntered.resolve();
              await releaseProvider.promise;
            },
          });
          await settledWithin(providerEntered.promise, {
            description: "the provider egress lane to be held",
          });
          const erasure = rejectionOf(
            writer.db.transaction(async (tx) => {
              await tryLockAccountMemberCleanup(tx, userId);
            }),
          );
          await settledWithin(erasure, {
            description: "account erasure to refuse without waiting",
          });
          expect(await erasure).toMatchObject({
            code: MEMBER_REMOVAL_BUSY_CODE,
            status: 409,
          });
          expect(
            await observer.db.$count(member, eq(member.id, memberId)),
          ).toBe(1);
          releaseProvider.resolve();
          await dispatch;

          await writer.db.transaction(async (tx) => {
            await tryLockAccountMemberCleanup(tx, userId);
          });
        } finally {
          releaseProvider.resolve();
          await Promise.allSettled(
            [dispatch].filter(
              (pending): pending is Promise<void> => pending !== undefined,
            ),
          );
          await reserved.release();
          await removeEgressFixture(setup.db, fixture);
        }
      });
    });

    test("a compaction run completes while trigger-backed deletions meet its egress fence", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient();
        const observer = openClient();
        const egress = openClient();
        const compactor = openClient();
        const fixture = await seedEgressFixture(setup.db);
        const { memberId, organizationId, userId } = fixture;
        const cascadeThreadId = await seedThread(setup.db, fixture, 6);
        const fencedThreadId = await seedThread(setup.db, fixture, 6);
        const reserved = await egress.sql.reserve();
        const egressPid = await backendPid(reserved);
        const writerPid = await backendPid(writer.sql);

        const withStoredContentEgress: WithThreadStoredContentEgress = async ({
          organizationId: fencedOrganizationId,
          threadId,
          userId: fencedUserId,
          work,
        }) =>
          await withChatStoredContentEgressSessionLock({
            connection: reserved,
            organizationId: fencedOrganizationId,
            threadId,
            userId: fencedUserId,
            work,
          });

        // Every compaction transaction holds the owner's membership and locks
        // the thread row, as the scheduler's owner-access wrapper does, on a
        // connection separate from the one holding the egress fence.
        const compactionSafeDb = (threadId: SafeId<"chatThread">) =>
          toSafeDbMock(
            asTestRaw<ScopedDb>(
              async <T>(callback: (tx: Transaction) => Promise<T>) =>
                await compactor.db.transaction(async (tx) => {
                  const held = await holdMemberAccessOnTx(tx, {
                    organizationId,
                    userId,
                    workspaceIds: [],
                  });
                  if (held.type !== "held") {
                    return panic("The compaction owner lost access");
                  }
                  const locked = await withAggregateLock({
                    aggregate: "chatThread",
                    id: { id: threadId, organizationId, userId },
                    mode: "update",
                    tx,
                  });
                  if (locked.status !== "locked") {
                    return panic("The compacted thread is missing");
                  }
                  return await callback(tx);
                }),
            ),
          );

        const runCompaction = async (
          threadId: SafeId<"chatThread">,
          beforeDispatchAuthorization: () => Promise<void>,
        ): Promise<ChatCompactionOutcome> => {
          const run = runChatThreadCompaction({
            abortSignal: new AbortController().signal,
            admission: testModelAdmission(organizationId),
            beforeDispatchAuthorization,
            extractionFeatureEnabled: false,
            managedAIResidency: "eu",
            orgAIConfig: null,
            organizationId,
            preserveTokens: 1,
            safeDb: compactionSafeDb(threadId),
            summarize: async () => SUMMARY_MARKDOWN,
            threadId,
            triggerTokens: 1,
            userId,
            withStoredContentEgress,
          });
          await settledWithin(run, {
            description: "the compaction run to finish",
          });
          const result = await run;
          if (Result.isError(result)) {
            return panic(`Compaction failed: ${result.error.message}`);
          }
          return result.value;
        };

        const threadCount = async (threadId: SafeId<"chatThread">) =>
          await observer.db.$count(chatThreads, eq(chatThreads.id, threadId));

        let fencedDeletion: Promise<unknown> | undefined;
        try {
          // A cascade deletes the thread and the membership without the
          // fence, after the run has read its delta and before it locks the
          // thread to authorize the dispatch.
          const cascadeOutcome = await runCompaction(
            cascadeThreadId,
            async () => {
              await expectEgressRefusal(
                writer.db
                  .delete(chatThreads)
                  .where(eq(chatThreads.id, cascadeThreadId)),
                "the unfenced thread deletion to be refused",
              );
              await expectEgressRefusal(
                writer.db.delete(member).where(eq(member.id, memberId)),
                "the unfenced membership deletion to be refused",
              );
            },
          );
          expect(cascadeOutcome.type).toBe("advanced");
          expect(await threadCount(cascadeThreadId)).toBe(1);
          await writer.db
            .delete(chatThreads)
            .where(eq(chatThreads.id, cascadeThreadId));
          expect(await threadCount(cascadeThreadId)).toBe(0);

          // The thread deletion handler's order: the fence first, holding no
          // row while it waits, so the run's row locks proceed.
          const fencedOutcome = await runCompaction(
            fencedThreadId,
            async () => {
              fencedDeletion = writer.db.transaction(async (tx) => {
                await lockThreadStoredContentTransitionOnTx(tx, fencedThreadId);
                await tx
                  .delete(chatThreads)
                  .where(eq(chatThreads.id, fencedThreadId));
              });
              await waitForBlockedPid(observer.sql, {
                holdingPid: egressPid,
                waitingPid: writerPid,
              });
            },
          );
          expect(fencedOutcome.type).toBe("advanced");
          await fencedDeletion;
          expect(await threadCount(fencedThreadId)).toBe(0);
        } finally {
          await Promise.allSettled(
            [fencedDeletion].filter(
              (pending): pending is Promise<unknown> => pending !== undefined,
            ),
          );
          await reserved.release();
          await removeEgressFixture(setup.db, fixture);
        }
      });
    });
  });
}
