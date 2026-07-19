import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import type { ResolvedSkillTool } from "@/api/mcp/gateway/skills";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Mock the two dispatch collaborators so this file exercises only
// `dispatchGatewayToolCall`'s own branch selection, audit call, and error
// envelope. The name-classification (`isSkillToolName` / `isExternalMcpToolName`)
// and result builders (`structuredErrorResult` / `textResult`) stay real, so the
// asserted envelopes are the exact shapes callers receive.
const callGatewayExternalMcpToolMock = mock();
const gatewayLoadErrorResultMock = mock();
const recordSkillGatewayToolAuditMock = mock(async () => undefined);
const resolveSkillToolMock = mock();

void mock.module("@/api/mcp/gateway/external-tools", () => ({
  callGatewayExternalMcpTool: callGatewayExternalMcpToolMock,
  gatewayLoadErrorResult: gatewayLoadErrorResultMock,
  recordSkillGatewayToolAudit: recordSkillGatewayToolAuditMock,
}));
void mock.module("@/api/mcp/gateway/skills", () => ({
  resolveSkillTool: resolveSkillToolMock,
}));

const { dispatchGatewayToolCall } =
  await import("@/api/mcp/gateway/dispatch-call");

const context = asTestRaw<McpRequestContext>({
  organizationId: toSafeId<"organization">("org_1"),
  userId: toSafeId<"user">("user_1"),
});

const resolvedSkill = asTestRaw<ResolvedSkillTool>({
  id: toSafeId<"agentSkill">("skill_alpha"),
  slug: "alpha",
  body: "# Alpha skill body",
  metadata: { key: "value" },
  origin: "authored",
  version: "1.2.3",
  license: "MIT",
  compatibility: "stella>=1",
  exposedName: "skill__alpha",
});

const parseResult = (result: CallToolResult | null): unknown => {
  const text = result?.content.at(0);
  if (text?.type !== "text") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(text.text);
};

describe("dispatchGatewayToolCall", () => {
  beforeEach(() => {
    callGatewayExternalMcpToolMock.mockReset();
    gatewayLoadErrorResultMock.mockReset();
    gatewayLoadErrorResultMock.mockReturnValue(null);
    recordSkillGatewayToolAuditMock.mockReset();
    recordSkillGatewayToolAuditMock.mockResolvedValue(undefined);
    resolveSkillToolMock.mockReset();
  });

  test("never dispatches in anonymized mode", async () => {
    const result = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "anonymized",
      toolName: "skill__alpha",
    });

    expect(result).toBeNull();
    expect(resolveSkillToolMock).not.toHaveBeenCalled();
    expect(callGatewayExternalMcpToolMock).not.toHaveBeenCalled();
  });

  test("routes an external connector tool to the external dispatcher", async () => {
    const sentinel: CallToolResult = {
      content: [{ type: "text", text: "external-ok" }],
    };
    callGatewayExternalMcpToolMock.mockResolvedValue(sentinel);
    const args = { query: "hi" };

    const result = await dispatchGatewayToolCall({
      args,
      context,
      mode: "default",
      toolName: "mcp__registry__lookup",
    });

    expect(result).toBe(sentinel);
    expect(callGatewayExternalMcpToolMock).toHaveBeenCalledWith({
      args,
      context,
      toolName: "mcp__registry__lookup",
    });
    expect(resolveSkillToolMock).not.toHaveBeenCalled();
  });

  test("returns null for a name that is neither a skill nor an external tool", async () => {
    const result = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "default",
      toolName: "list_matters",
    });

    expect(result).toBeNull();
    expect(resolveSkillToolMock).not.toHaveBeenCalled();
    expect(callGatewayExternalMcpToolMock).not.toHaveBeenCalled();
  });

  test("returns the structured unknown_tool envelope for an unresolved skill", async () => {
    resolveSkillToolMock.mockResolvedValue(null);

    const result = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "default",
      toolName: "skill__missing",
    });

    expect(result?.isError).toBe(true);
    expect(parseResult(result)).toEqual({
      error: {
        code: "unknown_tool",
        message: "Unknown tool: skill__missing",
        hint: "Call tools/list for the tools available to this session.",
      },
    });
    expect(recordSkillGatewayToolAuditMock).not.toHaveBeenCalled();
  });

  test("dispatches a resolved skill body and records a success audit event", async () => {
    resolveSkillToolMock.mockResolvedValue(resolvedSkill);

    const result = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "default",
      toolName: "skill__alpha",
    });

    expect(result?.isError).toBeUndefined();
    expect(parseResult(result)).toEqual({
      body: "# Alpha skill body",
      compatibility: "stella>=1",
      license: "MIT",
      metadata: { key: "value" },
      name: "alpha",
      origin: "authored",
      version: "1.2.3",
    });

    expect(recordSkillGatewayToolAuditMock).toHaveBeenCalledTimes(1);
    expect(recordSkillGatewayToolAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        outcome: "success",
        skillId: resolvedSkill.id,
        toolName: "skill__alpha",
        durationMs: expect.any(Number),
      }),
    );
  });

  test("answers a retryable envelope instead of throwing when resolving the skill faults", async () => {
    // A load fault means we cannot tell whether the skill exists: the retryable
    // envelope must win over a definitive `unknown_tool`, never surface as an
    // unhandled rejection.
    const loadFault = new Error("db unavailable");
    resolveSkillToolMock.mockRejectedValue(loadFault);
    const sentinel: CallToolResult = {
      content: [{ type: "text", text: "retryable" }],
      isError: true,
    };
    gatewayLoadErrorResultMock.mockReturnValue(sentinel);

    const result = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "default",
      toolName: "skill__alpha",
    });

    expect(gatewayLoadErrorResultMock).toHaveBeenCalledWith(loadFault);
    expect(result).toBe(sentinel);
    expect(recordSkillGatewayToolAuditMock).not.toHaveBeenCalled();
  });

  test("rethrows a resolve fault that gatewayLoadErrorResult does not recognize as a load fault", async () => {
    const otherFault = new Error("not a load fault");
    resolveSkillToolMock.mockRejectedValue(otherFault);
    gatewayLoadErrorResultMock.mockReturnValue(null);

    // bun-types declares `.rejects.toBe` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead (mirrors
    // external-tools.test.ts's load-fault assertion).
    const rejection: unknown = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "default",
      toolName: "skill__alpha",
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(otherFault);
  });
});
