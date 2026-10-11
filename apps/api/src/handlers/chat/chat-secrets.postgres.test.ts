import { panic, Result } from "better-result";
import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import {
  REQUEST_SECRET_TOOL_NAME,
  requestSecretOutputSchema,
} from "@stll/api-contract/chat-secret";
import type { RequestSecretInput } from "@stll/api-contract/chat-secret";
import { rejectionOf } from "@stll/property-testing/rejection";
import { DAY_IN_MS, Temporal } from "@stll/time";

import { organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  chatSecrets,
  chatMessages,
  chatTurns,
  chatThreads,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import savedSecret from "@/api/handlers/chat/saved-secret";
import submitSecret from "@/api/handlers/chat/submit-secret";
import type { ChatPart } from "@/api/handlers/chat/types";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { encryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import { validatePrivateReceipts } from "./chat-secret-validation";
import {
  consumeChatSecret,
  getChatSecretReceipt,
  storeChatSecret,
  saveChatSecretForFuture,
} from "./chat-secrets";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const withFixture = async <T>(
  db: GatedTestDb,
  run: (scope: {
    organizationId: ReturnType<typeof mintAuthProviderId<"organization">>;
    userId: ReturnType<typeof mintAuthProviderId<"user">>;
    threadId: ReturnType<typeof createSafeId<"chatThread">>;
    targetUrl: string;
    targetSlug: string;
    targetConnectionId: string;
    connectorId: ReturnType<typeof createSafeId<"mcpConnector">>;
  }) => Promise<T>,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const threadId = createSafeId<"chatThread">();
  const connectorId = createSafeId<"mcpConnector">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Test organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Test user",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await db.insert(chatThreads).values({
      id: threadId,
      organizationId,
      userId,
      title: "Test chat",
      workspaceId: null,
    });
    await db.insert(mcpConnectors).values({
      id: connectorId,
      organizationId,
      slug: connectorId,
      displayName: "Test connector",
      description: "",
      url: "https://example.test/mcp",
      authType: "bearer",
    });
    return await run({
      organizationId,
      userId,
      threadId,
      connectorId,
      targetUrl: "https://example.test/mcp",
      targetSlug: connectorId,
      targetConnectionId: Bun.randomUUIDv7(),
    });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  }
};

type Fixture = Parameters<Parameters<typeof withFixture>[1]>[0];

/** A request awaiting input, answered once with the saved credential. */
const answerPendingRequest = async (
  db: GatedTestDb,
  scope: Fixture,
  toolCallId: string,
) => {
  const credential = Bun.randomUUIDv7();
  const encrypted = await encryptMcpSecret({
    ...scope,
    purpose: "mcp_static_token",
    secret: credential,
  });
  await db.transaction(
    async (tx) => await saveChatSecretForFuture({ tx, ...scope, encrypted }),
  );
  const input = {
    purpose: "Test operation",
    kind: "token" as const,
    target: {
      type: "mcp-connector" as const,
      connectorSlug: scope.targetSlug,
    },
  };
  const userMessageId = createSafeId<"chatMessage">();
  const assistantMessageId = createSafeId<"chatMessage">();
  await db.insert(chatMessages).values([
    {
      id: userMessageId,
      threadId: scope.threadId,
      userId: scope.userId,
      role: "user",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "Test request" }],
      }),
    },
    {
      id: assistantMessageId,
      threadId: scope.threadId,
      userId: scope.userId,
      role: "assistant",
      content: toPersistedChatMessageContentV3({
        data: [
          {
            type: "tool-call",
            id: toolCallId,
            name: REQUEST_SECRET_TOOL_NAME,
            arguments: JSON.stringify(input),
            input,
            state: "input-complete",
          },
        ],
      }),
    },
  ]);
  const turnId = createSafeId<"chatTurn">();
  await db.insert(chatTurns).values({
    id: turnId,
    organizationId: scope.organizationId,
    userId: scope.userId,
    threadId: scope.threadId,
    userMessageId,
    assistantMessageId,
    status: "awaiting-user",
    interactionType: "client-tool",
    interactionToolCallId: toolCallId,
  });
  const safeDb = safeDbFromScoped(async (run) => await db.transaction(run));
  const submit = async (body: unknown) =>
    await submitSecret.handler(
      createTestHandlerContext<Parameters<typeof submitSecret.handler>[0]>({
        safeDb,
        scopedDb: NO_DB,
        session: { activeOrganizationId: scope.organizationId },
        user: { id: scope.userId },
        params: { threadId: scope.threadId, toolCallId },
        body,
        audit: auditRecorderDouble(),
      }),
    );
  const connection = (
    await db
      .select({ id: mcpUserConnections.id })
      .from(mcpUserConnections)
      .where(eq(mcpUserConnections.connectorId, scope.connectorId))
  ).at(0);
  if (!connection) {
    return panic("Expected saved connection");
  }
  const targetConnection = {
    connectionId: connection.id,
    host: new URL(scope.targetUrl).host,
  };
  const first = await submit({ decision: "use-saved", targetConnection });
  if (!v.safeParse(requestSecretOutputSchema, first).success) {
    return panic("Expected stored receipt");
  }
  const retryWithValue = async () =>
    await submit({
      decision: "provide",
      targetConnection,
      value: credential,
      saveForFuture: false,
      normalConnectionAction: "preserve",
    });
  return { first, retryWithValue, turnId };
};

