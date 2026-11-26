import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_REQUEST_EXPIRY,
  CHAT_LOCAL_RUN_REQUEST_STATUSES,
  CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY,
  type ChatLocalRunRequest,
  type ChatLocalRunRequestExpiry,
  type ChatLocalRunRequestStatus,
  unansweredLocalRunRequest,
} from "@stll/api-contract/chat-local-run-request";

import {
  awaitedLocalRunApproval,
  localRunRequestOfCall,
} from "@/components/chat/local-run-request.logic";

const CALL_ID = "local:run-1:item_cmd";
const REQUEST_ID = "00000000-0000-7000-8000-0000000000a1";

const approvalAsk = {
  kind: "approval",
  message: "Run the formatter over the draft",
  reason: null,
  toolName: "command_execution",
  input: { command: "format draft.txt" },
  approvalKind: null,
  decisions: ["approve", "deny"],
} as const satisfies ChatLocalRunRequest["ask"];

const questionAsk = {
  kind: "question",
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
} as const satisfies ChatLocalRunRequest["ask"];

/** The call the run asked its approval about, as the stream drew it. */
const commandCall = {
  type: "tool-call",
  id: CALL_ID,
  name: "command_execution",
  arguments: '{"command":"format draft.txt"}',
  input: { command: "format draft.txt" },
  state: "input-complete",
} as const;

const pending = (
  ask: ChatLocalRunRequest["ask"] = approvalAsk,
): ChatLocalRunRequest => ({
  requestId: REQUEST_ID,
  toolCallId: CALL_ID,
  ask,
  status: "pending",
});

/** Every state a request can be in: each status, and each expiry. */
const EVERY_REQUEST_STATE: readonly ChatLocalRunRequest[] =
  CHAT_LOCAL_RUN_REQUEST_STATUSES.flatMap(
    (status: ChatLocalRunRequestStatus): ChatLocalRunRequest[] => {
      const base = { requestId: REQUEST_ID, toolCallId: CALL_ID } as const;
      switch (status) {
        case "expired":
          return CHAT_LOCAL_RUN_REQUEST_EXPIRY.map(
            (expiry: ChatLocalRunRequestExpiry) => ({
              ...base,
              ask: approvalAsk,
              status,
              expiry,
            }),
          );
        case "pending":
        case "resolved":
        case "cancelled":
          return [{ ...base, ask: approvalAsk, status }];
        default:
          status satisfies never;
          return [];
      }
    },
  );

const metadataOf = (requests: readonly ChatLocalRunRequest[]) => ({
  [CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY]: requests,
});

describe("a call's local run request", () => {
  test("is the latest state the answer's metadata names for that call", () => {
    const resolved: ChatLocalRunRequest = {
      ...pending(),
      status: "resolved",
    };
    const other: ChatLocalRunRequest = {
      ...pending(),
      requestId: "00000000-0000-7000-8000-0000000000a2",
      toolCallId: "local:run-1:item_other",
    };
    // An earlier request about the same call, then the one it still asks.
    const asked: ChatLocalRunRequest = {
      ...pending(),
      requestId: "00000000-0000-7000-8000-0000000000a3",
    };

    expect(
      localRunRequestOfCall(metadataOf([resolved, other, asked]), CALL_ID),
    ).toEqual(asked);
    expect(
      localRunRequestOfCall(metadataOf([resolved, other]), CALL_ID),
    ).toEqual(resolved);
  });

  test("is none for a call no request names, or metadata that does not read", () => {
    expect(
      localRunRequestOfCall(metadataOf([pending()]), "local:run-1:item_other"),
    ).toBeNull();
    for (const metadata of [
      undefined,
      null,
      {},
      { [CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY]: "not a list" },
      // One request that does not read voids the list, never a guess.
      {
        [CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY]: [
          { ...pending(), status: "answered" },
        ],
      },
    ]) {
      expect(localRunRequestOfCall(metadata, CALL_ID)).toBeNull();
    }
  });
});

describe("a step the run waits on the member's approval for", () => {
  test("is asked under the request's id only while it is pending in a running turn", () => {
    const asked = awaitedLocalRunApproval(commandCall, pending(), true);
    expect(asked).toEqual({
      ...commandCall,
      state: "approval-requested",
      approval: { id: REQUEST_ID, needsApproval: true },
    });
    // The fixture differs from what the card would draw without it.
    expect(commandCall).not.toHaveProperty("approval");
  });

  test("is not asked in a turn that no longer runs", () => {
    expect(awaitedLocalRunApproval(commandCall, pending(), false)).toBeNull();
  });

  test("is not asked once the request closed, whichever way", () => {
    for (const request of EVERY_REQUEST_STATE) {
      if (request.status === "pending") {
        continue;
      }
      expect({
        request,
        asked: awaitedLocalRunApproval(commandCall, request, true),
      }).toEqual({ request, asked: null });
    }
  });

  test("is never a question, nor a call no request names", () => {
    expect(
      awaitedLocalRunApproval(commandCall, pending(questionAsk), true),
    ).toBeNull();
    expect(awaitedLocalRunApproval(commandCall, null, true)).toBeNull();
  });
});

describe("a request closed without the member's answer", () => {
  test("says why for every state, by whether the turn still runs", () => {
    const reasons = EVERY_REQUEST_STATE.flatMap((request) =>
      [true, false].map((turnRuns) => ({
        state:
          request.status === "expired"
            ? `expired:${request.expiry}`
            : request.status,
        turnRuns,
        reason: unansweredLocalRunRequest(request, turnRuns),
      })),
    );
    expect(reasons).toEqual([
      // Still waiting in a running turn: nothing to say yet.
      { state: "pending", turnRuns: true, reason: null },
      // A pending request in a stopped turn reads as the turn's stop.
      { state: "pending", turnRuns: false, reason: "cancelled" },
      { state: "resolved", turnRuns: true, reason: null },
      { state: "resolved", turnRuns: false, reason: null },
      { state: "expired:run_finished", turnRuns: true, reason: "runFinished" },
      { state: "expired:run_finished", turnRuns: false, reason: "runFinished" },
      { state: "expired:run_failed", turnRuns: true, reason: "runFailed" },
      { state: "expired:run_failed", turnRuns: false, reason: "runFailed" },
      { state: "expired:withdrawn", turnRuns: true, reason: "withdrawn" },
      { state: "expired:withdrawn", turnRuns: false, reason: "withdrawn" },
      { state: "expired:run_lost", turnRuns: true, reason: "runLost" },
      { state: "expired:run_lost", turnRuns: false, reason: "runLost" },
      { state: "cancelled", turnRuns: true, reason: "cancelled" },
      { state: "cancelled", turnRuns: false, reason: "cancelled" },
    ]);
  });

  test("says nothing for a call no request names", () => {
    expect(unansweredLocalRunRequest(null, true)).toBeNull();
    expect(unansweredLocalRunRequest(null, false)).toBeNull();
  });
});
