import { chat, EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  processServerChatStream,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import type { StreamChatFinishEvent } from "@/api/handlers/chat/stream-chat";
import { createChatMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import { createPromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import {
  instanceWireErrorModel,
  providerCallErrorCassettes,
  providerCallErrorSentinel,
} from "@/api/tests/helpers/provider-call-error-wire";
import {
  cassetteFor,
  loadProviderWireCassettes,
  PROVIDER_WIRE_PROVIDERS,
  WIRE_TOOL_NAME,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireProvider,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  wireOrgAIConfig,
  wireSideModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { replayedHarnessModel } from "@/api/tests/helpers/replayed-harness-model";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The whole chat pipeline on recorded provider responses: the web app's chat
// runtime posts to the real send handler, which resolves the organization's
// real provider adapter, and the adapter's SDK is answered from the provider
// wire corpus through `fetch`. Every oracle the scripted conversations are
// held to (stored thread, wire, live view against a reload, the provider's
// queue) runs after each step, so what a provider actually sends has to
// survive every layer above the adapter, not only the adapter.

const cassettes = loadProviderWireCassettes();

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let replay: ProviderWireReplay;
let previousMockAI: typeof env.USE_MOCK_AI;
let previousBedrockEndpoint: string | undefined;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  previousMockAI = env.USE_MOCK_AI;
  env.USE_MOCK_AI = false;
  previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
  replay = installProviderWireReplay({ retryAfterMs: 1 });
});

afterAll(async () => {
  replay.restore();
  env.USE_MOCK_AI = previousMockAI;
  if (previousBedrockEndpoint === undefined) {
    delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  } else {
    process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = previousBedrockEndpoint;
  }
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

/** A thread whose chat model is the one `cassette` was recorded with. */
const openThread = async (cassette: ProviderWireCassette) => {
  const { model, provider } = cassette;
  const prompts = createPromptPrefixLedger();
  const harness = createApprovalHarness({
    ids,
    model: replayedHarnessModel({ prompts, provider, replay }),
    organizationAIConfig: wireOrgAIConfig({
      apiKey: "cassette-replay-no-credentials",
      chatModel: model,
      provider,
      sideModel: wireSideModel(provider, model),
    }),
    safeDb,
    scopedDb,
    testDb,
  });
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const client = await harness.openWebClient(threadId);
  return { client, harness, prompts, threadId };
};

/** The provider's text answer, for the model's next call and for side calls
 *  (the thread title) on another model. */
const textAnswer = (provider: ProviderWireProvider): ProviderWireCassette =>
  cassetteFor(cassettes, provider, "text");

const storedCall = (
  messages: readonly { parts: readonly ChatPart[] }[],
  toolCallId: string,
) =>
  messages
    .flatMap(({ parts }) => parts)
    .find((part) => part.type === "tool-call" && part.id === toolCallId);

/** Retried failures wait out each SDK's backoff. */
const RETRY_TIMEOUT_MS = 60_000;

/**
 * The model asks for the approval-gated tool, the page approves its card,
 * the tool runs, and the model answers. A strict provider's call carries the
 * widened `null` on the wire.
 */
const approveToolCall = async (provider: ProviderWireProvider) => {
  const toolCall = cassetteFor(cassettes, provider, "tool-call");
  // The answer continues the same conversation, on the same model.
  expect(textAnswer(provider).model).toBe(toolCall.model);
  const { client, harness, prompts, threadId } = await openThread(toolCall);
  try {
    replay.answerSideCalls(textAnswer(provider).exchanges[0]);
    replay.serve(toolCall);
    await client.sendUserMessage(Bun.randomUUIDv7(), "Delete the draft");
    await harness.expectSoundWebClient({ client, threadId });

    const pending = await harness.lastAssistant(threadId);
    const call = pendingApprovalCallOf(pending.parts);
    // The stored call holds the input as declared, on every copy.
    expect(call.input).toEqual({ name: "draft" });
    expect(JSON.parse(call.arguments)).toEqual({ name: "draft" });

    replay.enqueue(textAnswer(provider));
    await client.approve(call.id, true);
    await harness.expectSoundWebClient({ client, threadId });

    expect(harness.executions).toEqual(["draft"]);
    expect(
      storedCall(await harness.readThreadMessages(threadId), call.id),
    ).toMatchObject({ output: { deleted: "draft" }, state: "complete" });

    // The next message's request rebuilds the call and its result from the
    // stored thread, and must still extend what the continuation sent.
    replay.enqueue(textAnswer(provider));
    await client.sendUserMessage(Bun.randomUUIDv7(), "Thanks");
    await harness.expectSoundWebClient({ client, threadId });
    expect(prompts.calls()).toBe(3);
  } finally {
    client.dispose();
    await harness.close();
    replay.answerSideCalls(undefined);
  }
};

/** A turn the provider rate-limits fails and settles as the page shows it. */
const rateLimitedTurn = async (provider: ProviderWireProvider) => {
  const rateLimit = cassetteFor(cassettes, provider, "rate-limit");
  const { client, harness, threadId } = await openThread(rateLimit);
  try {
    replay.serve(rateLimit);
    await client.sendUserMessage(Bun.randomUUIDv7(), "Delete the draft");
    const violations = await harness.checkWebClient({
      client,
      expected: { runFailure: true },
      threadId,
    });
    if (violations.length > 0) {
      panic(`The thread breaks an invariant: ${JSON.stringify(violations)}`);
    }
    expect(harness.executions).toEqual([]);
  } finally {
    client.dispose();
    await harness.close();
  }
};

describe("a replayed provider through the chat pipeline", () => {
  test("offers the wire tool under the harness's approval tool name", () => {
    expect(WIRE_TOOL_NAME).toBe(APPROVAL_TOOL_NAME);
  });

  test.each(providerCallErrorCassettes())(
    "provider failure persists and streams its kind with $scenario/$variant",
    async (cassette) => {
      const { client, harness, threadId } = await openThread(cassette);
      const analytics = installRecordingAnalytics();
      const logs = installRecordingLogger();
      try {
        const recording = harness.recordThread(threadId);
        replay.serve(cassette);
        await client.sendUserMessage(Bun.randomUUIDv7(), "Draft a memo");
        const violations = await harness.checkWebClient({
          client,
          expected: { runFailure: true },
          threadId,
        });
        expect(violations).toEqual([]);
        const stored = await harness.readThreadMessages(threadId);
        const assistant = await harness.lastAssistant(threadId);
        if (cassette.expect.outcome !== "error") {
          throw new TypeError("The fixture has an error outcome");
        }
        expect(JSON.stringify(assistant)).toContain(cassette.expect.errorKind);
        expect(recording).toHaveLength(1);
        expect(recording.at(0)?.response.body).toContain(
          cassette.expect.errorKind,
        );
        expect(logs.records.length).toBeGreaterThan(0);
        expect(analytics.exceptions()).toEqual([]);
        const sentinel = providerCallErrorSentinel(cassette);
        // The provider's raw reply never reaches logs, product analytics or
        // the error tracker.
        expect(
          JSON.stringify({
            logs: logs.records,
            analytics: analytics.events,
          }),
        ).not.toContain(sentinel);
        // The reader keeps the provider's reason, redacted, as part of the
        // turn: in the thread's own stored message content, the column that
        // holds its text, and in the stream that settled the turn. Nowhere
        // else in either does the reply appear.
        const outcome = assistant.metadata?.turnOutcome;
        const kept =
          outcome?.type === "failed"
            ? outcome.providerDiagnostic?.message
            : undefined;
        const withoutKept = (text: string) =>
          kept === undefined
            ? text
            : text.replaceAll(JSON.stringify(kept).slice(1, -1), "");
        expect(withoutKept(JSON.stringify(stored))).not.toContain(sentinel);
        expect(withoutKept(recording.at(0)?.response.body ?? "")).not.toContain(
          sentinel,
        );
      } finally {
        logs.restore();
        analytics.restore();
        client.dispose();
        await harness.close();
      }
    },
    RETRY_TIMEOUT_MS,
  );

  test.each(["rich", "spec"] as const)(
    "preserves %s usage attached to a replayed provider run error without provider text",
    async (shape) => {
      const cassette = providerCallErrorCassettes().at(0);
      if (cassette === undefined) {
        panic("The provider error corpus is non-empty");
      }
      const sentinel = providerCallErrorSentinel(cassette);
      const counts = { promptTokens: 24, completionTokens: 2, totalTokens: 26 };
      const details = {
        completionTokensDetails: { reasoningTokens: 1 },
        providerUsageDetails: { message: sentinel },
      };
      const events: StreamChatFinishEvent[] = [];
      const output: StreamChunk[] = [];
      let responseMessage: ChatMessage | null = null;
      const processor = new StreamProcessor({
        events: {
          onStreamEnd: (message) => {
            responseMessage = toChatMessage(message);
          },
        },
      });
      const logs = installRecordingLogger();
      const analytics = installRecordingAnalytics();
      try {
        replay.serve(cassette);
        // This adapter omits usage on errors. Attach the two documented SDK
        // shapes to its real wire error to exercise the persistence boundary.
        const source = async function* (): AsyncIterable<StreamChunk> {
          for await (const chunk of chat({
            adapter: instanceWireErrorModel(cassette.model).adapter,
            messages: [{ role: "user", content: "Draft a memo" }],
          })) {
            if (chunk.type !== EventType.RUN_ERROR) {
              yield chunk;
              continue;
            }
            expect(JSON.stringify(chunk)).toContain(sentinel);
            yield shape === "rich"
              ? { ...chunk, usage: { ...counts, ...details } }
              : {
                  ...chunk,
                  usage: [
                    {
                      inputTokens: 24,
                      outputTokens: 2,
                      totalTokens: 26,
                      provider: sentinel,
                    },
                  ],
                  metadata: { tanstack: { usage: details }, message: sentinel },
                };
          }
        };
        for await (const chunk of processServerChatStream({
          abortSignal: new AbortController().signal,
          deadlineSignal: new AbortController().signal,
          getResponseMessage: () => responseMessage,
          initialMessages: [],
          mapMessageId: createChatMessageIdMapper(() =>
            toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          ),
          onFinish: (event) => {
            events.push(event);
          },
          processor,
          source: source(),
        })) {
          output.push(chunk);
        }
        expect(events).toHaveLength(1);
        expect(events.at(0)?.responseMessage.metadata).toMatchObject({
          usage: { ...counts, completionTokensDetails: { reasoningTokens: 1 } },
        });
        expect(events.at(0)?.outcome).toMatchObject({ type: "failed" });
        expect(
          output.find((chunk) => chunk.type === EventType.RUN_ERROR)?.usage,
        ).toMatchObject(counts);
        expect(
          JSON.stringify({
            events,
            output,
            logs: logs.records,
            analytics: analytics.events,
          }),
        ).not.toContain(sentinel);
        expect(replay.takeFindings()).toMatchObject({
          unconsumed: [],
          unexpected: [],
        });
      } finally {
        logs.restore();
        analytics.restore();
      }
    },
    RETRY_TIMEOUT_MS,
  );

  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    test(
      `${provider}: a tool call reaches its card, runs once approved, and the answer reloads`,
      async () => {
        await approveToolCall(provider);
      },
      RETRY_TIMEOUT_MS,
    );

    test(
      `${provider}: a rate-limited turn fails, settles, and reloads as the page shows it`,
      async () => {
        await rateLimitedTurn(provider);
      },
      RETRY_TIMEOUT_MS,
    );
  }
});
