import { EventType } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { DesktopRunnerRequestEvent } from "@stll/api-contract/chat-local-run-request";
import { DESKTOP_RUNNER_DESKTOP_MESSAGE } from "@stll/api-contract/desktop-runner";

import { toSafeId } from "@/api/lib/branded-types";
import type { QueueCommandOutcome } from "@/api/lib/desktop-runner/control";
import { answerRunRequest } from "@/api/lib/desktop-runner/request-answers";
import type { ChatRunForRequest } from "@/api/lib/desktop-runner/store";

const RUN_ID = "0198c0de-0000-7000-8000-0000000000a1";
const REQUEST_ID = "0198c0de-0000-7000-8000-0000000000a2";
const OWNER = {
  userId: toSafeId<"user">("user_answers"),
  organizationId: toSafeId<"organization">("org_answers"),
};
const CHAT = {
  threadId: toSafeId<"chatThread">("thread_answers"),
  turnId: toSafeId<"chatTurn">("turn_answers"),
};

const approvalAsked: ChatRunForRequest = {
  runId: RUN_ID,
  harness: "codex",
  state: "running",
  outcome: null,
  chatReadSeq: 0,
  askedBy: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
  request: {
    type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
    runId: RUN_ID,
    seq: 3,
    requestId: REQUEST_ID,
    kind: "tool",
    summary: "Click the button",
  },
};

const questionAsked: ChatRunForRequest = {
  ...approvalAsked,
  askedBy: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
  request: {
    type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
    runId: RUN_ID,
    seq: 3,
    chunk: {
      type: EventType.RUN_FINISHED,
      runId: "segment",
      threadId: "thread",
      finishReason: "tool_calls",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: REQUEST_ID,
            reason: "user_input",
            toolCallId: "call-question",
            metadata: {
              kind: "question",
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  prompt: "Which folder?",
                  options: [{ label: "All", description: "" }],
                  allowsFreeText: false,
                  multiSelect: false,
                  secret: false,
                },
              ],
            },
          },
        ],
      },
    },
  },
};

/** The run's side as an answer reads and commands it. */
const control = ({
  run = approvalAsked,
  closure = null,
  queued = { type: "queued" },
  answered = false,
  ended,
}: {
  run?: ChatRunForRequest | null;
  closure?: DesktopRunnerRequestEvent | null;
  queued?: QueueCommandOutcome;
  /** Whether an answer to the request is queued already. */
  answered?: boolean;
  /** The run as a read after the command finds it. */
  ended?: ChatRunForRequest;
} = {}) => {
  const sent: string[] = [];
  let reads = 0;
  const queue = (kind: string) => {
    sent.push(kind);
    return Result.ok(queued);
  };
  return {
    sent,
    control: {
      readChatRunForRequest: async () => {
        reads += 1;
        return await Promise.resolve(
          Result.ok(reads > 1 && ended !== undefined ? ended : run),
        );
      },
      readRunRequestAnswered: async () =>
        await Promise.resolve(Result.ok(answered)),
      readRunRequestClosure: async () =>
        await Promise.resolve(Result.ok(closure)),
      answerApproval: async () => await Promise.resolve(queue("approval")),
      answerQuestion: async () => await Promise.resolve(queue("question")),
      stopTurn: async () => await Promise.resolve(queue("stop")),
    },
  };
};

const APPROVE = { type: "approval", decision: "approve" } as const;

const answer = async (
  fake: ReturnType<typeof control>,
  given: Parameters<typeof answerRunRequest>[1]["answer"] = APPROVE,
) => {
  const outcome = await answerRunRequest(fake.control, {
    owner: OWNER,
    chat: CHAT,
    requestId: REQUEST_ID,
    answer: given,
  });
  return outcome.isOk() ? outcome.value : outcome.error;
};

