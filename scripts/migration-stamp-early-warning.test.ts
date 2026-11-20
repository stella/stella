import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findMigrationTimestampViolations,
  MIGRATION_RESTAMP_COMMAND,
  readMigrationBaseSnapshot,
} from "./migration-stamps";

const SCRIPT = path.join(import.meta.dir, "migration-stamp-early-warning.sh");

const git = (cwd: string, ...arguments_: string[]) => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
};

const migration = (root: string, name: string) => {
  const directory = path.join(root, "apps/api/drizzle", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "migration.sql"), `-- ${name}\n`);
};

const commit = (root: string, message: string) => {
  git(root, "add", ".");
  git(root, "commit", "-qm", message);
};

/**
 * main holds an initial migration; `feature` branches from it and adds
 * `featureMigrations`; main then gains `mainMigrations`.
 */
const fixture = ({
  featureMigrations,
  mainMigrations,
}: {
  featureMigrations: readonly string[];
  mainMigrations: readonly string[];
}) => {
  const root = mkdtempSync(path.join(tmpdir(), "migration-early-warning-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  migration(root, "20260101000000_initial");
  commit(root, "initial");
  git(root, "switch", "-qc", "feature");
  for (const name of featureMigrations) {
    migration(root, name);
  }
  writeFileSync(path.join(root, "feature.txt"), "feature\n");
  commit(root, "feature");
  git(root, "switch", "-q", "main");
  for (const name of mainMigrations) {
    migration(root, name);
  }
  writeFileSync(path.join(root, "main.txt"), "main\n");
  commit(root, "main");
  git(root, "switch", "-q", "feature");
  return root;
};

const run = (root: string, ...arguments_: string[]) => {
  const summary = path.join(root, ".git", "step-summary.txt");
  const result = Bun.spawnSync(["bash", SCRIPT, ...arguments_], {
    cwd: root,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    wroteSummary: Bun.file(summary).size > 0,
  };
};

test("fails a migration that main overtook and prints the fix", () => {
  const root = fixture({
    featureMigrations: ["20260101010000_feature"],
    mainMigrations: ["20260101020000_main_newer"],
  });
  try {
    const result = run(root, "main");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "::error title=Migration stamp behind main::apps/api/drizzle/20260101010000_feature must be stamped later than apps/api/drizzle/20260101020000_main_newer on main",
    );
    expect(result.stdout).toContain(`Fix: ${MIGRATION_RESTAMP_COMMAND}`);
    expect(result.stdout).toContain(`\n${MIGRATION_RESTAMP_COMMAND}\n`);
    expect(result.wroteSummary).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names only the stale migrations and treats an equal stamp as stale", () => {
  const root = fixture({
    featureMigrations: [
      "20260101020000_same_stamp",
      "20260101015900_older",
      "20260101030000_newer",
    ],
    mainMigrations: ["20260101020000_main"],
  });
  try {
    const result = run(root, "main");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "- `apps/api/drizzle/20260101015900_older`",
    );
    expect(result.stdout).toContain(
      "- `apps/api/drizzle/20260101020000_same_stamp`",
    );
    expect(result.stdout).not.toContain("20260101030000_newer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes when every added migration follows main's newest", () => {
  const root = fixture({
    featureMigrations: ["20260101030000_feature"],
    mainMigrations: ["20260101020000_main"],
  });
  try {
    const result = run(root, "main");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Every added migration follows 20260101020000_main on main.",
    );
    expect(result.wroteSummary).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes a branch without migrations and ignores main's own additions", () => {
  const root = fixture({
    featureMigrations: [],
    mainMigrations: ["20260101020000_main"],
  });
  try {
    expect(run(root, "main").exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks an explicit head, such as the pull request merge commit", () => {
  const root = fixture({
    featureMigrations: ["20260101010000_feature"],
    mainMigrations: [],
  });
  try {
    // The merge commit of the branch onto main as it was; main then moves.
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge ref", "feature");
    const mergeRef = git(root, "rev-parse", "HEAD");
    git(root, "reset", "-q", "--hard", "HEAD^");
    const mainBefore = git(root, "rev-parse", "HEAD");
    migration(root, "20260101020000_main_newer");
    commit(root, "main moves");
    expect(run(root, "main", mergeRef).exitCode).toBe(1);
    expect(run(root, mainBefore, mergeRef).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agrees with the merge-group check on which migrations are stale", () => {
  const root = fixture({
    featureMigrations: [
      "20260101010000_a",
      "20260101020000_b",
      "20260101020001_c",
    ],
    mainMigrations: ["20260101015959_x", "20260101020000_y"],
  });
  try {
    const snapshot = readMigrationBaseSnapshot({ baseRef: "main", cwd: root });
    const expected = findMigrationTimestampViolations({
      addedDirectories: snapshot.changes.addedDirectories,
      baseDirectories: snapshot.baseDirectories,
    })
      .map(({ directory }) => directory)
      .toSorted();
    expect(expected).toEqual([
      "apps/api/drizzle/20260101010000_a",
      "apps/api/drizzle/20260101020000_b",
    ]);
    const reported = [
      ...run(root, "main").stdout.matchAll(
        /^- `(apps\/api\/drizzle\/[^`]+)`$/gmu,
      ),
    ].map((match) => match[1]);
    expect(reported).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
