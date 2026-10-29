import { panic } from "better-result";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { formattedLikeRepository } from "../packages/scripts/src/generated-artifact-format";

const ROOT = path.resolve(import.meta.dirname, "..");

const LOCAL_INFRASTRUCTURE_ACTIONS = new Set([
  "ci-install",
  "safe-chain",
  "setup-playwright",
]);
const EXTERNAL_INFRASTRUCTURE_ACTIONS = new Set([
  "actions/checkout",
  "oven-sh/setup-bun",
  "actions/setup-node",
  "actions/cache",
]);

type InfrastructureDefinition = {
  displayName: { prefix: string; suffix: string };
  declaredStepNames: string[];
  steps: string[];
};

const localActionName = (uses: string) =>
  /(?:^|\/)\.github\/actions\/([^/@]+)(?:@.*)?$/u.exec(uses)?.at(1);

const isInfrastructureAction = (uses: string) => {
  const action = uses.split("@").at(0);
  const local = localActionName(uses);
  return (
    (action !== undefined && EXTERNAL_INFRASTRUCTURE_ACTIONS.has(action)) ||
    (local !== undefined && LOCAL_INFRASTRUCTURE_ACTIONS.has(local))
  );
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const displayNamePattern = (id: string, name: unknown) => {
  if (typeof name !== "string") {
    return { prefix: id, suffix: "" };
  }
  const expression = name.indexOf("${{");
  if (expression === -1) {
    return { prefix: name, suffix: "" };
  }
  const close = name.indexOf("}}", expression);
  if (close === -1) {
    panic(`Unclosed matrix expression in job ${id}`);
  }
  return { prefix: name.slice(0, expression), suffix: name.slice(close + 2) };
};

export const generateMainHeavyInfrastructureSteps = async (source: string) => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !("jobs" in parsed)) {
    panic("Workflow has no jobs");
  }
  const jobs = parsed["jobs"];
  if (!isRecord(jobs)) {
    panic("Workflow jobs must be a mapping");
  }
  const definitions = Object.fromEntries(
    Object.entries(jobs).map(([id, value]) => {
      const job = isRecord(value) ? value : {};
      const steps = Array.isArray(job["steps"])
        ? job["steps"].filter(isRecord)
        : [];
      const names = new Set<string>();
      const declaredStepNames = new Set<string>();
      for (const step of steps) {
        if (typeof step["name"] === "string") {
          declaredStepNames.add(step["name"]);
        }
        if (
          typeof step["name"] === "string" &&
          typeof step["uses"] === "string" &&
          isInfrastructureAction(step["uses"])
        ) {
          names.add(step["name"]);
          names.add(`Post ${step["name"]}`);
        }
      }
      return [
        id,
        {
          displayName: displayNamePattern(id, job["name"]),
          declaredStepNames: [...declaredStepNames].toSorted(),
          steps: [...names].toSorted(),
        } satisfies InfrastructureDefinition,
      ] as const;
    }),
  );
  return await formattedLikeRepository(
    JSON.stringify(definitions),
    "json",
    ROOT,
  );
};

if (import.meta.main) {
  const workflow = await Bun.file(
    path.join(ROOT, ".github/workflows/ci.yml"),
  ).text();
  writeFileSync(
    path.join(ROOT, "scripts/main-heavy-infrastructure-steps.json"),
    await generateMainHeavyInfrastructureSteps(workflow),
  );
}
