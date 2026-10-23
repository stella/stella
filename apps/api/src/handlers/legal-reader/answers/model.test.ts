import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import type {
  ServerAnalytics,
  ServerAnalyticsCaptureParams,
} from "@/api/lib/analytics/server-analytics";
import { createSafeId } from "@/api/lib/branded-types";
import { ReaderAnswerCorpusError } from "@/api/lib/case-law/reader-answer-corpus";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

import { runReaderAnswerModel } from "./model";
import type { ReaderAnswerModelInput } from "./model";

type FixtureMode =
  "tools" | "error" | "length" | "missing-terminal" | "empty" | "success";
type AdapterFixtureOptions = {
  mode: FixtureMode;
  turns: number[];
  toolCalls: number;
  toolResults: unknown[];
};

/** Real SDK engine, fixture transport: no provider API or module mock. */
const adapterFixture = ({
  mode,
  turns,
  toolCalls,
  toolResults,
}: AdapterFixtureOptions) =>
  ({
    kind: "text",
    name: "reader-fixture",
    model: "gpt-5.5",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream({ runId, threadId, messages }) {
      const iteration = turns.length + 1;
      turns.push(iteration);
      const run = {
        runId: runId ?? "fixture-run",
        threadId: threadId ?? "fixture-thread",
      };
      yield { type: EventType.RUN_STARTED, ...run } satisfies StreamChunk;
      if (mode === "error") {
        yield {
          type: EventType.RUN_ERROR,
          message: "Fixture provider failure",
          code: "fixture",
        } satisfies StreamChunk;
        return;
      }
      const messageId = `fixture-message-${iteration}`;
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      } satisfies StreamChunk;
      if (mode !== "empty") {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta:
            iteration === 1 && mode === "tools" ? "Context. " : "Explained.",
        } satisfies StreamChunk;
      }
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      } satisfies StreamChunk;
      if (mode === "missing-terminal") {
        return;
      }
      if (mode === "tools" && iteration === 1) {
        for (let index = 0; index < toolCalls; index++) {
          const toolCallId = `fixture-call-${index}`;
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: "related_decision_paragraphs",
          } satisfies StreamChunk;
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: JSON.stringify({
              direction: "both",
              query: `liability ${index}`,
            }),
          } satisfies StreamChunk;
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId,
          } satisfies StreamChunk;
        }
      }
      if (mode === "tools" && iteration === 2) {
        for (const message of messages) {
          if (message.role !== "tool" || typeof message.content !== "string") {
            continue;
          }
          toolResults.push(JSON.parse(message.content));
        }
        // Assert the model receives all tool results including the explicit cap result.
        expect(messages.filter(({ role }) => role === "tool")).toHaveLength(
          toolCalls,
        );
        if (toolCalls > 3) {
          expect(
            messages.some(
              ({ role, content }) =>
                role === "tool" &&
                typeof content === "string" &&
                content.includes('"status":"limit"'),
            ),
          ).toBe(true);
        }
      }
      let finishReason: Extract<
        StreamChunk,
        { type: "RUN_FINISHED" }
      >["finishReason"] = "stop";
      if (mode === "length") {
        finishReason = "length";
      }
      if (mode === "tools" && iteration === 1) {
        finishReason = "tool_calls";
      }
      yield {
        type: EventType.RUN_FINISHED,
        ...run,
        finishReason,
        usage: {
          promptTokens: iteration * 10,
          completionTokens: iteration * 2,
          totalTokens: iteration * 12,
        },
      } satisfies StreamChunk;
    },
    structuredOutput: () => {
      throw new HandlerError({
        status: 500,
        message: "Structured fixture output is unavailable",
      });
    },
  }) satisfies AnyTextAdapter;

const inputFixture = () => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  return {
    admission: testModelAdmission(organizationId, "chat.send"),
    signal: new AbortController().signal,
    answerId: createSafeId<"legalReaderAnswer">(),
    decisionId: createSafeId<"caseLawDecision">(),
    paragraphId: "paragraph-1",
    system: "Explain in cs-CZ using the provided evidence.",
    messages: [{ role: "user", content: "Explain civil liability." }],
    modelId: "gpt-5.5",
    orgAIConfig: null,
    managedAIResidency: "eu",
    metering: {
      organizationId,
      userId,
      actionType: "chat",
      serviceTier: "standard",
      workspaceId: null,
      safeDb: async (_run) =>
        Result.err(
          new DatabaseError({
            message: "Fixture tenant database is unavailable",
          }),
        ),
    },
    onDelta: () => undefined,
    onEvidence: () => undefined,
  } satisfies ReaderAnswerModelInput;
};

