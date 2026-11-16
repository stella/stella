import { describe, expect, test } from "bun:test";

import {
  ASK_USER_TOOL_NAME,
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  CHAT_TURN_INTERACTION_TYPES,
  type ChatToolExecutor,
  type ChatTurnInteractionType,
  CREATE_DOCUMENT_TOOL_NAME,
} from "./chat";
import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "./chat-local-run-question";
import { isMemberAnsweredPart, memberWaitsOf } from "./chat-member-wait";
import { REQUEST_SECRET_TOOL_NAME } from "./chat-secret";

const call = ({
  approved,
  executor,
  name,
  output,
  state,
}: {
  approved?: boolean;
  executor: ChatToolExecutor;
  name: string;
  output?: unknown;
  state: string;
}) => ({
  type: "tool-call",
  id: `call-${name}-${state}`,
  name,
  state,
  input: {},
  metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: executor },
  ...(approved === undefined
    ? {}
    : { approval: { id: "approval-1", needsApproval: true, approved } }),
  ...(output === undefined ? {} : { output }),
});

// One stored call per kind of wait a turn row records. Keyed by the
// contract's list, so a new kind does not compile until it has a call here.
const WAITING_CALL = {
  approval: call({
    executor: "server",
    name: "search_documents",
    state: "approval-requested",
  }),
  "ask-user": call({
    executor: "client",
    name: ASK_USER_TOOL_NAME,
    state: "input-complete",
  }),
  "client-tool": call({
    executor: "client",
    name: CREATE_DOCUMENT_TOOL_NAME,
    state: "input-complete",
  }),
  "harness-question": call({
    executor: "harness",
    name: CHAT_LOCAL_RUN_QUESTION_TOOL,
    state: "input-complete",
  }),
} as const satisfies Record<ChatTurnInteractionType, unknown>;

const MEMBER_ANSWERS = {
  approval: true,
  "ask-user": true,
  // A document draft the app compiles on its own.
  "client-tool": false,
  "harness-question": true,
} as const satisfies Record<ChatTurnInteractionType, boolean>;

const assistant = (parts: readonly unknown[], metadata?: unknown) => ({
  role: "assistant",
  parts,
  ...(metadata === undefined ? {} : { metadata }),
});

/** What one part alone makes its message wait on. */
const waitOf = (part: unknown) =>
  memberWaitsOf(assistant([part])).at(0) ?? null;

describe("what a turn waits on", () => {
  test.each([...CHAT_TURN_INTERACTION_TYPES])(
    "a %s call makes its turn wait, and only the member answers the kinds that ask them",
    (type) => {
      const part = WAITING_CALL[type];
      expect(memberWaitsOf(assistant([part]))).toEqual([
        { type, toolCallId: part.id },
      ]);
      expect(isMemberAnsweredPart(part)).toBe(MEMBER_ANSWERS[type]);
    },
  );

  test("a card that asks the member for input is theirs to answer", () => {
    const part = call({
      executor: "client",
      name: REQUEST_SECRET_TOOL_NAME,
      state: "input-complete",
    });
    expect(waitOf(part)?.type).toBe("client-tool");
    expect(isMemberAnsweredPart(part)).toBe(true);
  });

  test("an approved client call waits for the app, not the member", () => {
    const part = call({
      approved: true,
      executor: "client",
      name: REQUEST_SECRET_TOOL_NAME,
      state: "approval-responded",
    });
    expect(waitOf(part)?.type).toBe("client-tool");
    expect(isMemberAnsweredPart(part)).toBe(false);
    expect(waitOf({ ...part, output: { value: "done" } })).toBeNull();
  });

  test("a call the API or a harness runs waits on nobody once its input is in", () => {
    for (const executor of ["server", "harness"] as const) {
      const part = call({
        executor,
        name: ASK_USER_TOOL_NAME,
        state: "input-complete",
      });
      expect(waitOf(part)).toBeNull();
    }
  });

  test("calls still streaming or settled wait on nothing", () => {
    for (const state of [
      "awaiting-input",
      "input-streaming",
      "complete",
      "error",
    ]) {
      expect(
        waitOf(call({ executor: "client", name: ASK_USER_TOOL_NAME, state })),
      ).toBeNull();
    }
  });

  test("a message whose turn settled waits on nothing, whatever its parts", () => {
    const parts = Object.values(WAITING_CALL);
    expect(memberWaitsOf(assistant(parts))).toHaveLength(parts.length);
    expect(
      memberWaitsOf(
        assistant(parts, { turnOutcome: { type: "awaiting-user" } }),
      ),
    ).toHaveLength(parts.length);
    for (const type of ["completed", "cancelled", "failed", "interrupted"]) {
      expect(
        memberWaitsOf(assistant(parts, { turnOutcome: { type } })),
      ).toEqual([]);
    }
    expect(memberWaitsOf({ role: "user", parts })).toEqual([]);
    expect(memberWaitsOf(null)).toEqual([]);
  });

  test("parts that are not tool calls are never waits", () => {
    for (const part of [
      null,
      "approval-requested",
      { type: "text", content: "hi" },
      { type: "tool-call", id: 1, name: "x", state: "approval-requested" },
    ]) {
      expect(waitOf(part)).toBeNull();
    }
  });
});
