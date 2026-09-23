import { describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { confirmationUnavailableResult } from "@/api/mcp/tool-utils";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const createContext = (
  toolConfirmation?: McpRequestContext["toolConfirmation"],
) => {
  const scopedDb = asTestRaw<
    McpRequestContext["scopedDb"] & ReturnType<typeof mock>
  >(mock(async () => []));
  const context: McpRequestContext = {
    accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
    accessibleWorkspaceIdSet: new Set(["ws_1"]),
    accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: MCP_OAUTH_SCOPES,
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
      mock(async () => undefined),
    ),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    userId: toSafeId<"user">("user_1"),
    ...(toolConfirmation === undefined ? {} : { toolConfirmation }),
  };
  return { context, scopedDb };
};

const errorCode = (result: Awaited<ReturnType<typeof handleMcpToolCall>>) => {
  const [content] = result.content;
  const text = content?.type === "text" ? content.text : "";
  // Handlers may answer with a plain-text error; only envelopes carry a code.
  if (!text.startsWith("{")) {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "code" in parsed.error
    ? parsed.error.code
    : null;
};

const DELETE_ARGS = {
  entity_id: "018f2a3e-4b5c-7d6e-8f90-a1b2c3d4e5f6",
  confirm: true,
};

describe("tool confirmation by session", () => {
  test("a confirmation-gated tool is unavailable when no person can confirm", async () => {
    const { context, scopedDb } = createContext(TOOL_CONFIRMATION.unavailable);

    const result = await handleMcpToolCall({
      args: DELETE_ARGS,
      context,
      toolName: "delete_document",
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("permission_denied");
    // Refused at the transport, before the handler touches the database.
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("a caller that relays confirmation still reaches the handler", async () => {
    const { context } = createContext();

    const result = await handleMcpToolCall({
      args: DELETE_ARGS,
      context,
      toolName: "delete_document",
    });

    expect(errorCode(result)).not.toBe("permission_denied");
  });

  test("the rule covers every registry tool that asks for confirmation", () => {
    // The gate reads each tool's registry behaviour, so the tools it covers
    // are exactly the ones declaring an irreversible or outbound behaviour.
    const gated = listStaticMcpToolDefinitions()
      .filter(
        ({ destructiveBehavior }) =>
          destructiveBehavior?.type === "always" ||
          destructiveBehavior?.type === "outbound",
      )
      .map(({ name }) => name);

    expect(gated).toContain("delete_document");
    expect(gated).toContain("submit_feedback");
  });

  test("the refusal is reserved for sessions without a person to confirm", () => {
    expect(
      confirmationUnavailableResult({ subject: "delete_document" }),
    ).toBeNull();
    expect(
      confirmationUnavailableResult({
        subject: "delete_document",
        toolConfirmation: TOOL_CONFIRMATION.caller,
      }),
    ).toBeNull();
    expect(
      confirmationUnavailableResult({
        subject: "delete_document",
        toolConfirmation: TOOL_CONFIRMATION.unavailable,
      }),
    ).toMatchObject({
      status: "error",
      error: { code: "permission_denied" },
    });
  });
});
