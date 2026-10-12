import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { findDecisionChatThread } from "./decision-thread";

// A decision's chat is one conversation per reader: reopening the decision
// finds the reader's own newest global thread about it, never another
// reader's, never a matter's, never one about another decision.

let testDb: TestDatabase;
let ids: TestIds;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const seedThread = async ({
  decisionId,
  updatedAt,
  userId = ids.userA1,
  workspaceId = null,
}: {
  decisionId: SafeId<"caseLawDecision"> | null;
  updatedAt: Date;
  userId?: string;
  workspaceId?: SafeId<"workspace"> | null;
}) => {
  const id = createSafeId<"chatThread">();
  seededThreadIds.push(id);
  await testDb.insert(chatThreads).values({
    id,
    organizationId: ids.orgA,
    subjectDecisionId: decisionId,
    title: "Decision chat",
    titleSource: "user",
    updatedAt,
    userId,
    workspaceId,
  });
  return id;
};

const find = async (decisionId: SafeId<"caseLawDecision">) =>
  (
    await findDecisionChatThread({
      decisionId,
      organizationId: ids.orgA,
      safeDb: toSafeDbMock(
        asTestRaw<ScopedDb>(
          createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        ),
      ),
      userId: ids.userA1,
    })
  ).unwrap();

describe("finding a reader's conversation about a decision", () => {
  test("answers the reader's newest global thread about that decision", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    await seedThread({ decisionId, updatedAt: new Date("2026-07-01") });
    const newest = await seedThread({
      decisionId,
      updatedAt: new Date("2026-07-02"),
    });
    // Neither a matter's thread, another reader's, nor one about another
    // decision may answer, however recent.
    await seedThread({
      decisionId,
      updatedAt: new Date("2026-07-03"),
      workspaceId: ids.wsA1,
    });
    await seedThread({
      decisionId,
      updatedAt: new Date("2026-07-03"),
      userId: ids.userA2,
    });
    await seedThread({
      decisionId: createSafeId<"caseLawDecision">(),
      updatedAt: new Date("2026-07-03"),
    });

    expect(await find(decisionId)).toEqual({ threadId: newest });
  });

  test("answers null when the reader has no conversation about it yet", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    await seedThread({
      decisionId,
      updatedAt: new Date("2026-07-01"),
      userId: ids.userA2,
    });

    expect(await find(decisionId)).toEqual({ threadId: null });
  });
});
