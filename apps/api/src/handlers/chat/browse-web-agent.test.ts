import { EventType, StreamProcessor } from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ChatMiddleware,
  ModelMessage,
  RunAgentResumeItem,
  StreamChunk,
  UIMessage,
} from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  BROWSE_WEB_TOOL_NAME,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_TOOL_NAME,
} from "@stll/api-contract/browser-control";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import { memberWaitsOf } from "@stll/api-contract/chat-member-wait";
import { CHAT_TURN_BUDGET, type ChatTurnBudget } from "@stll/chat-limits";

import type { SafeDb } from "@/api/db/safe-db";
import {
  BROWSE_WEB_RESULT_MAX_CHARS,
  browseWebResultsForModel,
  createBrowseWebAgent,
  prepareSuspendedBrowseRuns,
  type SuspendedBrowseRuns,
} from "@/api/handlers/chat/browse-web-agent";
import {
  cancelPendingChatToolCalls,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { validateMessage } from "@/api/handlers/chat/chat-schema";
import { createChatTurnBudget } from "@/api/handlers/chat/chat-turn-budget";
import { createBrowserControlTool } from "@/api/handlers/chat/tools/browser-control-tool";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type {
  ChatMessage,
  ChatPart,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { tokenUsageFromTerminalChunk } from "@/api/lib/tanstack-ai-usage";
import { diffLiveAgainstReload } from "@/api/tests/helpers/chat-live-reload-invariants";
import {
  scriptedAdapterBase,
  type ScriptedTurn,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { pageResult } from "@/api/tests/helpers/subagent-part-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The browsing sub-agent through the real SDK runtime: the main model calls
// `browse_web`, its child runs on its own model with `use-browser`, pauses on
// the approval and on the browser's answer exactly as a top-level call does,
// and the main model reads back only the child's text. The page the browser
// returns reaches the child and never the main model.

const ORGANIZATION = toSafeId<"organization">(
  "019eb9fa-c91f-7000-9b9c-9365977dda91",
);
const USER = toSafeId<"user">("019eb9fa-c91f-7000-9b9c-9365977dda92");
const THREAD = toSafeId<"chatThread">("019eb9fa-c91f-7000-9b9c-9365977dda93");
const PAGE_LABEL = "fees";
const PAGE_URL = `https://example.cz/${PAGE_LABEL}`;
/** Text only the page itself holds (`pageResult`). */
const PAGE_TEXT = `Stránka ${PAGE_LABEL}`;
const BROWSE_CALL = "call-browse";
const OPEN_CALL = "call-open";

/** A scripted model that records the messages of each request it gets. */
const recordingModel = (turns: readonly ScriptedTurn[]) => {
  const requests: ModelMessage[][] = [];
  let index = 0;
  const adapter: AnyTextAdapter = {
    ...scriptedAdapterBase,
    async *chatStream({ messages, model, runId, threadId }) {
      requests.push(structuredClone(messages));
      const current = index;
      index += 1;
      yield* scriptedTurnChunks(
        turns.at(current) ?? panic("The scripted model ran out of turns"),
        {
          index: current,
          model,
          runId: runId ?? "run",
          threadId,
        },
      );
    },
    structuredOutput: () => panic("No structured output in this test"),
  };
  return { adapter, requests };
};

const PARENT_CALL_USAGE = {
  completionTokens: 4,
  promptTokens: 50,
  totalTokens: 54,
};
const PARENT_USAGE = {
  completionTokens: 5,
  promptTokens: 100,
  totalTokens: 105,
};
const CHILD_STEP_USAGE = {
  completionTokens: 2,
  promptTokens: 7,
  totalTokens: 9,
};
const CHILD_ANSWER_USAGE = {
  completionTokens: 3,
  promptTokens: 20,
  totalTokens: 23,
};

/** A live part as the turn stores it. */
const persistedPart = (part: UIMessage["parts"][number]) => {
  const decision = classifyChatPartForPersistence(part);
  return decision.type === "persist"
    ? decision.part
    : panic(`The ${decision.partType} part was dropped`);
};

const browseScenario = (caps: ChatTurnBudget = CHAT_TURN_BUDGET) => {
  const parent = recordingModel([
    {
      arguments: JSON.stringify({ task: "Find the filing fee on example.cz." }),
      toolCallId: BROWSE_CALL,
      toolName: BROWSE_WEB_TOOL_NAME,
      type: "tool-call",
      usage: PARENT_CALL_USAGE,
    },
    {
      finishReason: "stop",
      text: "The filing fee is 10 EUR.",
      type: "text",
      usage: PARENT_USAGE,
    },
  ]);
  const child = recordingModel([
    {
      arguments: JSON.stringify({ action: "open", url: PAGE_URL }),
      toolCallId: OPEN_CALL,
      toolName: BROWSER_CONTROL_TOOL_NAME,
      type: "tool-call",
      usage: CHILD_STEP_USAGE,
    },
    {
      finishReason: "stop",
      text: "Filing fee: 10 EUR.",
      type: "text",
      usage: CHILD_ANSWER_USAGE,
    },
  ]);
  const childModel = asTestRaw<ResolvedTanStackTextModel>({
    adapter: child.adapter,
    keySource: "instance",
    modelId: "browse-model",
    modelOptions: {},
    provider: "openai",
  });
  const metered: number[] = [];
  const meter: ChatMiddleware = {
    name: "test-browse-meter",
    onUsage: (_ctx, usage) => {
      metered.push(usage.totalTokens);
    },
  };
  // One budget across the turn's requests, as the stored spend carries it.
  const budget = createChatTurnBudget({
    budget: caps,
    owningMessage: undefined,
  });
  const browserTool = applyChatToolPolicy(
    createBrowserControlTool()[BROWSER_CONTROL_TOOL_NAME],
    CHAT_TOOL_POLICY_KIND.external,
  );
  const agentFor = (suspendedRuns: SuspendedBrowseRuns) =>
    createBrowseWebAgent(
      {
        admission: testModelAdmission(ORGANIZATION),
        browserTool,
        feature: "chat.stream",
        managedAIResidency: "eu",
        organizationId: ORGANIZATION,
        orgAIConfig: null,
        safeDb: asTestRaw<SafeDb>({}),
        suspendedRuns,
        tenantWorkspaceIds: [],
        thirdPartyBoundary: { type: "raw" },
        threadId: THREAD,
        turnBudget: budget.childMiddleware,
        usageLane: undefined,
        userId: USER,
        workspaceId: null,
      },
      {
        meter: () => meter,
        resolveModel: async () => await Promise.resolve(childModel),
      },
    );

  const processor = new StreamProcessor({
    initialMessages: [
      {
        id: "user-1",
        parts: [{ content: "What is the filing fee?", type: "text" }],
        role: "user",
      },
    ],
  });
  /**
   * The continued message as the server takes an answer: the stored message
   * with the answer applied through the continuation check
   * (`validateMessage`). The child's run reports no state change for a call
   * it resumes, so the stored call moves only there, as in a real turn.
   */
  const acceptAnswer = async (resume: RunAgentResumeItem[]) => {
    const live =
      processor.getMessages().at(-1) ?? panic("The run built no message");
    const id = toSafeId<"chatMessage">(live.id);
    const stored = toPersistableChatMessage({
      id,
      parts: live.parts.map(persistedPart),
      role: "assistant",
    });
    const accepted = await validateMessage({
      message: { id, parts: live.parts, role: "assistant" },
      persistedMessage: {
        content: chatMessageContentFromMessage(stored),
        role: "assistant",
      },
      refRegistry: createChatRefRegistry(),
      resume,
      safeDb: async () =>
        panic("Continuation validation must not read the database"),
      threadId: THREAD,
      toolCallOwnership: "cloud",
      tools: {},
      userId: USER,
    });
    if (Result.isError(accepted)) {
      panic(accepted.error.message);
    }
    processor.setMessages([
      ...processor.getMessages().slice(0, -1),
      asTestRaw<UIMessage>({ ...accepted.value.message, id: live.id }),
    ]);
  };
  /** One run of the main chat, its chunks processed as the page and the
   *  server process them. */
  const run = async ({
    parentRunId,
    resume,
    runId,
  }: {
    parentRunId?: string;
    resume?: RunAgentResumeItem[];
    runId: string;
  }): Promise<StreamChunk[]> => {
    if (resume !== undefined) {
      await acceptAnswer(resume);
    }
    const messages = processor.getMessages();
    const suspended = await prepareSuspendedBrowseRuns({
      boundary: { type: "raw" },
      messages: asTestRaw<ChatMessage[]>(messages),
      workspaceIds: [],
    });
    if (Result.isError(suspended)) {
      return panic("A raw boundary never refuses");
    }
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamChatChunks({
      adapter: parent.adapter,
      messages,
      runId,
      threadId: THREAD,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(resume === undefined ? {} : { resume }),
      subagents: { agents: [agentFor(suspended.value.runs)] },
      middleware: [budget.middleware],
    })) {
      chunks.push(asTestRaw<StreamChunk>(chunk));
      processor.processChunk(asTestRaw<StreamChunk>(chunk));
    }
    processor.finalizeStream();
    return chunks;
  };
  const answer = (): UIMessage =>
    processor.getMessages().at(-1) ?? panic("The run built no message");
  return { answer, budget, child, metered, parent, run };
};

const terminalOf = (chunks: readonly StreamChunk[]) => {
  const terminal = chunks.findLast(
    (chunk) => chunk.type === EventType.RUN_FINISHED,
  );
  return terminal?.type === EventType.RUN_FINISHED
    ? terminal
    : panic("The run did not finish");
};

const interruptsOf = (chunks: readonly StreamChunk[]) => {
  const { outcome } = terminalOf(chunks);
  return outcome?.type === "interrupt"
    ? outcome.interrupts
    : panic("The run did not stop for the user");
};

const awaited = (message: UIMessage) => memberWaitsOf(message);

describe("the browsing sub-agent through the SDK runtime", () => {
  test("pauses on its approval and its browser call, and the main model never reads the page", async () => {
    const scenario = browseScenario();

    // 1. The child asks to open the page: the turn waits on its approval.
    const first = await scenario.run({ runId: "run-1" });
    const childStart = first.find(
      (chunk) =>
        chunk.type === EventType.TOOL_CALL_START &&
        chunk.toolCallName === BROWSER_CONTROL_TOOL_NAME,
    );
    // Stamped from the child's tools: a client call, not the main run's
    // default `server`.
    expect(childStart).toMatchObject({
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    });
    expect(Reflect.get(childStart ?? {}, "subagentRunId")).toEqual(
      expect.any(String),
    );
    expect(awaited(scenario.answer())).toEqual([
      { toolCallId: OPEN_CALL, type: "approval" },
    ]);
    const approval =
      interruptsOf(first).find(
        (interrupt) => interrupt.toolCallId === OPEN_CALL,
      ) ?? panic("The child's approval is not an interrupt of the turn");

    // 2. Approved: the call now waits on the browser, as a client call.
    const second = await scenario.run({
      parentRunId: "run-1",
      resume: [
        {
          interruptId: approval.id,
          payload: { approved: true },
          status: "resolved",
        },
      ],
      runId: "run-2",
    });
    expect(awaited(scenario.answer())).toEqual([
      { toolCallId: OPEN_CALL, type: "client-tool" },
    ]);
    const browserCall =
      interruptsOf(second).find(
        (interrupt) => interrupt.toolCallId === OPEN_CALL,
      ) ?? panic("The browser call is not an interrupt of the turn");

    // 3. The browser answers with the page; the child reads it and answers.
    const third = await scenario.run({
      parentRunId: "run-2",
      resume: [
        {
          interruptId: browserCall.id,
          payload: pageResult(PAGE_LABEL),
          status: "resolved",
        },
      ],
      runId: "run-3",
    });
    expect(terminalOf(third).outcome?.type ?? "success").toBe("success");

    // The page reached the child (the fixture reaches the boundary) ...
    expect(JSON.stringify(scenario.child.requests)).toContain(PAGE_TEXT);
    // ... and never the main model, which read the child's answer with the
    // page it came from.
    expect(JSON.stringify(scenario.parent.requests)).not.toContain(PAGE_TEXT);
    const browseResult = scenario.parent.requests
      .at(-1)
      ?.find(
        (message) =>
          message.role === "tool" && message.toolCallId === BROWSE_CALL,
      );
    expect(JSON.stringify(browseResult?.content)).toContain(
      "Filing fee: 10 EUR.",
    );
    expect(JSON.stringify(browseResult?.content)).toContain(PAGE_URL);
    expect(awaited(scenario.answer())).toEqual([]);
  });

  test("bills each model once: the child at its own meter, the main run's usage its own", async () => {
    const scenario = browseScenario();
    const first = await scenario.run({ runId: "run-1" });
    const approval =
      interruptsOf(first).at(0) ?? panic("The turn did not stop");
    const second = await scenario.run({
      parentRunId: "run-1",
      resume: [
        {
          interruptId: approval.id,
          payload: { approved: true },
          status: "resolved",
        },
      ],
      runId: "run-2",
    });
    const browserCall =
      interruptsOf(second).at(0) ?? panic("The turn did not stop");
    const third = await scenario.run({
      parentRunId: "run-2",
      resume: [
        {
          interruptId: browserCall.id,
          payload: pageResult(PAGE_LABEL),
          status: "resolved",
        },
      ],
      runId: "run-3",
    });

    // The child's two model calls, each metered once.
    expect(scenario.metered).toEqual([
      CHILD_STEP_USAGE.totalTokens,
      CHILD_ANSWER_USAGE.totalTokens,
    ]);
    // Each main run reports exactly its own model's usage, none when its
    // model made no call: the child's never rides on it.
    expect(tokenUsageFromTerminalChunk(terminalOf(first))?.totalTokens).toBe(
      PARENT_CALL_USAGE.totalTokens,
    );
    expect(
      tokenUsageFromTerminalChunk(terminalOf(second))?.totalTokens ?? 0,
    ).toBe(0);
    const final = terminalOf(third);
    expect(tokenUsageFromTerminalChunk(final)?.totalTokens).toBe(
      PARENT_USAGE.totalTokens,
    );
    // The SDK lists usage per call only once a child's usage joins the
    // terminal (`withChildUsage`); this one stays the main model's alone.
    expect(Array.isArray(final.usage)).toBe(false);
  });

  /** The three requests of a browse: the approval, the page, the answer. */
  const browseThrough = async (scenario: ReturnType<typeof browseScenario>) => {
    const first = await scenario.run({ runId: "run-1" });
    const approval =
      interruptsOf(first).at(0) ?? panic("The turn did not stop");
    const second = await scenario.run({
      parentRunId: "run-1",
      resume: [
        {
          interruptId: approval.id,
          payload: { approved: true },
          status: "resolved",
        },
      ],
      runId: "run-2",
    });
    const browserCall =
      interruptsOf(second).at(0) ?? panic("The turn did not stop");
    return await scenario.run({
      parentRunId: "run-2",
      resume: [
        {
          interruptId: browserCall.id,
          payload: pageResult(PAGE_LABEL),
          status: "resolved",
        },
      ],
      runId: "run-3",
    });
  };

  test("spends the turn's budget: the child's model calls count toward its prompt tokens", async () => {
    const scenario = browseScenario();
    await browseThrough(scenario);
    expect(scenario.budget.spend().promptTokens).toBe(
      PARENT_CALL_USAGE.promptTokens +
        CHILD_STEP_USAGE.promptTokens +
        CHILD_ANSWER_USAGE.promptTokens +
        PARENT_USAGE.promptTokens,
    );
  });

  test("pauses the turn at its cap when the child's model calls reach it", async () => {
    // The main model's call alone stays under the cap; with the child's
    // first step the turn reaches it. Every child step that browses waits on
    // the page, so the child's own steps end at that pause; the main model
    // is not called again once the run returns.
    const scenario = browseScenario({
      ...CHAT_TURN_BUDGET,
      maxPromptTokens:
        PARENT_CALL_USAGE.promptTokens + CHILD_STEP_USAGE.promptTokens,
    });
    await browseThrough(scenario);
    expect(scenario.parent.requests).toHaveLength(1);
    expect(scenario.budget.pause()).toMatchObject({
      reason: "prompt-tokens",
      type: "paused",
    });
  });

  test("a stopped turn closes the child's pending approval and stops the child", async () => {
    const scenario = browseScenario();
    await scenario.run({ runId: "run-1" });
    const closed = cancelPendingChatToolCalls(
      asTestRaw<PersistableChatMessage>(scenario.answer()),
    );
    const part = closed.parts.find(
      (candidate) => candidate.type === "subagent",
    );
    expect(part?.type === "subagent" ? part.subagent.status : null).toBe(
      "error",
    );
    const childCall =
      part?.type === "subagent"
        ? part.subagent.messages
            .flatMap((message) => message.parts)
            .find(
              (child) => child.type === "tool-call" && child.id === OPEN_CALL,
            )
        : undefined;
    expect(childCall).toMatchObject({
      approval: { approved: false },
      state: "error",
    });
    expect(awaited(asTestRaw<UIMessage>(closed))).toEqual([]);
  });

  test("a finished browsing turn reloads as it streamed", async () => {
    const scenario = browseScenario();
    const first = await scenario.run({ runId: "run-1" });
    const approval =
      interruptsOf(first).at(0) ?? panic("The turn did not stop");
    const second = await scenario.run({
      parentRunId: "run-1",
      resume: [
        {
          interruptId: approval.id,
          payload: { approved: true },
          status: "resolved",
        },
      ],
      runId: "run-2",
    });
    const browserCall =
      interruptsOf(second).at(0) ?? panic("The turn did not stop");
    await scenario.run({
      parentRunId: "run-2",
      resume: [
        {
          interruptId: browserCall.id,
          payload: pageResult(PAGE_LABEL),
          status: "resolved",
        },
      ],
      runId: "run-3",
    });
    const live = scenario.answer();
    const persisted = live.parts.map(persistedPart);
    const reloaded = chatMessageFromPersisted({
      content: toPersistedChatMessageContentV3({ data: persisted }),
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda94"),
      role: "assistant",
    });
    expect(
      diffLiveAgainstReload({
        live: [{ ...live, parts: persisted }],
        reload: [{ ...asTestRaw<UIMessage>(reloaded), id: live.id }],
      }),
    ).toEqual([]);
    // A finished browse stores no page whole.
    expect(JSON.stringify(persisted)).not.toContain(PAGE_TEXT);
  });
});

describe("answering a call inside a suspended browsing run", () => {
  const noDbReads: SafeDb = async () =>
    panic("Continuation validation must not read the database");

  /** The turn paused on the child's approval, stored, and the request that
   *  answers it. */
  const answering = async (
    shape: (parts: UIMessage["parts"]) => UIMessage["parts"] = (parts) => parts,
  ) => {
    const scenario = browseScenario();
    const first = await scenario.run({ runId: "run-1" });
    const paused = scenario.answer();
    const live = { ...paused, parts: shape(paused.parts) };
    const parts = live.parts.map(persistedPart);
    const id = toSafeId<"chatMessage">(live.id);
    const persisted = toPersistableChatMessage({
      id,
      parts,
      role: "assistant",
    });
    return {
      approval: interruptsOf(first).at(0) ?? panic("The turn did not stop"),
      validate: async (answer: RunAgentResumeItem[] | undefined) =>
        await validateMessage({
          message: { id, parts: live.parts, role: "assistant" },
          persistedMessage: {
            content: chatMessageContentFromMessage(persisted),
            role: "assistant",
          },
          refRegistry: createChatRefRegistry(),
          ...(answer === undefined ? {} : { resume: answer }),
          safeDb: noDbReads,
          threadId: THREAD,
          toolCallOwnership: "cloud",
          tools: {},
          userId: USER,
        }),
    };
  };

  const childCallOf = (parts: readonly ChatPart[]) =>
    parts
      .flatMap((part) =>
        part.type === "subagent"
          ? part.subagent.messages.flatMap((message) => message.parts)
          : [],
      )
      .find((part) => part.type === "tool-call" && part.id === OPEN_CALL);

  test("stores the answered approval on the child's call", async () => {
    const { approval, validate } = await answering();
    const accepted = await validate([
      {
        interruptId: approval.id,
        payload: { approved: true },
        status: "resolved",
      },
    ]);
    if (Result.isError(accepted)) {
      panic(accepted.error.message);
    }
    expect(childCallOf(accepted.value.message.parts)).toMatchObject({
      approval: { approved: true },
      state: "approval-responded",
    });
  });

  test("gives each of two suspended runs the answer its own interrupt carries", async () => {
    // Two browsing runs the main model started in one step, each paused on
    // its own approval.
    const secondRun = (parts: UIMessage["parts"]): UIMessage["parts"] => {
      const subagent = parts.find((part) => part.type === "subagent");
      const runId =
        subagent?.type === "subagent"
          ? subagent.subagent.id
          : panic("The turn holds no run");
      const copy: unknown = JSON.parse(
        JSON.stringify(parts)
          .replaceAll(OPEN_CALL, () => `${OPEN_CALL}-2`)
          .replaceAll(BROWSE_CALL, () => `${BROWSE_CALL}-2`)
          .replaceAll(runId, () => `${runId}-2`),
      );
      return [...parts, ...asTestRaw<UIMessage["parts"]>(copy)];
    };
    const { approval, validate } = await answering(secondRun);
    const second = `approval_${OPEN_CALL}-2`;
    expect(approval.id).not.toBe(second);
    const accepted = await validate([
      {
        interruptId: approval.id,
        payload: { approved: true },
        status: "resolved",
      },
      { interruptId: second, payload: { approved: false }, status: "resolved" },
    ]);
    if (Result.isError(accepted)) {
      panic(accepted.error.message);
    }
    const calls = accepted.value.message.parts.flatMap((part) =>
      part.type === "subagent"
        ? part.subagent.messages.flatMap((message) => message.parts)
        : [],
    );
    expect(
      calls.find((call) => "id" in call && call.id === OPEN_CALL),
    ).toMatchObject({
      approval: { approved: true },
      state: "approval-responded",
    });
    expect(
      calls.find((call) => "id" in call && call.id === `${OPEN_CALL}-2`),
    ).toMatchObject({
      approval: { approved: false },
      state: "approval-responded",
    });
    // An answer for only one of them, or one answer given twice, answers
    // neither.
    for (const answer of [
      [
        {
          interruptId: approval.id,
          payload: { approved: true },
          status: "resolved",
        },
      ],
      [
        {
          interruptId: approval.id,
          payload: { approved: true },
          status: "resolved",
        },
        {
          interruptId: approval.id,
          payload: { approved: false },
          status: "resolved",
        },
      ],
    ] satisfies RunAgentResumeItem[][]) {
      expect(Result.isError(await validate(answer))).toBe(true);
    }
  });

  test("refuses an answer that is not the awaited one", async () => {
    const { approval, validate } = await answering();
    const refused = [
      undefined,
      [
        {
          interruptId: approval.id,
          payload: { approved: "yes" },
          status: "resolved",
        },
      ],
      [
        {
          interruptId: "another",
          payload: { approved: true },
          status: "resolved",
        },
      ],
      [
        {
          interruptId: approval.id,
          payload: { approved: true, extra: 1 },
          status: "resolved",
        },
      ],
    ] satisfies (RunAgentResumeItem[] | undefined)[];
    for (const answer of refused) {
      const result = await validate(answer);
      expect(Result.isError(result)).toBe(true);
    }
  });
});

/** A tool message's text content, as the main model reads it. */
const contentOf = (message: ModelMessage | undefined): string =>
  typeof message?.content === "string"
    ? message.content
    : panic("The tool message holds no text");

describe("the main model's view of a browsing result", () => {
  const call = (id: string, name: string): ModelMessage => ({
    content: null,
    role: "assistant",
    toolCalls: [{ function: { arguments: "{}", name }, id, type: "function" }],
  });
  const result = (id: string, content: unknown): ModelMessage => ({
    content: JSON.stringify(content),
    role: "tool",
    toolCallId: id,
  });

  test("reads the child's text as untrusted web content, and leaves other results", () => {
    const messages = [
      call("browse", BROWSE_WEB_TOOL_NAME),
      result("browse", { result: "Fee: 10 EUR.", subagentRunId: "run" }),
      call("other", "web_search"),
      result("other", { result: "unchanged" }),
    ];
    const view = browseWebResultsForModel(messages);
    expect(JSON.parse(contentOf(view.at(1)))).toEqual({
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      note: expect.any(String),
      text: "Fee: 10 EUR.",
    });
    expect(view.at(3)).toBe(messages.at(3));
    // A failed run passes its error unchanged.
    const failed = [
      call("browse", BROWSE_WEB_TOOL_NAME),
      result("browse", { error: "Stopped", subagentRunId: "run" }),
    ];
    expect(browseWebResultsForModel(failed)).toEqual(failed);
  });

  test("cuts an answer that relays a whole page to the browsing result limit", () => {
    // A child that copies the page into its answer, ending on an emoji
    // whose pair the limit would split.
    const page = `${"a".repeat(BROWSE_WEB_RESULT_MAX_CHARS - 1)}😀${PAGE_TEXT}`;
    const view = browseWebResultsForModel([
      call("browse", BROWSE_WEB_TOOL_NAME),
      result("browse", { result: page, subagentRunId: "run" }),
    ]);
    const read: unknown = JSON.parse(contentOf(view.at(1)));
    expect(read).toMatchObject({
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      text: "a".repeat(BROWSE_WEB_RESULT_MAX_CHARS - 1),
      truncated: true,
    });
    expect(JSON.stringify(read)).not.toContain(PAGE_TEXT);
    // An answer within the limit is read whole.
    const short = browseWebResultsForModel([
      call("browse", BROWSE_WEB_TOOL_NAME),
      result("browse", { result: "Fee: 10 EUR.", subagentRunId: "run" }),
    ]);
    expect(JSON.parse(contentOf(short.at(1)))).not.toHaveProperty("truncated");
  });
});
