import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { deferred, settledWithin } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  chatThreads,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { withChatStoredContentEgressSessionLock } from "@/api/lib/db/aggregate-lock";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const EGRESS_LOCK_NAMESPACE = 252_759_214;
const OWNER_EGRESS_LOCK_NAMESPACE = 252_759_215;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat stored-content egress (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("chat stored-content egress (postgres)", () => {
    test("authority loss and raw provider egress commit in one order", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient();
        const observer = openClient();
        const egress = openClient();
        const userId = mintAuthProviderId<"user">();
        const ownerId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const threadId = createSafeId<"chatThread">();
        const deletedThreadId = createSafeId<"chatThread">();
        const workspaceId = createSafeId<"workspace">();
        const workspaceMemberId = createSafeId<"workspaceMember">();
        const memberId = mintAuthProviderIdValue();

        await setup.db.insert(user).values({
          email: `${userId}@example.test`,
          id: userId,
          name: "Egress lane test",
        });
        await setup.db.insert(user).values({
          email: `${ownerId}@example.test`,
          id: ownerId,
          name: "Egress lane owner",
        });
        await setup.db.insert(organization).values({
          createdAt: new Date(),
          id: organizationId,
          name: "Egress lane test",
          slug: organizationId,
        });
        await setup.db.insert(organizationAccessStates).values({
          organizationId,
          state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        });
        await setup.db.insert(member).values({
          createdAt: new Date(),
          id: memberId,
          organizationId,
          role: "member",
          userId,
        });
        await setup.db.insert(member).values({
          createdAt: new Date(),
          id: mintAuthProviderIdValue(),
          organizationId,
          role: "owner",
          userId: ownerId,
        });
        await setup.db.insert(chatThreads).values({
          id: threadId,
          organizationId,
          title: "Egress lane test",
          userId,
        });
        await setup.db.insert(chatThreads).values({
          id: deletedThreadId,
          organizationId,
          title: "Deleted egress lane test",
          userId,
        });
        await setup.db.insert(workspaces).values({
          id: workspaceId,
          name: "Egress lane test",
          organizationId,
          reference: `egress-${workspaceId}`,
        });
        await setup.db.insert(workspaceMembers).values({
          id: workspaceMemberId,
          userId,
          workspaceId,
        });

        const waitForWaiter = async (namespace: number): Promise<void> => {
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const rows = await observer.sql<
              { waiting: boolean }[]
            >`SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_locks
                WHERE locktype = 'advisory'
                  AND classid = ${namespace}
                  AND NOT granted
              ) AS waiting`;
            if (rows.at(0)?.waiting === true) {
              return;
            }
            await Bun.sleep(5);
          }
          throw new TypeError("an egress advisory lock waiter never appeared");
        };

        const reserved = await egress.sql.reserve();
        type FencedTransitionOptions = {
          assertBlocked: () => Promise<void>;
          namespace: number;
          threadId: SafeId<"chatThread">;
          transition: () => Promise<unknown>;
        };
        const runFencedTransition = async ({
          assertBlocked,
          namespace,
          threadId: transitionedThreadId,
          transition,
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
            mutation = transition();
            await waitForWaiter(namespace);
            await assertBlocked();
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

        try {
          await runFencedTransition({
            assertBlocked: async () => {
              expect(
                (
                  await observer.db.query.chatThreads.findFirst({
                    columns: { usedAnonymization: true },
                    where: { id: { eq: threadId } },
                  })
                )?.usedAnonymization,
              ).toBe(false);
            },
            namespace: EGRESS_LOCK_NAMESPACE,
            threadId,
            transition: async () =>
              await writer.db
                .update(chatThreads)
                .set({ usedAnonymization: true })
                .where(eq(chatThreads.id, threadId)),
          });
          expect(
            (
              await observer.db.query.chatThreads.findFirst({
                columns: { usedAnonymization: true },
                where: { id: { eq: threadId } },
              })
            )?.usedAnonymization,
          ).toBe(true);

          await runFencedTransition({
            assertBlocked: async () => {
              expect(
                await observer.db.$count(
                  chatThreads,
                  eq(chatThreads.id, deletedThreadId),
                ),
              ).toBe(1);
            },
            namespace: EGRESS_LOCK_NAMESPACE,
            threadId: deletedThreadId,
            transition: async () =>
              await writer.db
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
            assertBlocked: async () => {
              expect(
                await observer.db.$count(
                  workspaceMembers,
                  eq(workspaceMembers.id, workspaceMemberId),
                ),
              ).toBe(1);
            },
            namespace: OWNER_EGRESS_LOCK_NAMESPACE,
            threadId,
            transition: async () =>
              await writer.db
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
            assertBlocked: async () => {
              expect(
                await observer.db.$count(member, eq(member.id, memberId)),
              ).toBe(1);
            },
            namespace: OWNER_EGRESS_LOCK_NAMESPACE,
            threadId,
            transition: async () =>
              await writer.db.delete(member).where(eq(member.id, memberId)),
          });
          expect(
            await observer.db.$count(member, eq(member.id, memberId)),
          ).toBe(0);
        } finally {
          await reserved.release();
          await setup.db
            .delete(chatThreads)
            .where(eq(chatThreads.id, threadId));
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setup.db.delete(user).where(eq(user.id, userId));
          await setup.db.delete(user).where(eq(user.id, ownerId));
        }
      });
    });
  });
}
