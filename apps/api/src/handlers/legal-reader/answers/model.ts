import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import type {
  ReaderAnswerCitation,
  ReaderAnswerUsage,
} from "@stll/api-contract/reader-answers";

import { getTemperatureForTask, resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { ServerAnalytics } from "@/api/lib/analytics/server-analytics";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { readReaderAnswerRelated } from "@/api/lib/case-law/reader-answer-corpus";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { chatRequestOptions } from "@/api/lib/chat/chat-request";
import {
  guardModelMessages,
  guardModelToolSchemas,
  redactModelSystemPrompt,
} from "@/api/lib/chat/model-ingress-guard";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import {
  finishReasonOf,
  runFinishedOutcomeOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { AdmittedModelAction } from "@/api/lib/rate-limit/model-action-admission";
import {
  resolveTanStackTextModel,
  streamTanStackChatRun,
  textAdapterWithNormalizedStops,
} from "@/api/lib/tanstack-ai-generate";
import { modelAcceptsStreamingToolUse } from "@/api/lib/tanstack-ai-models";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";
import { tokenUsageFromTerminalChunk } from "@/api/lib/tanstack-ai-usage";

export type ReaderAnswerModelInput = AdmittedModelAction & {
  answerId: SafeId<"legalReaderAnswer">;
  decisionId: SafeId<"caseLawDecision">;
  paragraphId: string;
  system: string;
  messages: ModelMessage[];
  modelId: string | undefined;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  metering: AIUsageMetering;
  onDelta: (delta: string) => void;
  onEvidence: (citations: ReaderAnswerCitation[]) => void;
};
export type ReaderAnswerModelResult = {
  content: string;
  model: string;
  usage: ReaderAnswerUsage | null;
};
export type ReaderAnswerModelRunner = (
  input: ReaderAnswerModelInput,
) => Promise<Result<ReaderAnswerModelResult, unknown>>;

type ReaderAnswerModelDependencies = {
  resolveModel?: typeof resolveTanStackTextModel;
  analytics?: ServerAnalytics;
  readRelated?: typeof readReaderAnswerRelated;
  streamRun?: typeof streamTanStackChatRun;
};

const READER_ANSWER_TOOL_CALLS = 3;
const READER_ANSWER_MODEL_STEPS = 4;
const READER_ANSWER_OUTPUT_TOKENS = 4096;
const MODEL_FAILURE = failureSink({
  event: "reader_answer.model_failed",
  expected: [],
});
const CORPUS_FAILURE = failureSink({
  event: "reader_answer.related_corpus_unavailable",
  expected: [],
});

/** The same admitted, policy-aware model resolver and chat request/runtime as chat. */
export const runReaderAnswerModel = async (
  input: ReaderAnswerModelInput,
  {
    resolveModel = resolveTanStackTextModel,
    analytics: analyticsTransport,
    readRelated = readReaderAnswerRelated,
    streamRun = streamTanStackChatRun,
  }: ReaderAnswerModelDependencies = {},
): Promise<Result<ReaderAnswerModelResult, unknown>> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    task: "chat",
    scopeKey: null,
  });
  const analytics = createTanStackAIAnalyticsCallbacks({
    ...(analyticsTransport === undefined
      ? {}
      : { analytics: analyticsTransport }),
    dataClass: "customer",
    feature: "case-law.reader-answer",
    modelTask: "chat",
    modelTier: input.admission.modelTier,
    selectedModelId: input.modelId,
    orgAIConfig: input.orgAIConfig,
    traceId: Bun.randomUUIDv7(),
    sessionId: input.answerId,
    usageMetering: input.metering,
  });
  const resolved = await Result.tryPromise({
    try: async () =>
      await resolveModel({
        userId: input.admission.userId,
        admission: input.admission,
        dataClass: "customer",
        managedAIResidency: input.managedAIResidency,
        task: "chat",
        orgAIConfig: input.orgAIConfig,
        organizationId: input.metering.organizationId,
        modelId: input.modelId,
      }),
    catch: (error) => error,
  });
  if (resolved.isErr()) {
    observeFailure(resolved.error, { sink: MODEL_FAILURE });
    return Result.err(resolved.error);
  }
  const model = resolved.value;
  if (!modelAcceptsStreamingToolUse(model)) {
    const error = new HandlerError({
      status: 400,
      message:
        "Choose a model that supports streaming tools for reader answers",
    });
    observeFailure(error, { sink: MODEL_FAILURE });
    return Result.err(error);
  }
  let toolCalls = 0;
  const related = toolDefinition({
    name: "related_decision_paragraphs",
    description:
      "Read relevant paragraph excerpts from decisions cited by or citing this decision in the admitted public-law corpus. Excerpts preserve direction: cited is cited by this decision; citing cites this decision. Court and decisionDate identify the returned source. No web or external sources. Cite only returned decisionId and paragraphId pairs.",
    inputSchema: toTanStackValibotSchema(
      v.object({
        direction: v.picklist(["cited", "citing", "both"]),
        query: v.pipe(v.string(), v.maxLength(2000)),
      }),
    ),
  }).server(async ({ direction, query }) => {
    if (++toolCalls > READER_ANSWER_TOOL_CALLS) {
      return { status: "limit", excerpts: [] };
    }
    const read = await readRelated({
      decisionId: input.decisionId,
      paragraphId: input.paragraphId,
      direction,
      query,
    });
    if (Result.isError(read)) {
      observeFailure(read.error, { sink: CORPUS_FAILURE });
      return { status: "unavailable", excerpts: [] };
    }
    input.onEvidence(
      read.value.map(({ decisionId, paragraphId }) => ({
        decisionId,
        paragraphId,
      })),
    );
    return { status: "read", excerpts: read.value };
  });
  const { processor } = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  let content = "";
  let complete = false;
  let usage: ReaderAnswerUsage | null = null;
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) {
    abort();
  }
  const streamed = await Result.tryPromise({
    try: async () => {
      for await (const chunk of streamRun({
        userId: input.admission.userId,
        admission: input.admission,
        model,
        adapter: textAdapterWithNormalizedStops(model),
        messages: guardModelMessages({
          messages: input.messages,
          workspaceIds: [],
        }),
        abortController: controller,
        agentLoopStrategy: maxIterations(READER_ANSWER_MODEL_STEPS),
        ...chatRequestOptions({
          caching,
          model,
          modelTools: guardModelToolSchemas({
            tools: [related],
            workspaceIds: [],
          }),
          maxOutputTokens: READER_ANSWER_OUTPUT_TOKENS,
          serviceTier: input.metering.serviceTier,
          temperature: getTemperatureForTask("chat"),
          system: redactModelSystemPrompt({
            system: input.system,
            workspaceIds: [],
          }),
        }),
        middleware: [analytics.middleware],
      })) {
        // The shared processor owns SDK event exhaustiveness; only text and terminal
        // events affect this surface's content and durable terminal status.
        processor.processChunk(chunk);
        if (chunk.type === EventType.RUN_STARTED) {
          complete = false;
        }
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          content += chunk.delta;
          input.onDelta(chunk.delta);
        }
        if (
          chunk.type === EventType.RUN_FINISHED ||
          chunk.type === EventType.RUN_ERROR
        ) {
          const stepUsage = tokenUsageFromTerminalChunk(chunk);
          if (stepUsage !== undefined) {
            usage = {
              promptTokens: (usage?.promptTokens ?? 0) + stepUsage.promptTokens,
              completionTokens:
                (usage?.completionTokens ?? 0) + stepUsage.completionTokens,
              totalTokens: (usage?.totalTokens ?? 0) + stepUsage.totalTokens,
            };
          }
        }
        if (chunk.type === EventType.RUN_ERROR) {
          return Result.err(
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: "Reader answer generation failed",
            }),
          );
        }
        if (chunk.type === EventType.RUN_FINISHED) {
          complete =
            finishReasonOf(chunk) === "stop" &&
            runFinishedOutcomeOf(chunk) === "completed";
        }
      }
      if (
        !complete ||
        controller.signal.aborted ||
        content.trim().length === 0
      ) {
        return Result.err(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: "Reader answer generation did not complete",
          }),
        );
      }
      return Result.ok({ content, model: model.modelId, usage });
    },
    catch: (error) => error,
  });
  input.signal.removeEventListener("abort", abort);
  const result = streamed.isErr() ? Result.err(streamed.error) : streamed.value;
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: MODEL_FAILURE });
  }
  return result;
};
