import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { USE_CONNECTOR_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";

import { organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  chatSecrets,
  chatThreads,
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { storeChatSecret } from "@/api/handlers/chat/chat-secrets";
import { createSecretTools } from "@/api/handlers/chat/tools/secret-tools";
import { createSafeId } from "@/api/lib/branded-types";
import type { ChatSecretOutboundFetch } from "@/api/lib/mcp-upstream/chat-secret";
import { encryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
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
    connectionId: ReturnType<typeof createSafeId<"mcpUserConnection">>;
  }) => Promise<void>,
  { pendingReview = true }: { pendingReview?: boolean } = {},
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
    const connectionId = createSafeId<"mcpUserConnection">();
    await db.insert(mcpUserConnections).values({
      id: connectionId,
      organizationId,
      connectorId,
      userId,
      status: "connected",
      enabled: true,
    });
    if (pendingReview) {
      await db.insert(mcpConnectorAuthorizationReviews).values({
        organizationId,
        connectorId,
        status: "needs_reapproval",
      });
    }
    await run({ organizationId, userId, connectorId, connectionId });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  }
};

type UpstreamRequest = {
  authorization: string | null;
  message: { id?: number; method: string; params?: unknown };
};

const upstreamBody = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== "") {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });

const upstreamReply = (
  status: number,
  text = "",
  headers: Record<string, string> = {},
) =>
  Result.ok({
    body: upstreamBody(text),
    headers: new Headers(headers),
    ok: status < 300,
    status,
  });

const bodyText = (body: unknown): string => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  return "";
};

/** An in-process MCP server over streamable HTTP; nothing leaves the test. */
const fakeUpstream = (sentinel: string) => {
  const requests: UpstreamRequest[] = [];
  const outboundFetch = asTestRaw<ChatSecretOutboundFetch>({
    validateOutboundFetchTarget: async (url: string) =>
      await Promise.resolve(Result.ok({ url: new URL(url) })),
    safeOutboundFetchStream: async ({
      body,
      headers,
      method,
    }: Parameters<ChatSecretOutboundFetch["safeOutboundFetchStream"]>[0]) => {
      if (method !== "POST") {
        return await Promise.resolve(upstreamReply(405));
      }
      const message: UpstreamRequest["message"] = JSON.parse(bodyText(body));
      requests.push({
        authorization: new Headers(headers).get("authorization"),
        message,
      });
      if (message.id === undefined) {
        return upstreamReply(202);
      }
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion:
            typeof message.params === "object" && message.params !== null
              ? Reflect.get(message.params, "protocolVersion")
              : undefined,
          capabilities: { tools: {} },
          serverInfo: { name: "test-upstream", version: "1.0.0" },
        },
        "tools/list": {
          tools: [
            {
              name: "list_items",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ],
        },
        // The upstream answers with private content the chat must never see.
        "tools/call": { content: [{ type: "text", text: sentinel }] },
      };
      return upstreamReply(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: results[message.method] ?? {},
        }),
        { "content-type": "application/json" },
      );
    },
  });
  return { outboundFetch, requests };
};

if (!databaseUrl || !runPostgres) {
  describe.skip("private connector tool authorization review", () => {
    test("requires a configured Postgres test database", () => {});
  });
} else {
  describe("private connector tool authorization review", () => {
    test("calls an allowed tool with the private credential and returns a fixed receipt", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withFixture(
          db,
          async ({ organizationId, userId, connectorId, connectionId }) => {
            const threadId = createSafeId<"chatThread">();
            await db.insert(chatThreads).values({
              id: threadId,
              organizationId,
              userId,
              title: "Test chat",
              workspaceId: null,
            });
            const credential = Bun.randomUUIDv7();
            const encrypted = await encryptMcpSecret({
              organizationId,
              userId,
              connectorId,
              purpose: "mcp_static_token",
              secret: credential,
            });
            const receipt = await db.transaction(
              async (tx) =>
                await storeChatSecret({
                  tx,
                  organizationId,
                  userId,
                  threadId,
                  toolCallId: "request-call",
                  connectorId,
                  targetUrl: "https://example.test/mcp",
                  targetSlug: connectorId,
                  targetConnectionId: connectionId,
                  decision: { status: "provided", ...encrypted },
                }),
            );
            if (receipt.status !== "provided") {
              throw new Error("Expected a provided receipt");
            }
            const sentinel = `upstream-private-${Bun.randomUUIDv7()}`;
            const upstream = fakeUpstream(sentinel);
            const tools = createSecretTools({
              safeDb: safeDbFromScoped(
                async (run) => await db.transaction(run),
              ),
              organizationId,
              userId,
              threadId,
              outboundFetch: upstream.outboundFetch,
            });
            const execute = tools[USE_CONNECTOR_SECRET_TOOL_NAME].execute;
            if (!execute) {
              throw new Error("Expected connector secret tool executor");
            }

            const result = await execute(
              {
                secretRef: receipt.secretRef,
                target: { type: "mcp-connector", connectorSlug: connectorId },
                toolName: "list_items",
                arguments: { query: "open matters" },
              },
              asTestRaw<Parameters<NonNullable<typeof execute>>[1]>({}),
            );

            expect(result).toEqual({ status: "completed" });
            expect(JSON.stringify(result)).not.toContain(sentinel);
            expect(upstream.requests.length).toBeGreaterThan(0);
            expect(
              upstream.requests.map(({ authorization }) => authorization),
            ).toEqual(upstream.requests.map(() => `Bearer ${credential}`));
            const calls = upstream.requests.filter(
              ({ message }) => message.method === "tools/call",
            );
            expect(calls).toHaveLength(1);
            expect(calls.at(0)?.message.params).toMatchObject({
              name: "list_items",
              arguments: { query: "open matters" },
            });
            const stored = await db
              .select({ remainingUses: chatSecrets.remainingUses })
              .from(chatSecrets)
              .where(eq(chatSecrets.id, receipt.secretRef));
            expect(stored).toEqual([{ remainingUses: 7 }]);
          },
          { pendingReview: false },
        );
      });
    });

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
