import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateWorkspaceAppBoundaries } from "../packages/scripts/src/workspace-app-boundaries";

// An install that runs lifecycle scripts runs the workspace hygiene check,
// which in CI reads the app-boundary ledger at the merge base with
// origin/main. Each such job's checkout is replayed here against a release
// branch that took main, the shape the release refresh installs on.

const WORKFLOWS = path.join(import.meta.dir, "../.github/workflows");
const LEDGER_PATH = "scripts/app-boundary-exceptions.json";
const PUSH_TO_MAIN = {
  env: { CI: "true", GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "" },
};
const INSTALL_WITH_SCRIPTS =
  /\bbun (?:install|ci)\b(?![^\n]*--ignore-scripts)/u;

// timeout: each test builds a git remote and runs a synchronous git
// checkout for every installing workflow job; no wait is involved.
setDefaultTimeout(30_000);

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots = [];
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

/** Jobs whose steps install with lifecycle scripts, with their checkout inputs. */
const installingJobs = () =>
  readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith(".yml"))
    .toSorted()
    .flatMap((file) => {
      const workflow: unknown = Bun.YAML.parse(
        readFileSync(path.join(WORKFLOWS, file), "utf-8"),
      );
      assert.ok(isRecord(workflow) && isRecord(workflow["jobs"]), file);
      return Object.entries(workflow["jobs"]).flatMap(([id, job]) => {
        if (!isRecord(job) || !Array.isArray(job["steps"])) {
          return [];
        }
        const steps = job["steps"].filter(isRecord);
        const installs = steps.some(
          (step) =>
            typeof step["run"] === "string" &&
            INSTALL_WITH_SCRIPTS.test(step["run"]),
        );
        if (!installs) {
          return [];
        }
        const checkout = steps.find(
          (step) =>
            typeof step["uses"] === "string" &&
            step["uses"].startsWith("actions/checkout@"),
        );
        const inputs = isRecord(checkout?.["with"]) ? checkout["with"] : {};
        return [
          {
            job: `${file}#${id}`,
            fetchDepth: Number(inputs["fetch-depth"] ?? 1),
          },
        ];
      });
    });

/** Main, a release branched from it, and a staging tip merging main back in. */
const releaseRemote = () => {
  const remote = mkdtempSync(path.join(tmpdir(), "install-baseline-remote-"));
  roots.push(remote);
  for (const directory of ["apps", "packages", "scripts"]) {
    mkdirSync(path.join(remote, directory));
    writeFileSync(path.join(remote, directory, ".keep"), "");
  }
  writeFileSync(path.join(remote, LEDGER_PATH), "[]\n");
  git(remote, "init", "--quiet", "--initial-branch=main");
  git(remote, "config", "user.email", "release@example.invalid");
  git(remote, "config", "user.name", "Release test");
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(remote, "add", "--all");
  git(remote, "commit", "--quiet", "--message", "cut");
  git(remote, "switch", "--quiet", "--create", "release/v1.0.0");
  writeFileSync(path.join(remote, "VERSION"), "1.0.0\n");
  git(remote, "add", "VERSION");
  git(remote, "commit", "--quiet", "--message", "version");
  git(remote, "switch", "--quiet", "main");
  writeFileSync(path.join(remote, "scripts/later.txt"), "main moved on\n");
  git(remote, "add", "scripts/later.txt");
  git(remote, "commit", "--quiet", "--message", "later");
  git(
    remote,
    "switch",
    "--quiet",
    "--create",
    "release-refresh/1",
    "release/v1.0.0",
  );
  git(remote, "merge", "--quiet", "--no-edit", "main");
  const staged = git(remote, "rev-parse", "HEAD");
  git(remote, "switch", "--quiet", "main");
  return { remote, staged };
};

/** What actions/checkout fetches for a commit ref at the given depth. */
const checkOut = (remote: string, sha: string, fetchDepth: number) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "install-baseline-job-"));
  roots.push(workspace);
  git(workspace, "init", "--quiet");
  git(workspace, "remote", "add", "origin", `file://${remote}`);
  if (fetchDepth === 0) {
    git(
      workspace,
      "fetch",
      "--quiet",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    );
  } else {
    git(
      workspace,
      "fetch",
      "--quiet",
      "--no-tags",
      `--depth=${String(fetchDepth)}`,
      "origin",
      sha,
    );
  }
  git(workspace, "checkout", "--quiet", "--detach", sha);
  return workspace;
};

test("every job that installs with lifecycle scripts checks out the hygiene baseline", async () => {
  const jobs = installingJobs();
  expect(jobs.map(({ job }) => job)).toContain(
    "release-pr.yml#refresh-release-version",
  );
  const { remote, staged } = releaseRemote();
  for (const { job, fetchDepth } of jobs) {
    expect({
      job,
      issues: await validateWorkspaceAppBoundaries(
        checkOut(remote, staged, fetchDepth),
        PUSH_TO_MAIN,
      ),
    }).toEqual({ job, issues: [] });
  }
});

test("a single-commit checkout of the release has no baseline to read", async () => {
  const { remote, staged } = releaseRemote();
  expect(
    await validateWorkspaceAppBoundaries(
      checkOut(remote, staged, 1),
      PUSH_TO_MAIN,
    ),
  ).toEqual([
    {
      message: "app-boundary ledger baseline branch is unavailable",
      path: LEDGER_PATH,
    },
  ]);
});
