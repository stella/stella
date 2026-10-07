import { panic } from "better-result";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
});
const jobSchema = v.looseObject({
  steps: v.optional(v.array(stepSchema)),
});
const workflowSchema = v.object({ jobs: v.object({ validate: jobSchema }) });
const workflow = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/main-heavy.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const validationSteps = workflow.jobs.validate.steps ?? [];
const namedStep = (name: string) => {
  const step = validationSteps.find((candidate) => candidate.name === name);
  if (step?.run === undefined) {
    panic(`main-heavy.yml is missing runnable step ${name}`);
  }
  return step.run;
};
const validateFormat = namedStep("Validate SHA format");
const verifyAncestry = namedStep("Verify main ancestry");

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const runStep = (
  script: string,
  sha: string,
  cwd: string,
  outputPath: string,
) =>
  Bun.spawnSync(["bash", "-euc", script], {
    cwd,
    env: { ...process.env, SHA: sha, GITHUB_OUTPUT: outputPath },
  });

test("dispatch SHA validation accepts only existing commits already on main", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "main-heavy-sha-"));
  try {
    runGit(fixture, "init", "-b", "main");
    runGit(fixture, "config", "user.name", "Fixture");
    runGit(fixture, "config", "user.email", "fixture@example.invalid");
    runGit(fixture, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(fixture, "tracked"), "main\n");
    runGit(fixture, "add", "tracked");
    runGit(fixture, "commit", "-m", "main commit");
    const mainSha = runGit(fixture, "rev-parse", "HEAD");
    runGit(fixture, "update-ref", "refs/remotes/origin/main", mainSha);

    runGit(fixture, "checkout", "--orphan", "sibling");
    runGit(fixture, "rm", "-rf", ".");
    writeFileSync(path.join(fixture, "sibling"), "sibling\n");
    runGit(fixture, "add", "sibling");
    runGit(fixture, "commit", "-m", "unrelated commit");
    const siblingSha = runGit(fixture, "rev-parse", "HEAD");

    const outputPath = path.join(fixture, "github-output");
    const acceptedFormat = runStep(
      validateFormat,
      mainSha,
      fixture,
      outputPath,
    );
    expect(acceptedFormat.exitCode).toBe(0);
    expect(runStep(verifyAncestry, mainSha, fixture, outputPath).exitCode).toBe(
      0,
    );
    expect(readFileSync(outputPath, "utf-8")).toContain(`sha=${mainSha}`);

    const rejectedFormat = [
      mainSha.slice(0, 39),
      "A".repeat(40),
      `${mainSha.slice(0, 39)}g`,
    ];
    for (const sha of rejectedFormat) {
      expect(
        runStep(validateFormat, sha, fixture, outputPath).exitCode,
      ).not.toBe(0);
    }

    const missingSha = "a".repeat(40);
    expect(
      runStep(validateFormat, missingSha, fixture, outputPath).exitCode,
    ).toBe(0);
    expect(
      runStep(verifyAncestry, missingSha, fixture, outputPath).exitCode,
    ).not.toBe(0);
    expect(
      runStep(verifyAncestry, siblingSha, fixture, outputPath).exitCode,
    ).not.toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("main SHA checks finish before any checkout in the validation job", () => {
  const names = validationSteps.map(({ name }) => name);
  expect(names).toEqual([
    "Check release candidate",
    "Validate merge queue depth",
    "Select untested heavy SHA",
    "Validate SHA format",
    "Fetch main history",
    "Verify main ancestry",
  ]);
  expect(
    validationSteps.some(({ uses }) => uses?.startsWith("actions/checkout@")),
  ).toBe(false);
});
