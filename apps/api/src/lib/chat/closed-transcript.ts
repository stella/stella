import { getProviderExecutedMetadata } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import { getModelReasoningCapabilities } from "@stll/ai-catalog";
import type { ReasoningProvenance, TanStackAIProvider } from "@stll/ai-catalog";

import {
  withoutThinking,
  withResponsesReasoningPairedToCalls,
} from "@/api/lib/chat/provider-bound-reasoning";
import { isReasoningProvenance } from "@/api/lib/chat/reasoning-provenance";
import { emitReasoningReplayDroppedMetric } from "@/api/lib/observability/request-metrics";
import { isRecord } from "@/api/lib/type-guards";

export const TOOL_CLOSE_KINDS = [
  "completed",
  "declined",
  "cancelled",
  "failed",
  "timed_out",
] as const;
const closedTranscriptSchema = v.pipe(
  v.custom<ModelMessage[]>(Array.isArray),
  v.brand("ClosedTranscript"),
);

/** Only buildClosedTranscript closes calls and admits reasoning for replay. */
export type ClosedTranscript = v.InferOutput<typeof closedTranscriptSchema>;

type ReplayDrop = Parameters<typeof emitReasoningReplayDroppedMetric>[0];
type BuildClosedTranscriptOptions = {
  messages: readonly ModelMessage[];
  target: { provider: TanStackAIProvider; modelId: string };
  onReasoningDropped?: (drop: ReplayDrop) => void;
};

const provenanceOf = (value: unknown): ReasoningProvenance | undefined =>
  isReasoningProvenance(value) ? value : undefined;

/** Reorders each step's results before the next model turn, fills interrupted
 * calls with a failed result, and retains only explicitly compatible reasoning.
 * Reapplying the builder preserves the transcript. No content enters telemetry. */
export const buildClosedTranscript = ({
  messages,
  target,
  onReasoningDropped = emitReasoningReplayDroppedMetric,
}: BuildClosedTranscriptOptions): ClosedTranscript => {
  // A model the catalog does not describe accepts no replayed reasoning.
  const capabilities = getModelReasoningCapabilities(target.modelId);
  const accepts = (raw: unknown): boolean => {
    const provenance = provenanceOf(raw);
    const compatible =
      provenance !== undefined &&
      capabilities !== null &&
      capabilities.replayCompatibility.some(
        (entry) =>
          entry.provider === target.provider &&
          entry.provider === provenance.provider &&
          entry.model === provenance.model &&
          entry.format === provenance.format,
      );
    if (!compatible) {
      onReasoningDropped({
        fromProvider: provenance?.provider ?? "unknown",
        toProvider: target.provider,
        reason:
          provenance === undefined
            ? "missing-provenance"
            : "incompatible-provenance",
      });
    }
    return compatible;
  };
  const bound = messages.map((message) => {
    const thinking = message.thinking?.filter((item) =>
      accepts(Reflect.get(item, "provenance")),
    );
    let result = message;
    if (
      thinking !== undefined &&
      thinking.length !== message.thinking?.length
    ) {
      result =
        thinking.length === 0
          ? withoutThinking(message)
          : { ...message, thinking };
    }
    if (result.toolCalls !== undefined) {
      result = {
        ...result,
        toolCalls: result.toolCalls.map((call) => {
          const metadata = call.metadata;
          if (
            !isRecord(metadata) ||
            metadata["thoughtSignature"] === undefined
          ) {
            return call;
          }
          if (accepts(metadata["reasoningProvenance"])) {
            return call;
          }
          const {
            thoughtSignature: _signature,
            reasoningProvenance: _provenance,
            ...kept
          } = metadata;
          return { ...call, metadata: kept };
        }),
      };
    }
    return result;
  });
  const paired =
    target.provider === "openai"
      ? withResponsesReasoningPairedToCalls(bound)
      : bound;
  for (const [index, message] of paired.entries()) {
    const before = bound[index];
    if (before?.thinking !== undefined && message.thinking === undefined) {
      for (const item of before.thinking) {
        onReasoningDropped({
          fromProvider:
            provenanceOf(Reflect.get(item, "provenance"))?.provider ??
            "unknown",
          toProvider: target.provider,
          reason: "unpaired-reasoning",
        });
      }
    }
  }
  return v.parse(
    closedTranscriptSchema,
    closeToolCalls(paired, target.provider),
  );
};

const CONTINUATION_THINKING = ["as-requested", "disabled"] as const;
export type ContinuationThinking = (typeof CONTINUATION_THINKING)[number];

