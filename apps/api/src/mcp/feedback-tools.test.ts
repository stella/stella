import { describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  FEEDBACK_TOOL_HANDLERS,
  sliceWithoutDanglingHighSurrogate,
} from "@/api/mcp/feedback-tools";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const scopedDb = asTestRaw<
  McpRequestContext["scopedDb"] & ReturnType<typeof mock>
>(mock(async () => []));

const context: McpRequestContext = {
  accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
  accessibleWorkspaceIdSet: new Set(["ws_1"]),
  accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole: "owner",
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  ),
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
};

const parsePayload = async (args: Record<string, unknown>) => {
  const result = await FEEDBACK_TOOL_HANDLERS.send_feedback({ args, context });
  if (isMcpEgressPlan(result)) {
    throw new TypeError("Expected a finished result");
  }
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new TypeError("Expected a text result");
  }
  const payload: unknown = JSON.parse(item.text);
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Expected an object payload");
  }
  return { payload, result };
};

describe("MCP send_feedback tool", () => {
  test("returns sanitized content for manual submission", async () => {
    const { payload, result } = await parsePayload({
      kind: "bug",
      title: "Problem for person@example.com",
      body: "Details at https://private.example/path",
    });

    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      channel: "github",
      sanitized_title: "Problem for [redacted-email]",
      redactions: 2,
    });
    expect(payload).toHaveProperty("issue_url");
    expect(payload).toHaveProperty("gh_cli_command");
  });

  test("rejects unsupported delivery channels", async () => {
    const { result } = await parsePayload({
      kind: "docs",
      title: "Docs",
      body: "Clarify this section",
      channel: "email",
    });

    expect(result.isError).toBe(true);
  });

  test("URL truncation never leaves a dangling high surrogate", () => {
    expect(sliceWithoutDanglingHighSurrogate("abc😀", 4)).toBe("abc");
  });
});
