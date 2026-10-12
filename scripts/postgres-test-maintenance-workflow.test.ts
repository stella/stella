import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const workflow: unknown = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  ),
);
const JOB = "postgres-service-suites";
const CONFIGURE = "Configure ephemeral Postgres fixture maintenance";
const MIGRATE = "Apply migrations to service Postgres";
const RUN_TESTS = "Run Postgres-gated API suites";
const FIXTURE_DATABASE_URL =
  "postgres://stella_owner:stella@127.0.0.1:5432/stella";

const assertFixtureMaintenance = (candidate: unknown) => {
  const steps = workflowJobSteps(candidate, JOB);
  const configure = workflowStepByName(steps, CONFIGURE);
  const migrate = workflowStepByName(steps, MIGRATE);
  const runTests = workflowStepByName(steps, RUN_TESTS);
  expect(
    configure,
    "Maintenance must target the ephemeral fixture database",
  ).toMatchObject({
    "working-directory": "apps/api",
    env: { DATABASE_URL: FIXTURE_DATABASE_URL },
    run: "bun scripts/postgres-test-maintenance.ts",
  });
  expect(migrate).toMatchObject({
    env: { DATABASE_URL: FIXTURE_DATABASE_URL },
  });
  expect(runTests).toMatchObject({
    env: { DATABASE_URL: FIXTURE_DATABASE_URL },
  });
  expect(
    steps.indexOf(configure),
    "Maintenance must follow migrations",
  ).toBeGreaterThan(steps.indexOf(migrate));
  expect(
    steps.indexOf(configure),
    "Maintenance must precede tests",
  ).toBeLessThan(steps.indexOf(runTests));
};

test("Postgres fixture maintenance runs after migrations and before gated tests", () => {
  assertFixtureMaintenance(workflow);
});

test("fixture maintenance is confined to the ephemeral Postgres service job", () => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const maintenanceJobs = Object.keys(jobs).filter((jobId) => {
    const job: unknown = Reflect.get(jobs, jobId);
    if (typeof job !== "object" || job === null || !("steps" in job)) {
      return false;
    }
    return workflowJobSteps(workflow, jobId).some(
      (step) =>
        step["name"] === CONFIGURE ||
        String(step["run"]).includes("postgres-test-maintenance.ts"),
    );
  });
  expect(maintenanceJobs).toEqual([JOB]);
});

test("the maintenance guard rejects missing, late, early, and wrong-database configuration", () => {
  const steps = workflowJobSteps(workflow, JOB);
  const configure = workflowStepByName(steps, CONFIGURE);
  const remaining = steps.filter((step) => step !== configure);
  const mutate = (mutatedSteps: Record<string, unknown>[]) => ({
    jobs: { [JOB]: { steps: mutatedSteps } },
  });
  expect(() => assertFixtureMaintenance(mutate(remaining))).toThrow(
    `Expected one workflow step named ${CONFIGURE}; found 0`,
  );
  expect(() =>
    assertFixtureMaintenance(mutate([configure, ...remaining])),
  ).toThrow("Maintenance must follow migrations");
  expect(() =>
    assertFixtureMaintenance(mutate([...remaining, configure])),
  ).toThrow("Maintenance must precede tests");
  expect(() =>
    assertFixtureMaintenance(
      mutate(
        steps.map((step) =>
          step === configure
            ? {
                ...configure,
                env: {
                  DATABASE_URL:
                    "postgres://stella_owner:stella@127.0.0.1:5432/production",
                },
              }
            : step,
        ),
      ),
    ),
  ).toThrow("Maintenance must target the ephemeral fixture database");
});
