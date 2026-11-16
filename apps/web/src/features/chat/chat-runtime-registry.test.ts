import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as v from "valibot";

import { ASK_USER_TOOL_NAME } from "@stll/api-contract/chat";
import { CONNECT_CONNECTOR_TOOL_NAME } from "@stll/api-contract/chat-connector";
import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "@stll/api-contract/chat-local-run-question";
import { REQUEST_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";
import type { UserInputChatToolName } from "@stll/api-contract/chat-tool-activity";
import type { chatResumeSnapshotSchema } from "@stll/chat/resume-contract";

import { openMemberWaitKeys } from "@/components/chat/chat-ui-tools";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  __resetChatRequestStateForTests,
  acquireChatRuntime,
} from "@/features/chat/chat-runtime-registry";
import type { ChatThreadFetched } from "@/features/chat/queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

const previousFetch = globalThis.fetch;
beforeEach(() => {
  __resetChatRequestStateForTests();
});
afterEach(() => {
  globalThis.fetch = previousFetch;
});

const threadId = toChatThreadId("thread-member-wait");
const threadRef = { scope: "global", threadId } as const;
const activeOrganizationId = "org_test";
const context = { allowMissingThread: true };
const assistantMessageId = "11111111-1111-4111-8111-111111111111";
const TOOL_CALL_ID = "tool-wait";
const RUN_ID = "run-wait";

const buildThreadData = (
  overrides: Partial<ChatThreadFetched> = {},
): ChatThreadFetched => ({
  activeTurnId: null,
  attachedFiles: { fileCount: 0, files: [] },
  forkProvenance: { type: "none" },
  messages: [],
  olderCursor: null,
  contextMatterIds: [],
  lastActivityAt: null,
  threadRevision: null,
  activeSkill: null,
  threadExists: true,
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
  context: null,
  model: null,
  reasoningEffort: null,
  ...overrides,
});

/** A pending interrupt, as a stored turn's resume snapshot holds it. */
type Interrupt = NonNullable<
  v.InferOutput<typeof chatResumeSnapshotSchema>["pendingInterrupts"]
>[number];

/** The interrupt a browser-answered tool's call pauses its turn with. */
const clientToolInterrupt = (toolName: string): Interrupt => ({
  id: `client_tool_${TOOL_CALL_ID}`,
  reason: "tanstack:client_tool_execution",
  message: `Client tool ${toolName} is ready to run`,
  toolCallId: TOOL_CALL_ID,
  responseSchema: {},
  metadata: {
    kind: "client_tool",
    toolName,
    input: {},
    "tanstack:interruptBinding": {
      v: 1,
      kind: "client-tool-execution",
      interruptId: `client_tool_${TOOL_CALL_ID}`,
      interruptedRunId: RUN_ID,
      generation: 0,
      toolName,
      toolCallId: TOOL_CALL_ID,
      outputSchemaHash: "server-owned",
      responseSchemaHash: "server-owned",
    },
  },
});

/** The interrupt a tool that needs the member's approval pauses with. */
const approvalInterrupt = (toolName: string): Interrupt => ({
  id: `approval_${TOOL_CALL_ID}`,
  reason: "tool_call",
  toolCallId: TOOL_CALL_ID,
  metadata: {
    kind: "approval",
    toolName,
    input: {},
    "tanstack:interruptBinding": {
      v: 1,
      kind: "tool-approval",
      interruptId: `approval_${TOOL_CALL_ID}`,
      interruptedRunId: RUN_ID,
      generation: 0,
      toolName,
      toolCallId: TOOL_CALL_ID,
      originalArgs: {},
      inputSchemaHash: "server-owned",
      approvalSchemaHash: "server-owned",
      responseSchemaHash: "server-owned",
    },
  },
});

/** The interrupt a run on the member's computer pauses on its question with. */
const localRunQuestionInterrupt = (): Interrupt => ({
  id: "00000000-0000-7000-8000-0000000000a1",
  reason: "user_input",
  message: "Which law governs the lease?",
  toolCallId: TOOL_CALL_ID,
  metadata: {
    kind: "question",
    toolName: CHAT_LOCAL_RUN_QUESTION_TOOL,
    questions: [
      {
        id: "law",
        header: "Governing law",
        prompt: "Which law governs the lease?",
        options: [
          { label: "Czech", description: "" },
          { label: "Slovak", description: "" },
        ],
        allowsFreeText: false,
        multiSelect: false,
        secret: false,
      },
    ],
  },
});

type MemberWait = { toolName: string; interrupt: Interrupt };

/**
 * A turn paused on each tool whose call waits on the member. Total over the
 * user-input tools, so a new one is kept across a thread read or fails here.
 */
const USER_INPUT_WAITS = {
  [ASK_USER_TOOL_NAME]: {
    toolName: ASK_USER_TOOL_NAME,
    interrupt: clientToolInterrupt(ASK_USER_TOOL_NAME),
  },
  [REQUEST_SECRET_TOOL_NAME]: {
    toolName: REQUEST_SECRET_TOOL_NAME,
    interrupt: clientToolInterrupt(REQUEST_SECRET_TOOL_NAME),
  },
  [CONNECT_CONNECTOR_TOOL_NAME]: {
    toolName: CONNECT_CONNECTOR_TOOL_NAME,
    interrupt: clientToolInterrupt(CONNECT_CONNECTOR_TOOL_NAME),
  },
  [CHAT_LOCAL_RUN_QUESTION_TOOL]: {
    toolName: CHAT_LOCAL_RUN_QUESTION_TOOL,
    interrupt: localRunQuestionInterrupt(),
  },
} as const satisfies Record<UserInputChatToolName, MemberWait>;

