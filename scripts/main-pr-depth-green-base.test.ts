import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = new URL("main-pr-depth-green-base.sh", import.meta.url).pathname;
const REPOSITORY = "example/repository";
const RUNS = `https://github.com/${REPOSITORY}/actions/runs/`;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const commit = (root: string, args: readonly string[]) => {
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

type Status = {
  state: string;
  login?: string;
  type?: string;
  description?: string;
  /** The run the status links to; omitted links nowhere. */
  run?: { event?: string; path?: string; conclusion?: string };
};

// A main history of four commits; ancestors' statuses are served nearest
// first, each list newest first, and each linked run from its own file.
const greenBase = (statuses: readonly (readonly Status[])[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "green-base-script-"));
  roots.push(root);
  const repository = path.join(root, "repository");
  const served = path.join(root, "served");
  mkdirSync(repository);
  mkdirSync(served);
  commit(repository, ["init", "--quiet"]);
  const commits: string[] = [];
  for (const message of ["one", "two", "three", "four"]) {
    commit(repository, ["commit", "--quiet", "--allow-empty", "-m", message]);
    commits.push(commit(repository, ["rev-parse", "HEAD"]));
  }
  const ancestors = commits.slice(0, -1).toReversed();
  for (const [index, sha] of ancestors.entries()) {
    const list = (statuses[index] ?? []).map((status, offset) => {
      const runId = 100 + index * 10 + offset;
      if (status.run !== undefined) {
        writeFileSync(
          path.join(served, `run-${String(runId)}`),
          JSON.stringify({
            id: runId,
            html_url: `${RUNS}${String(runId)}`,
            repository: { full_name: REPOSITORY },
            path: status.run.path ?? ".github/workflows/main-pr-depth.yml",
            head_branch: "main",
            event: status.run.event ?? "schedule",
            head_sha: sha,
            display_title: `Main PR-depth checks ${sha}`,
            status: "completed",
            conclusion: status.run.conclusion ?? "success",
          }),
        );
      }
      return {
        context: "main/pr-depth",
        state: status.state,
        description:
          status.description ??
          `Main PR-depth checks: ${status.state}; code-check=covered`,
        target_url: `${RUNS}${String(runId)}`,
        creator: {
          login: status.login ?? "github-actions[bot]",
          type: status.type ?? "Bot",
        },
      };
    });
    writeFileSync(path.join(served, sha), JSON.stringify(list));
  }
  const stub = path.join(root, "gh-retry.sh");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'case "$*" in',
      `  *"/statuses"*) sha=$(sed -E 's#.*/commits/([0-9a-f]{40})/statuses.*#\\1#' <<< "$*"); cat "${served}/$sha" 2>/dev/null || echo '[]' ;;`,
      `  *"/actions/runs/"*) id=$(sed -E 's#.*/actions/runs/([0-9]+).*#\\1#' <<< "$*"); cat "${served}/run-$id" 2>/dev/null || exit 1 ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  const result = Bun.spawnSync(["bash", script], {
    cwd: repository,
    env: {
      PATH: process.env["PATH"] ?? "",
      GH_RETRY: stub,
      REPOSITORY,
      SHA: commits.at(-1) ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return { printed: result.stdout.toString().trim(), ancestors };
};

const covered = { state: "success", run: {} } as const;

test("the nearest ancestor whose newest status is a covered success is the base", () => {
  const { printed, ancestors } = greenBase([
    [{ state: "failure", run: {} }],
    // A later rerun turned the commit green; the newest status decides.
    [covered, { state: "failure", run: {} }],
    [covered],
  ]);
  expect<string | undefined>(printed).toBe(ancestors[1]);
});

test("a newer failure replaces an older success", () => {
  const { printed, ancestors } = greenBase([
    [{ state: "failure", run: {} }, covered],
    [covered],
  ]);
  expect<string | undefined>(printed).toBe(ancestors[1]);
});

test("a success without the coverage marker, from another creator or without a matching run is no base", () => {
  const { printed } = greenBase([
    // Written before the code check compared with a green base.
    [
      {
        state: "success",
        description: "Main PR-depth checks: success",
        run: {},
      },
    ],
    [
      { state: "success", login: "someone", type: "User", run: {} },
      // Not the newest, so never reached.
      covered,
    ],
    // Linked run is a dispatch of another workflow, or links nowhere.
    [
      {
        state: "success",
        run: {
          event: "workflow_dispatch",
          path: ".github/workflows/other.yml",
        },
      },
    ],
  ]);
  expect(printed).toBe("");
});

test("a status linking to no run is no base", () => {
  const { printed } = greenBase([[{ state: "success" }]]);
  expect(printed).toBe("");
});
