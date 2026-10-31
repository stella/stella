import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = new URL("main-pr-depth-green-base.sh", import.meta.url).pathname;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

type Status = { context: string; state: string; creator: string };

const run = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Green Base Test",
      "-c",
      "user.email=green-base-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

// A main history of four commits; statuses are served per commit, newest first.
const greenBase = (statuses: readonly (readonly Status[])[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "green-base-script-"));
  roots.push(root);
  const repository = path.join(root, "repository");
  const served = path.join(root, "statuses");
  mkdirSync(repository);
  mkdirSync(served);
  run(repository, ["init", "--quiet"]);
  const commits: string[] = [];
  for (const message of ["one", "two", "three", "four"]) {
    run(repository, ["commit", "--quiet", "--allow-empty", "-m", message]);
    commits.push(run(repository, ["rev-parse", "HEAD"]));
  }
  // Statuses for the ancestors of the checked commit, nearest first.
  const ancestors = commits.slice(0, -1).toReversed();
  for (const [index, commit] of ancestors.entries()) {
    writeFileSync(
      path.join(served, commit),
      JSON.stringify(
        (statuses[index] ?? []).map(({ context, state, creator }) => ({
          context,
          state,
          creator: { login: creator },
        })),
      ),
    );
  }
  const stub = path.join(root, "gh-retry.sh");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\ncommit=$(sed -E 's#.*/commits/([0-9a-f]{40})/statuses.*#\\1#' <<< "$*")\ncat "${served}/$commit" 2>/dev/null || echo '[]'\n`,
  );
  const result = Bun.spawnSync(["bash", script], {
    cwd: repository,
    env: {
      PATH: process.env["PATH"] ?? "",
      GH_RETRY: stub,
      REPOSITORY: "example/repository",
      SHA: commits.at(-1) ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return { printed: result.stdout.toString().trim(), ancestors };
};

const bot = "github-actions[bot]";

test("the nearest ancestor whose newest PR-depth status is green is the base", () => {
  const { printed, ancestors } = greenBase([
    [{ context: "main/pr-depth", state: "failure", creator: bot }],
    [
      // A later rerun turned the commit green; the newest status decides.
      { context: "main/pr-depth", state: "success", creator: bot },
      { context: "main/pr-depth", state: "failure", creator: bot },
    ],
    [{ context: "main/pr-depth", state: "success", creator: bot }],
  ]);
  expect(printed).toBe(ancestors[1]);
});

test("a status from anyone else or another context is not a green base", () => {
  const { printed } = greenBase([
    [{ context: "main/pr-depth", state: "success", creator: "someone" }],
    [{ context: "ci-result", state: "success", creator: bot }],
    [{ context: "main/pr-depth", state: "pending", creator: bot }],
  ]);
  expect(printed).toBe("");
});
