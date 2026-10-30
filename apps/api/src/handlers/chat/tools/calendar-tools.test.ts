import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { loadCalendarTools } from "./calendar-tools";
import { applyChatToolPolicies, getChatToolPolicy } from "./tool-policy";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();

test("calendar tools require the deployment, organization ceiling, and actual user grant", async () => {
  const policy = {
    sharepointConnectionEnabled: false,
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
              sharepointConnections: { findFirst: async () => grant },
            },
          }),
        ),
      );
    return await loadCalendarTools(
      {
        safeDb,
        organizationId,
        userId,
        recordAuditEvent: async () => {},
        createAbortSignal: () => new AbortController().signal,
      },
      () => enabled,
    );
  };
  for (const result of [
    await discover(policy, connection, false),
    await discover(undefined, connection),
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
