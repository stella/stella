import { describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  FEEDBACK_TOOL_DEFINITIONS,
  FEEDBACK_TOOL_HANDLERS,
} from "@/api/mcp/feedback-tools";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { handleMcpToolCall } from "@/api/mcp/tools";
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

const prepare = async (args: Record<string, unknown>) => {
  const result = await FEEDBACK_TOOL_HANDLERS.prepare_feedback({
    args,
    context,
  });
  if (isMcpEgressPlan(result)) {
    throw new TypeError("Expected a finished result");
  }
  if (result.status === "error") {
    return { payload: null, result };
  }
  const payload: unknown = result.data;
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Expected an object payload");
  }
  return { payload, result };
};

const MINIMAL_ARGS = {
  kind: "bug",
  area: "documents",
  title: "read_document answers with an empty body",
  what_happened: "The call returned an empty string for a long PDF.",
} as const;

describe("MCP prepare_feedback tool", () => {
  test("returns the sanitized report and names the fields it changed", async () => {
    const { payload, result } = await prepare({
      ...MINIMAL_ARGS,
      title: "Problem reported by person@example.com",
      evidence: "Fetched https://private.example/path",
      context: { client: "mcp", request_id: "req_01HZX8" },
    });

    expect(result.status).toBe("success");
    expect(payload).toMatchObject({
      redactions: 2,
      redacted_fields: ["title", "evidence"],
      report: {
        kind: "bug",
        area: "documents",
        title: "Problem reported by [redacted-email]",
        evidence: "Fetched [redacted-url]",
        // Not redacted: the request id is the maintainer's lookup key, so it
        // is validated rather than passed through the secret passes.
        context: { client: "mcp", request_id: "req_01HZX8" },
      },
    });
  });

  test("reports nothing redacted when the draft is already clean", async () => {
    const { payload } = await prepare(MINIMAL_ARGS);

    expect(payload).toMatchObject({ redactions: 0, redacted_fields: [] });
  });

  test("rejects an unknown area rather than guessing one", async () => {
    const { result } = await prepare({ ...MINIMAL_ARGS, area: "invoicing" });

    expect(result.status).toBe("error");
  });

  test("drops a request id that is not one", async () => {
    const { payload } = await prepare({
      ...MINIMAL_ARGS,
      context: { client: "mcp" },
    });

    expect(payload).toMatchObject({ report: { context: { client: "mcp" } } });
  });
});

describe("prepare_feedback and submit_feedback agree on one shape", () => {
  /**
   * The round trip is the contract: whatever `prepare_feedback` hands back is
   * what the human approves, so `submit_feedback` must accept it unchanged. A
   * field renamed on one side and not the other would make the approved bytes
   * and the submitted bytes different bytes.
   */
  test("the prepared report is accepted by submit_feedback byte for byte", async () => {
    const { payload } = await prepare({
      ...MINIMAL_ARGS,
      expected: "The first window of text.",
      steps: "1. call read_document\n2. read the response",
      evidence: "{}",
      context: {
        client: "cli",
        client_version: "0.9.0",
        request_id: "req_01HZX8",
        route: "read_document",
        error_reference: "internal_error",
      },
    });
    if (payload === null || !("report" in payload)) {
      throw new TypeError("Expected a prepared report");
    }
    const prepared = payload.report;
    if (typeof prepared !== "object" || prepared === null) {
      throw new TypeError("Expected a prepared report object");
    }
    const approvalToken =
      "approval_token" in payload ? payload.approval_token : undefined;

    // Parsed through the same schema object the handler parses with, not a
    // restatement of it: a schema-shaped copy would agree until one of them
    // changed.
    const submitTool = FEEDBACK_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "submit_feedback",
    );
    if (submitTool === undefined) {
      throw new TypeError("submit_feedback is missing from the registry");
    }
    const reparsed = v.safeParse(submitTool.inputSchemaSource, {
      ...prepared,
      approval_token: approvalToken,
      confirm: true,
    });

    expect(reparsed.issues).toBeUndefined();
    expect(reparsed.success).toBe(true);
  });

  test("a prepared report with no optional fields also round-trips", async () => {
    const { payload } = await prepare(MINIMAL_ARGS);
    if (payload === null || !("report" in payload)) {
      throw new TypeError("Expected a prepared report");
    }
    const submitTool = FEEDBACK_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "submit_feedback",
    );
    if (submitTool === undefined) {
      throw new TypeError("submit_feedback is missing from the registry");
    }

    const { report } = payload;
    if (typeof report !== "object" || report === null) {
      throw new TypeError("Expected the prepared report to be an object");
    }
    const approvalToken =
      "approval_token" in payload ? payload.approval_token : undefined;

    expect(
      v.safeParse(submitTool.inputSchemaSource, {
        ...report,
        approval_token: approvalToken,
        confirm: true,
      }).success,
    ).toBe(true);
  });
});

describe("submit_feedback approval binding", () => {
  const preparedSubmission = async () => {
    const { payload } = await prepare(MINIMAL_ARGS);
    if (
      payload === null ||
      !("report" in payload) ||
      !("approval_token" in payload) ||
      typeof payload.report !== "object" ||
      payload.report === null
    ) {
      throw new TypeError("Expected a prepared report and approval token");
    }
    return { report: payload.report, approvalToken: payload.approval_token };
  };

  const submitError = async (args: Record<string, unknown>) => {
    const result = await FEEDBACK_TOOL_HANDLERS.submit_feedback({
      args: { ...args, confirm: true },
      context,
    });
    if (isMcpEgressPlan(result)) {
      throw new TypeError("Expected a finished result");
    }
    return result.status === "error" ? result.error : null;
  };

  test("a report edited after preparation is refused", async () => {
    const { report, approvalToken } = await preparedSubmission();

    const error = await submitError({
      ...report,
      what_happened: "Different text the human never saw.",
      approval_token: approvalToken,
    });

    expect(error).toMatchObject({ code: "confirmation_required" });
  });

  test("a report prepared for another user is refused", async () => {
    const { report, approvalToken } = await preparedSubmission();

    const result = await FEEDBACK_TOOL_HANDLERS.submit_feedback({
      args: { ...report, approval_token: approvalToken, confirm: true },
      context: { ...context, userId: toSafeId<"user">("user_2") },
    });
    if (isMcpEgressPlan(result)) {
      throw new TypeError("Expected a finished result");
    }

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.error : null).toMatchObject({
      code: "confirmation_required",
    });
  });

  test("a report without an approval token is refused", async () => {
    const error = await submitError({ ...MINIMAL_ARGS });

    expect(error).toMatchObject({ code: "validation_error" });
    expect(error?.type === "structured" ? error.hint : "").toContain(
      "prepare_feedback",
    );
  });
});

describe("submit_feedback confirmation gate", () => {
  test("a call without confirm is refused before the handler runs", async () => {
    const result = await handleMcpToolCall({
      args: { ...MINIMAL_ARGS },
      context,
      toolName: "submit_feedback",
    });

    expect(result.isError).toBe(true);
    const [content] = result.content;
    const text = content?.type === "text" ? content.text : "";
    expect(text).toContain("confirmation_required");
    expect(text).toContain("confirm: true");
  });
});
