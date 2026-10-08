import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { REQUEST_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";
import { rejectionOf } from "@stll/property-testing/rejection";
import { DAY_IN_MS } from "@stll/time";

import { organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  chatSecrets,
  chatThreads,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import type { ChatPart } from "@/api/handlers/chat/types";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

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
    });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  }
};

if (!databaseUrl || !runPostgres) {
  describe.skip("chat secret receipts", () => {
    test("requires a configured Postgres test database", () => {});
  });
} else {
  describe("chat secret receipts", () => {
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
          };
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
              responseTargetUrl: scope.targetUrl,
              instructions: null,
              serverVersion: null,
              cachedTools: null,
            },
          ]);
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
            return panic("Expected provided receipt");
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
  });
}
