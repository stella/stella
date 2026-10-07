import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("require-transaction-abort", () => {
  test("reports failure returns after transaction writes", async () => {
    expect(
      await lintSingleRule(
        "require-transaction-abort",
        "safeDb(async tx => { await tx.insert(rows);\nreturn { ok: false as const }; });\nabortableTx(db, async tx => { await tx.delete(rows);\nreturn Result.err(error); });",
        { sourcePath: "apps/api/src/handlers/write.ts" },
      ),
    ).toEqual([2, 4]);
  });
  test("carries savepoint writes into the outer callback", async () => {
    expect(
      await lintSingleRule(
        "require-transaction-abort",
        'db.transaction(async tx => { await tx.transaction(async innerTx => { await innerTx.update(rows); });\nreturn new HandlerError({ message: "rejected" }); });',
        { sourcePath: "apps/api/src/handlers/write.ts" },
      ),
    ).toEqual([2]);
  });
  test("accepts aborting failures and read only rejections", async () => {
    expect(
      await lintSingleRule(
        "require-transaction-abort",
        'safeDb(async tx => { await tx.insert(rows); throw new HandlerError({ message: "rejected" }); });\nsafeDb(async tx => { await tx.select(rows); return { success: false }; });',
        { sourcePath: "apps/api/src/handlers/write.ts" },
      ),
    ).toEqual([]);
  });
  test("does not treat nested closure returns as transaction results", async () => {
    expect(
      await lintSingleRule(
        "require-transaction-abort",
        "safeDb(async tx => { await tx.insert(rows); const reject = () => { return { ok: false }; }; return { ok: true }; });",
        { sourcePath: "apps/api/src/handlers/write.ts" },
      ),
    ).toEqual([]);
  });
  test("accepts the documented commit on failure owner", async () => {
    expect(
      await lintSingleRule(
        "require-transaction-abort",
        "safeDb(async tx => { await tx.insert(rows); return { ok: false }; });",
        {
          sourcePath:
            "apps/api/src/handlers/entities/open-desktop-edit-session.ts",
        },
      ),
    ).toEqual([]);
  });
  test("confines same basename copies of commit owners", async () => {
    expect(
      await lintSingleRule(
        "require-transaction-abort",
        "safeDb(async tx => { await tx.insert(rows); return { ok: false }; });",
        {
          sourcePath:
            "apps/api/src/handlers/other/open-desktop-edit-session.ts",
        },
      ),
    ).toEqual([1]);
  });
});
