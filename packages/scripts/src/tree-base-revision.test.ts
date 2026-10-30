import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { treeBaseRevision } from "./tree-base-revision";

const withRepository = (
  verify: (root: string, git: (...args: string[]) => string) => void,
) => {
  const root = mkdtempSync(path.join(import.meta.dir, ".tree-base-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "--template=", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(root, "baseline.json"), '["existing"]');
    git("add", "baseline.json");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    verify(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const localEnv = () => ({ ...process.env, RATCHET_BASE_REF: undefined });

test("a baseline stays in the tree's format as main advances beyond its fork", () => {
  withRepository((repoRoot, git) => {
    const fork = git("rev-parse", "HEAD");
    git("switch", "-qc", "feature");
    writeFileSync(path.join(repoRoot, "feature.txt"), "feature");
    git("add", "feature.txt");
    git("commit", "-qm", "feature");
    git("switch", "-q", "main");
    writeFileSync(
      path.join(repoRoot, "baseline.json"),
      '{"format":2,"entries":["existing"]}',
    );
    git("add", "baseline.json");
    git("commit", "-qm", "advance baseline format");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const tip = git("rev-parse", "HEAD");
    git("switch", "-q", "feature");
    // Ensure the old live-tip behavior reaches a genuinely incompatible format.
    expect(JSON.parse(git("show", "origin/main:baseline.json"))).toEqual({
      format: 2,
      entries: ["existing"],
    });
    expect(tip).not.toBe(fork);
    const revision = treeBaseRevision({ repoRoot, env: localEnv() });
    expect(revision).toBe(fork);
    expect(JSON.parse(git("show", `${revision}:baseline.json`))).toEqual(
      JSON.parse(readFileSync(path.join(repoRoot, "baseline.json"), "utf-8")),
    );
    // A CI override is authoritative, including a merge group's older base.
    expect(
      treeBaseRevision({
        repoRoot,
        env: { ...localEnv(), RATCHET_BASE_REF: tip },
      }),
    ).toBe(tip);
    expect(
      treeBaseRevision({
        repoRoot,
        baseRef: fork,
        env: { ...localEnv(), RATCHET_BASE_REF: tip },
      }),
    ).toBe(fork);
  });
});

test("missing and empty configured revisions fail without falling back", () => {
  withRepository((repoRoot) => {
    for (const base of ["missing-revision", ""]) {
      expect(() =>
        treeBaseRevision({
          repoRoot,
          env: { ...localEnv(), RATCHET_BASE_REF: base },
        }),
      ).toThrow("Tree comparison base unavailable");
    }
  });
});

test("a missing remote base fails instead of substituting HEAD", () => {
  withRepository((repoRoot, git) => {
    git("update-ref", "-d", "refs/remotes/origin/main");
    expect(() => treeBaseRevision({ repoRoot, env: localEnv() })).toThrow(
      "Tree comparison base unavailable",
    );
  });
});

test("repository selectors from a hook cannot redirect the base lookup", () => {
  withRepository((repoRoot, git) => {
    expect(
      treeBaseRevision({
        repoRoot,
        env: { ...localEnv(), GIT_DIR: path.join(repoRoot, "absent") },
      }),
    ).toBe(git("rev-parse", "HEAD"));
  });
});
