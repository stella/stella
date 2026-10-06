import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, TransactionRollbackError } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import { aiMemories } from "@/api/db/schema";
import { deletePersonalAiMemories } from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const dedupKey = () => hashSha256Hex(Bun.randomUUIDv7());

describe("account deletion assistant memory", () => {
  test("removes the user's own memories and pending suggestions and keeps shared memory unattributed", async () => {
    try {
      await testDb.transaction(async (tx) => {
        const personalActiveId = createSafeId<"aiMemory">();
        const personalArchivedId = createSafeId<"aiMemory">();
        const pendingSuggestionId = createSafeId<"aiMemory">();
        const sharedMatterId = createSafeId<"aiMemory">();
        const sharedFirmId = createSafeId<"aiMemory">();
        const otherUserId = createSafeId<"aiMemory">();
        const seededIds = [
          personalActiveId,
          personalArchivedId,
          pendingSuggestionId,
          sharedMatterId,
          sharedFirmId,
          otherUserId,
        ];

        await tx.insert(aiMemories).values([
          {
            id: personalActiveId,
            organizationId: ids.orgA,
            scope: "user",
            userId: ids.userA1,
            kind: "preference",
            content: "Personal active memory",
            dedupKey: dedupKey(),
            source: "user",
            createdBy: ids.userA1,
          },
          {
            id: personalArchivedId,
            organizationId: ids.orgA,
            scope: "user",
            userId: ids.userA1,
            kind: "instruction",
            content: "Personal archived memory",
            dedupKey: dedupKey(),
            source: "user",
            status: "archived",
            createdBy: ids.userA1,
          },
          {
            id: pendingSuggestionId,
            organizationId: ids.orgA,
            scope: "workspace",
            workspaceId: ids.wsA2,
            kind: "fact",
            content: "Pending matter suggestion",
            dedupKey: dedupKey(),
            source: "extracted",
            status: "suggested",
            createdBy: ids.userA1,
            sourceDataWorkspaceIds: [ids.wsA2],
          },
          {
            id: sharedMatterId,
            organizationId: ids.orgA,
            scope: "workspace",
            workspaceId: ids.wsA2,
            kind: "fact",
            content: "Accepted matter memory",
            dedupKey: dedupKey(),
            source: "tool",
            createdBy: ids.userA1,
          },
          {
            id: sharedFirmId,
            organizationId: ids.orgA,
            scope: "organization",
            kind: "instruction",
            content: "Firm memory",
            dedupKey: dedupKey(),
            source: "user",
            createdBy: ids.userA1,
          },
          {
            id: otherUserId,
            organizationId: ids.orgA,
            scope: "user",
            userId: ids.userA2,
            kind: "preference",
            content: "Another user's memory",
            dedupKey: dedupKey(),
            source: "user",
            createdBy: ids.userA2,
          },
        ]);

        const selectSeeded = () =>
          tx
            .select({ createdBy: aiMemories.createdBy, id: aiMemories.id })
            .from(aiMemories)
            .where(inArray(aiMemories.id, seededIds));

        // The fixture must reach the fault: every seeded row exists first.
        expect(await selectSeeded()).toHaveLength(seededIds.length);

        await deletePersonalAiMemories(asTestRaw<Transaction>(tx), ids.userA1);

        const remaining = await selectSeeded();
        expect(remaining).toHaveLength(3);
        expect(remaining).toEqual(
          expect.arrayContaining([
            { createdBy: null, id: sharedMatterId },
            { createdBy: null, id: sharedFirmId },
            { createdBy: ids.userA2, id: otherUserId },
          ]),
        );

        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }

    throw new Error("Expected the integration test transaction to roll back");
  });
});
