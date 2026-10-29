import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract";
import { isGrantableChatTool } from "@stll/api-contract/chat-tool-grants";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings, sharepointConnections } from "@/api/db/schema";
import { encryptSharepointSecret } from "@/api/lib/auth/microsoft365/crypto";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createCalendarTools } from "./calendar-tools";
import { auditChatToolExecutions } from "./chat-tool-execution-audit";
import { applyChatToolGrants } from "./chat-tool-grants";
import { applyChatToolPolicies } from "./tool-policy";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
const noWorkspaces: SafeId<"workspace">[] = [];

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  scopedQuery = createScopedQuery(testDb);
});

afterAll(async () => {
  await testDb
    .delete(sharepointConnections)
    .where(
      and(
        eq(sharepointConnections.organizationId, ids.orgA),
        eq(sharepointConnections.userId, ids.userA1),
      ),
    );
  await releaseTestDb();
});

test("calendar executions use current stored grants, shared result provenance and execution audit", async () => {
  const organizationId = ids.orgA;
  const userId = ids.userA1;
  const threadId = createSafeId<"chatThread">();
  const grantId = createSafeId<"chatToolGrant">();
  const encrypted = await encryptSharepointSecret({
    organizationId,
    userId,
    purpose: "sharepoint_access_token",
    secret: "calendar-token",
  });
  await testDb
    .update(organizationSettings)
    .set({ microsoft365CalendarReadEnabled: true })
    .where(eq(organizationSettings.organizationId, organizationId));
  await testDb.insert(sharepointConnections).values({
    id: createSafeId<"sharepointConnection">(),
    organizationId,
    userId,
    status: "connected",
    scope: "Calendars.Read",
    expiresAt: new Date(Date.now() + 3_600_000),
    accessTokenEncrypted: encrypted.ciphertext,
    accessTokenIv: encrypted.iv,
    refreshTokenEncrypted: null,
    refreshTokenIv: null,
  });
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        organizationId,
        async (tx) => await run(asTestRaw(tx)),
        userId,
      ),
    );
  let reads = 0;
  const createdSignals: AbortSignal[] = [];
  const receivedSignals: (AbortSignal | undefined)[] = [];
  const original = applyChatToolPolicies({
    tools: createCalendarTools(
      {
        safeDb,
        organizationId,
        userId,
        recordAuditEvent: async () => {},
        createAbortSignal: () => {
          const signal = new AbortController().signal;
          createdSignals.push(signal);
          return signal;
        },
      },
      {
        deploymentEnabled: () => true,
        listCalendarEvents: async (_input, options) => {
          reads += 1;
          receivedSignals.push(options.signal);
          return Result.ok({ events: [], truncated: false });
        },
        calendarFreeBusy: async (_input, options) => {
          reads += 1;
          receivedSignals.push(options.signal);
          return Result.ok({
            type: "own_calendar" as const,
            events: [],
            truncated: false,
          });
        },
      },
    ),
    policyKinds: BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  });
  const rows: unknown[] = [];
  const audited = auditChatToolExecutions({
    audit: {
      safeDb,
      threadId,
      recordAuditEvent: (_tx, event) => {
        rows.push(event);
      },
    },
    tools: original,
  });
  const range = { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" };
  expect(createdSignals).toHaveLength(0);
  for (const name of ["calendar_list_events", "calendar_free_busy"] as const) {
    expect(isGrantableChatTool(name)).toBe(true);
    expect(audited[name]?.needsApproval).toBe(true);
    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants: [
        {
          id: grantId,
          scope: "conversation",
          chatThreadId: threadId,
          toolName: name,
          mcpConnectorId: null,
          mcpConnectorToolNamespace: null,
        },
      ],
      tools: audited,
    });
    expect(granted[name]?.needsApproval).toBeUndefined();
    const result = await granted[name]?.execute?.(range, { toolCallId: name });
    expect(result).toMatchObject({
      externalConnectorResult: { connector: "Outlook calendar", tool: name },
      structuredContent: { truncated: false },
    });
  }
  expect(reads).toBe(2);
  expect(createdSignals).toHaveLength(2);
  expect(receivedSignals).toEqual(createdSignals);
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row).toMatchObject({
      metadata: {
        approval: "grant",
        grantId,
        policyKind: "scope_expansion",
        capability: "calendar.read",
        rangeStart: range.start,
        rangeEnd: range.end,
      },
    });
    expect(JSON.stringify(row)).not.toContain("attendees");
    expect(row).not.toHaveProperty("metadata.subject");
    expect(row).not.toHaveProperty("metadata.body");
  }
  await testDb
    .update(organizationSettings)
    .set({ microsoft365CalendarReadEnabled: false })
    .where(eq(organizationSettings.organizationId, organizationId));
  expect(
    await rejectionOf(
      Promise.resolve(
        audited["calendar_list_events"]?.execute?.(range, {
          toolCallId: "revoked",
        }),
      ),
    ),
  ).toBeInstanceOf(ChatToolError);
  expect(reads).toBe(2);
  expect(rows.at(-1)).toMatchObject({
    metadata: { outcome: "error", approval: "grant" },
  });
});
