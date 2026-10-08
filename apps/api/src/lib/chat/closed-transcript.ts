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
export type ToolCloseKind = (typeof TOOL_CLOSE_KINDS)[number];

const closedTranscriptSchema = v.pipe(
  v.custom<ModelMessage[]>(Array.isArray),
  v.brand("ClosedTranscript"),
);

/** Only buildClosedTranscript closes calls and admits reasoning for replay. */
export type ClosedTranscript = v.InferOutput<typeof closedTranscriptSchema>;

type ReplayDrop = {
  fromProvider: TanStackAIProvider | "unknown";
  toProvider: TanStackAIProvider;
  reason:
    | "missing-provenance"
    | "incompatible-provenance"
    | "unpaired-reasoning";
};
type BuildClosedTranscriptOptions = {
  messages: readonly ModelMessage[];
  target: { provider: TanStackAIProvider; modelId: string };
  onReasoningDropped?: (drop: ReplayDrop) => void;
};

const provenanceOf = (value: unknown): ReasoningProvenance | undefined => {
  return isReasoningProvenance(value) ? value : undefined;
};

/** Reorders each step's results before the next model turn, fills interrupted
 * calls with a failed result, and retains only explicitly compatible reasoning.
 * Reapplying the builder preserves the transcript. No content enters telemetry. */
export const buildClosedTranscript = ({
  messages,
  target,
  onReasoningDropped = emitReasoningReplayDroppedMetric,
}: BuildClosedTranscriptOptions): ClosedTranscript => {
  const compatibility =
    getModelReasoningCapabilities(target.modelId)?.replayCompatibility ?? [];
  const accepts = (raw: unknown): boolean => {
    const provenance = provenanceOf(raw);
    const compatible =
      provenance !== undefined &&
      compatibility.some(
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
          if (!isRecord(metadata) || metadata["thoughtSignature"] === undefined)
            return call;
          if (accepts(metadata["reasoningProvenance"])) return call;
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
  const results = new Map<string, ModelMessage>();
  const calls = new Set<string>();
  const nativeCalls = new Set<string>();
  const embeddedResults = new Map<string, ModelMessage>();
  for (const message of paired) {
    if (message.role === "tool") {
      if (message.toolCallId === undefined)
        panic("Tool result lacks a call id");
      if (results.has(message.toolCallId))
        panic("Tool call has multiple results");
      results.set(message.toolCallId, message);
    }
    for (const call of message.toolCalls ?? []) {
      if (calls.has(call.id)) panic("Transcript has repeated tool call ids");
      calls.add(call.id);
      const nativeMetadata = getProviderExecutedMetadata(call);
      if (nativeMetadata === null) continue;
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
      if (content === undefined) panic("Native tool result is not JSON data");
      embeddedResults.set(call.id, {
        role: "tool",
        toolCallId: call.id,
        content,
      });
    }
  }
  for (const id of results.keys()) {
    if (!calls.has(id)) panic("Tool result has no matching call");
  }
  const closed: ModelMessage[] = [];
  for (const message of paired) {
    if (message.role === "tool") continue;
    closed.push(
      target.provider !== "anthropic" && message.toolCalls !== undefined
        ? {
            ...message,
            toolCalls: message.toolCalls.map((call) => {
              if (!nativeCalls.has(call.id) || !isRecord(call.metadata))
                return call;
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
    for (const call of message.toolCalls ?? []) {
      // Anthropic emits both native blocks from the embedded metadata. A
      // separate tool message would add a second, ordinary tool result.
      if (nativeCalls.has(call.id) && target.provider === "anthropic") continue;
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
  return v.parse(closedTranscriptSchema, closed);
};