type ModelFixtureOptions = {
  mode: FixtureMode;
  toolCalls?: number;
  keySource?: "byok" | "instance";
};
const modelFixture = ({
  mode,
  toolCalls = 4,
  keySource = "instance",
}: ModelFixtureOptions) => {
  const turns: number[] = [];
  const toolResults: unknown[] = [];
  const events: ServerAnalyticsCaptureParams[] = [];
  const model = {
    adapter: adapterFixture({ mode, turns, toolCalls, toolResults }),
    keySource,
    modelId: "gpt-5.5",
    modelOptions: {},
    provider: "openai",
  } satisfies ResolvedTanStackTextModel;
  const analytics = {
    capture: (event) => {
      events.push(event);
    },
    identifyOrganizationGroup: () => undefined,
    flush: async () => undefined,
  } satisfies ServerAnalytics;
  return { model, turns, toolResults, events, analytics };
};

describe("reader answer real SDK model boundary", () => {
  test("a multi-turn tool cycle keeps streamed content, evidence and total usage", async () => {
    const input = inputFixture();
    const fixture = modelFixture({ mode: "tools" });
    const deltas: string[] = [];
    const evidence: unknown[] = [];
    let reads = 0;
    const result = await runReaderAnswerModel(
      {
        ...input,
        onDelta: (delta) => {
          deltas.push(delta);
        },
        onEvidence: (citations) => {
          evidence.push(citations);
        },
      },
      {
        resolveModel: async (options) => {
          expect(options.admission).toBe(input.admission);
          expect(options.organizationId).toBe(input.metering.organizationId);
          if (options.dataClass !== "customer") {
            throw new HandlerError({
              status: 500,
              message: "Expected customer policy",
            });
          }
          expect(options.managedAIResidency).toBe("eu");
          expect(options.dataClass).toBe("customer");

          return fixture.model;
        },
        analytics: fixture.analytics,
        readRelated: async (options) => {
          reads++;
          expect(options.decisionId).toBe(input.decisionId);
          expect(options.paragraphId).toBe(input.paragraphId);
          return Result.ok([
            {
              decisionId: input.decisionId,
              direction: "cited",
              decisionDate: "2026-01-01",
              court: "Test court",
              paragraphId: "related-1",
              text: "Liability precedent",
            },
          ]);
        },
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(fixture.turns).toEqual([1, 2]);
    expect(reads).toBe(3);
    expect(fixture.toolResults).toEqual([
      ...Array.from({ length: 3 }, () => ({
        status: "read",
        excerpts: [
          {
            decisionId: input.decisionId,
            direction: "cited",
            decisionDate: "2026-01-01",
            court: "Test court",
            paragraphId: "related-1",
            text: "Liability precedent",
          },
        ],
      })),
      { status: "limit", excerpts: [] },
    ]);
    expect(evidence).toHaveLength(3);
    for (const citations of evidence) {
      expect(citations).toEqual([
        { decisionId: input.decisionId, paragraphId: "related-1" },
      ]);
    }
    expect(result.value.content).toBe(deltas.join(""));
    expect(result.value.content).toBe("Context. Explained.");
    expect(result.value.model).toBe("gpt-5.5");
    expect(result.value.usage).toEqual({
      promptTokens: 30,
      completionTokens: 6,
      totalTokens: 36,
    });
  });

  test("BYOK selection and metering are passed to the existing resolver and analytics", async () => {
    const input = inputFixture();
    const orgAIConfig = {
      providers: [{ provider: "openai", apiKey: "fixture-only" }],
      overrideModels: { chat: { provider: "openai", modelId: "gpt-5.5" } },
      decision: null,
    } satisfies OrgAIConfig;
    const fixture = modelFixture({ mode: "success", keySource: "byok" });
    let resolved = false;
    let meteringAttempts = 0;
    const run = runReaderAnswerModel(
      {
        ...input,
        orgAIConfig,
        metering: {
          ...input.metering,
          safeDb: async (transactionCallback) => {
            meteringAttempts++;
            return input.metering.safeDb(transactionCallback);
          },
        },
      },
      {
        resolveModel: async (options) => {
          resolved = true;
          expect(options.orgAIConfig).toBe(orgAIConfig);
          expect(options.modelId).toBe(input.modelId);
          return fixture.model;
        },
        analytics: fixture.analytics,
      },
    );
    const result = await run;
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value.content).toBe("Explained.");
    expect(resolved).toBe(true);
    expect(meteringAttempts).toBe(1);
    const completed = fixture.events.find(
      ({ event }) => event === SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
    );
    expect(completed).toBeDefined();
    if (completed?.event === SERVER_ANALYTICS_EVENTS.aiGenerationCompleted) {
      expect(completed.properties.model_key_source).toBe("byok");
      expect(completed.groups?.organization).toBe(
        input.metering.organizationId,
      );
    }
  });

  test("a recoverable corpus failure lets the model finish without invented evidence", async () => {
    const input = inputFixture();
    const fixture = modelFixture({ mode: "tools", toolCalls: 1 });
    const evidence: unknown[] = [];
    const failure = new ReaderAnswerCorpusError({
      message: "Fixture corpus unavailable",
      cause: null,
    });
    const result = await runReaderAnswerModel(
      {
        ...input,
        onEvidence: (citations) => {
          evidence.push(citations);
        },
      },
      {
        resolveModel: async () => fixture.model,
        analytics: fixture.analytics,
        readRelated: async () => Result.err(failure),
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value.content).toBe("Context. Explained.");
    expect(evidence).toEqual([]);
    expect(fixture.turns).toEqual([1, 2]);
  });

  for (const modelId of [undefined, "us.deepseek.r1-v1:0"]) {
    test(`unsupported ${modelId === undefined ? "default" : "selected"} model is rejected before streaming`, async () => {
      const fixture = modelFixture({ mode: "success" });
      const run = runReaderAnswerModel(
        { ...inputFixture(), modelId },
        {
          resolveModel: async () => ({
            ...fixture.model,
            modelId: "us.deepseek.r1-v1:0",
          }),
          analytics: fixture.analytics,
        },
      );
      const result = await run;
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          status: 400,
          message:
            "Choose a model that supports streaming tools for reader answers",
        });
      }
      expect(fixture.turns).toEqual([]);
      expect(fixture.events).toEqual([]);
    });
  }

  for (const mode of [
    "error",
    "length",
    "missing-terminal",
    "empty",
  ] as const) {
    test(`${mode} generation cannot become a complete persisted answer`, async () => {
      const fixture = modelFixture({ mode });
      const run = runReaderAnswerModel(inputFixture(), {
        resolveModel: async () => fixture.model,
        analytics: fixture.analytics,
      });
      const result = await run;
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          message:
            mode === "error"
              ? "Reader answer generation failed"
              : "Reader answer generation did not complete",
        });
      }
      expect(fixture.turns).toEqual([1]);
    });
  }

  test("a later started run must finish before earlier content can count as complete", async () => {
    const fixture = modelFixture({ mode: "empty" });
    const run = runReaderAnswerModel(inputFixture(), {
      resolveModel: async () => fixture.model,
      analytics: fixture.analytics,
      async *streamRun() {
        yield {
          type: EventType.RUN_STARTED,
          runId: "first",
          threadId: "thread",
        };
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "message",
          role: "assistant",
        };
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message",
          delta: "Earlier answer",
        };
        yield { type: EventType.TEXT_MESSAGE_END, messageId: "message" };
        yield {
          type: EventType.RUN_FINISHED,
          runId: "first",
          threadId: "thread",
          metadata: { tanstack: { finishReason: "stop" } },
        };
        yield {
          type: EventType.RUN_STARTED,
          runId: "second",
          threadId: "thread",
        };
      },
    });
    const result = await run;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        message: "Reader answer generation did not complete",
      });
    }
  });
});
