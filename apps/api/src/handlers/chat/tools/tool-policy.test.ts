import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";

const captureErrorMock = mock();

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

const {
  applyChatToolPolicy,
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
  copyChatToolPolicy,
  getChatToolPolicy,
} = await import("@/api/handlers/chat/tools/tool-policy");

const tool = (name: string): ChatTool => ({
  name,
  description: `Tool ${name}`,
});

beforeEach(() => {
  captureErrorMock.mockReset();
});

// Bun runs every test file in one process, and `mock.module` mutates a
// shared registry: without restoring here, this call would leak into
// whichever other test file runs next in the same process.
afterAll(() => {
  mock.restore();
});

describe("getChatToolPolicy", () => {
  test("fails closed and reports telemetry on a WeakMap miss", () => {
    const unregistered = tool("policy-miss-tool");

    expect(() => getChatToolPolicy(unregistered)).toThrow(
      'Chat tool policy is missing for "policy-miss-tool"',
    );
    expect(() => getChatToolPolicy(unregistered)).toThrow(
      'Chat tool policy is missing for "policy-miss-tool"',
    );

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "chat-tool-policy",
        toolName: "policy-miss-tool",
      }),
    );
  });

  test("does not report telemetry for a tool registered via applyChatToolPolicy", () => {
    const registered = tool("policy-registered-tool");
    applyChatToolPolicy(registered, CHAT_TOOL_POLICY_KIND.external);

    const policy = getChatToolPolicy(registered);

    expect(policy.kind).toBe(CHAT_TOOL_POLICY_KIND.external);
    expect(policy.needsApproval).toBe(true);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("copyChatToolPolicy preserves a registered policy without reporting telemetry", () => {
    const from = tool("policy-copy-source");
    applyChatToolPolicy(from, CHAT_TOOL_POLICY_KIND.publicOfficial);
    const to = tool("policy-copy-target");

    copyChatToolPolicy(from, to);

    expect(getChatToolPolicy(to).kind).toBe(
      CHAT_TOOL_POLICY_KIND.publicOfficial,
    );
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("copyChatToolPolicy from an unregistered tool fails closed", () => {
    const from = tool("policy-copy-missing-source");
    const to = tool("policy-copy-missing-target");

    expect(() => copyChatToolPolicy(from, to)).toThrow(
      'Chat tool policy is missing for "policy-copy-missing-source"',
    );

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "chat-tool-policy",
        toolName: "policy-copy-missing-source",
      }),
    );
    expect(() => getChatToolPolicy(to)).toThrow(
      'Chat tool policy is missing for "policy-copy-missing-target"',
    );
  });
});

describe("applyChatToolPolicies", () => {
  test("preserves a policy assigned before a dynamic tool joins the built-in map", () => {
    const dynamic = tool("dynamic-connector");
    applyChatToolPolicy(dynamic, CHAT_TOOL_POLICY_KIND.external);
    const tools: ChatToolMap = { dynamic };

    expect(applyChatToolPolicies({ policyKinds: {}, tools })).toBe(tools);
    expect(getChatToolPolicy(dynamic).kind).toBe(
      CHAT_TOOL_POLICY_KIND.external,
    );
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("rejects a tool whose policy is omitted instead of silently skipping it", () => {
    expect(() =>
      // @ts-expect-error Deliberately exercises the runtime defense for JS callers.
      applyChatToolPolicies({ tools: { unclassified: tool("unclassified") } }),
    ).toThrow('Chat tool policy is missing for "unclassified"');
  });
});
