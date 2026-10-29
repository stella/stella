import { Result } from "better-result";

import { CHAT_TOOL_POLICY_REQUIRES_APPROVAL } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  raiseChatToolError,
  reraiseChatToolFailure,
} from "@/api/handlers/chat/tools/tool-failure";
import {
  copyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatToolPolicyKind } from "@/api/handlers/chat/tools/tool-policy";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const EXECUTION_AUDIT_FAILED = failureSink({
  event: "chat.tool_execution_audit_failed",
  expected: [],
});

export type ChatToolExecutionAuditContext = {
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

/** Upstream identity of an external MCP tool, keyed by its exposed name. */
export type ExternalMcpToolIdentity = {
  connectorSlug: string;
  upstreamToolName: string;
};

/**
 * `dispatched` is written before the tool runs and must persist, so an action
 * with an effect always has a durable row even if the process stops before it
 * finishes; `success` or `error` follows once it settles.
 */
type ChatToolExecutionOutcome = "dispatched" | "error" | "success";

// Approval-gated kinds act outside the chat (mutations, third-party calls,
// reads beyond the chat's scope), so every execution leaves an audit row.
// Ungated kinds are high-volume reads whose handlers audit their own access.
const isAuditedPolicyKind = (kind: ChatToolPolicyKind): boolean =>
  CHAT_TOOL_POLICY_REQUIRES_APPROVAL[kind];

// Execute functions this module produced, so a tool that reaches more than one
// tool-set builder is audited once per call.
const auditedExecutes = new WeakSet<object>();

/**
 * Audited tools a stored grant ungated for this request, with that grant. A
 * granted call ran without a per-call approval, so its row names the grant.
 */
const grantedAuditedTools = new WeakMap<ChatTool, string>();

/** Record that stored grant `grantId`, not a per-call approval, lets `tool` run. */
export const markChatToolExecutionGranted = (
  tool: ChatTool,
  grantId: string,
): void => {
  grantedAuditedTools.set(tool, grantId);
};

/** How the call that executed was approved. */
type ChatToolExecutionApproval = "per-call" | "grant" | "none";

const executionApproval = (tool: ChatTool): ChatToolExecutionApproval => {
  if (grantedAuditedTools.has(tool)) {
    return "grant";
  }
  return tool.needsApproval === true ? "per-call" : "none";
};

const toolCallIdOf = (context: unknown): string | null => {
  if (typeof context !== "object" || context === null) {
    return null;
  }
  const toolCallId: unknown = Reflect.get(context, "toolCallId");
  return typeof toolCallId === "string" && toolCallId.length > 0
    ? toolCallId
    : null;
};

type RecordExecutionInput = {
  audit: ChatToolExecutionAuditContext;
  durationMs: number;
  externalMcp: ExternalMcpToolIdentity | undefined;
  approval: ChatToolExecutionApproval;
  grantId: string | null;
  outcome: ChatToolExecutionOutcome;
  policyKind: ChatToolPolicyKind;
  toolCallId: string | null;
  toolName: string;
};

/**
 * One row per execution. Arguments and results never enter the row: they can
 * carry privileged content, and the tool's own handler audits what it changed.
 */
const recordExecution = async ({
  audit,
  durationMs,
  externalMcp,
  approval,
  grantId,
  outcome,
  policyKind,
  toolCallId,
  toolName,
}: RecordExecutionInput) => {
  const result = await audit.safeDb(async (tx) => {
    await audit.recordAuditEvent(tx, {
      action: AUDIT_ACTION.EXECUTE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION,
      resourceId: toolCallId ?? audit.threadId,
      metadata: {
        // The runtime names an approval after the call it gates; a gated tool
        // only executes once that approval resolved as approved.
        approval,
        approvalId:
          approval === "per-call" && toolCallId !== null
            ? `approval_${toolCallId}`
            : null,
        durationMs,
        grantId,
        outcome,
        policyKind,
        threadId: audit.threadId,
        toolCallId,
        toolName,
        ...(externalMcp === undefined
          ? {}
          : {
              connectorSlug: externalMcp.connectorSlug,
              upstreamToolName: externalMcp.upstreamToolName,
            }),
      },
    });
  });
  return result;
};

type ChatToolExecute = NonNullable<ChatTool["execute"]>;

const auditedTool = ({
  audit,
  execute,
  externalMcp,
  policyKind,
  tool,
}: {
  audit: ChatToolExecutionAuditContext;
  execute: ChatToolExecute;
  externalMcp: ExternalMcpToolIdentity | undefined;
  policyKind: ChatToolPolicyKind;
  tool: ChatTool;
}): ChatTool => {
  const audited: ChatTool = { ...tool };
  const auditedExecute: ChatToolExecute = async (
    ...args: Parameters<ChatToolExecute>
  ): Promise<unknown> => {
    const startedAt = Temporal.Now.instant().epochMilliseconds;
    const record = async (outcome: ChatToolExecutionOutcome) =>
      await recordExecution({
        audit,
        durationMs: Temporal.Now.instant().epochMilliseconds - startedAt,
        externalMcp,
        approval: executionApproval(audited),
        grantId: grantedAuditedTools.get(audited) ?? null,
        outcome,
        policyKind,
        toolCallId: toolCallIdOf(args[1]),
        toolName: tool.name,
      });
    // Without a durable record of the dispatch the call does not run.
    const dispatched = await record("dispatched");
    if (Result.isError(dispatched)) {
      observeFailure(dispatched.error, {
        sink: EXECUTION_AUDIT_FAILED,
        ctx: { source: "chat-tool-execution-audit", operation: policyKind },
      });
      return raiseChatToolError(
        new ChatToolError({
          kind: "transient",
          message: "The tool call could not be recorded; it was not run.",
          cause: dispatched.error,
        }),
      );
    }
    const settled = await Result.tryPromise({
      try: async (): Promise<unknown> => await execute(...args),
      catch: (error: unknown) => error,
    });
    const recorded = await record(
      Result.isError(settled) ? "error" : "success",
    );
    if (Result.isError(recorded)) {
      // The call already ran; preserve its outcome so an audit outage cannot
      // invite a retry of a completed mutation.
      observeFailure(recorded.error, {
        sink: EXECUTION_AUDIT_FAILED,
        ctx: { source: "chat-tool-execution-audit", operation: policyKind },
      });
    }
    if (Result.isError(settled)) {
      return reraiseChatToolFailure(settled.error);
    }
    return settled.value;
  };
  auditedExecutes.add(auditedExecute);
  audited.execute = auditedExecute;
  copyChatToolPolicy(tool, audited);
  return audited;
};

/**
 * The same tool map with every server-executed, approval-gated tool wrapped so
 * each execution records an audit row (tool, policy kind, connector for
 * external MCP tools, outcome, thread, approval id). Other tools pass through
 * unchanged, and a tool already wrapped here is not wrapped again.
 */
export const auditChatToolExecutions = ({
  audit,
  externalMcpTools,
  tools,
}: {
  audit: ChatToolExecutionAuditContext;
  externalMcpTools?: ReadonlyMap<string, ExternalMcpToolIdentity> | undefined;
  tools: ChatToolMap;
}): ChatToolMap => {
  const auditedEntry = (
    name: string,
    tool: ChatTool | undefined,
  ): ChatTool | undefined => {
    if (tool?.execute === undefined || auditedExecutes.has(tool.execute)) {
      return tool;
    }
    const policyKind = getChatToolPolicy(tool).kind;
    if (!isAuditedPolicyKind(policyKind)) {
      return tool;
    }
    return auditedTool({
      audit,
      externalMcp: externalMcpTools?.get(name),
      policyKind,
      execute: tool.execute,
      tool,
    });
  };
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      auditedEntry(name, tool),
    ]),
  );
};
