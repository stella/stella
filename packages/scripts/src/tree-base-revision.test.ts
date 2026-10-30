import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { treeBaseRevision } from "./tree-base-revision";

const withRepository = (
  verify: (root: string, git: (...args: string[]) => string) => void,
) => {
  const root = mkdtempSync(
    path.resolve(import.meta.dir, "../../..", ".tree-base-"),
  );
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

const localEnv = () => ({
  ...process.env,
  RATCHET_BASE_REF: undefined,
  MERGE_GROUP_BASE_SHA: undefined,
  GITHUB_EVENT_NAME: undefined,
  GITHUB_EVENT_PATH: undefined,
});

type AdvancedMain = { fork: string; payloadBase: string; tip: string };

/**
 * A merge group built on a queued base while origin/main advanced on its own
 * line: the payload base is in the checked-out tree, the main tip is not, and
 * the live merge base is older than both.
 */
const advanceMainPastPayloadBase = (
  root: string,
  git: (...args: string[]) => string,
): AdvancedMain => {
  const fork = git("rev-parse", "HEAD");
  git("switch", "-qc", "group");
  git("commit", "-q", "--allow-empty", "-m", "queued base");
  const payloadBase = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "feature.txt"), "feature");
  git("add", "feature.txt");
  git("commit", "-qm", "feature");
  git("switch", "-q", "main");
  git("commit", "-q", "--allow-empty", "-m", "main advances");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const tip = git("rev-parse", "HEAD");
  git("switch", "-q", "group");
  return { fork, payloadBase, tip };
};

const writeEvent = (root: string, payload: unknown) => {
  const eventPath = path.join(root, `event-${crypto.randomUUID()}.json`);
  writeFileSync(eventPath, JSON.stringify(payload));
  return eventPath;
};

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

test("a merge group without an override compares against its payload base, not the advanced main", () => {
  withRepository((repoRoot, git) => {
    const { fork, payloadBase, tip } = advanceMainPastPayloadBase(
      repoRoot,
      git,
    );
    // The live merge base is another commit, so the fixture reaches the fault.
    expect(git("merge-base", "origin/main", "HEAD")).toBe(fork);
    expect(new Set([fork, payloadBase, tip]).size).toBe(3);
    const env = {
      ...localEnv(),
      GITHUB_EVENT_NAME: "merge_group",
      GITHUB_EVENT_PATH: writeEvent(repoRoot, {
        merge_group: { base_sha: payloadBase, head_sha: "b".repeat(40) },
      }),
    };
    expect(treeBaseRevision({ repoRoot, env })).toBe(payloadBase);
    // The workflow's exported group base wins over the payload.
    expect(
      treeBaseRevision({
        repoRoot,
        env: {
          ...env,
          MERGE_GROUP_BASE_SHA: payloadBase,
          GITHUB_EVENT_PATH: writeEvent(repoRoot, {
            merge_group: { base_sha: fork },
          }),
        },
      }),
    ).toBe(payloadBase);
    // An explicit override stays authoritative, even outside the tree.
    expect(
      treeBaseRevision({ repoRoot, env: { ...env, RATCHET_BASE_REF: tip } }),
    ).toBe(tip);
    // The payload describes the checked-out tree, not another named head.
    expect(treeBaseRevision({ repoRoot, headRef: "HEAD", env })).toBe(fork);
  });
});

test("an event base the inspected tree does not contain falls back to the merge base", () => {
  withRepository((repoRoot, git) => {
    const { fork, tip } = advanceMainPastPayloadBase(repoRoot, git);
    // A fixture repository inherits a CI step's event, whose base it lacks.
    const absent = "d".repeat(40);
    const gitStatus = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: repoRoot,
        env: { ...localEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      }).exitCode;
    expect(gitStatus("cat-file", "-e", `${absent}^{commit}`)).not.toBe(0);
    // The main tip exists here but is not an ancestor of the inspected head.
    expect(gitStatus("cat-file", "-e", `${tip}^{commit}`)).toBe(0);
    expect(gitStatus("merge-base", "--is-ancestor", tip, "HEAD")).toBe(1);
    for (const base of [absent, tip]) {
      for (const env of [
        {
          ...localEnv(),
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: writeEvent(repoRoot, {
            merge_group: { base_sha: base },
          }),
        },
        {
          ...localEnv(),
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: writeEvent(repoRoot, {
            pull_request: { base: { sha: base } },
          }),
        },
        { ...localEnv(), MERGE_GROUP_BASE_SHA: base },
      ]) {
        expect(treeBaseRevision({ repoRoot, env })).toBe(fork);
      }
    }
  });
});

test("a pull request compares against its payload base", () => {
  withRepository((repoRoot, git) => {
    const { payloadBase } = advanceMainPastPayloadBase(repoRoot, git);
    expect(
      treeBaseRevision({
        repoRoot,
        env: {
          ...localEnv(),
          GITHUB_EVENT_NAME: "pull_request",
          // The workflow exports an empty group base outside merge groups.
          MERGE_GROUP_BASE_SHA: "",
          GITHUB_EVENT_PATH: writeEvent(repoRoot, {
            pull_request: { base: { sha: payloadBase }, head: { sha: "c" } },
          }),
        },
      }),
    ).toBe(payloadBase);
  });
});

test("events without a base use the merge base without reading a payload", () => {
  withRepository((repoRoot, git) => {
    const { fork } = advanceMainPastPayloadBase(repoRoot, git);
    for (const event of ["push", "workflow_dispatch"]) {
      expect(
        treeBaseRevision({
          repoRoot,
          env: {
            ...localEnv(),
            GITHUB_EVENT_NAME: event,
            GITHUB_EVENT_PATH: path.join(repoRoot, "absent.json"),
          },
        }),
      ).toBe(fork);
    }
  });
});

test("a base event without a readable base fails instead of using the merge base", () => {
  withRepository((repoRoot) => {
    const cases = [
      { name: "merge_group", eventPath: undefined },
      { name: "merge_group", eventPath: path.join(repoRoot, "absent.json") },
      {
        name: "merge_group",
        eventPath: writeEvent(repoRoot, { merge_group: {} }),
      },
      {
        name: "pull_request",
        eventPath: writeEvent(repoRoot, {
          pull_request: { base: { sha: "main" } },
        }),
      },
    ];
    for (const { name, eventPath } of cases) {
      expect(() =>
        treeBaseRevision({
          repoRoot,
          env: {
            ...localEnv(),
            GITHUB_EVENT_NAME: name,
            GITHUB_EVENT_PATH: eventPath,
          },
        }),
      ).toThrow("Tree comparison base unavailable");
    }
  });
});
