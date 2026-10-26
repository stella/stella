import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (file: string) =>
  readFileSync(
    new URL(`../.github/workflows/${file}`, import.meta.url),
    "utf-8",
  );
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

test("release merge dispatches no tag and rewrites no release branch", () => {
  const workflow: unknown = Bun.YAML.parse(read("release-pr.yml"));
  const jobs = field(workflow, "jobs");
  expect(field(jobs, "tag-version")).toBeUndefined();
  expect(field(jobs, "refresh-release-stage")).toBeUndefined();
  expect(field(jobs, "refresh-release-version")).toBeUndefined();
});
test("heavy suites dispatch neither PR depth nor staging after a release merge", () => {
  const source = read("main-heavy.yml");
  expect(source).not.toContain('workflow_id: "main-pr-depth.yml"');
  expect(source).not.toContain('workflow_id: "deploy-staging.yml"');
});
test("the verified RC artifact run dispatches all three proof workflows", () => {
  const source: unknown = Bun.YAML.parse(read("release.yml"));
  const job = field(field(source, "jobs"), "promote-staging");
  const steps = field(job, "steps");
  const run = Array.isArray(steps)
    ? steps.map((step) => String(field(step, "run") ?? "")).join("\n")
    : "";
  for (const workflow of [
    "deploy-staging.yml",
    "main-heavy.yml",
    "main-pr-depth.yml",
  ]) {
    expect(run).toContain(workflow);
  }
});
