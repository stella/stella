import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { UNFINISHED_APPROVED_CALL_ERROR } from "@/api/handlers/chat/chat-turn-settlement";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { findUnownedPendingInteractions } from "@/api/tests/helpers/chat-thread-invariants";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createForkThread } from "./create";

// A fork copies history but not turn ownership (`chat_turns`). This suite runs
// a real approval round trip — the `chat()` loop pausing on an approval-gated
// tool, persisted through `send-message` — then forks the thread at that
// pending answer and answers the approval on both threads.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];
const openHarnesses: ChatHarness[] = [];

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
  // Each harness restores what the previous one installed: undo in reverse.
  for (const harness of openHarnesses.toReversed()) {
    harness.close();
  }
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

describe("forking a thread at a pending approval", () => {
  test("the fork carries no answerable approval, and the approved tool runs once, on the source thread", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    openHarnesses.push(harness);
    const {
      approveContext,
      executions,
      lastAssistant,
      script,
      send,
      sendContext,
    } = harness;
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const firstRunId = `run-${Bun.randomUUIDv7()}`;

    script(threadId, [
      {
        arguments: approvalToolArguments("NDA"),
        toolName: APPROVAL_TOOL_NAME,
        type: "tool-call",
      },
    ]);
    expect(
      await send(
        sendContext({
          message: {
            id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
            parts: [{ content: "Delete the NDA", type: "text" }],
            role: "user",
          },
          runId: firstRunId,
          threadId,
        }),
      ),
    ).toEqual({ status: "streamed" });

    const pending = await lastAssistant(threadId);
    const pendingCall = pendingApprovalCallOf(pending.parts);
    // The fixture must reach the fault: the source thread's answer is a live
    // approval owned by its awaiting turn.
    expect(pendingCall.state).toBe("approval-requested");
    expect(
      await findUnownedPendingInteractions({ db: testDb, threadId }),
    ).toEqual([]);

    const forkThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(forkThreadId);
    const forked = await createForkThread({
      indexChatThread: async () => undefined,
    }).handler(
      asTestRaw<Parameters<ReturnType<typeof createForkThread>["handler"]>[0]>({
        body: { newThreadId: forkThreadId, upToMessageId: pending.id },
        getWorkspaceAccess: async () => null,
        memberRole: { role: "owner" },
        params: { threadId },
        query: {},
        recordAuditEvent: async () => undefined,
        request: new Request("http://localhost/v1/chat/threads/fork"),
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      }),
    );
    expect(forked).toMatchObject({ threadId: forkThreadId });

    expect(
      await findUnownedPendingInteractions({
        db: testDb,
        threadId: forkThreadId,
      }),
    ).toEqual([]);

    // Approve on the source thread: the loop executes the tool, then answers.
    script(threadId, [
      { finishReason: "stop", text: "Deleted.", type: "text" },
    ]);
    expect(
      await send(
        approveContext({
          call: pendingCall,
          interruptedRunId: firstRunId,
          messageId: pending.id,
          parts: pending.parts,
          threadId,
        }),
      ),
    ).toEqual({ status: "streamed" });
    expect(executions).toEqual(["NDA"]);

    // The same approval, answered on the fork, is not a resumable interaction.
    const forkAnswer = await lastAssistant(forkThreadId);
    script(forkThreadId, [
      { finishReason: "stop", text: "Deleted again.", type: "text" },
    ]);
    const forkResult = await send(
      approveContext({
        call: pendingCall,
        interruptedRunId: firstRunId,
        messageId: forkAnswer.id,
        parts: pending.parts,
        threadId: forkThreadId,
      }),
    );
    expect({ executions, fork: forkResult.status }).toEqual({
      executions: ["NDA"],
      fork: "rejected",
    });
  });
});

describe("forking a thread whose approved call lost its result", () => {
  test("the fork holds the call as unfinished and never runs it", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    openHarnesses.push(harness);
    const { executions, lastAssistant, script, send, sendContext } = harness;
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);

    script(threadId, [
      {
        arguments: approvalToolArguments("NDA"),
        toolName: APPROVAL_TOOL_NAME,
        type: "tool-call",
      },
    ]);
    expect(
      await send(
        sendContext({
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
    const pending = await lastAssistant(threadId);
    const pendingCall = pendingApprovalCallOf(pending.parts);

    // The stored shape a run leaves when its process dies after the approved
    // call ran and before the result was saved. No production path writes it
    // on purpose, so it is written directly.
    const [stored] = await testDb
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.id, pending.id));
    const content = stored?.content;
    if (content === undefined) {
      throw new Error("Expected stored message content");
    }
    const data: unknown[] = [...content.data];
    const callIndex = data.findIndex(
      (part) => isRecord(part) && part["id"] === pendingCall.id,
    );
    const storedCall = data[callIndex];
    if (!isRecord(storedCall)) {
      throw new Error("Expected the stored approval call");
    }
    data[callIndex] = {
      ...storedCall,
      approval: { ...pendingCall.approval, approved: true },
      state: "approval-responded",
    };
    await testDb
      .update(chatMessages)
      .set({
        content: asTestRaw<PersistedChatMessageContent>({ ...content, data }),
      })
      .where(eq(chatMessages.id, pending.id));

    const forkThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(forkThreadId);
    const forked = await createForkThread({
      indexChatThread: async () => undefined,
    }).handler(
      asTestRaw<Parameters<ReturnType<typeof createForkThread>["handler"]>[0]>({
        body: { newThreadId: forkThreadId, upToMessageId: pending.id },
        getWorkspaceAccess: async () => null,
        memberRole: { role: "owner" },
        params: { threadId },
        query: {},
        recordAuditEvent: async () => undefined,
        request: new Request("http://localhost/v1/chat/threads/fork"),
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      }),
    );
    expect(forked).toMatchObject({ threadId: forkThreadId });
    const forkedAnswer = await lastAssistant(forkThreadId);
    expect({
      call: forkedAnswer.parts.find(
        (part) => part.type === "tool-call" && part.id === pendingCall.id,
      ),
      outcome: forkedAnswer.metadata?.turnOutcome,
    }).toMatchObject({
      call: {
        output: { error: UNFINISHED_APPROVED_CALL_ERROR },
        state: "error",
      },
      // Nothing is left to answer, and no turn owns the fork's copy.
      outcome: { reason: "superseded", type: "cancelled" },
    });

    script(forkThreadId, [
      { finishReason: "stop", text: "Anything else?", type: "text" },
    ]);
    expect(
      await send(
        sendContext({
          message: {
            id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
            parts: [{ content: "Thanks", type: "text" }],
            role: "user",
          },
          runId: `run-${Bun.randomUUIDv7()}`,
          threadId: forkThreadId,
        }),
      ),
    ).toEqual({ status: "streamed" });
    expect(executions).toEqual([]);
  });
});
