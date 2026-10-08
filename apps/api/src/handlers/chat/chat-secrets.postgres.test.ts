import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { chatSecrets, chatThreads, mcpConnectors } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  consumeChatSecret,
  getChatSecretReceipt,
  storeChatSecret,
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
