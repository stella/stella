import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import {
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  ASK_USER_TOOL_NAME,
  CREATE_DOCUMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/native-chat-tool-names";
import type {
  ChatMessage,
  ChatPart,
  ChatTurnOutcome,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  offeredInteractionsOf,
  readThreadInvariantSnapshot,
  threadInvariantViolationsOf,
  type ThreadInvariantSnapshot,
} from "@/api/tests/helpers/chat-thread-invariants";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import { withQueryLogger } from "@/api/tests/security/test-utils";

const userId = toSafeId<"chatMessage">("01900000-0000-7000-8000-000000000001");
const answerId = toSafeId<"chatMessage">(
  "01900000-0000-7000-8000-000000000002",
);
const turnId = toSafeId<"chatTurn">("01900000-0000-7000-8000-000000000003");
const newerTurnId = toSafeId<"chatTurn">(
  "01900000-0000-7000-8000-000000000004",
);

const message = ({
  id,
  ...rest
}: ChatMessage & { id: SafeId<"chatMessage"> }) => ({
  ...toPersistableChatMessage({ id, ...rest }),
  id,
});
const user = message({
  id: userId,
  role: "user",
  parts: [{ type: "text", content: "Proceed." }],
});
const call = (
  state: Extract<ChatPart, { type: "tool-call" }>["state"],
): Extract<ChatPart, { type: "tool-call" }> =>
  ({
    type: "tool-call",
    id: "approval",
    name: "mcp__external__delete",
    arguments: "{}",
    input: {},
    state,
    approval: { id: "approval-id", needsApproval: true },
    ...(state === "complete" ? { output: {} } : {}),
  }) as const satisfies ChatPart;
const answer = (outcome?: ChatTurnOutcome, parts: ChatPart[] = []) =>
  message({
    id: answerId,
    role: "assistant",
    parts,
    ...(outcome === undefined ? {} : { metadata: { turnOutcome: outcome } }),
  });
const turn = (status: ThreadInvariantSnapshot["turns"][number]["status"]) =>
  ({
    assistantMessageId: answerId,
    cancellationReason: null,
    failureCode: null,
    failureRetryable: null,
    id: turnId,
    interruptionReason: null,
    runId: null,
    status,
    userMessageId: userId,
  }) satisfies ThreadInvariantSnapshot["turns"][number];

const reasonCases = [
  {
    status: "cancelled",
    stored: { type: "cancelled", reason: "superseded" },
    cancellationReason: "user-stop",
    interruptionReason: null,
    expectedReason: "user-stop",
  },
  {
    status: "interrupted",
    stored: { type: "interrupted", reason: "owner-lost" },
    cancellationReason: null,
    interruptionReason: "timeout",
    expectedReason: "timeout",
  },
] as const;

const reasonCase = ({
  status,
  stored,
  cancellationReason,
  interruptionReason,
  expectedReason,
}: (typeof reasonCases)[number]) => {
  const owner = { ...turn(status), cancellationReason, interruptionReason };
  const snapshot = {
    messages: [user, answer(stored)],
    turns: [owner],
  } satisfies ThreadInvariantSnapshot;
  const expected = [
    {
      messageId: answerId,
      stored,
      turn: { id: turnId, reason: expectedReason, status },
    },
  ];
  return { snapshot, expected };
};

test.each(reasonCases)(
  "same-type outcomes still compare their reasons (%o)",
  (scenario) => {
    const { snapshot, expected } = reasonCase(scenario);
    expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual(
      expected,
    );
  },
);

test("omitting the real reason predicate fails the same cancelled-outcome assertion", async () => {
  const owner = path.join(import.meta.dir, "chat-thread-invariants.ts");
  const source = readFileSync(owner, "utf-8");
  const predicate = "storedReason(stored) === expected.reason";
  expect(source.split(predicate)).toHaveLength(2);
  const token = Bun.randomUUIDv7();
  const mutant = path.join(
    import.meta.dir,
    `chat-thread-invariants-${token}.mutation.ts`,
  );
  const runner = path.join(
    import.meta.dir,
    `chat-thread-invariants-${token}.assertion.ts`,
  );
  const fixture = reasonCase(reasonCases[0]);
  const assertion = "reason predicate required for cancelled outcome";
  try {
    writeFileSync(mutant, source.replace(predicate, "true"));
    writeFileSync(
      runner,
      `import { deepStrictEqual } from "node:assert/strict";
const { threadInvariantViolationsOf } = await import(process.argv[2]);
const { snapshot, expected } = ${JSON.stringify(fixture)};
deepStrictEqual(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches, expected, ${JSON.stringify(assertion)});
`,
    );
    const run = async (modulePath: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          path.resolve(import.meta.dir, "../setup-env.ts"),
          runner,
          modulePath,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return {
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        status: childExitStatus(child),
        stdout,
        stderr,
      };
    };
    const normal = await run(owner);
    expect(normal.status).toBe(0);
    expect(normal.exitCode).toBe(0);
    const omitted = await run(mutant);
    expect(omitted.status).toBe(1);
    expect(omitted.exitCode).toBe(1);
    expect(omitted.signalCode).toBeNull();
    expect(omitted.stderr).toContain("AssertionError");
    expect(omitted.stderr).toContain(assertion);
  } finally {
    rmSync(mutant, { force: true });
    rmSync(runner, { force: true });
  }
}, 30_000);

test("an answer missing its outcome and an answer with the wrong outcome type both disagree", () => {
  const snapshot = {
    messages: [user, answer()],
    turns: [turn("completed")],
  } satisfies ThreadInvariantSnapshot;
  expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual([
    {
      messageId: answerId,
      stored: null,
      turn: { id: turnId, reason: null, status: "completed" },
    },
  ]);
  const awaitingOutcome = {
    type: "awaiting-user",
    interaction: { type: "approval", toolCallId: "approval" },
  } as const satisfies ChatTurnOutcome;
  snapshot.messages = [user, answer(awaitingOutcome)];
  expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual([
    {
      messageId: answerId,
      stored: awaitingOutcome,
      turn: { id: turnId, reason: null, status: "completed" },
    },
  ]);
});

test("only the latest ordered turn for a user message decides its answer outcome", () => {
  const snapshot = {
    messages: [user, answer({ type: "completed" })],
    turns: [turn("failed"), { ...turn("completed"), id: newerTurnId }],
  } satisfies ThreadInvariantSnapshot;
  expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual(
    [],
  );
  snapshot.turns.reverse();
  expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual([
    {
      messageId: answerId,
      stored: { type: "completed" },
      turn: { id: turnId, reason: null, status: "failed" },
    },
  ]);
});

test("a turn without a named answer finds the first assistant after its user", () => {
  const snapshot = {
    messages: [
      user,
      answer({ type: "cancelled", reason: "superseded" }),
      message({
        id: toSafeId<"chatMessage">("01900000-0000-7000-8000-000000000005"),
        role: "assistant",
        parts: [],
        metadata: { turnOutcome: { type: "completed" } },
      }),
      message({
        id: toSafeId<"chatMessage">("01900000-0000-7000-8000-000000000006"),
        role: "user",
        parts: [{ type: "text", content: "Another request." }],
      }),
      message({
        id: toSafeId<"chatMessage">("01900000-0000-7000-8000-000000000007"),
        role: "assistant",
        parts: [],
        metadata: { turnOutcome: { type: "completed" } },
      }),
    ],
    turns: [
      {
        ...turn("cancelled"),
        assistantMessageId: null,
        cancellationReason: "user-stop",
      },
    ],
  } satisfies ThreadInvariantSnapshot;
  expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual([
    {
      messageId: answerId,
      stored: { type: "cancelled", reason: "superseded" },
      turn: { id: turnId, reason: "user-stop", status: "cancelled" },
    },
  ]);
});

test.each(["accepted", "running"] as const)(
  "a %s turn does not yet require settlement or a stored outcome",
  (status) => {
    const snapshot = {
      messages: [user, answer(undefined, [call("input-streaming")])],
      turns: [turn(status)],
    } satisfies ThreadInvariantSnapshot;
    expect(threadInvariantViolationsOf(snapshot)).toEqual({
      turnOutcomeMismatches: [],
      unownedPendingInteractions: [],
      unsettledToolCalls: [],
    });
  },
);

test("a settled turn with no answer has no outcome to compare", () => {
  const snapshot = {
    messages: [user],
    turns: [turn("failed")],
  } satisfies ThreadInvariantSnapshot;
  expect(threadInvariantViolationsOf(snapshot).turnOutcomeMismatches).toEqual(
    [],
  );
});

test("only an awaiting-user owner makes a pending approval both owned and offered", () => {
  const pending = answer(
    {
      type: "awaiting-user",
      interaction: { type: "approval", toolCallId: "approval" },
    },
    [call("approval-requested")],
  );
  const snapshot = {
    messages: [user, pending],
    turns: [turn("awaiting-user")],
  } satisfies ThreadInvariantSnapshot;
  expect(threadInvariantViolationsOf(snapshot)).toEqual({
    turnOutcomeMismatches: [],
    unownedPendingInteractions: [],
    unsettledToolCalls: [],
  });
  expect(offeredInteractionsOf(snapshot)).toEqual([
    {
      kind: "approval",
      messageId: answerId,
      state: "approval-requested",
      toolCallId: "approval",
    },
  ]);
  snapshot.turns = [turn("completed")];
  expect(
    threadInvariantViolationsOf(snapshot).unownedPendingInteractions,
  ).toEqual([
    {
      messageId: answerId,
      state: "approval-requested",
      toolCallId: "approval",
    },
  ]);
  expect(offeredInteractionsOf(snapshot)).toEqual([]);
});

test.each([
  {
    state: "approval-requested",
    expected: [
      {
        messageId: answerId,
        state: "approval-requested",
        toolCallId: "approval",
      },
    ],
  },
  {
    state: "input-complete",
    expected: [
      { messageId: answerId, state: "input-complete", toolCallId: "approval" },
    ],
  },
  { state: "approval-responded", expected: [] },
  { state: "awaiting-input", expected: [] },
  { state: "complete", expected: [] },
  { state: "error", expected: [] },
  { state: "input-streaming", expected: [] },
] as const)(
  "pending ownership applies precisely to actionable states (%o)",
  ({ state, expected }) => {
    const snapshot = {
      messages: [answer(undefined, [call(state)])],
      turns: [],
    } satisfies ThreadInvariantSnapshot;
    expect(
      threadInvariantViolationsOf(snapshot).unownedPendingInteractions,
    ).toEqual([...expected]);
  },
);

test("completed or ownerless messages cannot retain open server calls", () => {
  const snapshot = {
    messages: [user, answer({ type: "completed" }, [call("input-streaming")])],
    turns: [turn("completed")],
  } satisfies ThreadInvariantSnapshot;
  const expected = [
    { messageId: answerId, state: "input-streaming", toolCallId: "approval" },
  ] satisfies ReturnType<
    typeof threadInvariantViolationsOf
  >["unsettledToolCalls"];
  expect(threadInvariantViolationsOf(snapshot).unsettledToolCalls).toEqual(
    expected,
  );
  expect(
    threadInvariantViolationsOf({ ...snapshot, turns: [] }).unsettledToolCalls,
  ).toEqual(expected);
});

test("the latest owner status governs open calls even when an older owner was live", () => {
  const snapshot = {
    messages: [answer({ type: "completed" }, [call("input-streaming")])],
    turns: [turn("running"), { ...turn("completed"), id: newerTurnId }],
  } satisfies ThreadInvariantSnapshot;
  expect(threadInvariantViolationsOf(snapshot).unsettledToolCalls).toEqual([
    { messageId: answerId, state: "input-streaming", toolCallId: "approval" },
  ]);
});

test("an awaiting-user owner offers approvals, client tools and ask-user calls in message order", () => {
  const snapshot = {
    messages: [
      answer(
        {
          type: "awaiting-user",
          interaction: { type: "approval", toolCallId: "approval" },
        },
        [
          call("approval-requested"),
          {
            ...call("input-complete"),
            id: "document",
            name: CREATE_DOCUMENT_TOOL_NAME,
          },
          {
            ...call("input-complete"),
            id: "question",
            name: ASK_USER_TOOL_NAME,
          },
          { ...call("complete"), id: "finished" },
        ],
      ),
    ],
    turns: [turn("awaiting-user")],
  } satisfies ThreadInvariantSnapshot;
  expect(offeredInteractionsOf(snapshot)).toEqual([
    {
      kind: "approval",
      messageId: answerId,
      state: "approval-requested",
      toolCallId: "approval",
    },
    {
      kind: "client-tool",
      messageId: answerId,
      state: "input-complete",
      toolCallId: "document",
    },
    {
      kind: "ask-user",
      messageId: answerId,
      state: "input-complete",
      toolCallId: "question",
    },
  ]);
});

test("an awaiting-user owner offers only production-recognized pending interactions", () => {
  const snapshot = {
    messages: [
      answer(
        {
          type: "awaiting-user",
          interaction: { type: "approval", toolCallId: "approval" },
        },
        [call("complete"), { type: "text", content: "Ready." }],
      ),
    ],
    turns: [turn("awaiting-user")],
  } satisfies ThreadInvariantSnapshot;
  expect(offeredInteractionsOf(snapshot)).toEqual([]);
});

test("an awaiting-user owner does not offer cards from an outcome already settled", () => {
  const snapshot = {
    messages: [answer({ type: "completed" }, [call("approval-requested")])],
    turns: [turn("awaiting-user")],
  } satisfies ThreadInvariantSnapshot;
  expect(offeredInteractionsOf(snapshot)).toEqual([]);
});

test("one snapshot uses two reads and orders equal timestamps by message and turn ids", async () => {
  const { testDb, ids } = await getRlsFixture();
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const firstMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const secondMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const firstTurnId = toSafeId<"chatTurn">(Bun.randomUUIDv7());
  const secondTurnId = toSafeId<"chatTurn">(Bun.randomUUIDv7());
  const born = new Date("2026-01-01T00:00:00.000Z");
  try {
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      title: "Snapshot ordering",
    });
    await testDb.insert(chatMessages).values([
      {
        id: secondMessageId,
        threadId,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        role: "assistant",
        createdAt: born,
        content: toPersistedChatMessageContentV3({
          data: [],
          metadata: { turnOutcome: { type: "completed" } },
        }),
      },
      {
        id: firstMessageId,
        threadId,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        role: "user",
        createdAt: born,
        content: toPersistedChatMessageContentV3({
          data: [{ type: "text", content: "Proceed." }],
        }),
      },
    ]);
    const owner = {
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      threadId,
      userMessageId: firstMessageId,
      assistantMessageId: secondMessageId,
      status: "completed",
      createdAt: born,
      settledAt: born,
    } as const;
    await testDb.insert(chatTurns).values([
      { ...owner, id: secondTurnId },
      { ...owner, id: firstTurnId },
    ]);
    const queries: string[] = [];
    const snapshot = await readThreadInvariantSnapshot({
      threadId,
      db: withQueryLogger(testDb, {
        logQuery: (query) => {
          queries.push(query);
        },
      }),
    });
    expect(queries).toHaveLength(2);
    expect(
      queries.every((query) =>
        query.trimStart().toLowerCase().startsWith("select"),
      ),
    ).toBe(true);
    expect(snapshot.messages.map(({ id }) => id)).toEqual(
      [firstMessageId, secondMessageId].toSorted(),
    );
    expect(snapshot.turns.map(({ id }) => id)).toEqual(
      [firstTurnId, secondTurnId].toSorted(),
    );
    expect(threadInvariantViolationsOf(snapshot)).toEqual({
      turnOutcomeMismatches: [],
      unownedPendingInteractions: [],
      unsettledToolCalls: [],
    });
  } finally {
    await testDb.delete(chatThreads).where(eq(chatThreads.id, threadId));
    await releaseRlsFixture();
  }
});
