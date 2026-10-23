import { Result } from "better-result";
import { expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";

import { readOverviewHandler } from "./read-overview";

test("a database failure reaches the caller as the classified error", async () => {
  const failure = new DatabaseError({
    message: "Database query failed",
    code: "22008",
  });
  const safeDb: SafeDb = async () => Result.err(failure);

  const result = await readOverviewHandler({
    safeDb,
    workspaceId: toSafeId<"workspace">("ws_test123"),
  });

  expect(result.isErr() && result.error).toBe(failure);
});
