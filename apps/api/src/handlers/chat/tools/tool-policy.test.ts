import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyChatToolPolicies,
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
  copyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

const tool = (name: string): ChatTool => ({
  name,
  description: `Tool ${name}`,
});

// Installed per test: the real capture path throttles identical errors to one
// event per window, and every policy miss here shares a construction site.
let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  analytics.restore();
});

const exceptionProperties = () =>
  analytics.exceptions().map((event) => event.properties);

describe("getChatToolPolicy", () => {
  test("fails closed and reports telemetry on a WeakMap miss", () => {
    const unregistered = tool("policy-miss-tool");

    expect(() => getChatToolPolicy(unregistered)).toThrow(
      'Chat tool policy is missing for "policy-miss-tool"',
    );
    expect(() => getChatToolPolicy(unregistered)).toThrow(
      'Chat tool policy is missing for "policy-miss-tool"',
    );

    expect(exceptionProperties()).toMatchObject([
      {
        "error.class": "TelemetryError",
        source: "chat-tool-policy",
        toolName: "policy-miss-tool",
      },
    ]);
  });

  test("does not report telemetry for a tool registered via applyChatToolPolicy", () => {
    const registered = tool("policy-registered-tool");
    applyChatToolPolicy(registered, CHAT_TOOL_POLICY_KIND.external);

    const policy = getChatToolPolicy(registered);

    expect(policy.kind).toBe(CHAT_TOOL_POLICY_KIND.external);
    expect(policy.needsApproval).toBe(true);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("copyChatToolPolicy preserves a registered policy without reporting telemetry", () => {
    const from = tool("policy-copy-source");
    applyChatToolPolicy(from, CHAT_TOOL_POLICY_KIND.publicOfficial);
    const to = tool("policy-copy-target");

    copyChatToolPolicy(from, to);

    expect(getChatToolPolicy(to).kind).toBe(
      CHAT_TOOL_POLICY_KIND.publicOfficial,
    );
    expect(analytics.exceptions()).toEqual([]);
  });

  test("copyChatToolPolicy from an unregistered tool fails closed", () => {
    const from = tool("policy-copy-missing-source");
    const to = tool("policy-copy-missing-target");

    expect(() => copyChatToolPolicy(from, to)).toThrow(
      'Chat tool policy is missing for "policy-copy-missing-source"',
    );

    expect(exceptionProperties()).toMatchObject([
      {
        "error.class": "TelemetryError",
        source: "chat-tool-policy",
        toolName: "policy-copy-missing-source",
      },
    ]);
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
    expect(analytics.exceptions()).toEqual([]);
  });

  test("rejects a tool whose policy is omitted instead of silently skipping it", () => {
    expect(() =>
      // @ts-expect-error Deliberately exercises the runtime defense for JS callers.
      applyChatToolPolicies({ tools: { unclassified: tool("unclassified") } }),
    ).toThrow('Chat tool policy is missing for "unclassified"');
  });
});
