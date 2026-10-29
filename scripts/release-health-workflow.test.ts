import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { RELEASE_HEALTH_ASSET } from "./release-health";

const WORKFLOWS = path.join(import.meta.dir, "../.github/workflows");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workflow = (file: string) => {
  const source = readFileSync(path.join(WORKFLOWS, file), "utf-8");
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) {
    throw new TypeError(`${file} requires jobs`);
  }
  return { source, jobs: parsed["jobs"], on: parsed["on"] };
};

const job = (jobs: Record<string, unknown>, name: string) => {
  const found = jobs[name];
  if (!isRecord(found)) {
    throw new TypeError(`missing job ${name}`);
  }
  return found;
};

const runs = (found: Record<string, unknown>): string =>
  (Array.isArray(found["steps"]) ? found["steps"] : [])
    .map((step: unknown) =>
      isRecord(step) && typeof step["run"] === "string" ? step["run"] : "",
    )
    .join("\n");

describe("release health workflows", () => {
  test("production promotion waits for the previous release's gate", () => {
    const { jobs } = workflow("release.yml");
    const gate = job(jobs, "release-health-gate");

    expect(job(jobs, "promote-production")["needs"]).toContain(
      "release-health-gate",
    );
    expect(gate["if"]).toBe(job(jobs, "promote-production")["if"]);
    expect(runs(gate)).toContain("scripts/release-health.ts gate");
    expect(runs(gate)).toContain(`--pattern ${RELEASE_HEALTH_ASSET}`);
  });

  test("the promotion starts the window the gate later reads", () => {
    const release = workflow("release.yml");
    const health = workflow("release-health.yml");
    const dispatch = job(release.jobs, "dispatch-release-health");

    expect(dispatch["needs"]).toContain("promote-production");
    expect(runs(dispatch)).toContain(
      "actions/workflows/release-health.yml/dispatches",
    );
    expect(runs(dispatch)).toContain("inputs[release_ref]=");
    expect(health.on).toHaveProperty(
      "workflow_dispatch.inputs.release_ref.required",
      true,
    );
    const window = runs(job(health.jobs, "window"));
    expect(window).toContain(
      `--verdict "$RUNNER_TEMP/${RELEASE_HEALTH_ASSET}"`,
    );
    expect(window).toContain(
      `release upload "$RELEASE_REF" "$RUNNER_TEMP/${RELEASE_HEALTH_ASSET}"`,
    );
  });

  test("a verdict other than healthy alerts through the failed-run path", () => {
    const alerts = readFileSync(
      path.join(WORKFLOWS, "scheduled-run-alerts.yml"),
      "utf-8",
    );

    expect(alerts).toContain("- Release health");
    expect(alerts).toContain('".github/workflows/release-health.yml"');
  });
});

test("private findings persist successfully before any public verdict upload", () => {
  const { jobs } = workflow("release-health.yml");
  const window = job(jobs, "window");
  const steps = window["steps"];
  if (!Array.isArray(steps)) {
    throw new TypeError("window requires steps");
  }
  const persistence = steps.findIndex(
    (step: unknown) =>
      isRecord(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes("scripts/release-health.ts record"),
  );
  const upload = steps.findIndex(
    (step: unknown) =>
      isRecord(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes('release upload "$RELEASE_REF"'),
  );
  expect(persistence).toBeGreaterThanOrEqual(0);
  expect(upload).toBeGreaterThan(persistence);
  const persist = steps.at(persistence);
  if (!isRecord(persist)) {
    throw new TypeError("private persistence step required");
  }
  expect(persist["continue-on-error"]).not.toBe(true);
  expect(persist["if"]).toBeUndefined();
  expect(runs(window)).toContain(
    '--record "$RUNNER_TEMP/private-release-health.json"',
  );
  const publicUpload = steps.at(upload);
  if (!isRecord(publicUpload)) {
    throw new TypeError("public upload step required");
  }
  expect(publicUpload["if"]).toBeUndefined();
  expect(publicUpload["run"]).not.toContain("private-release-health.json");
});

test("private record access follows the configured deployment repository", () => {
  const { jobs } = workflow("release-health.yml");
  const found = job(jobs, "window");
  const steps = found["steps"];
  if (!Array.isArray(steps)) {
    throw new TypeError("window requires steps");
  }
  const token = steps.find(
    (step: unknown) => isRecord(step) && step["id"] === "record-token",
  );
  if (!isRecord(token)) {
    throw new TypeError("record token required");
  }
  expect(token["with"]).toHaveProperty(
    "repositories",
    `\${{ vars.STAGING_DEPLOY_REPOSITORY }}`,
  );
  const persist = steps.find(
    (step: unknown) =>
      isRecord(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes("scripts/release-health.ts record"),
  );
  if (!isRecord(persist)) {
    throw new TypeError("record persistence required");
  }
  expect(persist["env"]).toHaveProperty(
    "RECORD_STORE",
    `\${{ github.repository_owner }}/\${{ vars.STAGING_DEPLOY_REPOSITORY }}`,
  );
});
