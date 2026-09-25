import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
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
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import type { WebChatClient } from "@/api/tests/helpers/chat-web-client";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// An approved server tool runs inside the continuation that resumes its turn.
// Whatever the model does next, the stored thread must carry that call's
// result, so a reload shows it settled and the thread's next turn starts clean.
// The web app's chat runtime answers the approval card it shows, and the
// harness checks the stored thread, the wire and the live view against a
// reload after every step.

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

const openThread = async () => {
  const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const client = await harness.openWebClient(threadId);
  return { client, harness, threadId };
};

const closeThread = ({
  client,
  harness,
}: {
  client: WebChatClient;
  harness: ChatHarness;
}) => {
  client.dispose();
  harness.close();
};

const storedCall = (
  messages: readonly { parts: readonly ChatPart[] }[],
  toolCallId: string,
) =>
  messages
    .flatMap(({ parts }) => parts)
    .find((part) => part.type === "tool-call" && part.id === toolCallId);

/**
 * Asks for the approval-gated tool on `name` and approves its card, with
 * `continuation` scripting the model's steps after the tool runs. Returns the
 * approved call's id.
 */
const requestAndApprove = async ({
  client,
  continuation,
  harness,
  name,
  threadId,
}: {
  client: WebChatClient;
  continuation: ScriptedTurn[];
  harness: ChatHarness;
  name: string;
  threadId: SafeId<"chatThread">;
}): Promise<string> => {
  const callId = `call-${name}`;
  harness.script(threadId, [
    {
      arguments: approvalToolArguments(name),
      toolCallId: callId,
      toolName: APPROVAL_TOOL_NAME,
      type: "tool-call",
    },
  ]);
  await client.sendUserMessage(Bun.randomUUIDv7(), `Delete the ${name}`);
  await harness.expectSoundWebClient({ client, threadId });

  harness.script(threadId, continuation);
  await client.approve(callId, true);
  await harness.expectSoundWebClient({ client, threadId });
  return callId;
};

/**
 * `requestAndApprove` on the server's own request path: the approval is
 * answered from the stored thread rather than from a page, and the harness
 * checks the wire and the stored thread after each send.
 */
const requestAndApproveStored = async ({
  continuation,
  harness,
  name,
  threadId,
}: {
  continuation: ScriptedTurn[];
  harness: ChatHarness;
  name: string;
  threadId: SafeId<"chatThread">;
}): Promise<void> => {
  const runId = `run-${Bun.randomUUIDv7()}`;
  harness.script(threadId, [
    {
      arguments: approvalToolArguments(name),
      toolCallId: `call-${name}`,
      toolName: APPROVAL_TOOL_NAME,
      type: "tool-call",
    },
  ]);
  expect(
    await harness.send(
      harness.sendContext({
        message: {
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          parts: [{ content: `Delete the ${name}`, type: "text" }],
          role: "user",
        },
        runId,
        threadId,
      }),
    ),
  ).toEqual({ status: "streamed" });

  const pending = await harness.lastAssistant(threadId);
  const call = pendingApprovalCallOf(pending.parts);

  harness.script(threadId, continuation);
  expect(
    await harness.send(
      harness.approveContext({
        call,
        interruptedRunId: runId,
        messageId: pending.id,
        parts: pending.parts,
        threadId,
      }),
    ),
  ).toEqual({ status: "streamed" });
};

describe("an approved server tool's result", () => {
  test("is stored on its owning message when the model's next step is another approval", async () => {
    // The second call is still open, and owned by the turn awaiting its answer;
    // the first is settled.
    const thread = await openThread();
    const { harness, threadId } = thread;
    try {
      const callId = await requestAndApprove({
        ...thread,
        continuation: [
          {
            arguments: approvalToolArguments("Lease"),
            toolCallId: "call-Lease",
            toolName: APPROVAL_TOOL_NAME,
            type: "tool-call",
          },
        ],
        name: "NDA",
      });

      expect(harness.executions).toEqual(["NDA"]);
      expect(
        storedCall(await harness.readThreadMessages(threadId), callId),
      ).toMatchObject({ output: { deleted: "NDA" }, state: "complete" });
    } finally {
      closeThread(thread);
    }
  });

  test("is stored on its owning message when the model answers in text", async () => {
    const thread = await openThread();
    const { harness, threadId } = thread;
    try {
      const callId = await requestAndApprove({
        ...thread,
        continuation: [
          { finishReason: "stop", text: "Deleted.", type: "text" },
        ],
        name: "NDA",
      });

      // The fixture must reach the fault: the tool ran and the turn settled.
      expect(harness.executions).toEqual(["NDA"]);
      expect(
        storedCall(await harness.readThreadMessages(threadId), callId),
      ).toMatchObject({ output: { deleted: "NDA" }, state: "complete" });
    } finally {
      closeThread(thread);
    }
  });

  test("leaves a later approval in the same thread answerable", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    try {
      await requestAndApproveStored({
        continuation: [
          { finishReason: "stop", text: "Deleted.", type: "text" },
        ],
        harness,
        name: "NDA",
        threadId,
      });
      await requestAndApproveStored({
        continuation: [
          { finishReason: "stop", text: "Deleted too.", type: "text" },
        ],
        harness,
        name: "Lease",
        threadId,
      });

      expect(harness.executions).toEqual(["NDA", "Lease"]);
    } finally {
      harness.close();
    }
  });

  test("leaves a later approval in the same thread answerable from the page", async () => {
    const thread = await openThread();
    const { harness } = thread;
    try {
      await requestAndApprove({
        ...thread,
        continuation: [
          { finishReason: "stop", text: "Deleted.", type: "text" },
        ],
        name: "NDA",
      });
      await requestAndApprove({
        ...thread,
        continuation: [
          { finishReason: "stop", text: "Deleted too.", type: "text" },
        ],
        name: "Lease",
      });

      expect(harness.executions).toEqual(["NDA", "Lease"]);
    } finally {
      closeThread(thread);
    }
  });
});