if (!databaseUrl || !runPostgres) {
  describe.skip("chat secret receipts", () => {
    test("requires a configured Postgres test database", () => {});
  });
} else {
  describe("chat secret receipts", () => {
    test("recovers a stored submission after client continuation fails", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const toolCallId = "retry-request";
          const credential = Bun.randomUUIDv7();
          const encrypted = await encryptMcpSecret({
            ...scope,
            purpose: "mcp_static_token",
            secret: credential,
          });
          await db.transaction(
            async (tx) =>
              await saveChatSecretForFuture({ tx, ...scope, encrypted }),
          );
          const input = {
            purpose: "Test operation",
            kind: "token" as const,
            target: {
              type: "mcp-connector" as const,
              connectorSlug: scope.targetSlug,
            },
          };
          const part = {
            type: "tool-call",
            id: toolCallId,
            name: REQUEST_SECRET_TOOL_NAME,
            arguments: JSON.stringify(input),
            input,
            state: "input-complete",
          } as const satisfies ChatPart;
          const userMessageId = createSafeId<"chatMessage">();
          const assistantMessageId = createSafeId<"chatMessage">();
          await db.insert(chatMessages).values([
            {
              id: userMessageId,
              threadId: scope.threadId,
              userId: scope.userId,
              role: "user",
              content: toPersistedChatMessageContentV3({
                data: [{ type: "text", content: "Test request" }],
              }),
            },
            {
              id: assistantMessageId,
              threadId: scope.threadId,
              userId: scope.userId,
              role: "assistant",
              content: toPersistedChatMessageContentV3({ data: [part] }),
            },
          ]);
          await db.insert(chatTurns).values({
            id: createSafeId<"chatTurn">(),
            organizationId: scope.organizationId,
            userId: scope.userId,
            threadId: scope.threadId,
            userMessageId,
            assistantMessageId,
            status: "awaiting-user",
            interactionType: "client-tool",
            interactionToolCallId: toolCallId,
          });
          const safeDb = safeDbFromScoped(
            async (run) => await db.transaction(run),
          );
          const auditCalls = { count: 0 };
          const audit = auditRecorderDouble((events) => {
            auditCalls.count += 1;
            expect(events).toEqual([
              expect.objectContaining({
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
                resourceId: scope.threadId,
              }),
            ]);
          });
          const submit = async (body: unknown) =>
            await submitSecret.handler(
              createTestHandlerContext<
                Parameters<typeof submitSecret.handler>[0]
              >({
                safeDb,
                scopedDb: NO_DB,
                session: { activeOrganizationId: scope.organizationId },
                user: { id: scope.userId },
                params: { threadId: scope.threadId, toolCallId },
                body,
                audit,
              }),
            );
          const connection = (
            await db
              .select({ id: mcpUserConnections.id })
              .from(mcpUserConnections)
              .where(eq(mcpUserConnections.connectorId, scope.connectorId))
          ).at(0);
          if (!connection) {
            panic("Expected saved connection");
          }
          const targetConnection = {
            connectionId: connection.id,
            host: new URL(scope.targetUrl).host,
          };
          const first = await submit({
            decision: "use-saved",
            targetConnection,
          });
          expect(auditCalls.count).toBe(1);
          const parsed = v.safeParse(requestSecretOutputSchema, first);
          if (!parsed.success) {
            panic("Expected stored receipt");
          }
          // The client continuation can fail independently after the submission commits.
          const continuation = await Result.tryPromise(async () => {
            throw new HandlerError({
              status: 503,
              message: "Continuation unavailable",
            });
          });
          expect(continuation.isErr()).toBe(true);
          const recovered = await submit({
            decision: "provide",
            targetConnection,
            value: credential,
            saveForFuture: false,
            normalConnectionAction: "preserve",
          });
          expect(recovered).toEqual(first);
          expect(auditCalls.count).toBe(1);
          expect(
            await submit({ decision: "use-saved", targetConnection }),
          ).toEqual(first);
          const resumed = await validatePrivateReceipts({
            parts: [{ ...part, state: "complete", output: parsed.output }],
            safeDb,
            threadId: scope.threadId,
            userId: scope.userId,
          });
          expect(resumed.isOk()).toBe(true);
          expect(
            await submit({
              decision: "provide",
              targetConnection,
              value: Bun.randomUUIDv7(),
              saveForFuture: false,
              normalConnectionAction: "preserve",
            }),
          ).toMatchObject({ code: 409 });
          const rows = await db
            .select({ id: chatSecrets.id })
            .from(chatSecrets)
            .where(eq(chatSecrets.threadId, scope.threadId));
          expect(rows).toHaveLength(1);
        });
      });
    });

    test("refuses a same-value retry once the request stopped waiting", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const { first, retryWithValue, turnId } = await answerPendingRequest(
            db,
            scope,
            "moved-on-request",
          );
          expect(await retryWithValue()).toEqual(first);
          await db
            .update(chatTurns)
            .set({
              status: "completed",
              interactionType: null,
              interactionToolCallId: null,
              settledAt: new Date(),
            })
            .where(eq(chatTurns.id, turnId));
          expect(await retryWithValue()).toMatchObject({ code: 409 });
        });
      });
    });

    test("caps same-value retries per request", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const { first, retryWithValue } = await answerPendingRequest(
            db,
            scope,
            "capped-request",
          );
          for (let attempt = 0; attempt < 5; attempt += 1) {
            expect(await retryWithValue()).toEqual(first);
          }
          expect(await retryWithValue()).toMatchObject({ code: 409 });
        });
      });
    });

    test("replays provided and declined receipts", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          for (const status of ["provided", "declined"] as const) {
            const toolCallId = `request-${status}`;
            const receipt = await db.transaction(
              async (tx) =>
                await storeChatSecret({
                  tx,
                  ...scope,
                  toolCallId,
                  decision:
                    status === "provided"
                      ? {
                          status,
                          ciphertext: Buffer.from([1, 2, 3]),
                          iv: Buffer.alloc(12, 1),
                        }
                      : { status },
                }),
            );
            expect(receipt.status).toBe(status);
            const replay = await db.transaction(
              async (tx) =>
                await storeChatSecret({
                  tx,
                  ...scope,
                  toolCallId,
                  decision: { status: "declined" },
                }),
            );
            expect(replay).toEqual(receipt);
            const loaded = await db.transaction(
              async (tx) =>
                await getChatSecretReceipt({ tx, ...scope, toolCallId }),
            );
            expect(loaded).toEqual(receipt);
          }
        });
      });
    });

    test("keeps receipts after connector rename and deletion", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const receipt = await db.transaction(
            async (tx) =>
              await storeChatSecret({
                tx,
                ...scope,
                toolCallId: "historical-request",
                decision: { status: "declined" },
              }),
          );
          const input = {
            purpose: "Connect a test source",
            kind: "token",
            target: { type: "mcp-connector", connectorSlug: scope.targetSlug },
          } as const satisfies RequestSecretInput;
          const parts = [
            {
              type: "tool-call",
              id: "historical-request",
              name: REQUEST_SECRET_TOOL_NAME,
              arguments: JSON.stringify(input),
              input,
              state: "complete",
              output: { ...receipt, target: input.target },
            },
          ] satisfies ChatPart[];
          const safeDb = safeDbFromScoped(
            async (run) => await db.transaction(run),
          );
          await db
            .update(mcpConnectors)
            .set({ slug: `${scope.connectorId}-renamed` })
            .where(eq(mcpConnectors.id, scope.connectorId));
          const renamed = await db.transaction(
            async (tx) =>
              await getChatSecretReceipt({
                tx,
                ...scope,
                toolCallId: "historical-request",
              }),
          );
          expect(renamed).toEqual(receipt);
          const afterRename = await validatePrivateReceipts({
            parts,
            safeDb,
            threadId: scope.threadId,
            userId: scope.userId,
          });
          expect(afterRename.isOk()).toBe(true);
          await db
            .delete(mcpConnectors)
            .where(eq(mcpConnectors.id, scope.connectorId));
          const deleted = await db.transaction(
            async (tx) =>
              await getChatSecretReceipt({
                tx,
                ...scope,
                toolCallId: "historical-request",
              }),
          );
          expect(deleted).toEqual(receipt);
          const afterDelete = await validatePrivateReceipts({
            parts,
            safeDb,
            threadId: scope.threadId,
            userId: scope.userId,
          });
          expect(afterDelete.isOk()).toBe(true);
          const stored = await db
            .select({
              targetSlug: chatSecrets.targetSlug,
              connectorId: chatSecrets.connectorId,
            })
            .from(chatSecrets)
            .where(eq(chatSecrets.threadId, scope.threadId));
          expect(stored).toEqual([
            { targetSlug: scope.targetSlug, connectorId: null },
          ]);
        });
      });
    });

    test("preserves an existing connector connection when saving a chat value", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          await db.insert(mcpUserConnections).values({
            organizationId: scope.organizationId,
            userId: scope.userId,
            connectorId: scope.connectorId,
            status: "connected",
          });
          const refusal = await rejectionOf(
            db.transaction(
              async (tx) =>
                await saveChatSecretForFuture({
                  tx,
                  ...scope,
                  encrypted: {
                    ciphertext: Buffer.from([1, 2, 3]),
                    iv: Buffer.alloc(12, 1),
                  },
                }),
            ),
          );
          expect(refusal).toMatchObject({
            status: 409,
            code: "CHAT_SAVED_CONNECTION_EXISTS",
          });
          const existing = await db
            .select({
              responseDisposition: mcpUserConnections.responseDisposition,
            })
            .from(mcpUserConnections)
            .where(eq(mcpUserConnections.connectorId, scope.connectorId));
          expect(existing).toEqual([{ responseDisposition: "normal" }]);
        });
      });
    });

    test("replaces an existing connection after explicit confirmation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          await db.insert(mcpUserConnections).values({
            organizationId: scope.organizationId,
            userId: scope.userId,
            connectorId: scope.connectorId,
            status: "connected",
            instructions: "Test connector instructions",
            serverVersion: "Test version",
            cachedTools: [],
          });
          await db.transaction(
            async (tx) =>
              await saveChatSecretForFuture({
                tx,
                ...scope,
                normalConnectionAction: "replace-with-receipt-only",
                encrypted: {
                  ciphertext: Buffer.from([1, 2, 3]),
                  iv: Buffer.alloc(12, 1),
                },
              }),
          );
          const saved = await db
            .select({
              responseDisposition: mcpUserConnections.responseDisposition,
              responseTargetUrl: mcpUserConnections.responseTargetUrl,
              instructions: mcpUserConnections.instructions,
              serverVersion: mcpUserConnections.serverVersion,
              cachedTools: mcpUserConnections.cachedTools,
            })
            .from(mcpUserConnections)
            .where(eq(mcpUserConnections.connectorId, scope.connectorId));
          expect(saved).toEqual([
            {
              responseDisposition: "receipt-only",
              responseTargetUrl: new URL(scope.targetUrl).origin,
              instructions: null,
              serverVersion: null,
              cachedTools: null,
            },
          ]);
        });
      });
    });

    test("uses one timestamp when setting the receipt lifetime", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const createdAt = new Date("2026-10-01T12:00:00Z");
          setSystemTime(createdAt);
          const secondClock = spyOn(Temporal.Now, "instant").mockImplementation(
            () =>
              Temporal.Instant.fromEpochMilliseconds(createdAt.getTime() + 1),
          );
          try {
            const receipt = await db.transaction(
              async (tx) =>
                await storeChatSecret({
                  tx,
                  ...scope,
                  toolCallId: "lifetime-request",
                  decision: { status: "declined" },
                }),
            );
            expect(receipt.status).toBe("declined");
            const stored = await db
              .select({
                createdAt: chatSecrets.createdAt,
                expiresAt: chatSecrets.expiresAt,
              })
              .from(chatSecrets)
              .where(eq(chatSecrets.threadId, scope.threadId));
            expect(stored).toEqual([
              {
                createdAt,
                expiresAt: new Date(createdAt.getTime() + DAY_IN_MS),
              },
            ]);
          } finally {
            secondClock.mockRestore();
            setSystemTime();
          }
        });
      });
    });

    test("provides the configured number of uses", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const receipt = await db.transaction(
            async (tx) =>
              await storeChatSecret({
                tx,
                ...scope,
                toolCallId: "request",
                decision: {
                  status: "provided",
                  ciphertext: Buffer.from([1, 2, 3]),
                  iv: Buffer.alloc(12, 1),
                },
              }),
          );
          if (receipt.status !== "provided") {
            panic("Expected provided receipt");
          }
          const initial =
            (
              await db
                .select({
                  createdAt: chatSecrets.createdAt,
                  expiresAt: chatSecrets.expiresAt,
                })
                .from(chatSecrets)
                .where(eq(chatSecrets.id, receipt.secretRef))
            ).at(0) ?? panic("Expected receipt timestamps");
          expect(
            initial.expiresAt.getTime() - initial.createdAt.getTime(),
          ).toBe(DAY_IN_MS);
          const safeDb = safeDbFromScoped(
            async (run) => await db.transaction(run),
          );
          for (let count = 0; count < 8; count += 1) {
            const result = await consumeChatSecret({
              safeDb,
              ...scope,
              secretRef: receipt.secretRef,
            });
            expect(result.isOk()).toBe(true);
          }
          const stored = await db
            .select({
              remainingUses: chatSecrets.remainingUses,
              ciphertext: chatSecrets.ciphertext,
              iv: chatSecrets.iv,
            })
            .from(chatSecrets)
            .where(eq(chatSecrets.id, receipt.secretRef));
          expect(stored).toEqual([
            { remainingUses: 0, ciphertext: null, iv: null },
          ]);
          const timestamps = await db
            .select({
              createdAt: chatSecrets.createdAt,
              expiresAt: chatSecrets.expiresAt,
            })
            .from(chatSecrets)
            .where(eq(chatSecrets.id, receipt.secretRef));
          expect(timestamps).toEqual([initial]);
          const final = await consumeChatSecret({
            safeDb,
            ...scope,
            secretRef: receipt.secretRef,
          });
          expect(final.isErr()).toBe(true);
          if (final.isErr()) {
            expect(final.error).toMatchObject({
              status: 409,
              code: "CHAT_SECRET_UNAVAILABLE",
            });
          }
        });
      });
    });

    test("answers the owner's own thread and refuses a thread that does not exist", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(db, async (scope) => {
          const safeDb = safeDbFromScoped(
            async (run) => await db.transaction(run),
          );
          const readSaved = async (threadId: Fixture["threadId"]) =>
            await savedSecret.handler(
              createTestHandlerContext<
                Parameters<typeof savedSecret.handler>[0]
              >({
                safeDb,
                scopedDb: NO_DB,
                session: { activeOrganizationId: scope.organizationId },
                user: { id: scope.userId },
                params: { threadId },
                query: { connectorSlug: "missing-connector" },
                audit: NO_AUDIT,
              }),
            );
          const submitDecline = async (threadId: Fixture["threadId"]) =>
            await submitSecret.handler(
              createTestHandlerContext<
                Parameters<typeof submitSecret.handler>[0]
              >({
                safeDb,
                scopedDb: NO_DB,
                session: { activeOrganizationId: scope.organizationId },
                user: { id: scope.userId },
                params: { threadId, toolCallId: "missing-request" },
                body: { decision: "decline" },
                audit: auditRecorderDouble(),
              }),
            );

          // The owner's thread reaches the connector lookup, which has no
          // enabled connector for this slug.
          expect(await readSaved(scope.threadId)).toMatchObject({
            code: 404,
            response: {
              message:
                "Enable this connector in settings before providing a credential",
            },
          });
          // The owner's thread reaches the pending-request check, which finds
          // no request awaiting input.
          expect(await submitDecline(scope.threadId)).toMatchObject({
            code: 409,
          });

          const unknownThread = createSafeId<"chatThread">();
          const threadNotFound = {
            code: 404,
            response: { message: "Chat thread not found" },
          };
          expect(await readSaved(unknownThread)).toMatchObject(threadNotFound);
          expect(await submitDecline(unknownThread)).toMatchObject(
            threadNotFound,
          );
        });
      });
    });
  });
}
