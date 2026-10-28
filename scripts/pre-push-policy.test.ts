import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readYaml = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(new URL(file, import.meta.url), "utf-8"));

// An unknown command must receive an explicit policy decision before it can
// introduce compiler or repository-wide work into every push.
const assertLightweightPush = (config: unknown) => {
  expect(isRecord(config)).toBe(true);
  const push = isRecord(config) ? config["pre-push"] : undefined;
  expect(isRecord(config) ? config["extends"] : undefined).toBeUndefined();
  expect(push).toEqual({
    parallel: false,
    commands: {
      changeset: { run: "bun scripts/changeset-guard.ts --base origin/main" },
      "cli-contract": {
        run: "bun scripts/check-cli-contract-changeset.ts --base origin/main",
      },
      typecheck: {
        run: "bun scripts/pre-push-typecheck.ts --base origin/main",
      },
      secrets: { use_stdin: true, run: "bun run secrets:check:pushed" },
      "ai-skills": { run: "bash scripts/check-ai-skill-sources.sh" },
      lockfiles: { run: "bun run check:standalone-lockfiles" },
      "job-classification": {
        run: "bun scripts/check-ci-job-classification.ts --pre-push",
      },
    },
  });
};

test("every push limits compiler work to touched TypeScript packages", () => {
  assertLightweightPush(readYaml("../lefthook.yml"));
});

test.each([
  "bun scripts/typecheck-baseline.ts --check-delta base.json",
  "bun run typecheck",
  "bun run lint",
  "bun run verify",
])("adding %s to pre-push violates its lightweight policy", (run) => {
  const config = readYaml("../lefthook.yml");
  if (!isRecord(config) || !isRecord(config["pre-push"])) {
    throw new TypeError("Expected pre-push configuration");
  }
  const push = config["pre-push"];
  if (!isRecord(push["commands"])) {
    throw new TypeError("Expected pre-push commands");
  }
  push["commands"]["heavy"] = { run };
  expect(() => assertLightweightPush(config)).toThrow("toEqual");
});

test.each([
  { key: "scripts", value: { "heavy.sh": { runner: "bash" } } },
  { key: "jobs", value: [{ name: "heavy", run: "bun run typecheck" }] },
])("adding pre-push $key violates its lightweight policy", ({ key, value }) => {
  const config = readYaml("../lefthook.yml");
  if (!isRecord(config) || !isRecord(config["pre-push"])) {
    throw new TypeError("Expected pre-push configuration");
  }
  config["pre-push"][key] = value;
  expect(() => assertLightweightPush(config)).toThrow("toEqual");
});

const runCommands = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(runCommands);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    key === "run" && typeof nested === "string"
      ? [nested]
      : runCommands(nested),
  );
};

test("CI retains full merge-base typecheck measurements and runs the push policy guard", () => {
  const commands = runCommands(readYaml("../.github/workflows/ci.yml"));
  expect(
    commands.some((run) => run.includes("scripts/prepare-typecheck-base.sh")),
  ).toBe(true);
  expect(
    readFileSync(
      new URL("prepare-typecheck-base.sh", import.meta.url),
      "utf-8",
    ),
  ).toContain("bun scripts/typecheck-baseline.ts --measure");
  expect(
    commands.some((run) =>
      run.includes(
        'bun scripts/typecheck-baseline.ts --check-delta "$RUNNER_TEMP/typecheck-base.json"',
      ),
    ),
  ).toBe(true);
  expect(
    commands.some((run) => run.includes("scripts/pre-push-policy.test.ts")),
  ).toBe(true);
});
