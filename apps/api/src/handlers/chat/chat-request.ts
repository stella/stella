import type { SystemPrompt } from "@tanstack/ai";

import type { ModelRole } from "@stll/ai-catalog";

import type { ChatSafePromptLayers } from "@/api/handlers/chat/chat-prompt";
import { getTemperatureForRole } from "@/api/lib/ai-config";
import type {
  AIRequestServiceTier,
  CachingDecision,
} from "@/api/lib/ai-config";
import { withRunToolCallIds } from "@/api/lib/chat/provider-stream-contract";
import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";
import type { ToolCallIdLedger } from "@/api/lib/chat/unique-tool-call-ids";
import { logger } from "@/api/lib/observability/logger";
import type { LayeredSystemPrompt } from "@/api/lib/tanstack-ai-caching";
import {
  chatTurnOutputTokens,
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

// The one place a chat surface shapes what it sends a provider: its tools, its
// system prompt and its generation options. The chat turn, its fallback, a
// loop-recovery rewrite and a subagent all build here, and the lint rule
// `no-ad-hoc-chat-request` keeps every other file under `handlers/chat` from
// assembling either on its own.
//
// A chat turn's system prompt arrives in layers, in prompt order (see
// `chat-prompt.ts`):
//
//   static        same for every organization   marker
//   organization  same for its users            marker
//   turn          per user and per turn         none
//
// then the messages, whose last block the request-level marker lands on. On a
// provider that caches at markers (`PROVIDER_PROMPT_CACHING`) that is three
// of the four markers a request may carry: the tools and the static layer are
// shared by every organization, the organization layer by its users, and each
// request reads the prefix the request before it wrote, so a thread's history
// and every tool-loop iteration are cached. Every other provider receives the
// layers as one string, the same bytes as before they were layered, and
// caches the shared prefix without a marker.

/**
 * The guarded system prompt split at its cacheable layers. The guard only ever
 * checks a server-built prompt, so the prompt still begins with the layers; if
 * a rewrite ever changed them, the prompt is sent whole instead (one cache
 * miss, not a failed turn).
 */
const layeredChatSystemPrompt = ({
  layers,
  system,
}: {
  layers: ChatSafePromptLayers;
  system: string;
}): LayeredSystemPrompt | string => {
  const prefix = `${layers.static}${layers.organization}`;
  if (!system.startsWith(prefix)) {
    logger.warn("chat.system_prompt_layers_diverged", {
      "chat.cached_layers_chars": prefix.length,
      "chat.system_chars": system.length,
    });
    return system;
  }
  return {
    organization: layers.organization,
    static: layers.static,
    turn: system.slice(prefix.length),
  };
};

type ChatSystemPromptInput = {
  caching: CachingDecision;
  model: ResolvedTanStackTextModel;
  system: string | undefined;
  /** The cacheable layers `system` begins with; a surface without them (a
   *  subagent, a wire probe) sends its prompt unlayered. */
  systemLayers?: ChatSafePromptLayers | undefined;
};

const systemPromptsFor = ({
  caching,
  model,
  system,
  systemLayers,
}: ChatSystemPromptInput): { systemPrompts?: SystemPrompt[] } =>
  systemPromptsPatch({
    caching,
    model,
    system:
      system === undefined || systemLayers === undefined
        ? system
        : layeredChatSystemPrompt({ layers: systemLayers, system }),
  });

/**
 * The system prompts a runtime rewrite hands the engine mid-run (loop
 * recovery appends to the turn layer), split the way the request's own were.
 */
export const chatSystemPrompts = (
  input: ChatSystemPromptInput & { system: string },
): SystemPrompt[] => systemPromptsFor(input).systemPrompts ?? [];

type ChatRequestOptionsInput = ChatSystemPromptInput & {
  maxOutputTokens: number | undefined;
  modelTools: Parameters<
    typeof projectChatToolSchemasForProvider
  >[0]["modelTools"];
  serviceTier: AIRequestServiceTier;
  temperature: number | undefined;
};

/** A chat surface's tools, system prompt and generation options. */
export const chatRequestOptions = ({
  caching,
  maxOutputTokens,
  model,
  modelTools,
  serviceTier,
  system,
  systemLayers,
  temperature,
}: ChatRequestOptionsInput) => ({
  tools: projectChatToolSchemasForProvider({
    modelTools,
    provider: model.provider,
  }),
  ...systemPromptsFor({ caching, model, system, systemLayers }),
  modelOptions: mergeGenerationOptions({
    cacheConversation: systemLayers !== undefined,
    caching,
    model,
    maxOutputTokens,
    serviceTier,
    temperature,
  }),
});

type ChatAttemptRole = Extract<ModelRole, "chat" | "reasoning">;

/**
 * What a chat attempt hands the engine that shapes the provider request: the
 * adapter bound to the run's tool call ids, the tools as the provider reads
 * them, the system prompt, and the generation options. The provider wire
 * test builds its requests here too, so what it sends is what a chat turn
 * sends. `maxOutputTokens` defaults to the chat turn's ceiling.
 */
export const chatAttemptRequestOptions = ({
  caching,
  maxOutputTokens,
  model,
  modelTools,
  role,
  system,
  systemLayers,
  toolCallIds,
}: {
  caching: CachingDecision;
  maxOutputTokens?: number | undefined;
  model: ResolvedTanStackTextModel;
  modelTools: ChatRequestOptionsInput["modelTools"];
  role: ChatAttemptRole;
  system: string | undefined;
  systemLayers?: ChatSafePromptLayers | undefined;
  toolCallIds: ToolCallIdLedger;
}) => ({
  adapter: withRunToolCallIds(model.adapter, toolCallIds),
  ...chatRequestOptions({
    caching,
    maxOutputTokens: maxOutputTokens ?? chatTurnOutputTokens(model),
    model,
    modelTools,
    serviceTier: "standard",
    system,
    systemLayers,
    temperature: getTemperatureForRole(role),
  }),
});
