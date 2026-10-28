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

const BUN_TEST_COMMAND =
  /\bbun\b[^\n;&|]*\s(?:run\s+)?test(?::[\w-]+)?\b|\bbun\s+(?:[^\n;&|]*\/)?run-tests\.ts\b/u;

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
        BUN_TEST_COMMAND.test(run) &&
        (owner === -1 || owner >= index)
      ) {
        violations.push(`${workflowPath}: jobs.${jobName}.steps[${index}]`);
      }
    }
  }
  return violations;
};
