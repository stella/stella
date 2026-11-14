import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const withMergedRelease = (
  check: (
    run: (options?: {
      strict?: boolean;
      head?: string;
      rc?: boolean;
    }) => Bun.ReadableSyncSubprocess,
  ) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-pr-retry-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "--initial-branch=main", "--template=");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
    writeFileSync(path.join(root, "bun.lock"), "{}\n");
    git("add", ".");
    git("commit", "-qm", "main base");
    git("switch", "-qc", "release/v1.2.4");
    mkdirSync(path.join(root, "docs/changelog"), { recursive: true });
    writeFileSync(path.join(root, "VERSION"), "1.2.4\n");
    writeFileSync(path.join(root, "docs/changelog/v1.2.4.md"), "# Release\n");
    git("add", ".");
    git("commit", "-qm", "chore: release v1.2.4");
    const sha = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    git("merge", "--squash", "release/v1.2.4");
    git("commit", "-qm", "chore: release v1.2.4 (#1)");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(git("rev-parse", "HEAD")).not.toBe(sha);
    writeFileSync(
      path.join(root, "gh.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *pulls?*) printf '%s\\n' "$PULLS" ;;
  *commits/*) endpoint="\u0024{!#}"; commit="\u0024{endpoint##*/}"; tree=$(git rev-parse "$commit^{tree}"); jq -nc --arg sha "$commit" --arg tree "$tree" '{sha:$sha,commit:{tree:{sha:$tree}}}' ;;
  *) echo "unexpected API request $*" >&2; exit 1 ;;
esac
`,
    );
    check((options = {}) => {
      if (options.rc === false) {
        git("tag", "-d", "v1.2.4-rc.1");
      } else if (git("tag", "--list", "v1.2.4-rc.1") === "") {
        git("tag", "v1.2.4-rc.1", sha);
      }
      const pull = {
        state: "closed",
        draft: false,
        merged_at: "2026-01-01T00:00:00Z",
        title: "chore: release v1.2.4",
        head: {
          sha: options.head ?? sha,
          repo: { full_name: "stella/stella" },
        },
        base: { ref: "main", repo: { full_name: "stella/stella" } },
      };
      return Bun.spawnSync(
        [
          "bash",
          new URL("verify-release-tree-proof.sh", import.meta.url).pathname,
          ...(options.strict ? ["--allow-pr-head"] : []),
          "stella/stella",
          sha,
          sha,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
            PULLS: JSON.stringify([[pull]]),
          },
        },
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a final run retry after squash merge accepts the recorded RC head", () =>
  withMergedRelease((run) => {
    const result = run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("relation=pr-head");
  }));
test("a merged PR cannot authorize another recorded head", () =>
  withMergedRelease((run) => {
    const result = run({ head: "f".repeat(40) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "release PR head relation is unverified",
    );
  }));
test("creating an RC remains strict-open even with a prior RC receipt", () =>
  withMergedRelease((run) => {
    const result = run({ strict: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "release PR head relation is unverified",
    );
  }));
test("a merged PR without an RC receipt cannot authorize finalization", () =>
  withMergedRelease((run) => {
    run();
    const result = run({ rc: false });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "release PR head relation is unverified",
    );
  }));
