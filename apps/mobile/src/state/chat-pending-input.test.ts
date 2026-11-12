import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_QUESTION_TOOL,
  chatLocalRunAnswersRefusal,
  type ChatLocalRunQuestion,
  chatLocalRunQuestionReplySchema,
} from "@stll/api-contract/chat-local-run-question";
import type { ChatLocalRunTarget } from "@stll/api-contract/chat-run-target";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { compileDraftDocument } from "./chat-documents";
import { readChatThread } from "./chat-messages";
import {
  allowedWithGrant,
  continuationOf,
  grantableApproval,
  isSamePendingInput,
  pendingInputKey,
  pendingInputOf,
  showsPendingInput,
} from "./chat-pending-input";
import type { PendingInput } from "./chat-pending-input";
import { chatContinueBody } from "./chat-stream";

/**
 * Conversations the API recorded against the web client: each step's
 * request as the web sent it, and the thread page the server stored after
 * it. The phone reads the same pages and must answer with the same
 * continuation.
 */
const recorded = (scenario: string) =>
  v.parse(
    v.looseObject({
      steps: v.array(
        v.looseObject({
          exchanges: v.array(
            v.looseObject({
              request: v.looseObject({
                runId: v.string(),
                parentRunId: v.optional(v.string()),
                resume: v.optional(v.unknown()),
                forwardedProps: v.looseObject({
                  message: v.looseObject({
                    id: v.string(),
                    parts: v.array(v.unknown()),
                  }),
                }),
              }),
              page: v.optional(
                v.looseObject({
                  activeTurnId: v.nullable(v.string()),
                  messages: v.array(
                    v.looseObject({
                      id: v.string(),
                      role: v.string(),
                      metadata: v.optional(v.unknown()),
                      parts: v.array(v.unknown()),
                    }),
                  ),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
    JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          `../../../web/src/components/chat/__fixtures__/recorded-conversations/${scenario}.gen.json`,
        ),
        "utf-8",
      ),
    ),
  );

type Recorded = ReturnType<typeof recorded>;
type RecordedExchange = Recorded["steps"][number]["exchanges"][number];

const exchange = (
  conversation: Recorded,
  step: number,
  index = 0,
): RecordedExchange => {
  const found = conversation.steps[step]?.exchanges[index];
  if (found === undefined) {
    throw new Error(`The recording has no step ${String(step)}`);
  }
  return found;
};

const storedPage = (recordedExchange: RecordedExchange) => {
  const { page } = recordedExchange;
  if (page === undefined) {
    throw new Error("The exchange stored no page");
  }
  return page;
};

/** What the latest stored message of a recorded page waits for. */
const pendingOfPage = (
  recordedExchange: RecordedExchange,
  runTarget?: unknown,
): PendingInput | null =>
  pendingInputOf({
    message: storedPage(recordedExchange).messages.at(-1),
    runTarget,
  });

const answerable = (pending: PendingInput | null) => {
  if (pending === null || pending.type === "elsewhere") {
    throw new Error("The turn waits for nothing the phone can answer");
  }
  return pending;
};

/** The continuation the phone sends for an answer, as it goes on the wire. */
const wireBody = ({
  answer,
  pending,
  runId,
}: {
  answer: Parameters<typeof continuationOf>[1];
  pending: ReturnType<typeof answerable>;
  runId: string;
}) => {
  const settles = continuationOf(pending, answer);
  if (settles === undefined) {
    throw new Error("The answer does not answer the pause");
  }
  // The text the request carries, read back as the server reads it.
  const sent = JSON.stringify(
    chatContinueBody({
      anonymized: false,
      continuation: {
        messageId: pending.messageId,
        parentRunId: pending.parentRunId,
        ...settles,
      },
      matterId: undefined,
      runId,
      runTarget:
        pending.owner.type === "harness" ? pending.owner.runTarget : undefined,
      threadId: THREAD_ID,
    }),
  );
  return v.parse(sentBodySchema, JSON.parse(sent));
};

/** The fields of a sent continuation these tests read. */
const sentBodySchema = v.looseObject({
  parentRunId: v.unknown(),
  resume: v.unknown(),
  forwardedProps: v.looseObject({
    message: v.looseObject({
      id: v.unknown(),
      role: v.unknown(),
      parts: v.unknown(),
    }),
  }),
  data: v.unknown(),
});

const THREAD_ID = "00000000-0000-7000-8000-000000000002";

describe("a turn waiting for an approval", () => {
  const deny = recorded("deny");

  test("is read from the stored thread with the call it asks to run", () => {
    const pending = answerable(pendingOfPage(exchange(deny, 0)));
    expect(pending.type).toBe("steps");
    expect(pending.owner).toEqual({ type: "cloud" });
    expect(pending.parentRunId).toBe("run-recorded-1");
    expect(
      pending.type === "steps"
        ? pending.approvals.map(({ interruptId, toolName, input }) => ({
            interruptId,
            toolName,
            input,
          }))
        : [],
    ).toEqual([
      {
        interruptId: "approval_call-1",
        toolName: "mcp__external__delete",
        input: { name: "call-1" },
      },
    ]);
  });

  test("is denied with the continuation the web sends", () => {
    const pending = answerable(pendingOfPage(exchange(deny, 0)));
    const { request } = exchange(deny, 1);
    const body = wireBody({
      answer: {
        type: "steps",
        allowed: { "approval_call-1": false },
        asked: {},
        documents: {},
      },
      pending,
      runId: request.runId,
    });
    expect(body.parentRunId).toBe(request.parentRunId);
    expect(body.resume).toEqual(request.resume);
    expect(body.forwardedProps.message.id).toBe(
      request.forwardedProps.message.id,
    );
    expect(body.forwardedProps.message.role).toBe("assistant");
    expect(body.forwardedProps.message.parts).toEqual(
      request.forwardedProps.message.parts,
    );
    // The envelope's copies agree, or the server refuses it.
    expect(body.data).toEqual(body.forwardedProps);
    expect(body.forwardedProps["resume"]).toEqual(body.resume);
  });

  test("is allowed with the continuation the web sends", () => {
    const allowed = recorded("single-approval");
    const pending = answerable(pendingOfPage(exchange(allowed, 0)));
    const { request } = exchange(allowed, 1);
    const body = wireBody({
      answer: {
        type: "steps",
        allowed: { "approval_call-1": true },
        asked: {},
        documents: {},
      },
      pending,
      runId: request.runId,
    });
    expect(body.resume).toEqual(request.resume);
    expect(body.forwardedProps.message.parts).toEqual(
      request.forwardedProps.message.parts,
    );
  });

  test("waits for every call of one step to be decided, and sends them together", () => {
    const both = recorded("approvals-in-one-step");
    const pending = answerable(pendingOfPage(exchange(both, 0)));
    expect(
      continuationOf(pending, {
        type: "steps",
        allowed: { "approval_call-1": true },
        asked: {},
        documents: {},
      }),
    ).toBeUndefined();
    // The web sends both answers in the step that decides the last one.
    const { request } = exchange(both, 2);
    const body = wireBody({
      answer: {
        type: "steps",
        allowed: { "approval_call-1": true, "approval_call-2": true },
        asked: {},
        documents: {},
      },
      pending,
      runId: request.runId,
    });
    expect(body.resume).toEqual(request.resume);
    expect(body.forwardedProps.message.parts).toEqual(
      request.forwardedProps.message.parts,
    );
  });

  test("is gone once the answer settles it, wherever it was given", () => {
    const pending = answerable(pendingOfPage(exchange(deny, 0)));
    const settled = pendingOfPage(exchange(deny, 1));
    expect(settled).toBeNull();
    expect(isSamePendingInput(pending, settled)).toBe(false);
    expect(isSamePendingInput(pending, pendingOfPage(exchange(deny, 0)))).toBe(
      true,
    );
  });

  test("reads the same from the thread as the server serves it", async () => {
    const page = storedPage(exchange(deny, 0));
    const fetch: Fetch = async () => Response.json(page);
    const read = await readChatThread({
      fetch,
      matterId: undefined,
      source: sourceFor(fetch),
      threadId: THREAD_ID,
    });
    expect(read.isOk() ? read.value.pendingInput : read.error._tag).toEqual(
      pendingOfPage(exchange(deny, 0)),
    );
    expect(read.isOk() ? read.value.activeTurnId : null).toBe(
      page.activeTurnId,
    );
  });
});

describe("an answer the server refuses", () => {
  const deny = recorded("deny");

  test("leaves the card on screen, held, from the send to the refusal", () => {
    const pending = answerable(pendingOfPage(exchange(deny, 0)));
    // Waiting; the answer's run starting, which continues the paused
    // message; then the refusal, which takes that run off the screen.
    const answering = [
      null,
      { streaming: true, continues: pending.messageId },
      null,
    ];
    expect(answering.map((live) => showsPendingInput(live))).toEqual([
      true,
      true,
      true,
    ]);
    // Any other answer still arriving has nothing to ask yet.
    expect(showsPendingInput({ streaming: true, continues: undefined })).toBe(
      false,
    );
    expect(showsPendingInput({ streaming: false, continues: undefined })).toBe(
      true,
    );
  });

  test("keeps what was entered when the thread, read again, still waits on the same pause", () => {
    const asked = answerable(pendingOfPage(exchange(deny, 0)));
    // The thread is read again after the refusal: the same stored pause.
    const reread = answerable(pendingOfPage(exchange(deny, 0)));
    expect(reread).not.toBe(asked);
    expect(pendingInputKey(reread)).toBe(pendingInputKey(asked));
    // A different pause starts with nothing entered.
    const other = answerable(
      pendingOfPage(exchange(recorded("approvals-in-one-step"), 0)),
    );
    expect(pendingInputKey(other)).not.toBe(pendingInputKey(asked));
    const question = answerable(
      pendingInputOf({ message: pausedOnQuestion, runTarget: LOCAL_TARGET }),
    );
    expect(
      pendingInputKey(
        answerable(
          pendingInputOf({
            message: structuredClone(pausedOnQuestion),
            runTarget: LOCAL_TARGET,
          }),
        ),
      ),
    ).toBe(pendingInputKey(question));
  });
});

describe("a turn waiting for the model's questions", () => {
  const askUser = recorded("ask-user");
  const question = "Which side?";

  test("is read from the stored thread with the questions it asks", () => {
    const pending = answerable(pendingOfPage(exchange(askUser, 0)));
    expect(pending.owner).toEqual({ type: "cloud" });
    expect(pending.parentRunId).toBe("run-recorded-1");
    expect(
      pending.type === "steps"
        ? pending.asks.map(({ interruptId, questions }) => ({
            interruptId,
            questions,
          }))
        : pending.type,
    ).toEqual([
      {
        interruptId: "client_tool_call-1",
        questions: [{ question, reason: "It decides the draft." }],
      },
    ]);
  });

  test("is answered with the continuation the web sends", () => {
    const pending = answerable(pendingOfPage(exchange(askUser, 0)));
    const { request } = exchange(askUser, 1);
    const body = wireBody({
      answer: {
        type: "steps",
        allowed: {},
        asked: { "client_tool_call-1": [{ question, answer: "Buyer" }] },
        documents: {},
      },
      pending,
      runId: request.runId,
    });
    expect(body.parentRunId).toBe(request.parentRunId);
    expect(body.resume).toEqual(request.resume);
    expect(body.data).toEqual(body.forwardedProps);
    expect(body.forwardedProps["resume"]).toEqual(body.resume);
    // The call moves to its answer and its result follows, as the web
    // sends them; the call's own fields stay the server's stored copy.
    const answerOf = (part: unknown) =>
      v.parse(
        v.looseObject({
          type: v.string(),
          id: v.optional(v.string()),
          toolCallId: v.optional(v.string()),
          state: v.optional(v.string()),
          output: v.optional(v.unknown()),
          content: v.optional(v.string()),
        }),
        part,
      );
    const pick = ({
      content,
      id,
      output,
      state,
      toolCallId,
      type,
    }: ReturnType<typeof answerOf>) => ({
      // The result carries the answers as JSON; its key order is the
      // serializer's, not part of the answer.
      content:
        content === undefined ? undefined : (JSON.parse(content) as unknown),
      id,
      output,
      state,
      toolCallId,
      type,
    });
    expect(
      v
        .parse(v.array(v.unknown()), body.forwardedProps.message.parts)
        .map((part) => pick(answerOf(part))),
    ).toEqual(
      request.forwardedProps.message.parts.map((part) => pick(answerOf(part))),
    );
  });

  test("is sent only once every question has an answer the server takes", () => {
    const pending = answerable(pendingOfPage(exchange(askUser, 0)));
    for (const answers of [
      {},
      { "client_tool_call-1": [] },
      { "client_tool_call-1": [{ question: "Another?", answer: "Buyer" }] },
      { "client_tool_call-1": [{ question, selected: ["Buyer"] }] },
    ]) {
      expect(
        continuationOf(pending, {
          type: "steps",
          allowed: {},
          asked: answers,
          documents: {},
        }),
      ).toBe(undefined);
    }
    expect(
      continuationOf(pending, {
        type: "steps",
        allowed: { "client_tool_call-1": true },
        asked: {},
        documents: {},
      }),
    ).toBe(undefined);
  });

  test("keeps what was entered while the same pause is read again", () => {
    const first = answerable(pendingOfPage(exchange(askUser, 0)));
    const again = answerable(pendingOfPage(exchange(askUser, 0)));
    expect(pendingInputKey(first)).toBe(pendingInputKey(again));
    expect(isSamePendingInput(first, again)).toBe(true);
  });

  test("names nothing once the turn has settled", () => {
    expect(pendingOfPage(exchange(askUser, 1))).toBeNull();
  });
});

describe("a turn waiting for a draft the model wrote", () => {
  const clientTool = recorded("client-tool");

  test("is answered with the compiled draft, as the web sends it", () => {
    const pending = answerable(pendingOfPage(exchange(clientTool, 0)));
    if (pending.type !== "steps") {
      throw new Error("The draft is not a step");
    }
    expect(pending.approvals).toEqual([]);
    expect(pending.asks).toEqual([]);
    const [document] = pending.documents;
    if (document === undefined) {
      throw new Error("The turn waits for no draft");
    }
    const { request } = exchange(clientTool, 1);
    const body = wireBody({
      answer: {
        type: "steps",
        allowed: {},
        asked: {},
        documents: {
          [document.interruptId]: compileDraftDocument(
            document.input,
            "Could not create document",
          ),
        },
      },
      pending,
      runId: request.runId,
    });
    expect(body.parentRunId).toBe(request.parentRunId);
    expect(body.resume).toEqual(request.resume);
    expect(stepFields(body.forwardedProps.message.parts)).toEqual(
      stepFields(request.forwardedProps.message.parts),
    );
  });
});

/** A paused message of one model step, for steps the recordings lack. */
const pausedStep = ({
  interrupts,
  parts,
}: {
  interrupts: readonly unknown[];
  parts: readonly unknown[];
}) => ({
  id: "00000000-0000-7000-8000-0000000000m1",
  role: "assistant",
  metadata: {
    turnOutcome: { type: "awaiting-user" },
    resumeSnapshot: {
      resumeState: { threadId: THREAD_ID, runId: "run-step" },
      pendingInterrupts: interrupts,
    },
  },
  parts,
});

const serverCall = (id: string, name: string) => ({
  type: "tool-call",
  id,
  name,
  arguments: "{}",
  input: { name: id },
  state: "approval-requested",
  approval: { id: `approval_${id}`, needsApproval: true },
  metadata: { stellaStepId: id, stellaToolExecutor: "server" },
});

const askCall = (id: string) => ({
  type: "tool-call",
  id,
  name: "ask-user",
  arguments: "{}",
  input: {
    analysis: "The draft depends on the side.",
    questions: [{ question: "Which side?", reason: "It decides the draft." }],
  },
  state: "input-complete",
  metadata: { stellaStepId: id, stellaToolExecutor: "client" },
});

const approvalInterrupt = (id: string) => ({
  id: `approval_${id}`,
  reason: "tool_call",
  toolCallId: id,
  metadata: { kind: "approval" },
});

const clientInterrupt = (id: string) => ({
  id: `client_tool_${id}`,
  reason: "tanstack:client_tool_execution",
  toolCallId: id,
  metadata: { kind: "client_tool" },
});

describe("a step with an approval and the model's questions", () => {
  const step = pausedStep({
    interrupts: [approvalInterrupt("call-1"), clientInterrupt("call-2")],
    parts: [serverCall("call-1", "mcp__external__delete"), askCall("call-2")],
  });

  test("waits for both, and sends them together", () => {
    const pending = answerable(
      pendingInputOf({ message: step, runTarget: null }),
    );
    expect(pending.type).toBe("steps");
    const answer = {
      type: "steps",
      allowed: { "approval_call-1": true },
      asked: {
        "client_tool_call-2": [{ question: "Which side?", answer: "Buyer" }],
      },
      documents: {},
    } as const;
    expect(continuationOf(pending, { ...answer, allowed: {} })).toBeUndefined();
    expect(continuationOf(pending, { ...answer, asked: {} })).toBeUndefined();
    const settles = continuationOf(pending, answer);
    expect(settles?.resume).toEqual([
      {
        interruptId: "approval_call-1",
        status: "resolved",
        payload: { approved: true },
      },
      {
        interruptId: "client_tool_call-2",
        status: "resolved",
        payload: { answers: [{ question: "Which side?", answer: "Buyer" }] },
      },
    ]);
    // The answered calls first, then the result the questions' answer adds.
    expect(stepFields(settles?.parts ?? [])).toEqual([
      {
        type: "tool-call",
        id: "call-1",
        state: "approval-responded",
        output: undefined,
        toolCallId: undefined,
        content: undefined,
      },
      {
        type: "tool-call",
        id: "call-2",
        state: "complete",
        output: { answers: [{ question: "Which side?", answer: "Buyer" }] },
        toolCallId: undefined,
        content: undefined,
      },
      {
        type: "tool-result",
        id: undefined,
        state: "complete",
        output: undefined,
        toolCallId: "call-2",
        content: {
          answers: [{ question: "Which side?", answer: "Buyer" }],
        },
      },
    ]);
  });
});

describe("a standing grant given from an approval", () => {
  const step = pausedStep({
    interrupts: [
      approvalInterrupt("call-1"),
      approvalInterrupt("call-2"),
      approvalInterrupt("call-3"),
      approvalInterrupt("call-4"),
    ],
    parts: [
      serverCall("call-1", "mcp__acme__send"),
      serverCall("call-2", "mcp__acme__archive"),
      serverCall("call-3", "mcp__other__send"),
      serverCall("call-4", "use_connector_secret"),
    ],
  });

  test("allows the step's other approvals it covers, and no others", () => {
    const pending = answerable(
      pendingInputOf({ message: step, runTarget: null }),
    );
    if (pending.type !== "steps") {
      throw new Error("Not a step");
    }
    expect(
      allowedWithGrant(
        pending.approvals,
        { "approval_call-1": true, "approval_call-4": false },
        "mcp__acme__send",
      ),
    ).toEqual({
      "approval_call-1": true,
      "approval_call-2": true,
      "approval_call-4": false,
    });
  });

  test("is offered only for a tool a stored grant may cover", () => {
    expect(grantableApproval("mcp__acme__send")).toBe(true);
    expect(grantableApproval("web_search")).toBe(true);
    expect(grantableApproval("use_connector_secret")).toBe(false);
    expect(grantableApproval("suggest_changes")).toBe(false);
    expect(grantableApproval("use-browser")).toBe(false);
  });
});

describe("a step only another place takes", () => {
  const clientStep = (name: string, state: string, approved?: boolean) =>
    pendingInputOf({
      message: pausedStep({
        interrupts: [clientInterrupt("call-1")],
        parts: [
          {
            type: "tool-call",
            id: "call-1",
            name,
            arguments: "{}",
            input: {},
            state,
            ...(approved === undefined
              ? {}
              : {
                  approval: {
                    id: "approval_call-1",
                    needsApproval: true,
                    approved,
                  },
                }),
            metadata: { stellaToolExecutor: "client" },
          },
        ],
      }),
      runTarget: null,
    });

  test("names the computer for a browser command allowed from here", () => {
    expect(clientStep("use-browser", "approval-responded", true)).toEqual({
      type: "elsewhere",
      reason: "browser",
    });
  });

  test("says why a key or a connection is not added from the phone", () => {
    expect(clientStep("request_secret", "input-complete")).toEqual({
      type: "elsewhere",
      reason: "secret",
    });
    expect(clientStep("connect_connector", "input-complete")).toEqual({
      type: "elsewhere",
      reason: "connector",
    });
  });

  test("asks about a browser command like any other call", () => {
    const pending = answerable(
      pendingInputOf({
        message: pausedStep({
          interrupts: [approvalInterrupt("call-1")],
          parts: [serverCall("call-1", "use-browser")],
        }),
        runTarget: null,
      }),
    );
    expect(pending.type === "steps" ? pending.approvals.length : 0).toBe(1);
  });
});

/** The fields of sent parts a continuation sets: which call or result, and its answer. */
function stepFields(parts: unknown) {
  return v.parse(v.array(v.unknown()), parts).map((part) => {
    const read = v.parse(
      v.looseObject({
        type: v.string(),
        id: v.optional(v.string()),
        toolCallId: v.optional(v.string()),
        state: v.optional(v.string()),
        output: v.optional(v.unknown()),
        content: v.optional(v.string()),
      }),
      part,
    );
    return {
      type: read.type,
      id: read.id,
      toolCallId: read.toolCallId,
      state: read.state,
      output: read.output,
      // A result's answer as JSON; its key order is the serializer's.
      content:
        read.content === undefined
          ? undefined
          : (JSON.parse(read.content) as unknown),
    };
  });
}

const governingLaw = {
  id: "law",
  header: "Governing law",
  prompt: "Which law governs the lease?",
  options: [
    { label: "Czech", description: "Czech Civil Code" },
    { label: "Slovak", description: "Slovak Civil Code" },
  ],
  allowsFreeText: false,
  multiSelect: false,
  secret: false,
} as const satisfies ChatLocalRunQuestion;
const passphrase = {
  id: "passphrase",
  header: "Passphrase",
  prompt: "The archive passphrase?",
  options: [],
  allowsFreeText: true,
  multiSelect: false,
  secret: true,
} as const satisfies ChatLocalRunQuestion;

const LOCAL_TARGET = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
} as const satisfies ChatLocalRunTarget;

const QUESTION_REQUEST_ID = "0198f3a4-6b1c-7d2e-8f3a-4b5c6d7e8f90";
const QUESTION_CALL_ID = "0198f3a46b1c7d2e8f3a4b5c6d7e8f90_call-q";
const PAUSED_MESSAGE_ID = "00000000-0000-7000-8000-000000000003";

/** A local run's question call, as the thread stores the harness's call. */
const questionCall = {
  type: "tool-call",
  id: QUESTION_CALL_ID,
  name: CHAT_LOCAL_RUN_QUESTION_TOOL,
  arguments: JSON.stringify({ questions: [governingLaw, passphrase] }),
  input: { questions: [governingLaw, passphrase] },
  metadata: { stellaToolExecutor: "harness" },
  state: "input-complete",
};

/**
 * A turn a coding agent paused on its blocking question, as the thread
 * stores it: the question's call, the turn awaiting the person, and the
 * interrupt the agent paused with in the resume snapshot.
 */
const pausedOnQuestion = {
  id: PAUSED_MESSAGE_ID,
  role: "assistant",
  metadata: {
    turnOutcome: {
      type: "awaiting-user",
      interaction: { type: "harness-question", toolCallId: QUESTION_CALL_ID },
    },
    resumeSnapshot: {
      resumeState: { threadId: THREAD_ID, runId: "run-local-1" },
      pendingInterrupts: [
        {
          id: QUESTION_REQUEST_ID,
          reason: "user_input",
          message: governingLaw.prompt,
          toolCallId: QUESTION_CALL_ID,
          metadata: {
            kind: "question",
            toolName: CHAT_LOCAL_RUN_QUESTION_TOOL,
            questions: [governingLaw, passphrase],
          },
        },
      ],
    },
  },
  parts: [{ type: "text", content: "Let me check one thing." }, questionCall],
};

describe("a turn a coding agent paused on its question", () => {
  test("is answered from a thread that runs on the person's computer", () => {
    const pending = answerable(
      pendingInputOf({ message: pausedOnQuestion, runTarget: LOCAL_TARGET }),
    );
    expect(pending.type).toBe("question");
    expect(pending.owner).toEqual({
      type: "harness",
      runTarget: LOCAL_TARGET,
    });
    expect(pending.type === "question" ? pending.pause : null).toEqual({
      interruptId: QUESTION_REQUEST_ID,
      questions: [governingLaw, passphrase],
    });
  });

  test("is left to the web app where the thread names no computer to answer through", () => {
    expect(
      pendingInputOf({
        message: pausedOnQuestion,
        runTarget: { kind: "cloud" },
      }),
    ).toEqual({ type: "elsewhere", reason: "other" });
    expect(
      pendingInputOf({ message: pausedOnQuestion, runTarget: undefined }),
    ).toEqual({ type: "elsewhere", reason: "other" });
  });

  test("sends answers the server accepts, keeping the call as stored", () => {
    const pending = answerable(
      pendingInputOf({ message: pausedOnQuestion, runTarget: LOCAL_TARGET }),
    );
    const answers = { law: ["Czech"], passphrase: [" open sesame "] };
    const body = wireBody({
      answer: { type: "question", answers },
      pending,
      runId: "run-local-2",
    });
    expect(body.forwardedProps["runTarget"]).toEqual(LOCAL_TARGET);
    expect(body.parentRunId).toBe("run-local-1");
    expect(body.forwardedProps.message).toEqual({
      id: PAUSED_MESSAGE_ID,
      role: "assistant",
      parts: [questionCall],
    });
    expect(body.resume).toEqual([
      {
        interruptId: QUESTION_REQUEST_ID,
        status: "resolved",
        payload: { answers },
      },
    ]);
    const [resumed] = v.parse(
      v.tuple([v.looseObject({ payload: v.unknown() })]),
      body.resume,
    );
    const reply = v.parse(chatLocalRunQuestionReplySchema, resumed.payload);
    expect(
      chatLocalRunAnswersRefusal([governingLaw, passphrase], reply.answers),
    ).toBeNull();
  });

  test("is dismissed by cancelling its interrupt, which stops the agent's turn", () => {
    const pending = answerable(
      pendingInputOf({ message: pausedOnQuestion, runTarget: LOCAL_TARGET }),
    );
    const body = wireBody({
      answer: { type: "question", answers: null },
      pending,
      runId: "run-local-2",
    });
    expect(body.resume).toEqual([
      { interruptId: QUESTION_REQUEST_ID, status: "cancelled" },
    ]);
  });

  test("reads as nothing once the agent's turn went on", () => {
    expect(
      pendingInputOf({
        message: {
          ...pausedOnQuestion,
          metadata: { turnOutcome: { type: "completed" } },
          parts: [
            pausedOnQuestion.parts[0],
            { ...questionCall, state: "complete" },
          ],
        },
        runTarget: LOCAL_TARGET,
      }),
    ).toBeNull();
  });
});

describe("a computer's approval", () => {
  const APPROVAL_REQUEST_ID = "0198f3a4-6b1c-7d2e-8f3a-4b5c6d7e8f91";
  const commandCall = {
    type: "tool-call",
    id: "0198f3a46b1c7d2e8f3a4b5c6d7e8f91_call-c",
    name: "command_execution",
    arguments: JSON.stringify({ command: "ls -la" }),
    input: { command: "ls -la" },
    metadata: { stellaToolExecutor: "harness" },
    state: "approval-requested",
    approval: { id: APPROVAL_REQUEST_ID, needsApproval: true },
  };
  const pausedOnApproval = {
    id: PAUSED_MESSAGE_ID,
    role: "assistant",
    metadata: {
      turnOutcome: { type: "awaiting-user" },
      resumeSnapshot: {
        resumeState: { threadId: THREAD_ID, runId: "run-local-1" },
        pendingInterrupts: [
          {
            id: APPROVAL_REQUEST_ID,
            reason: "tool_call",
            message: "ls -la",
            toolCallId: commandCall.id,
            metadata: {
              kind: "approval",
              toolName: "command_execution",
              input: { command: "ls -la" },
              approvalKind: "command",
              decisions: ["approve", "approve_for_session", "deny"],
            },
          },
        ],
      },
    },
    parts: [commandCall],
  };

  test("is answered through the thread's computer, its call echoed with the answer", () => {
    const pending = answerable(
      pendingInputOf({ message: pausedOnApproval, runTarget: LOCAL_TARGET }),
    );
    const body = wireBody({
      answer: {
        type: "steps",
        allowed: { [APPROVAL_REQUEST_ID]: true },
        asked: {},
        documents: {},
      },
      pending,
      runId: "run-local-2",
    });
    expect(body.forwardedProps["runTarget"]).toEqual(LOCAL_TARGET);
    expect(body.forwardedProps.message.parts).toEqual([
      {
        ...commandCall,
        state: "approval-responded",
        approval: { ...commandCall.approval, approved: true },
      },
    ]);
    expect(body.resume).toEqual([
      {
        interruptId: APPROVAL_REQUEST_ID,
        status: "resolved",
        payload: { approved: true },
      },
    ]);
  });

  test("never mixes with stella's own calls in one answer", () => {
    const cloudCall = {
      ...commandCall,
      id: "call-cloud",
      metadata: { stellaToolExecutor: "server" },
      approval: { id: "approval_call-cloud", needsApproval: true },
    };
    expect(
      pendingInputOf({
        message: {
          ...pausedOnApproval,
          metadata: {
            ...pausedOnApproval.metadata,
            resumeSnapshot: {
              ...pausedOnApproval.metadata.resumeSnapshot,
              pendingInterrupts: [
                ...pausedOnApproval.metadata.resumeSnapshot.pendingInterrupts,
                {
                  id: "approval_call-cloud",
                  reason: "tool_call",
                  toolCallId: "call-cloud",
                  metadata: { kind: "approval" },
                },
              ],
            },
          },
          parts: [commandCall, cloudCall],
        },
        runTarget: LOCAL_TARGET,
      }),
    ).toEqual({ type: "elsewhere", reason: "other" });
  });
});

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
};
