import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decideReleaseHold,
  parseHoldArgs,
  readAddedCliChangesets,
} from "./check-release-cli-changeset-hold";

const CLI_CHANGESET = '---\n"@stll/cli": minor\n---\n\nAdd a command.\n';
const OTHER_CHANGESET =
  '---\n"@stll/business-registries": patch\n---\n\nUpdate a parser.\n';

describe("release CLI changeset hold", () => {
  test("holds a CLI changeset in the merge queue while a release is open", () => {
    expect(
      decideReleaseHold({
        addedCliChangesets: [".changeset/add-command.md"],
        event: "merge_group",
        isReleasePullRequest: false,
        openReleases: 1,
      }),
    ).toEqual({ status: "hold", changesets: [".changeset/add-command.md"] });
  });

  test("only warns on the pull request itself", () => {
    expect(
      decideReleaseHold({
        addedCliChangesets: [".changeset/add-command.md"],
        event: "pull_request",
        isReleasePullRequest: false,
        openReleases: 1,
      }),
    ).toEqual({ status: "warn", changesets: [".changeset/add-command.md"] });
  });

  test("never holds the release pull request", () => {
    expect(
      decideReleaseHold({
        addedCliChangesets: [".changeset/release-v1.md"],
        event: "merge_group",
        isReleasePullRequest: true,
        openReleases: 1,
      }),
    ).toEqual({ status: "clear" });
  });

  test("clears when no release is open or no CLI changeset is added", () => {
    expect(
      decideReleaseHold({
        addedCliChangesets: [".changeset/add-command.md"],
        event: "merge_group",
        isReleasePullRequest: false,
        openReleases: 0,
      }),
    ).toEqual({ status: "clear" });
    expect(
      decideReleaseHold({
        addedCliChangesets: [],
        event: "merge_group",
        isReleasePullRequest: false,
        openReleases: 1,
      }),
    ).toEqual({ status: "clear" });
  });

  test("requires every flag in a known form", () => {
    expect(
      parseHoldArgs([
        "--event",
        "merge_group",
        "--open-releases",
        "2",
        "--is-release",
        "false",
      ]),
    ).toMatchObject({
      base: "origin/main",
      event: "merge_group",
      isReleasePullRequest: false,
      openReleases: 2,
    });
    expect(() =>
      parseHoldArgs([
        "--event",
        "push",
        "--open-releases",
        "0",
        "--is-release",
        "false",
      ]),
    ).toThrow("usage:");
    expect(() =>
      parseHoldArgs(["--event", "merge_group", "--open-releases", "0"]),
    ).toThrow("usage:");
    expect(() =>
      parseHoldArgs([
        "--event",
        "merge_group",
        "--open-releases",
        "-1",
        "--is-release",
        "false",
      ]),
    ).toThrow("usage:");
  });
});

const runGit = (root: string, args: readonly string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
};

const commitAll = (root: string, message: string): void => {
  runGit(root, ["add", "-A"]);
  runGit(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  ]);
};

const withGitFixture = (callback: (root: string) => void): void => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-release-hold-"));
  try {
    runGit(root, ["init", "-q", "-b", "main"]);
    mkdirSync(path.join(root, ".changeset"));
    writeFileSync(path.join(root, ".changeset/pending-cli.md"), CLI_CHANGESET);
    commitAll(root, "base");
    runGit(root, ["branch", "base"]);
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("release CLI changeset hold integration", () => {
  test("lists only CLI changesets the pull request adds", () => {
    withGitFixture((root) => {
      writeFileSync(path.join(root, ".changeset/new-cli.md"), CLI_CHANGESET);
      writeFileSync(path.join(root, ".changeset/other.md"), OTHER_CHANGESET);
      writeFileSync(path.join(root, ".changeset/empty.md"), "---\n---\n");
      commitAll(root, "change");

      expect(readAddedCliChangesets(root, "base")).toEqual([
        ".changeset/new-cli.md",
      ]);
    });
  });

  test("counts a pending changeset the pull request edits to name the CLI", () => {
    withGitFixture((root) => {
      writeFileSync(
        path.join(root, ".changeset/other-base.md"),
        OTHER_CHANGESET,
      );
      commitAll(root, "another pending entry");
      runGit(root, ["branch", "-f", "base"]);
      writeFileSync(path.join(root, ".changeset/other-base.md"), CLI_CHANGESET);
      commitAll(root, "edit");

      expect(readAddedCliChangesets(root, "base")).toEqual([
        ".changeset/other-base.md",
      ]);
    });
  });

  test("ignores a CLI changeset already pending on the base", () => {
    withGitFixture((root) => {
      commitAll(root, "no changesets");

      expect(readAddedCliChangesets(root, "base")).toEqual([]);
    });
  });

  test("ignores an uncommitted CLI changeset", () => {
    withGitFixture((root) => {
      writeFileSync(path.join(root, ".changeset/draft.md"), CLI_CHANGESET);

      expect(readAddedCliChangesets(root, "base")).toEqual([]);
    });
  });

  test("fails closed when the base ref is missing", () => {
    withGitFixture((root) => {
      expect(() => readAddedCliChangesets(root, "missing")).toThrow(
        "git merge-base missing HEAD failed",
      );
    });
  });
});
