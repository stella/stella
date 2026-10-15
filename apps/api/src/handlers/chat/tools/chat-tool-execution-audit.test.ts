import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CHAT_TOOL_POLICY_KIND,
  CHAT_TOOL_POLICY_REQUIRES_APPROVAL,
} from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import { auditChatToolExecutions } from "@/api/handlers/chat/tools/chat-tool-execution-audit";
import type { ChatToolExecutionAuditContext } from "@/api/handlers/chat/tools/chat-tool-execution-audit";
import {
  applyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatToolPolicyKind } from "@/api/handlers/chat/tools/tool-policy";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatTool } from "@/api/lib/chat/chat-tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const threadId = toSafeId<"chatThread">("thread_1");
const PRIVILEGED_ARGUMENT = "privileged-argument-text";
const PRIVILEGED_RESULT = "privileged-result-text";

const auditFixture = () => {
  const rows: Record<string, unknown>[] = [];
  const audit: ChatToolExecutionAuditContext = {
    recordAuditEvent: (_tx, event) => {
      for (const entry of Array.isArray(event) ? event : [event]) {
        rows.push(asTestRaw<Record<string, unknown>>(entry));
      }
    },
    safeDb: asTestRaw<SafeDb>(
      async (operation: (tx: unknown) => Promise<unknown>) =>
        Result.ok(await operation({})),
    ),
    threadId,
  };
  return { audit, rows };
};

const toolWithPolicy = (
  name: string,
  kind: ChatToolPolicyKind,
  execute: ChatTool["execute"] = async () =>
    await Promise.resolve(PRIVILEGED_RESULT),
): ChatTool =>
  applyChatToolPolicy(
    {
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      execute,
    },
    kind,
  );

const ALL_KINDS = Object.values(CHAT_TOOL_POLICY_KIND);

describe("chat tool execution audit", () => {
  test("every approval-gated kind records one row per execution, ungated kinds none", async () => {
    for (const kind of ALL_KINDS) {
      const { audit, rows } = auditFixture();
      const tools = auditChatToolExecutions({
        audit,
        tools: { probe: toolWithPolicy("probe", kind) },
      });

      const result: unknown = await tools["probe"]?.execute?.(
        { text: PRIVILEGED_ARGUMENT },
        { toolCallId: "call_1" },
      );

      expect(result).toBe(PRIVILEGED_RESULT);
      expect(rows).toHaveLength(
        CHAT_TOOL_POLICY_REQUIRES_APPROVAL[kind] ? 1 : 0,
      );
    }
  });

  test("the row names the tool, policy, outcome, thread and approval, never the payload", async () => {
    const { audit, rows } = auditFixture();
    const tools = auditChatToolExecutions({
      audit,
      tools: {
        save_task: toolWithPolicy("save_task", CHAT_TOOL_POLICY_KIND.mutation),
      },
    });

    await tools["save_task"]?.execute?.(
      { text: PRIVILEGED_ARGUMENT },
      { toolCallId: "call_7" },
    );

    expect(rows).toEqual([
      {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION,
        resourceId: "call_7",
        metadata: {
          approvalId: "approval_call_7",
          durationMs: expect.any(Number),
          outcome: "success",
          policyKind: CHAT_TOOL_POLICY_KIND.mutation,
          threadId,
          toolCallId: "call_7",
          toolName: "save_task",
        },
      },
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PRIVILEGED_ARGUMENT);
    expect(serialized).not.toContain(PRIVILEGED_RESULT);
  });

  test("a failing execution records an error outcome and rethrows", async () => {
    const { audit, rows } = auditFixture();
    const failure = new Error(PRIVILEGED_RESULT);
    const tools = auditChatToolExecutions({
      audit,
      tools: {
        mcp__registry__lookup: toolWithPolicy(
          "mcp__registry__lookup",
          CHAT_TOOL_POLICY_KIND.external,
          async () => await Promise.reject(failure),
        ),
      },
      externalMcpTools: new Map([
        [
          "mcp__registry__lookup",
          { connectorSlug: "registry", upstreamToolName: "lookup" },
        ],
      ]),
    });

    const thrown = await rejectionOf(
      Promise.resolve(
        tools["mcp__registry__lookup"]?.execute?.({}, { toolCallId: "call_2" }),
      ),
    );

    expect(thrown).toBe(failure);
    expect(rows).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          connectorSlug: "registry",
          outcome: "error",
          policyKind: CHAT_TOOL_POLICY_KIND.external,
          upstreamToolName: "lookup",
        }),
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(PRIVILEGED_RESULT);
  });

  test("a tool passed through two builders is audited once and keeps its policy", async () => {
    const { audit, rows } = auditFixture();
    const once = auditChatToolExecutions({
      audit,
      tools: {
        save_task: toolWithPolicy("save_task", CHAT_TOOL_POLICY_KIND.mutation),
      },
    });
    const twice = auditChatToolExecutions({ audit, tools: once });
    const tool = twice["save_task"];
    if (!tool) {
      throw new Error("expected the audited tool");
    }

    await tool.execute?.({}, { toolCallId: "call_3" });

    expect(rows).toHaveLength(1);
    expect(getChatToolPolicy(tool).kind).toBe(CHAT_TOOL_POLICY_KIND.mutation);
  });

  test("an audit write failure does not fail the tool call", async () => {
    const { audit } = auditFixture();
    const failingAudit: ChatToolExecutionAuditContext = {
      ...audit,
      safeDb: asTestRaw<SafeDb>(async () =>
        Result.err(new Error("audit store unavailable")),
      ),
    };
    const tools = auditChatToolExecutions({
      audit: failingAudit,
      tools: {
        save_task: toolWithPolicy("save_task", CHAT_TOOL_POLICY_KIND.mutation),
      },
    });

    expect(
      await tools["save_task"]?.execute?.({}, { toolCallId: "call_4" }),
    ).toBe(PRIVILEGED_RESULT);
  });
});