const MEMBER_WAITS: (MemberWait & { kind: string })[] = [
  {
    kind: "an approval",
    toolName: "web_search",
    interrupt: approvalInterrupt("web_search"),
  },
  ...Object.values(USER_INPUT_WAITS).map((wait) => ({
    kind: `a ${wait.toolName} card`,
    ...wait,
  })),
];

/** A run that calls the tool and pauses its turn on the member. */
const pausedRun = ({ toolName, interrupt }: MemberWait) => [
  { type: "RUN_STARTED", threadId, runId: RUN_ID },
  {
    type: "TEXT_MESSAGE_START",
    messageId: assistantMessageId,
    role: "assistant",
  },
  {
    type: "TOOL_CALL_START",
    parentMessageId: assistantMessageId,
    toolCallId: TOOL_CALL_ID,
    toolCallName: toolName,
    toolName,
  },
  { type: "TOOL_CALL_ARGS", delta: "{}", toolCallId: TOOL_CALL_ID },
  {
    type: "TOOL_CALL_END",
    input: {},
    toolCallId: TOOL_CALL_ID,
    toolCallName: toolName,
    toolName,
  },
  {
    type: "RUN_FINISHED",
    threadId,
    runId: RUN_ID,
    finishReason: "tool_calls",
    outcome: { type: "interrupt", interrupts: [interrupt] },
  },
];

/** The paused turn's messages as the server stores them: its pending
 *  interrupts in the answer's resume snapshot. */
const storedPausedMessages = (
  messages: readonly PersistedChatMessage[],
  interrupt: Interrupt,
): PersistedChatMessage[] =>
  messages.map((message, index) =>
    index === messages.length - 1
      ? {
          ...message,
          metadata: {
            ...message.metadata,
            resumeSnapshot: {
              resumeState: { threadId, runId: RUN_ID },
              pendingInterrupts: [interrupt],
            },
          },
        }
      : message,
  );

/** A page whose turn paused on `wait`, and the requests it has made. */
const pauseOn = async (wait: MemberWait) => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return new Response(
        pausedRun(wait)
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  const queryClient = new QueryClient();
  const runtime = acquireChatRuntime({
    activeOrganizationId,
    context,
    data: buildThreadData(),
    key: threadRef,
    queryClient,
  });
  const started = await runtime.startRouteHandoffMessage({
    content: "Draft the lease",
    id: toSafeId<"chatMessage">("22222222-2222-4222-8222-2222222222d1"),
  });
  await started.stream;
  const { localRunQuestion, messages } = runtime.getSnapshot();
  // The fixture reaches the boundary: the turn is over and waits on the
  // member, so only the wait can keep the runtime.
  expect(runtime.getSnapshot()).toMatchObject({
    isLoading: false,
    status: "ready",
  });
  expect(openMemberWaitKeys({ localRunQuestion, messages })).not.toEqual([]);
  const acquire = (data: ChatThreadFetched) =>
    acquireChatRuntime({
      activeOrganizationId,
      context,
      data,
      key: threadRef,
      queryClient,
    });
  return { acquire, requests, runtime };
};

describe.each(MEMBER_WAITS)("a runtime waiting on $kind", (wait) => {
  test("is kept when the thread read after the pause still holds the wait", async () => {
    const { acquire, requests, runtime } = await pauseOn(wait);
    const waiting = runtime.getSnapshot();
    const stored = buildThreadData({
      lastActivityAt: "2026-07-08T10:00:00.000Z",
      messages: storedPausedMessages(waiting.messages, wait.interrupt),
      threadRevision: "revision-paused",
    });

    expect(acquire(stored)).toBe(runtime);
    // Acknowledged: the same read on a later render keeps it too.
    expect(acquire(stored)).toBe(runtime);
    expect(runtime.getSnapshot().localRunQuestion).toBe(
      waiting.localRunQuestion,
    );
    // Nothing reads the paused turn from the server again.
    expect(requests).toHaveLength(1);
  });

  test("is replaced when the thread read no longer holds the wait", async () => {
    const { acquire, runtime } = await pauseOn(wait);
    const answeredElsewhere = buildThreadData({
      lastActivityAt: "2026-07-08T10:00:00.000Z",
      messages: [
        {
          id: "22222222-2222-4222-8222-2222222222d1",
          role: "user",
          parts: [{ type: "text", content: "Draft the lease" }],
        },
        {
          id: assistantMessageId,
          role: "assistant",
          parts: [{ type: "text", content: "Answered on another device." }],
        },
      ],
      threadRevision: "revision-answered",
    });

    const replaced = acquire(answeredElsewhere);
    expect(replaced).not.toBe(runtime);
    expect(replaced.getSnapshot().messages.at(-1)?.parts).toEqual([
      { type: "text", content: "Answered on another device." },
    ]);
  });
});

test("a turn paused on a local run's question reads as its call and its interrupt", async () => {
  const wait = USER_INPUT_WAITS[CHAT_LOCAL_RUN_QUESTION_TOOL];
  const { runtime } = await pauseOn(wait);
  const { localRunQuestion, messages } = runtime.getSnapshot();
  expect(openMemberWaitKeys({ localRunQuestion, messages })).toEqual([
    `part:${TOOL_CALL_ID}`,
    `interrupt:${wait.interrupt.id}`,
  ]);
});
