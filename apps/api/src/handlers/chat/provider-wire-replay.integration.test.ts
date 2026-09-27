import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import {
  APPROVAL_TOOL_NAME,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import type { HarnessModel } from "@/api/tests/helpers/chat-approval-harness";
import {
  createPromptPrefixLedger,
  wirePromptBlocksOf,
} from "@/api/tests/helpers/chat-prompt-prefix";
import type {
  PromptPrefixLedger,
  WirePromptSections,
} from "@/api/tests/helpers/chat-prompt-prefix";
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
let previousMockAI: boolean;
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
  replay = installProviderWireReplay();
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

const entriesOf = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

/** Where each provider's request body holds its tools, system prompt and
 *  messages. */
const WIRE_PROMPT_SECTIONS = {
  anthropic: (body) => ({
    messages: entriesOf(body["messages"]),
    system: entriesOf(body["system"]),
    tools: entriesOf(body["tools"]),
  }),
  bedrock: (body) => ({
    messages: entriesOf(body["messages"]),
    system: entriesOf(body["system"]),
    tools: entriesOf(
      isRecord(body["toolConfig"]) ? body["toolConfig"]["tools"] : undefined,
    ),
  }),
  google: (body) => ({
    messages: entriesOf(body["contents"]),
    system: entriesOf(body["systemInstruction"]),
    tools: entriesOf(body["tools"]),
  }),
  // The system prompt is the first message.
  mistral: (body) => ({
    messages: entriesOf(body["messages"]),
    system: [],
    tools: entriesOf(body["tools"]),
  }),
  openai: (body) => ({
    messages: entriesOf(body["input"]),
    system: entriesOf(body["instructions"]),
    tools: entriesOf(body["tools"]),
  }),
  openrouter: (body) => ({
    messages: entriesOf(body["messages"]),
    system: [],
    tools: entriesOf(body["tools"]),
  }),
} as const satisfies Record<
  ProviderWireProvider,
  (body: Record<string, unknown>) => WirePromptSections
>;

/** The harness's model seam, answered by the replay: its queue is the
 *  conversation's script. Every request the chat model answered is held to
 *  `chat.provider.prefix-stable` as its SDK wrote it. */
const replayedModel = ({
  prompts,
  provider,
}: {
  prompts: PromptPrefixLedger;
  provider: ProviderWireProvider;
}): HarnessModel => {
  /** How many of the replay's requests `prompts` holds. */
  let recorded = 0;
  const recordNewRequests = () => {
    const requests = replay.requests();
    for (const { body, exchange } of requests.slice(recorded)) {
      // Side calls go to another model; a refused request reached no one.
      if (typeof exchange !== "number") {
        continue;
      }
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) {
        panic("A chat request body is a JSON object");
      }
      prompts.record(
        wirePromptBlocksOf(WIRE_PROMPT_SECTIONS[provider](parsed)),
      );
    }
    recorded = requests.length;
  };
  return {
    modelOptionsOf: () => [],
    promptsOf: () => {
      recordNewRequests();
      return prompts;
    },
    restore: () => undefined,
    script: (_threadId, ...runs) => {
      expect(runs).toEqual([]);
    },
    stalled: async () => {
      await Promise.reject(
        new TypeError("A replayed provider does not stall on cue"),
      );
    },
    takeFindings: () => {
      recordNewRequests();
      // Taking the replay's findings clears its requests.
      const { unconsumed, unexpected } = replay.takeFindings();
      recorded = 0;
      return { unconsumedScripts: unconsumed, unscriptedCalls: unexpected };
    },
  };
};

/** A thread whose chat model is the one `cassette` was recorded with. */
const openThread = async (cassette: ProviderWireCassette) => {
  const { model, provider } = cassette;
  const prompts = createPromptPrefixLedger();
  const harness = createApprovalHarness({
    ids,
    model: replayedModel({ prompts, provider }),
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
    harness.close();
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
    harness.close();
  }
};

describe("a replayed provider through the chat pipeline", () => {
  test("offers the wire tool under the harness's approval tool name", () => {
    expect(WIRE_TOOL_NAME).toBe(APPROVAL_TOOL_NAME);
  });

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