type ContinuationThinkingOptions = {
  transcript: ClosedTranscript;
  target: { provider: TanStackAIProvider; modelId: string };
  /** Whether the request as built asks the model to think. */
  thinkingRequested: boolean;
  onReasoningDropped?: (drop: ReplayDrop) => void;
};

/**
 * Anthropic continues a tool-use turn with thinking enabled only when the
 * turn's last assistant message starts with that turn's thinking. A turn
 * whose reasoning cannot be replayed here (started on another model, or
 * stored before reasoning carried its provenance) is therefore continued
 * with thinking disabled for this one request; the next user turn thinks as
 * requested again. The decision is counted, never silent.
 */
export const continuationThinkingFor = ({
  transcript,
  target,
  thinkingRequested,
  onReasoningDropped = emitReasoningReplayDroppedMetric,
}: ContinuationThinkingOptions): ContinuationThinking => {
  const capabilities = getModelReasoningCapabilities(target.modelId);
  if (
    target.provider !== "anthropic" ||
    !thinkingRequested ||
    capabilities === null ||
    capabilities.anthropicThinking === "none"
  ) {
    return "as-requested";
  }
  const lastAssistant = transcript.findLastIndex(
    ({ role }) => role === "assistant",
  );
  const openTurn = transcript.at(lastAssistant);
  if (
    lastAssistant === -1 ||
    openTurn === undefined ||
    openTurn.toolCalls === undefined ||
    openTurn.toolCalls.length === 0 ||
    transcript.slice(lastAssistant + 1).some(({ role }) => role !== "tool") ||
    (openTurn.thinking !== undefined && openTurn.thinking.length > 0)
  ) {
    return "as-requested";
  }
  onReasoningDropped({
    fromProvider: "unknown",
    toProvider: target.provider,
    reason: "continuation-thinking-disabled",
  });
  return "disabled";
};

const closeToolCalls = (
  messages: readonly ModelMessage[],
  provider: TanStackAIProvider,
) => {
  const results = new Map<string, ModelMessage>();
  const calls = new Set<string>();
  const nativeCalls = new Set<string>();
  const embeddedResults = new Map<string, ModelMessage>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        panic("Tool result lacks a call id");
      }
      if (results.has(message.toolCallId)) {
        panic("Tool call has multiple results");
      }
      results.set(message.toolCallId, message);
    }
    if (message.toolCalls === undefined) {
      continue;
    }
    for (const call of message.toolCalls) {
      if (calls.has(call.id)) {
        panic("Transcript has repeated tool call ids");
      }
      calls.add(call.id);
      const nativeMetadata = getProviderExecutedMetadata(call);
      if (nativeMetadata === null) {
        continue;
      }
      const anthropic = nativeMetadata["anthropic"];
      if (
        !isRecord(anthropic) ||
        typeof anthropic["serverToolType"] !== "string" ||
        (anthropic["resultBlockType"] !== "web_search_tool_result" &&
          anthropic["resultBlockType"] !== "web_fetch_tool_result") ||
        !("result" in anthropic)
      ) {
        panic("Provider-executed call lacks a recognized embedded result");
      }
      nativeCalls.add(call.id);
      const content = JSON.stringify(anthropic["result"]);
      if (content === undefined) {
        panic("Native tool result is not JSON data");
      }
      embeddedResults.set(call.id, {
        role: "tool",
        toolCallId: call.id,
        content,
      });
    }
  }
  for (const id of results.keys()) {
    if (!calls.has(id)) {
      panic("Tool result has no matching call");
    }
  }
  const closed: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      continue;
    }
    closed.push(
      provider !== "anthropic" && message.toolCalls !== undefined
        ? {
            ...message,
            toolCalls: message.toolCalls.map((call) => {
              if (!nativeCalls.has(call.id) || !isRecord(call.metadata)) {
                return call;
              }
              const {
                providerExecuted: _providerExecuted,
                anthropic: _anthropic,
                ...metadata
              } = call.metadata;
              const { metadata: _native, ...ordinaryCall } = call;
              return Object.keys(metadata).length === 0
                ? ordinaryCall
                : { ...ordinaryCall, metadata };
            }),
          }
        : message,
    );
    if (message.toolCalls === undefined) {
      continue;
    }
    for (const call of message.toolCalls) {
      // Anthropic emits both native blocks from the embedded metadata. A
      // separate tool message would add a second, ordinary tool result.
      if (nativeCalls.has(call.id) && provider === "anthropic") {
        continue;
      }
      closed.push(
        embeddedResults.get(call.id) ??
          results.get(call.id) ?? {
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({
              status: "failed",
              error: "Tool execution did not produce a result.",
            }),
          },
      );
    }
  }
  return closed;
};
