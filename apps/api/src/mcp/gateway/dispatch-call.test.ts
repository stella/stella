import type { CallToolResult } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import type { ResolvedSkillTool } from "@/api/mcp/gateway/skills";
import { structuredErrorResult } from "@/api/mcp/tool-utils";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Mock the two dispatch collaborators so this file exercises only
// `dispatchGatewayToolCall`'s own branch selection, audit call, and result
// envelope. The name-classification (`isSkillToolName` /
// `isExternalMcpToolName`) and internal result builders stay real.
const callGatewayExternalMcpToolMock = mock();
const gatewayLoadErrorResultMock = mock();
const recordSkillGatewayToolAuditMock = mock(async () => undefined);
const resolveSkillToolMock = mock();

const dependencies = {
  callGatewayExternalMcpTool: callGatewayExternalMcpToolMock,
  gatewayLoadErrorResult: gatewayLoadErrorResultMock,
  recordSkillGatewayToolAudit: recordSkillGatewayToolAuditMock,
  resolveSkillTool: resolveSkillToolMock,
};

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
      dependencies,
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
      dependencies,
    });

    expect(result).toEqual({ type: "external_mcp", result: sentinel });
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
      dependencies,
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
      dependencies,
    });

    expect(result?.type).toBe("internal");
    if (result?.type !== "internal") {
      throw new Error("expected an internal gateway result");
    }
    expect(result.result).toEqual({
      status: "error",
      error: {
        type: "structured",
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
      dependencies,
    });

    expect(result?.type).toBe("internal");
    if (result?.type !== "internal") {
      throw new Error("expected an internal gateway result");
    }
    expect(result.result).toEqual({
      status: "success",
      data: {
        body: "# Alpha skill body",
        compatibility: "stella>=1",
        license: "MIT",
        metadata: { key: "value" },
        name: "alpha",
        origin: "authored",
        version: "1.2.3",
      },
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
    const sentinel = structuredErrorResult({
      code: "internal_error",
      message: "retryable",
      retryable: true,
    });
    gatewayLoadErrorResultMock.mockReturnValue(sentinel);

    const result = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "default",
      toolName: "skill__alpha",
      dependencies,
    });

    expect(gatewayLoadErrorResultMock).toHaveBeenCalledWith(loadFault);
    expect(result).toEqual({ type: "internal", result: sentinel });
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
      dependencies,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(otherFault);
  });
});
