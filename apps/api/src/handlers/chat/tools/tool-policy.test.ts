import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChatTool } from "@/api/lib/chat/chat-tool-types";

const captureErrorMock = mock();

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

const {
  applyChatToolPolicy,
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
  test("falls back to internal and reports telemetry once per tool name on a WeakMap miss", () => {
    const unregisteredA = tool("policy-miss-tool");
    const unregisteredB = tool("policy-miss-tool");

    const policyA = getChatToolPolicy(unregisteredA);
    const policyB = getChatToolPolicy(unregisteredB);

    expect(policyA).toEqual({
      kind: CHAT_TOOL_POLICY_KIND.internal,
      needsApproval: false,
      requiresAnonymization: false,
    });
    expect(policyB.kind).toBe(CHAT_TOOL_POLICY_KIND.internal);

    // Deduped per process by tool name: the second miss for the same name
    // must not capture again.
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

  test("copyChatToolPolicy from an unregistered tool still reports the source miss", () => {
    const from = tool("policy-copy-missing-source");
    const to = tool("policy-copy-missing-target");

    copyChatToolPolicy(from, to);

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "chat-tool-policy",
        toolName: "policy-copy-missing-source",
      }),
    );
    // The copy itself lands the fallback internal policy on `to` without a
    // second report for `to`'s own (never-queried) name.
    expect(getChatToolPolicy(to).kind).toBe(CHAT_TOOL_POLICY_KIND.internal);
  });
});
