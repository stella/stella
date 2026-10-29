type WorkflowStep = {
  run?: unknown;
  uses?: unknown;
};

type WorkflowJob = {
  steps?: unknown;
};

type Workflow = {
  jobs?: unknown;
};

export const QUARANTINE_ACTION =
  "./.github/actions/flaky-test-quarantine" as const;

const includesBunTestCommand = (command: string): boolean =>
  command.split(/[;&|\n]/u).some((part) => {
    const words = part.trim().split(/\s+/u);
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
    const owner = steps.findIndex(({ uses }) => uses === QUARANTINE_ACTION);
    for (const [index, { run }] of steps.entries()) {
      if (
        typeof run === "string" &&
        includesBunTestCommand(run) &&
        (owner === -1 || owner >= index)
      ) {
        violations.push(`${workflowPath}: jobs.${jobName}.steps[${index}]`);
      }
    }
  }
  return violations;
};
