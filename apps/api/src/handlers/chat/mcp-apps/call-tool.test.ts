import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { STELLA_MCP_APP_LIMITS } from "@stll/api-contract/stella-mcp-app";
import type { StellaMcpAppToolResult } from "@stll/api-contract/stella-mcp-app";
import { CASE_LAW_RESULTS_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";

import { chatMessages } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createCallChatMcpAppTool } from "./call-tool";

const ids = createTestIds();
let database: TestDatabase;

const OWN_CALL = "app-call-own";
const OTHER_MEMBER_CALL = "app-call-other-member";

const storedAppMessage = (toolCallId: string) => {
  const part = createVisualResourceOrigin().issueMcpApp({
    call: {
      input: { query: "unfair dismissal" },
      result: { structuredContent: { results: [], nextCursor: null } },
    },
    toolCallId,
    toolName: "search_case_law",
  });
  if (Result.isError(part)) {
    return panic(part.error);
  }
  return toPersistedChatMessageContentV3({ data: [part.value] });
};

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  database = await getTestDb();
  await setupRlsTestData(database, ids);
  await database.insert(chatMessages).values([
    {
      id: createSafeId<"chatMessage">(),
      threadId: ids.chatThreadGlobalA1,
      userId: ids.userA1,
      workspaceId: null,
      role: "assistant",
      content: storedAppMessage(OWN_CALL),
    },
    {
      id: createSafeId<"chatMessage">(),
      threadId: ids.chatThreadWorkspaceA1UserA2,
      userId: ids.userA2,
      workspaceId: ids.wsA1,
      role: "assistant",
      content: storedAppMessage(OTHER_MEMBER_CALL),
    },
  ]);
}, 30_000);
afterAll(releaseTestDb);

type ReadRequest = { name: string; args: Record<string, unknown> };

const answered: StellaMcpAppToolResult = {
  content: [{ type: "text", text: '{"courts":[]}' }],
  structuredContent: { courts: [] },
};

const callAs = async ({
  threadId,
  toolCallId,
  body,
  userId = ids.userA1,
}: {
  threadId: SafeId<"chatThread">;
  toolCallId: string;
  body: unknown;
  userId?: SafeId<"user">;
}) => {
  const reads: ReadRequest[] = [];
  const handler = createCallChatMcpAppTool({
    runRead: async ({ name, args }) => {
      reads.push({ name, args });
      return await Promise.resolve(answered);
    },
  });
  const response = await handler.handler(
    createTestHandlerContext<Parameters<typeof handler.handler>[0]>({
      audit: NO_AUDIT,
      scopedDb: NO_DB,
      params: { threadId, toolCallId },
      body,
      session: { activeOrganizationId: ids.orgA },
      user: { id: userId },
      safeDb: createSafeDb(database, [], ids.orgA, userId),
      request: new Request("https://example.test/app-call", {
        method: "POST",
      }),
    }),
  );
  return { response, reads };
};

describe("an app's tool call through chat", () => {
  test("runs a tool the app's manifest lists, with the app's arguments", async () => {
    const { response, reads } = await callAs({
      threadId: ids.chatThreadGlobalA1,
      toolCallId: OWN_CALL,
      body: { name: "list_case_law_courts", arguments: { country: "CZ" } },
    });
    expect(response).toEqual(answered);
    expect(reads).toEqual([
      { name: "list_case_law_courts", args: { country: "CZ" } },
    ]);
  });

  test("refuses a tool outside the app's manifest without running it", async () => {
    for (const name of ["read_document", "list_matters", "save_task"]) {
      const { response, reads } = await callAs({
        threadId: ids.chatThreadGlobalA1,
        toolCallId: OWN_CALL,
        body: { name, arguments: {} },
      });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain("permission_denied");
      expect(reads).toEqual([]);
    }
  });

  test("never mints a link handoff for an app in chat", async () => {
    const { response, reads } = await callAs({
      threadId: ids.chatThreadGlobalA1,
      toolCallId: OWN_CALL,
      body: {
        name: "mint_web_handoff",
        arguments: { url: "https://example.test" },
      },
    });
    expect(response).toMatchObject({ isError: true });
    expect(reads).toEqual([]);
  });

  test("finds no app in another member's thread", async () => {
    const { response, reads } = await callAs({
      threadId: ids.chatThreadWorkspaceA1UserA2,
      toolCallId: OTHER_MEMBER_CALL,
      body: { name: "list_case_law_courts", arguments: {} },
    });
    expect(response).toMatchObject({ code: 404 });
    expect(reads).toEqual([]);
  });

  test("finds no app for a call the thread never showed", async () => {
    for (const toolCallId of ["app-call-unknown", OTHER_MEMBER_CALL]) {
      const { response, reads } = await callAs({
        threadId: ids.chatThreadGlobalA1,
        toolCallId,
        body: { name: "list_case_law_courts", arguments: {} },
      });
      expect(response).toMatchObject({ code: 404 });
      expect(reads).toEqual([]);
    }
  });

  test("refuses a malformed or oversized call before reading anything", async () => {
    for (const body of [
      { name: "list_case_law_courts", arguments: [] },
      { arguments: {} },
      {
        name: "list_case_law_courts",
        arguments: {
          query: "x".repeat(STELLA_MCP_APP_LIMITS.callArgumentsBytes),
        },
      },
    ]) {
      const { response, reads } = await callAs({
        threadId: ids.chatThreadGlobalA1,
        toolCallId: OWN_CALL,
        body,
      });
      expect(JSON.stringify(response)).toContain("validation_error");
      expect(reads).toEqual([]);
    }
  });
});

test("the stored part names the app the tool links", () => {
  const part = createVisualResourceOrigin().issueMcpApp({
    call: { input: {}, result: { structuredContent: {} } },
    toolCallId: "app-call-uri",
    toolName: "search_case_law",
  });
  expect(Result.isOk(part) && part.value.resource.uri).toBe(
    CASE_LAW_RESULTS_RESOURCE_URI,
  );
});
