import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import { createPromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import type { WebChatClient } from "@/api/tests/helpers/chat-web-client";
import {
  cassetteFor,
  loadProviderWireCassettes,
  PROVIDER_WIRE_PROVIDERS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type { ProviderWireProvider } from "@/api/tests/helpers/provider-wire-cassette";
import {
  wireOrgAIConfig,
  wireSideModel,
} from "@/api/tests/helpers/provider-wire-contract";
import type { ReplayGate } from "@/api/tests/helpers/provider-wire-gate";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import {
  committedTranscriptFiles,
  loadProviderWireTranscript,
  normalizeOutboundRequest,
  plannedTranscript,
  transcriptPath,
  TRANSCRIPTS_WRITE_ENV,
  transcriptSteps,
} from "@/api/tests/helpers/provider-wire-transcript";
import type {
  ProviderWireTranscript,
  TranscriptPlan,
} from "@/api/tests/helpers/provider-wire-transcript";
import { replayedHarnessModel } from "@/api/tests/helpers/replayed-harness-model";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Conversations through the real send path, the provider's real adapter and
// the web app's chat runtime, held to a two-way transcript per provider
// (`provider-wire-transcript.ts`): what the page does mid-answer (stop,
// approve, deny, lose its connection, queue a message, regenerate) must
// leave the provider with exactly the requests the transcript expects, and
// the thread sound by every oracle the harness runs. Pause points hold an
// answer at a labelled frame so the page can act while the provider is
// mid-answer.
//
// `bun run gen:provider-wire-transcripts` records the expected requests
// again from the current request builder; review the diff.

const cassettes = loadProviderWireCassettes();
const RECORD = process.env[TRANSCRIPTS_WRITE_ENV] === "1";
/** Retried failures wait out each SDK's backoff. */
const SCENARIO_TIMEOUT_MS = 60_000;

const testState = createTestState({ file: import.meta.path, config: env });

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let replay: ProviderWireReplay;
const seededThreadIds: SafeId<"chatThread">[] = [];

testState.beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  testState.setConfig("USE_MOCK_AI", false);
  testState.setEnv(
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid",
  );
  replay = installProviderWireReplay({ retryAfterMs: 1 });
});

