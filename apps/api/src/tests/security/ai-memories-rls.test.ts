import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { aiMemories } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Behavioural RLS coverage for ai_memories: the structural shape is
// asserted in rls-coverage.test.ts; here we prove the policies actually
// scope rows the way the ethical wall requires.

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: Awaited<ReturnType<typeof getRlsFixture>>["scopedQuery"];

const memId = () => toSafeId<"aiMemory">(Bun.randomUUIDv7());
const dedupKey = () =>
  new Bun.CryptoHasher("sha256").update(Bun.randomUUIDv7()).digest("hex");

// Memory rows seeded once via the privileged (owner) connection, which
// bypasses RLS — the scoped reads below are what exercise the policies.
const mem = {
  userA1: memId(),
  userA1FromWsA2: memId(),
  wsA1: memId(),
  wsA2: memId(),
  firmA: memId(),
  wsB1: memId(),
};

const tryCatch = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;

  await testDb.insert(aiMemories).values([
    {
      id: mem.userA1,
      organizationId: ids.orgA,
      scope: "user",
      userId: ids.userA1,
      kind: "preference",
      content: "userA1 prefers OSCOLA citations",
      dedupKey: dedupKey(),
      source: "user",
    },
    {
      // A user-scoped memory whose content was derived from wsA2 data:
      // gated by source_data_workspace_ids, so it must vanish once the
      // session loses access to wsA2.
      id: mem.userA1FromWsA2,
      organizationId: ids.orgA,
      scope: "user",
      userId: ids.userA1,
      kind: "instruction",
      content: "derived from wsA2",
      dedupKey: dedupKey(),
      source: "extracted",
      sourceDataWorkspaceIds: [ids.wsA2],
    },
    {
      id: mem.wsA1,
      organizationId: ids.orgA,
      scope: "workspace",
      workspaceId: ids.wsA1,
      kind: "fact",
      content: "wsA1 fact",
      dedupKey: dedupKey(),
      source: "tool",
    },
    {
      id: mem.wsA2,
      organizationId: ids.orgA,
      scope: "workspace",
      workspaceId: ids.wsA2,
      kind: "fact",
      content: "wsA2 fact",
      dedupKey: dedupKey(),
      source: "tool",
    },
    {
      id: mem.firmA,
      organizationId: ids.orgA,
      scope: "organization",
      kind: "preference",
      content: "firm A house style",
      dedupKey: dedupKey(),
      source: "user",
    },
    {
      id: mem.wsB1,
      organizationId: ids.orgB,
      scope: "workspace",
      workspaceId: ids.wsB1,
      kind: "fact",
      content: "wsB1 fact",
      dedupKey: dedupKey(),
      source: "tool",
    },
  ]);
});

afterAll(async () => {
  await releaseRlsFixture();
});

const countMemory = async (
  wsIds: SafeId<"workspace">[],
  orgId: SafeId<"organization">,
  userId: SafeId<"user">,
  id: SafeId<"aiMemory">,
) =>
  await scopedQuery(
    wsIds,
    orgId,
    (tx) => tx.$count(aiMemories, eq(aiMemories.id, id)),
    userId,
  );

describe("ai_memories ethical wall", () => {
  test("matter memory is invisible from another matter (same org)", async () => {
    const c = await countMemory([ids.wsA2], ids.orgA, ids.userA2, mem.wsA1);
    expect(c).toBe(0);
  });

  test("matter memory is visible from its own matter", async () => {
    const c = await countMemory([ids.wsA2], ids.orgA, ids.userA2, mem.wsA2);
    expect(c).toBe(1);
  });

  test("user memory is invisible to a different user", async () => {
    const c = await countMemory([ids.wsA2], ids.orgA, ids.userA2, mem.userA1);
    expect(c).toBe(0);
  });

  test("user memory is visible to its owner", async () => {
    const c = await countMemory(
      [ids.wsA1, ids.wsA2],
      ids.orgA,
      ids.userA1,
      mem.userA1,
    );
    expect(c).toBe(1);
  });

  test("firm memory is visible org-wide", async () => {
    const c = await countMemory([ids.wsA1], ids.orgA, ids.userA1, mem.firmA);
    expect(c).toBe(1);
  });

  test("firm memory is invisible to another org", async () => {
    const c = await countMemory([ids.wsB1], ids.orgB, ids.userB1, mem.firmA);
    expect(c).toBe(0);
  });
});

describe("ai_memories source-data gating", () => {
  test("matter-derived user memory hides when source matter is out of scope", async () => {
    const c = await countMemory(
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
      mem.userA1FromWsA2,
    );
    expect(c).toBe(0);
  });

  test("matter-derived user memory shows when source matter is in scope", async () => {
    const c = await countMemory(
      [ids.wsA1, ids.wsA2],
      ids.orgA,
      ids.userA1,
      mem.userA1FromWsA2,
    );
    expect(c).toBe(1);
  });
});

describe("ai_memories archive-only", () => {
  test("direct DELETE affects zero rows and leaves the memory intact", async () => {
    const deleted = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .delete(aiMemories)
          .where(eq(aiMemories.id, mem.wsA1))
          .returning({ id: aiMemories.id }),
      ids.userA1,
    );
    expect(deleted).toHaveLength(0);

    const stillThere = await countMemory(
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
      mem.wsA1,
    );
    expect(stillThere).toBe(1);
  });

  test("archived rows remain deduplication tombstones", async () => {
    const key = dedupKey();
    await testDb.insert(aiMemories).values({
      id: memId(),
      organizationId: ids.orgA,
      scope: "user",
      userId: ids.userA1,
      kind: "instruction",
      content: "Keep this archived identity",
      dedupKey: key,
      source: "user",
      status: "archived",
    });

    const error = await tryCatch(async () =>
      testDb.insert(aiMemories).values({
        id: memId(),
        organizationId: ids.orgA,
        scope: "user",
        userId: ids.userA1,
        kind: "instruction",
        content: "Keep this archived identity",
        dedupKey: key,
        source: "user",
      }),
    );
    expect(error).not.toBeNull();
  });
});

describe("ai_memories CHECK constraints", () => {
  test("user scope with a workspace_id is rejected", async () => {
    const error = await tryCatch(async () =>
      testDb.insert(aiMemories).values({
        id: memId(),
        organizationId: ids.orgA,
        scope: "user",
        userId: ids.userA1,
        workspaceId: ids.wsA1,
        kind: "preference",
        content: "bad scope/id combo",
        dedupKey: dedupKey(),
        source: "user",
      }),
    );
    expect(error).not.toBeNull();
  });

  test("a matter-specific kind at user scope is rejected", async () => {
    const error = await tryCatch(async () =>
      testDb.insert(aiMemories).values({
        id: memId(),
        organizationId: ids.orgA,
        scope: "user",
        userId: ids.userA1,
        kind: "fact",
        content: "matter fact masquerading as user memory",
        dedupKey: dedupKey(),
        source: "user",
      }),
    );
    expect(error).not.toBeNull();
  });

  test("organization scope with a user_id is rejected", async () => {
    const error = await tryCatch(async () =>
      testDb.insert(aiMemories).values({
        id: memId(),
        organizationId: ids.orgA,
        scope: "organization",
        userId: ids.userA1,
        kind: "preference",
        content: "firm memory with a stray user id",
        dedupKey: dedupKey(),
        source: "user",
      }),
    );
    expect(error).not.toBeNull();
  });
});
