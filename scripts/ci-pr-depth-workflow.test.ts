import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { prDepthJobs } from "./main-heavy-plan";

const readWorkflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}`, import.meta.url),
      "utf-8",
    ),
  ) as Record<string, unknown>;
const ci = readWorkflow("ci.yml");
const main = readWorkflow("main-pr-depth.yml");
const releaseHealth = readFileSync(
  new URL("check-release-main-health.sh", import.meta.url),
  "utf-8",
);

const command = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(args, { cwd });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

const patchId = (cwd: string, base: string, head: string) => {
  const diff = Bun.spawnSync(["git", "diff", "--binary", `${base}..${head}`], {
    cwd,
  });
  expect(diff.exitCode).toBe(0);
  const result = Bun.spawnSync(["git", "patch-id", "--stable"], {
    cwd,
    stdin: diff.stdout,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split(" ").at(0);
};

test("stable patch ids match across bases and reject a resolved change", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pr-depth-patch-id-"));
  try {
    command(directory, "git", "init", "-q");
    command(directory, "git", "config", "user.name", "test");
    command(directory, "git", "config", "user.email", "test@example.com");
    writeFileSync(path.join(directory, "file"), "base\n");
    command(directory, "git", "add", "file");
    command(directory, "git", "commit", "-qm", "base");
    const base = command(directory, "git", "rev-parse", "HEAD");
    command(directory, "git", "switch", "-qc", "first");
    writeFileSync(path.join(directory, "file"), "base\nchange\n");
    command(directory, "git", "commit", "-qam", "change");
    const first = command(directory, "git", "rev-parse", "HEAD");
    command(directory, "git", "switch", "-q", "master");
    writeFileSync(path.join(directory, "other"), "other\n");
    command(directory, "git", "add", "other");
    command(directory, "git", "commit", "-qm", "new base");
    const secondBase = command(directory, "git", "rev-parse", "HEAD");
    writeFileSync(path.join(directory, "file"), "base\nchange\n");
    command(directory, "git", "commit", "-qam", "same change");
    const same = command(directory, "git", "rev-parse", "HEAD");
    expect(patchId(directory, base, first)).toBe(
      patchId(directory, secondBase, same),
    );
    writeFileSync(path.join(directory, "file"), "base\nresolved differently\n");
    command(directory, "git", "commit", "-qam", "resolved change");
    const resolved = command(directory, "git", "rev-parse", "HEAD");
    expect(patchId(directory, secondBase, resolved)).not.toBe(
      patchId(directory, base, first),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hourly workflow calls the derived PR-depth set and publishes its status", () => {
  const parsed = v.parse(
    v.object({
      on: v.object({
        schedule: v.array(v.object({ cron: v.string() })),
        workflow_dispatch: v.unknown(),
      }),
      jobs: v.record(v.string(), v.unknown()),
    }),
    main,
  );
  expect(parsed.on.schedule).toEqual([{ cron: "47 * * * *" }]);
  expect(JSON.stringify(main)).toContain("main/pr-depth");
  expect(JSON.stringify(main)).toContain('"pr_depth_only":true');
  expect(prDepthJobs(ci)).toEqual([
    "ci-generated-sources",
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
    "code-quality-api",
    "code-quality-web-rest",
  ]);
});

const ciJobs = v.parse(
  v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      steps: v.optional(
        v.array(
          v.looseObject({
            id: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      ),
    }),
  ),
  ci["jobs"],
);
const REUSE_SKIP = "needs.ci-plan.outputs.pr_depth_reused != 'true'";
const MAIN_SKIP = "inputs.pr_depth_only != true";
// Jobs that only orchestrate: the planner, the result gate and a cancellation
// helper that acts on another job's failure.
const ORCHESTRATION_JOBS = new Set([
  "ci-plan",
  "ci-result",
  "marketing-screenshots-cancel",
]);

type SkipViolationsOptions = {
  jobs: typeof ciJobs;
  depthJobs: readonly string[];
};
const skipViolations = ({ jobs, depthJobs }: SkipViolationsOptions) =>
  Object.entries(jobs).flatMap(([job, { if: condition = "" }]) => {
    if (ORCHESTRATION_JOBS.has(job)) {
      return [];
    }
    const depth = depthJobs.includes(job);
    const reuseSkip = condition.includes(REUSE_SKIP);
    const mainSkip = condition.includes(MAIN_SKIP);
    return depth === reuseSkip && depth !== mainSkip ? [] : [job];
  });

test("PR-depth jobs and only they skip on reuse; every other job stays off the main PR-depth run", () => {
  const depthJobs = prDepthJobs(ci);
  expect(skipViolations({ jobs: ciJobs, depthJobs })).toEqual([]);
  const docs = ciJobs["ci-checks-docs"];
  expect(
    skipViolations({
      jobs: { ...ciJobs, "ci-checks-docs": { ...docs, if: REUSE_SKIP } },
      depthJobs,
    }),
  ).toEqual(["ci-checks-docs"]);
  expect(
    skipViolations({ jobs: ciJobs, depthJobs: [...depthJobs, "ci-tests"] }),
  ).toEqual(["ci-tests"]);
});

test("the planner's inline derivation returns exactly prDepthJobs", () => {
  const step = ciJobs["ci-plan"]?.steps?.find(
    ({ id }) => id === "pr-depth-plan",
  );
  const script = v.parse(v.string(), step?.run);
  const directory = mkdtempSync(path.join(tmpdir(), "pr-depth-plan-"));
  try {
    const output = path.join(directory, "output");
    writeFileSync(output, "");
    const result = Bun.spawnSync(["ruby", "-e", script], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe(
      `pr_depth_jobs=${JSON.stringify(prDepthJobs(ci))}\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the release gate requires heavy and PR-depth status provenance", () => {
  expect(releaseHealth).toContain('validate_main_status "main/heavy"');
  expect(releaseHealth).toContain('validate_main_status "main/pr-depth"');
  const mutated = releaseHealth.replace(
    /^validate_main_status "main\/pr-depth".*$/mu,
    "",
  );
  expect(mutated).not.toContain('validate_main_status "main/pr-depth"');
});
