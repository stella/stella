import { EventType, maxIterations } from "@tanstack/ai";
import type { TokenUsage, UIMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";

import type { ModelRole } from "@stll/ai-catalog";

import type { SafeDb } from "@/api/db/safe-db";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  deanonymizeFromBoundary,
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
  reserveThirdPartyBoundarySourcePlaceholders,
} from "@/api/handlers/chat/third-party-boundary";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { getTemperatureForRole, resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  chatToolMapToArray,
  type ChatToolMap,
} from "@/api/lib/chat/chat-tool-types";
import {
  guardModelMessages,
  guardModelToolSchemas,
  redactModelSystemPrompt,
} from "@/api/lib/chat/model-ingress-guard";
import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import {
  finishReasonOf,
  streamChatChunks,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type { TanStackTextFinishReason } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  abortControllerFromSignal,
  mergeGenerationOptions,
  resolveTanStackTextModel,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import {
  addTokenUsage,
  tokenUsageFromRunFinishedChunk,
} from "@/api/lib/tanstack-ai-usage";

type RunSubagentMetering = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  serviceTier: AIRequestServiceTier;
  feature: string;
  sessionId: string;
  traceId: string;
};

export type RunSubagentOptions = {
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  role: ModelRole;
  modelId?: string | undefined;
  /**
   * Server-built framing and tool catalog. Sent verbatim, never anonymized,
   * like `ChatPromptParts.safePrompt` on the parent turn.
   */
  systemSafe: string;
  /**
   * Text the parent model authored (its expected-output brief). Crosses the
   * third-party boundary like message content.
   */
  systemUntrusted: string;
  messages: ChatMessage[];
  /**
   * Tenant set for the model-ingress guard. A subagent runs the parent turn's
   * tools against the same tenant, so the parent passes the same ids it
   * guarded its own dispatch with.
   */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  tools: ChatToolMap;
  abortSignal: AbortSignal;
  maxSteps: number;
  delegationDepth: number;
  metering: RunSubagentMetering;
  thirdPartyBoundary: ChatThirdPartyBoundary;
};

/**
 * Why a subagent run produced no usable answer. `run-error` is a provider
 * failure the run reported; the finish reasons name a final model step that
 * did not end in a complete answer; `empty` is a run that ended with no
 * assistant message at all.
 */
type SubagentFailureReason =
  | "content_filter"
  | "empty"
  | "length"
  | "run-error"
  | "tool_calls";

/**
 * `usage` is the whole run's, summed over every model step, on both branches:
 * a failed run still spent the tokens of the steps before it ended.
 */
export type RunSubagentResult =
  | { outcome: "completed"; text: string; usage: TokenUsage | undefined }
  | {
      message: string;
      outcome: "failed";
      reason: SubagentFailureReason;
      usage: TokenUsage | undefined;
    };

type SubagentFinalStep =
  | { type: "answered" }
  | {
      message: string;
      reason: Extract<
        SubagentFailureReason,
        "content_filter" | "length" | "tool_calls"
      >;
      type: "incomplete";
    };

/** How the run's last model step ended decides whether its text is a result. */
const subagentFinalStep = (
  finishReason: TanStackTextFinishReason,
): SubagentFinalStep => {
  switch (finishReason) {
    // A provider that reports no reason still produced the text it streamed.
    case null:
    case "stop":
      return { type: "answered" };
    case "length":
      return {
        message:
          "The subagent's answer was cut off at the model's output limit.",
        reason: "length",
        type: "incomplete",
      };
    case "content_filter":
      return {
        message:
          "The provider's content filter withheld the subagent's answer.",
        reason: "content_filter",
        type: "incomplete",
      };
    case "tool_calls":
      return {
        message:
          "The subagent used every step on tool calls without answering.",
        reason: "tool_calls",
        type: "incomplete",
      };
    default:
      finishReason satisfies never;
      return panic(`Unhandled finish reason: ${String(finishReason)}`);
  }
};

type UIMessagePart = UIMessage["parts"][number];

type UIMessageTextPart = Extract<UIMessagePart, { type: "text" }>;

const isTextPart = (part: UIMessagePart): part is UIMessageTextPart =>
  part.type === "text";

const textFromUIMessage = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => (isTextPart(part) ? [part.content] : []))
    .join("");

export type RunSubagentDependencies = {
  resolveModel: typeof resolveTanStackTextModel;
};

const defaultRunSubagentDependencies = {
  resolveModel: resolveTanStackTextModel,
} satisfies RunSubagentDependencies;

/**
 * Runs a nested TanStack AI `chat()` agentic tool loop to completion inside a
 * server-tool handler (e.g. a `spawn_subagents` tool) and returns its outcome:
 * the final assistant text, or why the run ended without one, plus the token
 * usage of every model step.
 *
 * This fully consumes the nested stream itself — it never re-streams chunks
 * to a client. Token usage IS metered via `createTanStackAIAnalyticsCallbacks`
 * (actionType: "subagent"), so callers must always supply `metering` or
 * subagent tokens go unaccounted for.
 *
 * Does not accept an `mcp` source: subagents get no external MCP client of
 * their own — reusing the parent's `connection: "close"` client here would
 * close it out from under the parent run.
 */
