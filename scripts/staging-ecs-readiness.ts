import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

type EcsReadinessOutcome =
  | { status: "ready" }
  | { status: "unrecorded"; reason: string }
  | { status: "environment-unavailable"; reason: string };

/**
 * No deployment produces the receipt yet. Until one does, the proof relies on
 * the promote, which fails unless the ECS rollout converged on the deployed
 * task revision, and on the exact-commit, exact-environment readiness check.
 */
export const RECEIPT_NOT_PRODUCED =
  "ECS readiness receipt not produced by infra; using promote convergence + /ready exact-commit/environment.";

const unavailable = (reason: string): EcsReadinessOutcome => ({
  status: "environment-unavailable",
  reason,
});

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The deploy job records the complete service scope and both task status lists.
export const readStagingEcsReadiness = async (
  receiptPath: string,
  expectedCommit: string,
): Promise<EcsReadinessOutcome> => {
  if (!existsSync(receiptPath)) {
    return { status: "unrecorded", reason: RECEIPT_NOT_PRODUCED };
  }
  const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf-8"));
  if (
    !record(receipt) ||
    receipt["commit"] !== expectedCommit ||
    !Array.isArray(receipt["scope"]) ||
    receipt["scope"].length === 0 ||
    !receipt["scope"].every(
      (name: unknown) => typeof name === "string" && name !== "",
    ) ||
    !Array.isArray(receipt["services"])
  ) {
    return unavailable(
      "Deployment ECS readiness receipt does not identify this proof.",
    );
  }
  const scope = new Set(receipt["scope"]);
  const seen = new Set<string>();
  for (const service of receipt["services"]) {
    if (
      !record(service) ||
      typeof service["service"] !== "string" ||
      !scope.has(service["service"]) ||
      seen.has(service["service"]) ||
      typeof service["deploymentId"] !== "string" ||
      service["deploymentId"] === "" ||
      !Array.isArray(service["tasks"])
    ) {
      return unavailable(
        "Deployment ECS readiness service census is incomplete.",
      );
    }
    seen.add(service["service"]);
    let running = false;
    for (const task of service["tasks"]) {
      if (
        !record(task) ||
        typeof task["startedBy"] !== "string" ||
        typeof task["lastStatus"] !== "string"
      ) {
        return unavailable(
          "Deployment ECS readiness task census is incomplete.",
        );
      }
      if (
        task["lastStatus"] === "STOPPED" &&
        typeof task["stoppedReason"] !== "string"
      ) {
        return unavailable(
          "Deployment ECS readiness stopped-task evidence is incomplete.",
        );
      }
      if (task["startedBy"] !== service["deploymentId"]) {
        continue;
      }
      if (task["lastStatus"] === "RUNNING") {
        running = true;
      }
      if (
        task["lastStatus"] === "STOPPED" &&
        typeof task["stoppedReason"] === "string" &&
        task["stoppedReason"].includes("ResourceInitializationError")
      ) {
        return unavailable(
          `Deployment ECS task initialization failed: ${task["stoppedReason"]}`,
        );
      }
    }
    if (!running) {
      return unavailable(
        "A staging service has no running task from the current deployment.",
      );
    }
  }
  if (scope.size !== receipt["scope"].length || seen.size !== scope.size) {
    return unavailable(
      "Deployment ECS readiness service census is incomplete.",
    );
  }
  return { status: "ready" };
};
