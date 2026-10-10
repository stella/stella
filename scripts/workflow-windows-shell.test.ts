import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { flattenWorkflowSteps } from "./workflow-steps";

// A `run` step without `shell` uses bash on Linux and macOS but PowerShell on
// Windows, where `$VAR` reads an unset PowerShell variable instead of the
// environment. A step written for bash then fails only on the Windows leg,
// which for release-desktop.yml means only after a release tag is pushed.
// Every command step in a job that can land on Windows names its shell.

const WORKFLOWS_DIR = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defaultShell = (holder: unknown): unknown =>
  isRecord(holder) &&
  isRecord(holder["defaults"]) &&
  isRecord(holder["defaults"]["run"])
    ? holder["defaults"]["run"]["shell"]
    : undefined;

/** Command steps that would run under an implicit, OS-dependent shell. */
const implicitShellSteps = (workflow: unknown): string[] => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return [];
  }
  const problems: string[] = [];
  for (const [jobId, job] of Object.entries(workflow["jobs"])) {
    if (!isRecord(job) || !("steps" in job)) {
      continue;
    }
    // A matrix can route `runs-on` through an expression, so the runner
    // labels may live in the strategy rather than in `runs-on` itself.
    const runners = JSON.stringify([job["runs-on"], job["strategy"]]);
    if (!/windows/iu.test(runners)) {
      continue;
    }
    if (
      defaultShell(job) !== undefined ||
      defaultShell(workflow) !== undefined
    ) {
      continue;
    }
    for (const step of flattenWorkflowSteps(job["steps"])) {
      if ("run" in step && !("shell" in step)) {
        problems.push(`${jobId}: ${String(step["name"] ?? step["run"])}`);
      }
    }
  }
  return problems;
};

test("command steps in Windows-capable jobs name their shell", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((file) =>
    /\.ya?ml$/u.test(file),
  );
  expect(files.length).toBeGreaterThan(0);
  const problems = files.flatMap((file) =>
    implicitShellSteps(
      Bun.YAML.parse(readFileSync(`${WORKFLOWS_DIR}${file}`, "utf-8")),
    ).map((problem) => `${file} ${problem}`),
  );
  expect(problems).toEqual([]);
});

test("a matrix Windows leg without a shell is caught; defaults and Linux-only jobs pass", () => {
  const step = { name: "Copy tooling", run: 'cp "$GITHUB_WORKSPACE/x" y' };
  const matrixJob = {
    "runs-on": `\${{ matrix.runner }}`,
    strategy: { matrix: { include: [{ runner: "windows-latest" }] } },
  };
  expect(
    implicitShellSteps({ jobs: { build: { ...matrixJob, steps: [step] } } }),
  ).toEqual(["build: Copy tooling"]);
  expect(
    implicitShellSteps({
      jobs: {
        build: { "runs-on": "windows-2025", steps: [{ parallel: [step] }] },
      },
    }),
  ).toEqual(["build: Copy tooling"]);
  expect(
    implicitShellSteps({
      jobs: { build: { ...matrixJob, steps: [{ ...step, shell: "bash" }] } },
    }),
  ).toEqual([]);
  expect(
    implicitShellSteps({
      jobs: {
        build: {
          ...matrixJob,
          defaults: { run: { shell: "bash" } },
          steps: [step],
        },
      },
    }),
  ).toEqual([]);
  expect(
    implicitShellSteps({
      defaults: { run: { shell: "bash" } },
      jobs: { build: { ...matrixJob, steps: [step] } },
    }),
  ).toEqual([]);
  expect(
    implicitShellSteps({
      jobs: { lint: { "runs-on": "ubuntu-latest", steps: [step] } },
    }),
  ).toEqual([]);
});
