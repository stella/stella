import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { USE_CONNECTOR_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";

import { organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { createSecretTools } from "@/api/handlers/chat/tools/secret-tools";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const withFixture = async (
  db: GatedTestDb,
  run: (scope: {
    organizationId: ReturnType<typeof mintAuthProviderId<"organization">>;
    userId: ReturnType<typeof mintAuthProviderId<"user">>;
    connectorId: ReturnType<typeof createSafeId<"mcpConnector">>;
  }) => Promise<void>,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
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
    await db.insert(mcpConnectors).values({
      id: connectorId,
      organizationId,
      slug: connectorId,
      displayName: "Test connector",
      description: "",
      url: "https://example.test/mcp",
      authType: "bearer",
    });
    await db.insert(mcpUserConnections).values({
      id: createSafeId<"mcpUserConnection">(),
      organizationId,
      connectorId,
      userId,
      status: "connected",
      enabled: true,
    });
    await db.insert(mcpConnectorAuthorizationReviews).values({
      organizationId,
      connectorId,
      status: "needs_reapproval",
    });
    await run({ organizationId, userId, connectorId });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  }
};

if (!databaseUrl || !runPostgres) {
  describe.skip("private connector tool authorization review", () => {
    test("requires a configured Postgres test database", () => {});
  });
} else {
  describe("private connector tool authorization review", () => {
    test("does not resolve a connector with a pending authorization review", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(
          db,
          async ({ organizationId, userId, connectorId }) => {
            const safeDb = safeDbFromScoped(
              async (run) => await db.transaction(run),
            );
            const tools = createSecretTools({
              safeDb,
              organizationId,
              userId,
              threadId: createSafeId<"chatThread">(),
            });
            const tool = tools[USE_CONNECTOR_SECRET_TOOL_NAME];
            const execute = tool.execute;
            if (!execute) {
              throw new Error("Expected connector secret tool executor");
            }
            const result = await execute(
              {
                secretRef: "00000000-0000-4000-8000-000000000001",
                target: { type: "mcp-connector", connectorSlug: connectorId },
                toolName: "list_items",
                arguments: {},
              },
              asTestRaw<Parameters<NonNullable<typeof execute>>[1]>({}),
            );
            expect(result).toMatchObject({
              status: "unavailable",
              code: "connector-unavailable",
            });
          },
        );
      });
    });
  });
}
