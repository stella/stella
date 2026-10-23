import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { Result, panic } from "better-result";
import { expect, test } from "bun:test";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract";
import { isGrantableChatTool } from "@stll/api-contract/chat-tool-grants";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import {
  MICROSOFT365_TOKEN_PURPOSE,
  encryptMicrosoft365Secret,
} from "@/api/lib/auth/microsoft365/crypto";
import { createSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createCalendarTools, loadCalendarTools } from "./calendar-tools";
import { auditChatToolExecutions } from "./chat-tool-execution-audit";
import { applyChatToolGrants } from "./chat-tool-grants";
import { applyChatToolPolicies, getChatToolPolicy } from "./tool-policy";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();

test("calendar tools require the deployment, organization ceiling, and actual user grant", async () => {
  const policy = {
    microsoft365ConnectionEnabled: true,
    microsoft365FilesReadEnabled: false,
    microsoft365CalendarReadEnabled: true,
  };
  const connection = {
    organizationId,
    userId,
    status: "connected",
    scope: "Calendars.Read",
  };
  const discover = async (
    settings: typeof policy | undefined,
    grant: typeof connection | undefined,
    enabled = true,
  ) => {
    const safeDb: SafeDb = async (run) =>
      Result.ok(
        await run(
          asTestRaw({
            query: {
              organizationSettings: { findFirst: async () => settings },
              microsoft365Connections: { findFirst: async () => grant },
            },
          }),
        ),
      );
    return await loadCalendarTools(
      { safeDb, organizationId, userId, recordAuditEvent: async () => {} },
      () => enabled,
    );
  };
  for (const result of [
    await discover(policy, connection, false),
    await discover(undefined, connection),
    await discover(
      { ...policy, microsoft365ConnectionEnabled: false },
      connection,
    ),
    await discover(
      { ...policy, microsoft365CalendarReadEnabled: false },
      connection,
    ),
    await discover(policy, undefined),
    await discover(policy, {
      ...connection,
      scope: "Files.Read.All Sites.Read.All",
    }),
    await discover(policy, { ...connection, status: "reconnect_required" }),
  ]) {
    expect(result.unwrap()).toBeUndefined();
  }
  const available = (await discover(policy, connection)).unwrap();
  if (available === undefined) {
    panic("Expected calendar tools for a granted capability");
  }
  expect(Object.keys(available)).toEqual([
    "calendar_list_events",
    "calendar_free_busy",
  ]);
  for (const tool of Object.values(available)) {
    const schema = convertSchemaToJsonSchema(tool.inputSchema);
    expect(schema?.type).toBe("object");
    expect(schema?.properties).toHaveProperty("start");
    expect(schema?.properties).toHaveProperty("end");
  }
  const tools = applyChatToolPolicies({
    tools: available,
    policyKinds: BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  });
  expect(getChatToolPolicy(tools.calendar_list_events).needsApproval).toBe(
    true,
  );
  expect(getChatToolPolicy(tools.calendar_free_busy).needsApproval).toBe(true);
});

test("calendar executions use stored grants, shared result provenance and execution audit", async () => {
  const threadId = createSafeId<"chatThread">();
  const grantId = createSafeId<"chatToolGrant">();
  const encrypted = await encryptMicrosoft365Secret({
    organizationId,
    userId,
    purpose: MICROSOFT365_TOKEN_PURPOSE.access,
    secret: "calendar-token",
  });
  let calendarEnabled = true;
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await run(
        asTestRaw({
          query: {
            organizationSettings: {
              findFirst: async () => ({
                microsoft365ConnectionEnabled: true,
                microsoft365FilesReadEnabled: false,
                microsoft365CalendarReadEnabled: calendarEnabled,
              }),
            },
            microsoft365Connections: {
              findFirst: async () => ({
                organizationId,
                userId,
                status: "connected",
                scope: "Calendars.Read",
                expiresAt: new Date(Date.now() + 3_600_000),
                accessTokenEncrypted: encrypted.ciphertext,
                accessTokenIv: encrypted.iv,
              }),
            },
          },
        }),
      ),
    );
  let reads = 0;
  const original = applyChatToolPolicies({
    tools: createCalendarTools(
      { safeDb, organizationId, userId, recordAuditEvent: async () => {} },
      {
        deploymentEnabled: () => true,
        listCalendarEvents: async () => {
          reads += 1;
          return Result.ok({ events: [], truncated: false });
        },
        calendarFreeBusy: async () => {
          reads += 1;
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
  for (const name of ["calendar_list_events", "calendar_free_busy"] as const) {
    expect(isGrantableChatTool(name)).toBe(true);
    expect(audited[name]?.needsApproval).toBe(true);
    const granted = applyChatToolGrants({
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
  }
  for (const row of rows) {
    expect(JSON.stringify(row)).not.toContain("attendees");
    expect(row).not.toHaveProperty("metadata.subject");
    expect(row).not.toHaveProperty("metadata.body");
  }
  calendarEnabled = false;
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
