import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { buildMemoryPromptParts } from "@/api/handlers/chat/memory-context";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Memory injection runs on the per-message chat path, which the route-smoke
// network baseline does not cover: that guard walks page loads, and its differ
// requires every baseline key to be visited in the run, so a mutation cannot
// contribute entries from another spec. Nothing else would catch this cost
// growing, so the round-trip count is pinned here instead.
//
// The budget is: one SELECT for the visible rows, plus at most one UPDATE to
// re-stamp lastUsedAt. Each safeDb() call is one round-trip, so counting calls
// is counting round-trips.

const ORGANIZATION_ID = toSafeId<"organization">(
  "00000000-0000-4000-8000-000000000001",
);
const USER_ID = toSafeId<"user">("00000000-0000-4000-8000-000000000002");

type MemoryRowStub = {
  id: SafeId<"aiMemory">;
  content: string;
  kind: "preference";
  pinned: boolean;
  scope: "user";
  workspaceId: null;
};

const memoryRow = (content: string): MemoryRowStub => ({
  id: toSafeId<"aiMemory">(Bun.randomUUIDv7()),
  content,
  kind: "preference",
  pinned: false,
  scope: "user",
  workspaceId: null,
});

/**
 * Stubs safeDb without running the callback: the handler's round-trip count is
 * what matters here, not the SQL, which the RLS suite already covers. The first
 * call resolves to the row set; later calls (the lastUsedAt stamp) resolve void.
 */
const countingSafeDb = (rows: readonly MemoryRowStub[]) => {
  let calls = 0;
  const safeDb = asTestRaw<SafeDb>(async () => {
    calls += 1;
    return Result.ok(calls === 1 ? rows : undefined);
  });
  return {
    safeDb,
    get calls() {
      return calls;
    },
  };
};

describe("memory injection query budget", () => {
  test("costs at most two round-trips per message", async () => {
    const db = countingSafeDb([
      memoryRow("Prefers OSCOLA citations"),
      memoryRow("Drafts in Czech"),
    ]);

    const result = await buildMemoryPromptParts({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      contextMatterIds: [],
      workspaceId: null,
      safeDb: db.safeDb,
    });

    expect(Result.isError(result)).toBe(false);
    // One SELECT + one conditional stamp. A third would mean the per-message
    // chat path grew a query.
    expect(db.calls).toBeLessThanOrEqual(2);
  });

  test("skips the stamp round-trip when no memories are visible", async () => {
    const db = countingSafeDb([]);

    const result = await buildMemoryPromptParts({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      contextMatterIds: [],
      workspaceId: null,
      safeDb: db.safeDb,
    });

    expect(Result.isError(result)).toBe(false);
    // Nothing to stamp, so the write must not be issued at all: most chats in
    // an org with no memories should pay a single query.
    expect(db.calls).toBe(1);
  });
});