export const runSubagent = async (
  options: RunSubagentOptions,
  dependencies: RunSubagentDependencies = defaultRunSubagentDependencies,
): Promise<RunSubagentResult> => {
  const model = dependencies.resolveModel({
    modelId: options.modelId,
    organizationId: options.organizationId,
    orgAIConfig: options.orgAIConfig,
    role: options.role,
  });

  const abortController = abortControllerFromSignal(options.abortSignal);

  const analytics = createTanStackAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "subagent",
      organizationId: options.organizationId,
      safeDb: options.metering.safeDb,
      serviceTier: options.metering.serviceTier,
      userId: options.metering.userId,
      workspaceId: options.metering.workspaceId,
    },
    feature: options.metering.feature,
    modelRole: options.role,
    orgAIConfig: options.orgAIConfig,
    properties: {
      organization_id: options.organizationId,
      ...(options.metering.workspaceId
        ? { workspace_id: options.metering.workspaceId }
        : {}),
    },
    sessionId: options.metering.sessionId,
    traceId: options.metering.traceId,
  });

  const boundaryTools = prepareToolsForThirdParty({
    boundary: options.thirdPartyBoundary,
    tools: options.tools,
  });
  const projectedTools = projectChatToolSchemasForProvider({
    modelTools: guardModelToolSchemas({
      tools: chatToolMapToArray(boundaryTools),
      workspaceIds: options.tenantWorkspaceIds,
    }),
    provider: model.provider,
  });

  // Subagent calls have no caller-supplied cache scope key, so prompt caching
  // is left disabled here rather than guessing at a scope.
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: options.role,
    scopeKey: null,
  });

  reserveThirdPartyBoundarySourcePlaceholders({
    boundary: options.thirdPartyBoundary,
    value: [options.systemSafe, options.systemUntrusted, options.messages],
  });

  // Same split as `streamChat`: only the parent model's brief is anonymized.
  // The safe half carries the code-mode catalog's function signatures, which
  // an anonymizing boundary would rewrite into names no tool answers to.
  const preparedUntrusted = await prepareTextForThirdParty({
    boundary: options.thirdPartyBoundary,
    text: options.systemUntrusted,
  });
  if (Result.isError(preparedUntrusted)) {
    throw preparedUntrusted.error;
  }
  const system =
    preparedUntrusted.value.length > 0
      ? `${options.systemSafe}\n\n${preparedUntrusted.value}`
      : options.systemSafe;

  const preparedMessages = await prepareMessagesForThirdParty({
    boundary: options.thirdPartyBoundary,
    messages: options.messages,
  });
  if (Result.isError(preparedMessages)) {
    throw preparedMessages.error;
  }

  const { processor, message: finalMessage } = createStreamMessageCapture({
    initialMessages: preparedMessages.value,
    capture: (message) => message,
  });

  // Same seam as `streamChat`: nothing reaches the provider that has not been
  // through the guard. The subagent's system prompt interpolates the parent
  // model's own tool input (the expected-output brief), so it is redacted and
  // reported rather than fail-closed.
  const guardedSystem = redactModelSystemPrompt({
    system,
    workspaceIds: options.tenantWorkspaceIds,
  });
  const guardedMessages = guardModelMessages({
    messages: preparedMessages.value,
    workspaceIds: options.tenantWorkspaceIds,
  });

  const stream = streamChatChunks({
    adapter: model.adapter,
    messages: guardedMessages,
    tools: projectedTools,
    agentLoopStrategy: maxIterations(options.maxSteps),
    abortController,
    ...systemPromptsPatch({
      caching,
      model,
      system: guardedSystem,
    }),
    modelOptions: mergeGenerationOptions({
      caching,
      model,
      maxOutputTokens: undefined,
      serviceTier: options.metering.serviceTier,
      temperature: getTemperatureForRole(options.role),
    }),
    middleware: [analytics.middleware],
    context: { delegationDepth: options.delegationDepth },
  });

  // One RUN_FINISHED per model step: a tool round trip is its own provider
  // call, so the run's usage is the sum and its outcome is the last step's.
  let usage: TokenUsage | undefined;
  let finishReason: TanStackTextFinishReason = null;
  let runErrorMessage: string | null = null;
  for await (const chunk of stream) {
    if (chunk.type === EventType.RUN_FINISHED) {
      usage = addTokenUsage(usage, tokenUsageFromRunFinishedChunk(chunk));
      finishReason = finishReasonOf(chunk);
    }
    if (chunk.type === EventType.RUN_ERROR) {
      runErrorMessage = chunk.message;
    }
    processor.processChunk(chunk);
  }

  if (abortController.signal.aborted) {
    const abortError = new Error("Subagent run was aborted.");
    abortError.name = "AbortError";
    throw abortError;
  }

  if (runErrorMessage !== null) {
    return {
      message: `The subagent run failed: ${runErrorMessage}`,
      outcome: "failed",
      reason: "run-error",
      usage,
    };
  }

  const finalStep = subagentFinalStep(finishReason);
  switch (finalStep.type) {
    case "incomplete":
      return {
        message: finalStep.message,
        outcome: "failed",
        reason: finalStep.reason,
        usage,
      };
    case "answered":
      break;
    default:
      finalStep satisfies never;
      return panic(`Unhandled final step: ${String(finalStep)}`);
  }

  const answer = finalMessage();
  if (answer === null) {
    return {
      message: "The subagent ended without producing an answer.",
      outcome: "failed",
      reason: "empty",
      usage,
    };
  }

  return {
    outcome: "completed",
    text: deanonymizeFromBoundary({
      boundary: options.thirdPartyBoundary,
      text: textFromUIMessage(answer),
    }),
    usage,
  };
};
