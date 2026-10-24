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
import { applyChatToolGrants } from "@/api/handlers/chat/tools/chat-tool-grants";
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
      // A dispatch row before the call, an outcome row after it.
      expect(rows).toHaveLength(
        CHAT_TOOL_POLICY_REQUIRES_APPROVAL[kind] ? 2 : 0,
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

    const row = (outcome: string) => ({
      action: AUDIT_ACTION.EXECUTE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION,
      resourceId: "call_7",
      metadata: {
        approval: "per-call",
        approvalId: "approval_call_7",
        durationMs: expect.any(Number),
        grantId: null,
        outcome,
        policyKind: CHAT_TOOL_POLICY_KIND.mutation,
        threadId,
        toolCallId: "call_7",
        toolName: "save_task",
      },
    });
    expect(rows).toEqual([row("dispatched"), row("success")]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PRIVILEGED_ARGUMENT);
    expect(serialized).not.toContain(PRIVILEGED_RESULT);
  });

  test("a call a stored grant ungated records the grant and names no approval", async () => {
    const { audit, rows } = auditFixture();
    const audited = auditChatToolExecutions({
      audit,
      tools: {
        web_search: toolWithPolicy(
          "web_search",
          CHAT_TOOL_POLICY_KIND.external,
        ),
      },
    });
    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants: [
        {
          id: toSafeId<"chatToolGrant">("grant_1"),
          scope: "conversation",
          chatThreadId: threadId,
          toolName: "web_search",
          mcpConnectorId: null,
          mcpConnectorToolNamespace: null,
        },
      ],
      tools: audited,
    });

    await granted["web_search"]?.execute?.({}, { toolCallId: "call_9" });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            approval: "grant",
            approvalId: null,
            grantId: "grant_1",
            toolCallId: "call_9",
          }),
        }),
      );
    }
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
        metadata: expect.objectContaining({ outcome: "dispatched" }),
      }),
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

    expect(rows).toHaveLength(2);
    expect(getChatToolPolicy(tool).kind).toBe(CHAT_TOOL_POLICY_KIND.mutation);
  });

  test("a call whose dispatch cannot be recorded does not run", async () => {
    const { audit } = auditFixture();
    let ran = false;
    const failingAudit: ChatToolExecutionAuditContext = {
      ...audit,
      safeDb: asTestRaw<SafeDb>(async () =>
        Result.err(new Error("audit store unavailable")),
      ),
    };
    const tools = auditChatToolExecutions({
      audit: failingAudit,
      tools: {
        save_task: toolWithPolicy(
          "save_task",
          CHAT_TOOL_POLICY_KIND.mutation,
          async () => {
            ran = true;
            return await Promise.resolve(PRIVILEGED_RESULT);
          },
        ),
      },
    });

    const thrown = await rejectionOf(
      Promise.resolve(
        tools["save_task"]?.execute?.({}, { toolCallId: "call_4" }),
      ),
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(ran).toBe(false);
  });
});
