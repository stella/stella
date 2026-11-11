import { Result } from "better-result";
import parse from "shell-quote/parse";

import { stepConditionCovers } from "./github-expression";

type WorkflowStep = {
  run?: unknown;
  uses?: unknown;
  if?: unknown;
  id?: unknown;
};

type WorkflowJob = {
  steps?: unknown;
};

type Workflow = {
  jobs?: unknown;
};

export const QUARANTINE_ACTION =
  "./.github/actions/flaky-test-quarantine" as const;
const PRESERVED_QUARANTINE_ACTION =
  "./.quarantine-tooling/.github/actions/flaky-test-quarantine" as const;

const includesBunTestCommand = (command: string): boolean =>
  command.split("\n").some((part) => {
    if (!/\bbun\b/u.test(part)) {
      return false;
    }
    const parsed = Result.try(() => parse(part, (name) => `$${name}`));
    const words = parsed.isOk()
      ? parsed.value.map((token) => (typeof token === "string" ? token : ""))
      : part.trim().split(/\s+/u);
    const bunIndex = words.indexOf("bun");
    if (bunIndex === -1) {
      return false;
    }
    let executableIndex = bunIndex + 1;
    while (words.at(executableIndex)?.startsWith("-")) {
      const option = words.at(executableIndex);
      if (option === "--cwd" || option === "--filter") {
        executableIndex += 1;
      }
      executableIndex += 1;
    }
    if (words.at(executableIndex) === "run") {
      executableIndex += 1;
    }
    const executable = words.at(executableIndex);
    return (
      executable === "test" ||
      executable?.startsWith("test:") === true ||
      executable?.endsWith("/run-tests.ts") === true ||
      executable === "run-tests.ts"
    );
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workflowSteps = (job: WorkflowJob): readonly WorkflowStep[] =>
  Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];

const conditionOf = (step: WorkflowStep): string | undefined => {
  if (step.if === undefined) {
    return "true";
  }
  return typeof step.if === "string" || typeof step.if === "boolean"
    ? String(step.if)
    : undefined;
};

export const unownedBunTestSteps = (
  value: unknown,
  workflowPath: string,
): readonly string[] => {
  if (!isRecord(value)) {
    return [];
  }
  const workflow: Workflow = value;
  if (!isRecord(workflow.jobs)) {
    return [];
  }

  const violations: string[] = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) {
      continue;
    }
    const steps = workflowSteps(job);
    let owner:
      | { condition: string | undefined; stableStepIds: ReadonlySet<string> }
      | undefined;
    const priorStepIds = new Set<string>();
    for (const [index, step] of steps.entries()) {
      if (
        step.uses === QUARANTINE_ACTION ||
        step.uses === PRESERVED_QUARANTINE_ACTION
      ) {
        owner = {
          condition: conditionOf(step),
          stableStepIds: new Set(priorStepIds),
        };
      }
      if (typeof step.id === "string") {
        priorStepIds.add(step.id.toLowerCase());
      }
      const { run } = step;
      const later = conditionOf(step);
      if (
        typeof run === "string" &&
        includesBunTestCommand(run) &&
        (owner?.condition === undefined ||
          later === undefined ||
          !stepConditionCovers({
            earlier: owner.condition,
            later,
            stableStepIds: owner.stableStepIds,
          }))
      ) {
        violations.push(`${workflowPath}: jobs.${jobName}.steps[${index}]`);
      }
    }
  }
  return violations;
};
