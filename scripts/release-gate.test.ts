import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { evaluate } from "./github-expression";

const subject = path.join(import.meta.dir, "release-gate.sh");
const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  "continue-on-error": v.optional(v.boolean()),
  env: v.optional(v.record(v.string(), v.string())),
});
const workflow = v.parse(
  v.looseObject({
    on: v.looseObject({
      workflow_dispatch: v.looseObject({
        inputs: v.record(v.string(), v.looseObject({ type: v.string() })),
      }),
    }),
    jobs: v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.string()),
        steps: v.array(stepSchema),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(
      path.join(import.meta.dir, "../.github/workflows/release-tag.yml"),
      "utf-8",
    ),
  ),
);
const tagSteps =
  workflow.jobs["tag"]?.steps ?? panic("release-tag.yml has no tag job");

const recorder = 'bash "$RUNNER_TEMP/release-gate.sh"';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
const gateDir = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-gate-"));
  directories.push(directory);
  return directory;
};
const gate = (directory: string, ...args: string[]) => {
  const result = Bun.spawnSync(["bash", subject, ...args], {
    env: { PATH: process.env["PATH"] ?? "", RELEASE_GATE_DIR: directory },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};
const failureLines = (stdout: string) =>
  stdout.split("\n").filter((line) => line.startsWith("::error::"));

const GATES = [
  "release-evidence",
  "dependency-audit",
  "changelog",
  "npm-publish-lag",
  "npm-publish-readiness",
  "cli-coupling",
];

test("three failing gates give three verdict lines in one run", () => {
  const directory = gateDir();
  const outcomes: Record<string, string> = {
    "release-evidence":
      "echo '::error::RELEASE_STATUS_NOT_GREEN: release SHA abc carries main/pr-depth = missing' >&2; exit 1",
    "dependency-audit":
      "echo 'audit found 2 high advisories' >&2; echo '::error::2 high or critical advisories' >&2; exit 1",
    changelog: "echo changelog ok",
    "npm-publish-lag":
      "echo '::error::@stll/cli 0.9.58 is not on npm' >&2; exit 1",
    "cli-coupling": "true",
    "npm-publish-readiness": "true",
  };
  for (const [name, script] of Object.entries(outcomes)) {
    gate(directory, "run", name, "bash", "-c", script);
  }
  const verdict = gate(directory, "verdict", ...GATES);
  expect(verdict.exitCode).toBe(1);
  expect(failureLines(verdict.stdout)).toEqual([
    "::error::RELEASE_GATE_FAILED release-evidence: RELEASE_STATUS_NOT_GREEN: release SHA abc carries main/pr-depth = missing",
    "::error::RELEASE_GATE_FAILED dependency-audit: 2 high or critical advisories",
    "::error::RELEASE_GATE_FAILED npm-publish-lag: @stll/cli 0.9.58 is not on npm",
  ]);
  expect(verdict.stdout).toContain("3 of 6 release gates failed.");
});

test("a gate that never ran fails the verdict", () => {
  const directory = gateDir();
  for (const name of GATES.slice(1)) {
    gate(directory, "run", name, "true");
  }
  const verdict = gate(directory, "verdict", ...GATES);
  expect(verdict.exitCode).toBe(1);
  expect(failureLines(verdict.stdout)).toEqual([
    "::error::RELEASE_GATE_FAILED release-evidence: did not run",
  ]);
});

test("a failure without an annotation names its last stderr line or exit status", () => {
  const directory = gateDir();
  gate(
    directory,
    "run",
    "changelog",
    "bash",
    "-c",
    "echo a >&2; echo b >&2; exit 3",
  );
  gate(directory, "run", "cli-coupling", "bash", "-c", "exit 4");
  const verdict = gate(directory, "verdict", "changelog", "cli-coupling");
  expect(failureLines(verdict.stdout)).toEqual([
    "::error::RELEASE_GATE_FAILED changelog: b",
    "::error::RELEASE_GATE_FAILED cli-coupling: exit 4",
  ]);
});

test("a failure reports an error annotation written to stdout", () => {
  const directory = gateDir();
  const run = gate(
    directory,
    "run",
    "dependency-audit",
    "bash",
    "-c",
    "echo evidence=value; echo '::error::audit failed'; exit 1",
  );
  expect(run.stdout).toBe("evidence=value\n::error::audit failed\n");

  const verdict = gate(directory, "verdict", "dependency-audit");
  expect(failureLines(verdict.stdout)).toEqual([
    "::error::RELEASE_GATE_FAILED dependency-audit: audit failed",
  ]);
});

test("passing gates give a passing verdict", () => {
  const directory = gateDir();
  for (const name of GATES) {
    gate(directory, "run", name, "true");
  }
  const verdict = gate(directory, "verdict", ...GATES);
  expect(verdict.exitCode).toBe(0);
  expect(failureLines(verdict.stdout)).toEqual([]);
});

test("a recorded gate keeps its stdout, stderr and exit status", () => {
  const directory = gateDir();
  const run = gate(
    directory,
    "run",
    "release-evidence",
    "bash",
    "-c",
    "echo sha=abc; echo note >&2; exit 5",
  );
  expect(run).toEqual({ exitCode: 5, stdout: "sha=abc\n", stderr: "note\n" });
});

test("gate names cannot escape the record directory", () => {
  const directory = gateDir();
  expect(gate(directory, "run", "../x", "true").exitCode).toBe(2);
  expect(gate(directory, "verdict", "../x").exitCode).toBe(2);
});

// Every gate in the tag job is recorded and listed by the one verdict: a gate
// added without the recorder, or missing from the verdict, fails here.
test("the tag job reports every gate in one verdict before any tag work", () => {
  const recorded = tagSteps.flatMap(({ run }) => {
    const match = run?.match(/release-gate\.sh" run ([a-z0-9-]+) /u);
    return match?.[1] ? [match[1]] : [];
  });
  const verdictIndex = tagSteps.findIndex(({ run }) =>
    run?.startsWith(`${recorder} verdict `),
  );
  const verdict = tagSteps[verdictIndex] ?? panic("missing verdict step");
  expect(verdict.run?.split(" ").slice(3)).toEqual(recorded);
  expect(recorded.toSorted()).toEqual(GATES.toSorted());
  expect(verdict["continue-on-error"] ?? false).toBe(false);
  expect(verdict.if).toBeUndefined();

  const preserve = tagSteps.findIndex(({ run }) =>
    run?.includes('cp scripts/release-gate.sh "$RUNNER_TEMP/release-gate.sh"'),
  );
  const checkout = tagSteps.findIndex(({ run }) =>
    run?.includes("git checkout --detach"),
  );
  expect(preserve).toBeGreaterThan(-1);
  expect(preserve).toBeLessThan(checkout);

  for (const [index, step] of tagSteps.entries()) {
    const gated = step.run?.startsWith(`${recorder} run `) ?? false;
    if (gated) {
      expect(step["continue-on-error"], step.name).toBe(true);
      expect(index, step.name).toBeGreaterThan(preserve);
      expect(index, step.name).toBeLessThan(verdictIndex);
    }
    if (
      step.run?.includes("git push") ||
      step.id === "app-token" ||
      index > verdictIndex
    ) {
      expect(index, step.name).toBeGreaterThan(verdictIndex);
      expect(step["continue-on-error"] ?? false, step.name).toBe(false);
    }
  }
});

const skippedOnDryRun = (condition: string | undefined) => {
  const source = (condition ?? "true").replace(/^\$\{\{(.*)\}\}$/su, "$1");
  return [false, true].map((dryRun) =>
    evaluate(source, {
      values: {
        "inputs.dry_run": dryRun,
        "github.event_name": "workflow_dispatch",
        "github.ref": "refs/heads/main",
        "inputs.mode": "rc",
      },
    }),
  );
};

test("a dry run evaluates every gate and never mints a token or pushes the tag", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs["dry_run"]?.type).toBe("boolean");
  for (const step of tagSteps.slice(
    tagSteps.findIndex(({ id }) => id === "app-token"),
  )) {
    expect(skippedOnDryRun(step.if), step.name).toEqual([true, false]);
  }
  const push = tagSteps.find(({ run }) => run?.includes("git push"));
  expect(skippedOnDryRun(push?.if)).toEqual([true, false]);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "tag") {
      const [normalRun, dryRun] = skippedOnDryRun(job.if);
      expect(
        typeof normalRun,
        `${name}: resolved RC dispatch eligibility`,
      ).toBe("boolean");
      expect(dryRun, `${name}: no job after an RC dry run`).toBe(false);
    }
  }
  for (const step of tagSteps.filter(({ run }) =>
    run?.startsWith(`${recorder} run `),
  )) {
    expect(step.if?.includes("dry_run") ?? false, step.name).toBe(false);
  }
});
