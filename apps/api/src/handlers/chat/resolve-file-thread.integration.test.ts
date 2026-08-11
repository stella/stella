import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Logger } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { chatThreads, fileChatThreads } from "@/api/db/schema";
import { markRlsDatabase, createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { lockFileChatThreadMapping } from "./file-thread-mapping";

let testDb: TestDatabase;
let ids: TestIds;
let hiddenThreadId: SafeId<"chatThread">;
let queryCount = 0;

const logger: Logger = {
  logQuery: () => {
    queryCount += 1;
  },
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  hiddenThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());

  await testDb.insert(chatThreads).values({
    id: hiddenThreadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "Thread with inaccessible historical matter data",
    workspaceId: ids.wsA2,
    dataWorkspaceIds: [ids.wsA1, ids.wsA2],
  });
  await testDb.insert(fileChatThreads).values({
    id: toSafeId<"fileChatThread">(Bun.randomUUIDv7()),
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    entityId: ids.entityA2,
    fieldId: ids.fieldA2,
    chatThreadId: hiddenThreadId,
  });
});

afterAll(async () => {
  await testDb.delete(chatThreads).where(eq(chatThreads.id, hiddenThreadId));
  await releaseRlsFixture();
});

const lookup = async ({
  workspaceId,
  entityId,
  fieldId,
}: {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
}) => {
  const countedDb = markRlsDatabase(
    drizzle({
      client: testDb.$client,
      logger,
    }),
  );
  const scopedDb = createScopedDb(
    countedDb,
    [workspaceId],
    ids.orgA,
    ids.userA1,
  );

  return await scopedDb(async (tx) => {
    queryCount = 0;
    const mapping = await lockFileChatThreadMapping(
      asTestRaw<Transaction>(tx),
      {
        entityId,
        fieldId,
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId,
      },
    );
    return { mapping, queryCount };
  });
};

describe("file-thread mapping lookup", () => {
  test("locks and resolves an accessible thread in one query", async () => {
    const result = await lookup({
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      fieldId: ids.fieldA1,
    });

    expect(result.queryCount).toBe(1);
    expect(result.mapping).toMatchObject({
      id: ids.fileChatThreadA1,
      mappedChatThreadId: ids.chatThreadWorkspaceA1,
      thread: { id: ids.chatThreadWorkspaceA1 },
    });
  });

  test("keeps the mapping visible when thread RLS hides the join", async () => {
    const result = await lookup({
      workspaceId: ids.wsA2,
      entityId: ids.entityA2,
      fieldId: ids.fieldA2,
    });

    expect(result.queryCount).toBe(1);
    expect(result.mapping).toMatchObject({
      mappedChatThreadId: hiddenThreadId,
      thread: null,
    });
  });
});
