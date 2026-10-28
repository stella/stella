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
