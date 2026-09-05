import { EventType, maxIterations, StreamProcessor } from "@tanstack/ai";
import type { TokenUsage, UIMessage } from "@tanstack/ai";
import { Result } from "better-result";

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
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { ChatEmptyCompletionError } from "@/api/lib/errors/tagged-errors";
import {
  abortControllerFromSignal,
  mergeGenerationOptions,
  resolveTanStackTextModel,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import { tokenUsageFromRunFinishedChunk } from "@/api/lib/tanstack-ai-usage";

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
  system: string;
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

export type RunSubagentResult = {
  text: string;
  usage: TokenUsage | undefined;
};

type UIMessagePart = UIMessage["parts"][number];

type UIMessageTextPart = Extract<UIMessagePart, { type: "text" }>;

const isTextPart = (part: UIMessagePart): part is UIMessageTextPart =>
  part.type === "text";

const textFromUIMessage = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => (isTextPart(part) ? [part.content] : []))
    .join("");

/**
 * Runs a nested TanStack AI `chat()` agentic tool loop to completion inside a
 * server-tool handler (e.g. a `spawn_subagents` tool) and returns the final
 * assistant text plus token usage.
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
): Promise<RunSubagentResult> => {
  const model = resolveTanStackTextModel({
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
    value: [options.system, options.messages],
  });

  const preparedSystem = await prepareTextForThirdParty({
    boundary: options.thirdPartyBoundary,
    text: options.system,
  });
  if (Result.isError(preparedSystem)) {
    throw preparedSystem.error;
  }

  const preparedMessages = await prepareMessagesForThirdParty({
    boundary: options.thirdPartyBoundary,
    messages: options.messages,
  });
  if (Result.isError(preparedMessages)) {
    throw preparedMessages.error;
  }

  // Captured on an object property, not a bare `let`: `onStreamEnd` runs later,
  // and type-aware lint narrows a closure-mutated local to its initializer
  // (`null`), which would flag the `=== null` checks below as unnecessary.
  const captured: { message: UIMessage | null } = { message: null };
  const processor = new StreamProcessor({
    initialMessages: preparedMessages.value,
    events: {
      onStreamEnd: (message) => {
        captured.message = message;
      },
    },
  });

  // Same seam as `streamChat`: nothing reaches the provider that has not been
  // through the guard. The subagent's system prompt interpolates the parent
  // model's own tool input (the expected-output brief), so it is redacted and
  // reported rather than fail-closed.
  const guardedSystem = redactModelSystemPrompt({
    system: preparedSystem.value,
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

  let usage: TokenUsage | undefined;
  for await (const chunk of stream) {
    if (chunk.type === EventType.RUN_FINISHED) {
      usage = tokenUsageFromRunFinishedChunk(chunk);
    }
    processor.processChunk(chunk);
  }

  if (abortController.signal.aborted) {
    const abortError = new Error("Subagent run was aborted.");
    abortError.name = "AbortError";
    throw abortError;
  }

  if (captured.message === null) {
    throw new ChatEmptyCompletionError({
      message: "Subagent stream ended without producing an assistant message.",
    });
  }

  return {
    text: deanonymizeFromBoundary({
      boundary: options.thirdPartyBoundary,
      text: textFromUIMessage(captured.message),
    }),
    usage,
  };
};
