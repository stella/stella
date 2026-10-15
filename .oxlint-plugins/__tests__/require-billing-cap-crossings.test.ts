import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-billing-cap-crossings", () => {
  test("reports time-entry updates without reconciliation", async () => {
    expect(
      await lintSingleRule(
        "require-billing-cap-crossings",
        'import { timeEntries } from "@/api/db/schema/billing";\nasync function save(tx) { await tx.update(timeEntries).set({ hours: 1 }); }',
      ),
    ).toEqual([2]);
  });
  test("requires reconciliation on the same transaction", async () => {
    expect(
      await lintSingleRule(
        "require-billing-cap-crossings",
        'import { timeEntries } from "@/api/db/schema/billing";\nimport { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";\nasync function save(tx, other) { await tx.delete(timeEntries); await recordBillingCapCrossings(other); }',
      ),
    ).toEqual([3]);
  });
  test("accepts an awaited reconciliation after the update", async () => {
    expect(
      await lintSingleRule(
        "require-billing-cap-crossings",
        'import { timeEntries as entries } from "@/api/db/schema/billing";\nimport { recordBillingCapCrossings as reconcile } from "@/api/lib/billing/arrangements";\nasync function save(tx) { await tx.update(entries); await reconcile(tx); }',
      ),
    ).toEqual([]);
  });
  test("leaves other tables alone", async () => {
    expect(
      await lintSingleRule(
        "require-billing-cap-crossings",
        "async function save(tx) { await tx.update(users); }",
      ),
    ).toEqual([]);
  });
  test("requires awaited reconciliation after the mutation", async () => {
    expect(
      await lintSingleRule(
        "require-billing-cap-crossings",
        'import { timeEntries } from "@/api/db/schema/billing";\nimport { recordBillingCapCrossings as reconcile } from "@/api/lib/billing/arrangements";\nasync function unawaited(tx) { await tx.update(timeEntries); reconcile(tx); }\nasync function tooEarly(tx) { await reconcile(tx); await tx.delete(timeEntries); }',
      ),
    ).toEqual([3, 4]);
  });
  test("requires reconciliation after raw SQL mutations", async () => {
    expect(
      await lintSingleRule(
        "require-billing-cap-crossings",
        "async function update(tx) { await tx.execute(sql`UPDATE time_entries SET hours = 1`); }\nasync function remove(tx) { await tx.execute(sql`DELETE FROM time_entries WHERE id = 1`); }",
      ),
    ).toEqual([1, 2]);
  });
});