afterAll(async () => {
  replay.restore();
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

type ReplayRun = {
  client: WebChatClient;
  gate: ReplayGate;
  harness: ChatHarness;
  /** Every chat-model request the conversation made so far, normalized as
   *  its transcript holds it. */
  sentRequests: () => readonly unknown[];
  threadId: SafeId<"chatThread">;
};

type ReplayScenario = {
  /** Names the approval-gated tool fails on (`failingApprovalNames`). */
  failingApprovalNames?: readonly string[];
  plan: TranscriptPlan;
  run: (conversation: ReplayRun) => Promise<void>;
};

/**
 * Registers `scenario` once per provider, each played against its committed
 * transcript, or recording it under `gen:provider-wire-transcripts`.
 */
const itRunsReplayFixtures = (name: string, scenario: ReplayScenario) => {
  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    test(
      `${provider}: ${name}`,
      async () => {
        await playScenario(name, provider, scenario);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
};

const playScenario = async (
  name: string,
  provider: ProviderWireProvider,
  { failingApprovalNames, plan, run }: ReplayScenario,
) => {
  const transcript: ProviderWireTranscript = RECORD
    ? plannedTranscript({ cassettes, plan, provider, scenario: name })
    : loadProviderWireTranscript({
        cassettes,
        plan,
        provider,
        scenario: name,
      });
  const { gate, mismatches, steps } = transcriptSteps({
    cassettes,
    record: RECORD,
    transcript,
  });
  const prompts = createPromptPrefixLedger();
  const model = replayedHarnessModel({ prompts, provider, replay });
  const harness = createApprovalHarness({
    failingApprovalNames,
    ids,
    model,
    organizationAIConfig: wireOrgAIConfig({
      apiKey: "cassette-replay-no-credentials",
      chatModel: transcript.model,
      provider,
      sideModel: wireSideModel(provider, transcript.model),
    }),
    safeDb,
    scopedDb,
    testDb,
  });
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const client = await harness.openWebClient(threadId);
  // Calls on another model (the thread title) are side calls: when they
  // run races the turn, so they are answered outside the transcript.
  replay.answerSideCalls(cassetteFor(cassettes, provider, "text").exchanges[0]);
  replay.play(transcript.model, steps);
  harness.streamLive(threadId);
  try {
    await run({
      client,
      gate,
      harness,
      sentRequests: () =>
        model
          .sentRequests()
          .filter(({ exchange }) => typeof exchange === "number")
          .map((request) => normalizeOutboundRequest(provider, request)),
      threadId,
    });
    await harness.expectSoundWebClient({ client, threadId });
    const missing = replay.takeTranscriptRemainder();
    const violations = violationsOf(CHAT_ORACLE.providerWireOutbound, [
      ...mismatches.map((mismatch) => ({ mismatch })),
      ...missing.map((step) => ({ missing: step })),
    ]);
    if (violations.length > 0) {
      panic(
        `The conversation left its transcript: ${JSON.stringify(violations)}`,
      );
    }
    expect(gate.unfinished()).toEqual([]);
    if (RECORD) {
      const file = transcriptPath(name, provider);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(transcript, null, 2)}\n`);
    }
  } finally {
    gate.releaseAll();
    replay.takeTranscriptRemainder();
    client.dispose();
    await harness.close();
    replay.answerSideCalls(undefined);
  }
};

// --- What the page sees ---------------------------------------------------------

const isApprovalToolCall = (part: UIMessage["parts"][number]) =>
  part.type === "tool-call" && part.name === APPROVAL_TOOL_NAME;

/** The live view shows the approval-gated tool's call, in any state. */
const showsToolCall = (messages: readonly UIMessage[]) =>
  messages.some(({ parts }) => parts.some(isApprovalToolCall));

/** The live view shows some of the answer's text. */
const showsAnswerText = (messages: readonly UIMessage[]) =>
  messages.some(
    ({ parts, role }) =>
      role === "assistant" &&
      parts.some((part) => part.type === "text" && part.content !== ""),
  );

const storedCallsOf = async (
  harness: ChatHarness,
  threadId: SafeId<"chatThread">,
) =>
  (await harness.readThreadMessages(threadId))
    .flatMap(({ parts }): readonly ChatPart[] => parts)
    .filter(
      (part): part is Extract<ChatPart, { type: "tool-call" }> =>
        part.type === "tool-call" && part.name === APPROVAL_TOOL_NAME,
    );

const send = async (client: WebChatClient, text: string) => {
  await client.sendUserMessage(Bun.randomUUIDv7(), text);
};

// --- The web app's send queue ---------------------------------------------------

const WEB_SEND_QUEUE_URL = new URL(
  "../../../../web/src/features/chat/hooks/use-chat-session-send-queue.logic.ts",
  import.meta.url,
).href;

type QueuedEntry = { id: string; message: { content: string; id: string } };
type SendQueueState = { queue: readonly QueuedEntry[] };
type SendQueueTransition = {
  dispatchedEntry: QueuedEntry | null;
  state: SendQueueState;
};
type SendQueueModule = {
  createInitialSendQueueState: (conversationId: string) => SendQueueState;
  reduceSendQueue: (
    state: SendQueueState,
    event: Record<string, unknown>,
  ) => SendQueueTransition;
};

/** The composer's send queue (`useChatSession`'s reducer), from the web
 *  app itself. */
const loadSendQueue = async (): Promise<SendQueueModule> => {
  const module: unknown = await import(WEB_SEND_QUEUE_URL);
  if (
    typeof module !== "object" ||
    module === null ||
    typeof Reflect.get(module, "reduceSendQueue") !== "function" ||
    typeof Reflect.get(module, "createInitialSendQueueState") !== "function"
  ) {
    return panic("The web send queue no longer exports its reducer");
  }
  return asTestRaw<SendQueueModule>(module);
};

// --- Scenarios ------------------------------------------------------------------

const SCENARIOS = {
  // CHAT_ORACLE.ledgerEffectsAuthorized: a call stopped while its input
  // streams never runs, and the next message settles the thread around it.
  "interrupt-mid-tool": {
    plan: [
      {
        label: "ask",
        inbound: "tool-call",
        pauses: [{ label: "tool-call-streaming", at: "tool-call-open" }],
      },
      { label: "after-stop", inbound: "text" },
    ],
    run: async ({ client, gate, harness, threadId }) => {
      await client.startUserMessage(
        Bun.randomUUIDv7(),
        "Delete the draft",
        showsToolCall,
      );
      await gate.reached("tool-call-streaming");
      await client.stop();
      gate.release("tool-call-streaming");
      await harness.expectSoundWebClient({ client, threadId });
      expect(client.cards()).toEqual([]);
      await send(client, "Thanks");
      await harness.expectSoundWebClient({ client, threadId });
      expect(harness.executions).toEqual([]);
    },
  },
  // The user approves the call; the tool runs once, and its result is
  // stored while the model is still answering from it.
  "approve-mid-tool": {
    plan: [
      { label: "ask", inbound: "tool-call" },
      {
        label: "after-approval",
        inbound: "text",
        pauses: [{ label: "answer-streaming", at: "text-open" }],
      },
      { label: "next-message", inbound: "text" },
    ],
    run: async ({ client, gate, harness, threadId }) => {
      await send(client, "Delete the draft");
      await harness.expectSoundWebClient({ client, threadId });
      const call = pendingApprovalCallOf(
        (await harness.lastAssistant(threadId)).parts,
      );
      const approving = client.approve(call.id, true);
      await gate.reached("answer-streaming");
      await client.waitForMessages(showsAnswerText);
      // Held mid-answer: the tool ran once and the answer is still coming.
      expect(client.runtimeState().requestActive).toBe(true);
      expect(harness.executions).toEqual(["draft"]);
      gate.release("answer-streaming");
      await approving;
      await harness.expectSoundWebClient({ client, threadId });
      expect(await storedCallsOf(harness, threadId)).toMatchObject([
        { output: { deleted: "draft" }, state: "complete" },
      ]);
      await send(client, "Thanks");
      await harness.expectSoundWebClient({ client, threadId });
      expect(harness.executions).toEqual(["draft"]);
    },
  },
  // CHAT_ORACLE.ledgerEffectsAuthorized: a denied write never runs, and the
  // model is told it was denied.
  "deny-write-tool": {
    plan: [
      { label: "ask", inbound: "tool-call" },
      { label: "after-denial", inbound: "text" },
    ],
    run: async ({ client, harness, threadId }) => {
      await send(client, "Delete the draft");
      await harness.expectSoundWebClient({ client, threadId });
      const call = pendingApprovalCallOf(
        (await harness.lastAssistant(threadId)).parts,
      );
      await client.approve(call.id, false);
      await harness.expectSoundWebClient({ client, threadId });
      expect(harness.executions).toEqual([]);
    },
  },
  // CHAT_ORACLE.runOutlivesRequest: the page loses its connection while the
  // call streams; the turn goes on, the page catches up, and the provider
  // is asked nothing twice.
  "reconnect-mid-tool": {
    plan: [
      {
        label: "ask",
        inbound: "tool-call",
        pauses: [{ label: "tool-call-streaming", at: "tool-call-open" }],
      },
      { label: "after-approval", inbound: "text" },
    ],
    run: async ({ client, gate, harness, threadId }) => {
      await client.startUserMessage(
        Bun.randomUUIDv7(),
        "Delete the draft",
        showsToolCall,
      );
      await gate.reached("tool-call-streaming");
      harness.dropConnection(threadId);
      gate.release("tool-call-streaming");
      await client.settle();
      await harness.expectSoundWebClient({ client, threadId });
      const call = pendingApprovalCallOf(
        (await harness.lastAssistant(threadId)).parts,
      );
      await client.approve(call.id, true);
      await harness.expectSoundWebClient({ client, threadId });
      expect(harness.executions).toEqual(["draft"]);
    },
  },
  // A regenerate after a stop asks the model the original question again,
  // with nothing of the stopped answer in it.
  "regenerate-after-interrupt": {
    plan: [
      {
        label: "ask",
        inbound: "tool-call",
        pauses: [{ label: "tool-call-streaming", at: "tool-call-open" }],
      },
      { label: "regenerate", inbound: "text" },
    ],
    run: async ({ client, gate, harness, sentRequests, threadId }) => {
      await client.startUserMessage(
        Bun.randomUUIDv7(),
        "Delete the draft",
        showsToolCall,
      );
      await gate.reached("tool-call-streaming");
      await client.stop();
      gate.release("tool-call-streaming");
      await harness.expectSoundWebClient({ client, threadId });
      await client.resend();
      await harness.expectSoundWebClient({ client, threadId });
      expect(harness.executions).toEqual([]);
      const [ask, regenerate] = sentRequests();
      expect(regenerate).toEqual(ask);
    },
  },
  // A message queued while the answer streams and cancelled before the turn
  // ends is never sent: the provider is asked nothing after the turn.
  "queued-send-cancelled": {
    plan: [
      {
        label: "ask",
        inbound: "text",
        pauses: [{ label: "answer-streaming", at: "text-open" }],
      },
      { label: "next-message", inbound: "text" },
    ],
    run: async ({ client, gate, harness, threadId }) => {
      const { createInitialSendQueueState, reduceSendQueue } =
        await loadSendQueue();
      await client.startUserMessage(
        Bun.randomUUIDv7(),
        "Summarize the draft",
        showsAnswerText,
      );
      await gate.reached("answer-streaming");
      expect(client.runtimeState().requestActive).toBe(true);
      let queue = createInitialSendQueueState(threadId);
      queue = reduceSendQueue(queue, {
        type: "turn-boundary-checked",
        isGenerating: true,
        status: "streaming",
      }).state;
      const queuedId = Bun.randomUUIDv7();
      const queuedText = "Also list the parties";
      queue = reduceSendQueue(queue, {
        type: "message-enqueued",
        entry: {
          id: queuedId,
          text: queuedText,
          fileCount: 0,
          message: { content: queuedText, id: queuedId },
        },
      }).state;
      queue = reduceSendQueue(queue, {
        type: "queued-message-removed",
        id: queuedId,
      }).state;
      gate.release("answer-streaming");
      await client.settle();
      const boundary = reduceSendQueue(queue, {
        type: "turn-boundary-checked",
        isGenerating: false,
        status: "ready",
      });
      // Whatever the queue hands back is sent, as `useChatSession` does, so
      // a cancelled message that still went out meets the transcript.
      if (boundary.dispatchedEntry !== null) {
        await client.sendUserMessage(
          boundary.dispatchedEntry.message.id,
          boundary.dispatchedEntry.message.content,
        );
      }
      await harness.expectSoundWebClient({ client, threadId });
      await send(client, "Thanks");
      await harness.expectSoundWebClient({ client, threadId });
    },
  },
  // Two calls in one step, both approved; one fails. The model is handed
  // one result and one failure, each on its own call.
  "parallel-tools-one-fails": {
    failingApprovalNames: ["memo"],
    plan: [
      { label: "ask", inbound: "parallel-tool-calls" },
      { label: "after-approvals", inbound: "text" },
    ],
    run: async ({ client, harness, threadId }) => {
      await send(client, "Delete the draft and the memo");
      await harness.expectSoundWebClient({ client, threadId });
      const calls = await storedCallsOf(harness, threadId);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        await client.approve(call.id, true);
      }
      await harness.expectSoundWebClient({ client, threadId });
      expect(harness.executions.toSorted()).toEqual(["draft", "memo"]);
      const settled = await storedCallsOf(harness, threadId);
      expect(
        settled.find(({ input }) => isNamed(input, "draft")),
      ).toMatchObject({ output: { deleted: "draft" }, state: "complete" });
      expect(
        JSON.stringify(settled.find(({ input }) => isNamed(input, "memo"))),
      ).toContain("could not delete memo");
    },
  },
} as const satisfies Record<string, ReplayScenario>;

const isNamed = (input: unknown, name: string) =>
  typeof input === "object" &&
  input !== null &&
  Reflect.get(input, "name") === name;

describe("two-way provider transcripts through the chat pipeline", () => {
  // A recording writes the files this compares.
  test.skipIf(RECORD)(
    "every committed transcript belongs to a scenario and provider",
    () => {
      const expected = Object.keys(SCENARIOS)
        .flatMap((scenario) =>
          PROVIDER_WIRE_PROVIDERS.map(
            (provider) => `${scenario}/${provider}.json`,
          ),
        )
        .toSorted();
      expect(committedTranscriptFiles().toSorted()).toEqual(expected);
    },
  );

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    itRunsReplayFixtures(name, scenario);
  }
});
