import { EventType } from "@tanstack/ai";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import {
  CHAT_TOOL_DECLINED_ERROR,
  isDeclinedChatToolCall,
} from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { declineToolCall } from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A call the user declines is stored in one shape, whoever declines it: the
// engine when the page answers Deny, or the API when a new message
// supersedes an approval nobody answered. The engine runs for real behind a
// scripted model, and what the page reads while the turn streams must show
// the declined call exactly as a reload does.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const newThreadId = () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  return threadId;
};

const askToDelete = (name: string) => ({
  arguments: approvalToolArguments(name),
  toolCallId: `call-${name}`,
  toolName: APPROVAL_TOOL_NAME,
  type: "tool-call" as const,
});

/** What a reader sees of a call: its state, its decision and its output. */
const callView = (part: unknown) =>
  typeof part === "object" &&
  part !== null &&
  Reflect.get(part, "type") === "tool-call"
    ? {
        approved: asTestRaw<{ approved?: unknown } | undefined>(
          Reflect.get(part, "approval"),
        )?.approved,
        id: Reflect.get(part, "id"),
        output: Reflect.get(part, "output"),
        state: Reflect.get(part, "state"),
      }
    : null;

/** The declined call and the result answering it, as stored. */
const storedDenial = (parts: readonly ChatPart[], toolCallId: string) => ({
  call: callView(
    parts.find((part) => part.type === "tool-call" && part.id === toolCallId),
  ),
  result: parts.flatMap((part) =>
    part.type === "tool-result" && part.toolCallId === toolCallId
      ? [{ error: part.error, outcome: part.outcome, state: part.state }]
      : [],
  ),
});

/** The parts every snapshot of an SSE body carries for `toolCallId`. */
const snapshotCallsOf = (body: string, toolCallId: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line): unknown => JSON.parse(line.slice("data: ".length)))
    .filter(
      (chunk) =>
        typeof chunk === "object" &&
        chunk !== null &&
        Reflect.get(chunk, "type") === EventType.MESSAGES_SNAPSHOT,
    )
    .flatMap(
      (chunk) =>
        asTestRaw<{ messages: { parts?: unknown[] }[] }>(chunk).messages,
    )
    .flatMap(({ parts }) => parts ?? [])
    .map(callView)
    .filter((view) => view?.id === toolCallId);

/** A pending approval declined by the API's own writer. */
const declinedByWriter = (toolCallId: string) => {
  const name = toolCallId.replace(/^call-/u, "");
  const pending = {
    approval: { id: `approval_${toolCallId}`, needsApproval: true },
    arguments: approvalToolArguments(name),
    id: toolCallId,
    input: { name },
    name: APPROVAL_TOOL_NAME,
    state: "approval-requested",
    type: "tool-call",
  } as const satisfies ChatPart;
  const { call, result } = declineToolCall(pending, pending.approval);
  return {
    call: callView(call),
    result: [
      { error: result.error, outcome: result.outcome, state: result.state },
    ],
  };
};

const closeHarness = async (harness: ChatHarness) => {
  await harness.close();
};

describe("a declined tool call", () => {
  test("streams and reloads in the shape the engine stores", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    const client = await harness.openWebClient(threadId);
    try {
      const recording = harness.recordThread(threadId);
      harness.script(threadId, [askToDelete("NDA")]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Delete the NDA");
      await harness.expectSoundWebClient({ client, threadId });

      // After the decline the model asks for a second approval, so the run
      // ends on an interrupt whose snapshot carries the declined call.
      harness.script(threadId, [askToDelete("Lease")]);
      await client.approve("call-NDA", false);
      await harness.expectSoundWebClient({ client, threadId });

      expect(harness.executions).toEqual([]);
      const stored = await harness.lastAssistant(threadId);
      const denial = storedDenial(stored.parts, "call-NDA");
      // The engine settled the call as the API's writer stores a denial.
      expect(denial).toEqual(declinedByWriter("call-NDA"));
      expect(denial).toEqual({
        call: {
          approved: false,
          id: "call-NDA",
          output: { error: CHAT_TOOL_DECLINED_ERROR },
          state: "error",
        },
        result: [
          {
            error: CHAT_TOOL_DECLINED_ERROR,
            outcome: "denied",
            state: "error",
          },
        ],
      });

      // The wire: every snapshot of the decline's response that carries the
      // call carries it as stored. The fixture reaches the snapshot.
      const decline = recording.at(-1);
      const snapshotCalls = snapshotCallsOf(
        decline?.response.body ?? "",
        "call-NDA",
      );
      expect(snapshotCalls.length).toBeGreaterThan(0);
      for (const view of snapshotCalls) {
        expect(view).toEqual(denial.call);
      }

      // The page live, and the page after a reload.
      const liveCall = client
        .messages()
        .flatMap(({ parts }) => parts)
        .map(callView)
        .find((view) => view?.id === "call-NDA");
      const reloadedCall = (await harness.reloadView(threadId))
        .flatMap(({ parts }) => parts)
        .map(callView)
        .find((view) => view?.id === "call-NDA");
      expect(liveCall).toEqual(denial.call);
      expect(reloadedCall).toEqual(denial.call);
    } finally {
      client.dispose();
      await closeHarness(harness);
    }
  });

  test("is stored in the same shape when a new message supersedes its approval", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    try {
      harness.script(threadId, [askToDelete("NDA")]);
      expect(
        await harness.send(
          harness.sendContext({
            message: {
              id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
              parts: [{ content: "Delete the NDA", type: "text" }],
              role: "user",
            },
            runId: `run-${Bun.randomUUIDv7()}`,
            threadId,
          }),
        ),
      ).toEqual({ status: "streamed" });
      const pending = await harness.lastAssistant(threadId);
      // The fixture reaches the fault: the approval waits on the user.
      expect(pendingApprovalCallOf(pending.parts).id).toBe("call-NDA");

      harness.script(threadId, [
        { finishReason: "stop", text: "Kept.", type: "text" },
      ]);
      expect(
        await harness.send(
          harness.sendContext({
            message: {
              id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
              parts: [{ content: "Never mind", type: "text" }],
              role: "user",
            },
            runId: `run-${Bun.randomUUIDv7()}`,
            threadId,
          }),
        ),
      ).toEqual({ status: "streamed" });

      const superseded = (await harness.readThreadMessages(threadId)).find(
        ({ id }) => id === pending.id,
      );
      const parts = superseded?.parts ?? [];
      expect(
        parts.some(
          (part) => part.type === "tool-call" && isDeclinedChatToolCall(part),
        ),
      ).toBe(true);
      expect(storedDenial(parts, "call-NDA")).toEqual(
        declinedByWriter("call-NDA"),
      );
      expect(harness.executions).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });
});
