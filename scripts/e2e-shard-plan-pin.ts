import { readFileSync } from "node:fs";

import { createSha256 } from "@stll/sha256/node";

import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };

export const E2E_PRODUCTION_PLAN_PIN = "e2eProductionShards.planSha256";

export const e2eProductionPlanFingerprint = (
  command: string,
  readPlanFile = (file: string) =>
    readFileSync(new URL(`../${file}`, import.meta.url)),
): string => {
  const hash = createSha256().update(command);
  for (const file of configuredBudgets.e2eProductionShards.planFiles) {
    hash.update(readPlanFile(file));
  }
  return hash.digest("hex");
};
