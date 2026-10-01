import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { isRecord } from "@/api/lib/type-guards";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A chat turn the anonymized boundary refuses is measured twice: the refusal
// where it was built, and the turn's failed settlement under its boundary
// mode, so the failure rate of anonymized turns can be watched in production.
// The turn runs through the real send handler and `streamChat`; only the
// anonymizer behind the boundary is replaced, by one that fails.

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

afterEach(() => {
  resetMetricLineSinkForTesting();
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

/** The records of `metric` among the EMF lines written. */
const recordsOf = (lines: readonly string[], metric: string) =>
  lines
    .map((line): unknown => JSON.parse(line))
    .filter(
      (record): record is Record<string, unknown> =>
        isRecord(record) && metric in record,
    );

const collectMetricLines = (): string[] => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  return lines;
};

const turnStatusesOf = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ failureCode: chatTurns.failureCode, status: chatTurns.status })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId))
  ).map(({ failureCode, status }) => ({ failureCode, status }));

describe("chat turn outcome metrics", () => {
  test("a turn the anonymized boundary refuses counts the refusal and the failed turn", async () => {
    const harness = createApprovalHarness({
      boundaryAnonymizer: async () =>
        await Promise.reject(new Error("anonymizer unavailable")),
      ids,
      safeDb,
      scopedDb,
      testDb,
    });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const lines = collectMetricLines();
    try {
      await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
        sendMode: CHAT_SEND_MODE.anonymized,
      });
      await client.settle();

      // The fixture reaches the fault: the page shows the turn failed and
      // its row says so.
      expect(client.runtimeState().hasError).toBe(true);
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: "internal", status: "failed" },
      ]);

      expect(
        recordsOf(lines, "AnonymizationRefusals").map(({ reason, site }) => ({
          reason,
          site,
        })),
      ).toEqual([{ reason: "pipeline_error", site: "text_batch" }]);
      expect(
        recordsOf(lines, "ChatTurnSettlements").map(
          ({ failure_code, mode, outcome, provider }) => ({
            failure_code,
            mode,
            outcome,
            provider,
          }),
        ),
      ).toEqual([
        {
          failure_code: "internal",
          mode: "anonymized",
          outcome: "failed",
          // Refused before the model was resolved.
          provider: "none",
        },
      ]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("a completed raw turn counts once, under its provider, with no refusal", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const lines = collectMetricLines();
    try {
      harness.script(threadId, [
        { type: "step", text: "Hello back.", toolCalls: [] },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
        sendMode: CHAT_SEND_MODE.rawOverride,
      });
      await client.settle();

      expect(client.runtimeState().hasError).toBe(false);
      expect(recordsOf(lines, "AnonymizationRefusals")).toEqual([]);
      expect(
        recordsOf(lines, "ChatTurnSettlements").map(
          ({ failure_code, mode, outcome, provider }) => ({
            failure_code,
            mode,
            outcome,
            provider,
          }),
        ),
      ).toEqual([
        {
          failure_code: "none",
          mode: "raw",
          outcome: "completed",
          provider: "openai",
        },
      ]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });
});