describe("answering what a run on the member's computer asked", () => {
  test("a pending approval's answer goes to the run, and a repeat replays its receipt", async () => {
    const first = control();
    expect(await answer(first)).toEqual({ type: "answered" });
    expect(first.sent).toEqual(["approval"]);
    const repeat = control({ queued: { type: "duplicate" } });
    expect(await answer(repeat)).toEqual({ type: "answered" });
  });

  test("an answer to a request the run already resolved is told so and sends nothing", async () => {
    const fake = control({
      closure: { requestId: REQUEST_ID, status: "resolved" },
    });
    expect(await answer(fake)).toEqual({ type: "already_resolved" });
    expect(fake.sent).toEqual([]);
  });

  test("an answer after the run finished without the step is told it expired, never that the computer stopped", async () => {
    const closed = control({
      closure: {
        requestId: REQUEST_ID,
        status: "expired",
        expiry: "run_finished",
      },
      run: { ...approvalAsked, state: "finished", outcome: "completed" },
    });
    expect(await answer(closed)).toEqual({
      type: "expired",
      expiry: "run_finished",
    });
    expect(closed.sent).toEqual([]);
    // A run that ended without reporting the request read by its end.
    const ends = [
      ["completed", { type: "expired", expiry: "run_finished" }],
      ["failed", { type: "expired", expiry: "run_failed" }],
      ["interrupted", { type: "cancelled" }],
      [null, { type: "expired", expiry: "run_lost" }],
    ] as const;
    for (const [outcome, told] of ends) {
      const ended = control({
        run: {
          ...approvalAsked,
          state: outcome === null ? "lost" : "finished",
          outcome,
        },
      });
      expect(await answer(ended)).toEqual(told);
      expect(ended.sent).toEqual([]);
    }
  });

  test("a run that ends between the read and the command reads by its end, read again", async () => {
    expect(
      await answer(
        control({
          queued: { type: "run_ended", state: "finished" },
          ended: { ...approvalAsked, state: "finished", outcome: "completed" },
        }),
      ),
    ).toEqual({ type: "expired", expiry: "run_finished" });
    // A run that ended with no outcome of its own was lost.
    expect(
      await answer(
        control({
          queued: { type: "run_ended", state: "lost" },
          ended: { ...approvalAsked, state: "lost", outcome: null },
        }),
      ),
    ).toEqual({ type: "expired", expiry: "run_lost" });
  });

  test("dismissing a question already answered keeps the answer and stops nothing", async () => {
    const fake = control({ run: questionAsked, answered: true });
    expect(await answer(fake, { type: "dismiss" })).toEqual({
      type: "answered",
    });
    expect(fake.sent).toEqual([]);
  });

  test("a withdrawn or stopped request is told so", async () => {
    expect(
      await answer(
        control({
          closure: {
            requestId: REQUEST_ID,
            status: "expired",
            expiry: "withdrawn",
          },
        }),
      ),
    ).toEqual({ type: "expired", expiry: "withdrawn" });
    expect(
      await answer(
        control({ closure: { requestId: REQUEST_ID, status: "cancelled" } }),
      ),
    ).toEqual({ type: "cancelled" });
  });

  test("a run holding as many commands as it may refuses the answer as full", async () => {
    expect(
      await answer(control({ queued: { type: "command_limit" } })),
    ).toEqual({ type: "refused", reason: "run_full" });
  });

  test("an answer of the wrong kind, or answers the question does not take, are refused unsent", async () => {
    const approval = control();
    expect(
      await answer(approval, { type: "question", answers: { scope: ["All"] } }),
    ).toEqual({ type: "refused", reason: "invalid_answer" });
    expect(await answer(approval, { type: "dismiss" })).toEqual({
      type: "refused",
      reason: "invalid_answer",
    });
    const question = control({ run: questionAsked });
    expect(await answer(question)).toEqual({
      type: "refused",
      reason: "invalid_answer",
    });
    expect(
      await answer(question, {
        type: "question",
        answers: { scope: ["Elsewhere"] },
      }),
    ).toEqual({ type: "refused", reason: "invalid_answer" });
    expect(approval.sent).toEqual([]);
    expect(question.sent).toEqual([]);
  });

  test("a question takes its answers, and dismissing it stops the run's turn", async () => {
    const answered = control({ run: questionAsked });
    expect(
      await answer(answered, { type: "question", answers: { scope: ["All"] } }),
    ).toEqual({ type: "answered" });
    const dismissed = control({ run: questionAsked });
    expect(await answer(dismissed, { type: "dismiss" })).toEqual({
      type: "answered",
    });
    expect([...answered.sent, ...dismissed.sent]).toEqual(["question", "stop"]);
  });

  test("a request no run of the member's turn asked is not found", async () => {
    expect(await answer(control({ run: null }))).toBeNull();
  });
});
