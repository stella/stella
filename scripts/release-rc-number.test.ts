import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = new URL("release-rc-number.sh", import.meta.url).pathname;
const withTags = (check: (root: string, sha: string) => void) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-rc-number-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "--template=");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "candidate",
    );
    check(root, git("rev-parse", "HEAD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const nextCandidate = (root: string, sha: string) =>
  Bun.spawnSync(["bash", script, "1.2.3", sha], { cwd: root });
const tag = (root: string, name: string, sha: string) => {
  const result = Bun.spawnSync(
    ["git", "-c", "tag.gpgsign=false", "tag", name, sha],
    { cwd: root },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

test("next RC is max plus one, including failed candidates and gaps", () =>
  withTags((root, sha) => {
    // Different objects reserve old receipts; their proof conclusions never free a number.
    const other = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        "HEAD^{tree}",
      ],
      { cwd: root, stdin: new Blob(["earlier failed rc\n"]) },
    )
      .stdout.toString()
      .trim();
    for (const name of ["v1.2.3-rc.1", "v1.2.3-rc.3", "v1.2.3-rc.10"]) {
      tag(root, name, other);
    }
    tag(root, "v1.2.4-rc.99", other);
    expect(nextCandidate(root, sha).stdout.toString()).toBe(
      "tag=v1.2.3-rc.11\nexisting=false\n",
    );
  }));
test("an existing RC on the exact SHA is idempotent", () =>
  withTags((root, sha) => {
    tag(root, "v1.2.3-rc.4", sha);
    expect(nextCandidate(root, sha).stdout.toString()).toBe(
      "tag=v1.2.3-rc.4\nexisting=true\n",
    );
  }));
test("stable tag prevents any new RC even on a replayed SHA", () =>
  withTags((root, sha) => {
    tag(root, "v1.2.3", sha);
    const result = nextCandidate(root, sha);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Final release v1.2.3 already exists",
    );
  }));
test("an empty candidate series starts at one", () =>
  withTags((root, sha) => {
    expect(nextCandidate(root, sha).stdout.toString()).toBe(
      "tag=v1.2.3-rc.1\nexisting=false\n",
    );
  }));
