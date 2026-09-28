import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A turn's run owns the turn once the send hands its response back. The
// harness tears every request down at that moment: its signal aborts and any
// later read of it is a `chat.run.outlives-request` finding. Here nobody reads
// the response until the turn has settled, so the run can only have finished
// on its own.

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

describe("a turn's run", () => {
  test("runs an approved call to completion after its request is torn down, with nobody reading", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    try {
      const runId = `run-${Bun.randomUUIDv7()}`;
      harness.script(threadId, [
        {
          arguments: approvalToolArguments("NDA"),
          toolCallId: "call-NDA",
          toolName: APPROVAL_TOOL_NAME,
          type: "tool-call",
        },
      ]);
      expect(
        await harness.send(
          harness.sendContext({
            message: {
              id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
              parts: [{ content: "Delete the NDA", type: "text" }],
              role: "user",
            },
            runId,
            threadId,
          }),
          { readAfterSettling: true },
        ),
      ).toEqual({ status: "streamed" });
      const pending = await harness.lastAssistant(threadId);

      harness.script(threadId, [
        { finishReason: "stop", text: "Deleted.", type: "text" },
      ]);
      expect(
        await harness.send(
          harness.approveContext({
            call: pendingApprovalCallOf(pending.parts),
            interruptedRunId: runId,
            messageId: pending.id,
            parts: pending.parts,
            threadId,
          }),
          { readAfterSettling: true },
        ),
      ).toEqual({ status: "streamed" });

      // The approved call ran once, inside the run, and the turn completed
      // with its answer stored.
      expect(harness.executions).toEqual(["NDA"]);
      expect(
        await testDb
          .select({ status: chatTurns.status })
          .from(chatTurns)
          .where(eq(chatTurns.threadId, threadId)),
      ).toEqual([{ status: "completed" }]);
      expect(
        (await harness.lastAssistant(threadId)).parts.find(
          (part) => part.type === "text" && part.content === "Deleted.",
        ),
      ).toBeDefined();
    } finally {
      harness.close();
    }
  });
});
