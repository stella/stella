import { expect, test } from "bun:test";

import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };
import { e2eProductionPlanFingerprint } from "./e2e-shard-plan-pin";

test("every measured input contributes to the production plan pin", () => {
  const read = () => Buffer.from("original");
  const original = e2eProductionPlanFingerprint("runner", read);
  expect(e2eProductionPlanFingerprint("edited runner", read)).not.toBe(
    original,
  );
  for (const changed of configuredBudgets.e2eProductionShards.planFiles) {
    expect(
      e2eProductionPlanFingerprint("runner", (file) =>
        Buffer.from(file === changed ? "edited" : "original"),
      ),
      changed,
    ).not.toBe(original);
  }
});
