import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW_DIRECTORY = path.join(import.meta.dir, "../.github/workflows");
const TURBO_CONFIG = path.join(import.meta.dir, "../turbo.json");

const REQUIRED_GIT_ENV = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_KEY_2: "gc.autoDetach",
  GIT_CONFIG_VALUE_2: "false",
} as const;

const TEST_COMMAND_PATTERNS = [
  /\bbun\s+(?:(?:run\s+)?test|--filter\s+\S+\s+test|--cwd(?:=|\s+)\S+\s+(?:run\s+)?test|run\s+--cwd(?:=|\s+)\S+\s+test)(?:\b|:)/u,
  /\bturbo\s+(?:run\s+)?test(?:\b|:)/u,
  /(?:^|[\s/])[^\s/]+\.test\.sh(?:\s|$)/u,
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workflowRunsTests = (workflow: Record<string, unknown>): boolean => {
  const jobs = workflow["jobs"];
  if (!isRecord(jobs)) {
    return false;
  }

  return Object.values(jobs).some((job) => {
    if (!isRecord(job) || !Array.isArray(job["steps"])) {
      return false;
    }

    return job["steps"].some((step) => {
      const run = isRecord(step) ? step["run"] : undefined;
      return (
        typeof run === "string" &&
        TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(run))
      );
    });
  });
};

test("workflows that run tests disable Git background maintenance", () => {
  const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted();
  const violations: string[] = [];

  for (const file of workflowFiles) {
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(path.join(WORKFLOW_DIRECTORY, file), "utf-8"),
    );
    if (!isRecord(parsed) || !workflowRunsTests(parsed)) {
      continue;
    }

    const env = parsed["env"];
    if (!isRecord(env)) {
      violations.push(`${file}: missing top-level env`);
      continue;
    }

    for (const [key, expected] of Object.entries(REQUIRED_GIT_ENV)) {
      if (env[key] !== expected) {
        violations.push(
          `${file}: expected top-level env ${key}=${JSON.stringify(expected)}, received ${JSON.stringify(env[key])}`,
        );
      }
    }
  }

  expect(violations).toEqual([]);
});

// `bun run test` dispatches package tests through Turbo, whose strict env mode
// passes a workflow variable to a task only when the config declares it.
test("Turbo passes the Git maintenance settings to package test tasks", () => {
  const config: unknown = Bun.JSONC.parse(readFileSync(TURBO_CONFIG, "utf-8"));
  const declared =
    isRecord(config) && Array.isArray(config["globalPassThroughEnv"])
      ? config["globalPassThroughEnv"].filter(
          (name): name is string => typeof name === "string",
        )
      : [];
  const passes = (key: string) =>
    declared.some((name) =>
      name.endsWith("*") ? key.startsWith(name.slice(0, -1)) : name === key,
    );

  expect(Object.keys(REQUIRED_GIT_ENV).filter((key) => !passes(key))).toEqual(
    [],
  );
});
