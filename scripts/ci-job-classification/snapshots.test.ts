import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkJobClassification } from "../check-ci-job-classification";
import { decisionKeyFromPath, writeDecision } from "./decisions";
import { generateClassification, readClassificationInputs } from "./generate";
import type { DerivedJob } from "./generate";
import { decisionPathForKey } from "./inputs";
import { writeSnapshots } from "./snapshots";

const git = (directory: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
};

const commit = (directory: string, message: string) => {
  git(directory, "add", ".");
  git(directory, "commit", "--allow-empty", "-m", message);
  return git(directory, "rev-parse", "HEAD");
};

const reusable = (step = "run: echo ok") => `name: shared
on:
  workflow_call:
jobs:
  shared:
    runs-on: ubuntu-latest
    steps:
      - ${step}
`;

const caller = (sha?: string) => `name: caller
on: push
jobs:
  local:
    runs-on: ubuntu-latest
    steps:
      - run: echo local
${sha ? `  shared:\n    uses: acme/shared/.github/workflows/shared.yml@${sha}\n` : ""}`;

const write = (root: string, file: string, text: string) => {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
};

const createFixture = (newWorkflow = reusable()) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "classification-snapshots-"),
  );
  const source = path.join(directory, "source");
  const root = path.join(directory, "candidate");
  mkdirSync(source);
  mkdirSync(root);
  for (const repository of [source, root]) {
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "tests@example.com");
    git(repository, "config", "user.name", "Tests");
  }
  write(source, ".github/workflows/shared.yml", reusable());
  const oldSha = commit(source, "old");
  write(source, ".github/workflows/shared.yml", newWorkflow);
  const newSha = commit(source, "new");

  write(root, ".github/workflows/caller.yml", caller(oldSha));
  write(
    root,
    ".github/ci-job-classification-sources.json",
    `${JSON.stringify(
      {
        supplier6: {
          origin: { type: "git", owner: "acme", repo: "shared", sha: oldSha },
          documents: {
            ".github/workflows/shared.yml": reusable(),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(root, ".github/ci-job-classification-decisions"));
  let jobs: ReadonlyMap<string, DerivedJob> | undefined;
  generateClassification({
    ...readClassificationInputs(root),
    observeJobs: (value) => {
      jobs = value;
    },
  });
  if (!jobs) {
    throw new Error("fixture jobs missing");
  }
  for (const [key, job] of jobs) {
    writeDecision(root, key, {
      kind: "ordinary",
      qualifier: `reviewed ${key}`,
      reviewedDigest: job.digest,
    });
  }
  const base = commit(root, "base");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  return { root, source, oldSha, newSha, base };
};

const sources = (source: string, sha: string) => ({
  [`acme/shared@${sha}`]: { directory: source, revision: sha },
});

test("a bumped pin snapshots the new revision and preserves the review decision", () => {
  const fixture = createFixture();
  write(fixture.root, ".github/workflows/caller.yml", caller(fixture.newSha));
  writeSnapshots({
    root: fixture.root,
    sources: sources(fixture.source, fixture.newSha),
    base: fixture.base,
  });

  const snapshots = readClassificationInputs(fixture.root).snapshots;
  expect(Object.keys(snapshots)).toEqual(["supplier7"]);
  expect(snapshots["supplier7"]?.origin.sha).toBe(fixture.newSha);
  const remoteDecision = readdirSync(
    path.join(fixture.root, ".github/ci-job-classification-decisions"),
  )
    .map((name) =>
      decisionKeyFromPath(`.github/ci-job-classification-decisions/${name}`),
    )
    .find((key) => key.startsWith("supplier7:"));
  expect(remoteDecision).toBe("supplier7:.github/workflows/shared.yml/shared");
  if (!remoteDecision) {
    throw new Error("renamed remote decision missing");
  }
  const decision = JSON.parse(
    readFileSync(
      path.join(fixture.root, decisionPathForKey(remoteDecision)),
      "utf-8",
    ),
  );
  expect(decision.kind).toBe("ordinary");
  expect(decision.qualifier).toBe(
    "reviewed supplier6:.github/workflows/shared.yml/shared",
  );
});

test("an unchanged pin writes nothing", () => {
  const fixture = createFixture();
  writeSnapshots({ root: fixture.root, sources: {}, base: fixture.base });
  expect(git(fixture.root, "status", "--porcelain")).toBe("");
});

test("a removed reference drops its supplier and decisions", () => {
  const fixture = createFixture();
  write(fixture.root, ".github/workflows/caller.yml", caller());
  writeSnapshots({ root: fixture.root, sources: {}, base: fixture.base });
  expect(readClassificationInputs(fixture.root).snapshots).toEqual({});
  expect(
    readdirSync(
      path.join(fixture.root, ".github/ci-job-classification-decisions"),
    ).some((name) => decodeURIComponent(name).startsWith("supplier6:")),
  ).toBe(false);
});

test("a transitively used composite action is included", () => {
  const fixture = createFixture(reusable("uses: ./.github/actions/setup"));
  write(
    fixture.source,
    ".github/actions/setup/action.yml",
    "name: setup\nruns:\n  using: composite\n  steps:\n    - run: echo setup\n      shell: bash\n",
  );
  git(fixture.source, "add", ".");
  git(fixture.source, "commit", "--amend", "--no-edit");
  const sha = git(fixture.source, "rev-parse", "HEAD");
  write(fixture.root, ".github/workflows/caller.yml", caller(sha));
  writeSnapshots({
    root: fixture.root,
    sources: sources(fixture.source, sha),
    base: fixture.base,
  });
  const snapshot = readClassificationInputs(fixture.root).snapshots[
    "supplier7"
  ];
  expect(Object.keys(snapshot?.documents ?? {})).toEqual([
    ".github/actions/setup/action.yml",
    ".github/workflows/shared.yml",
  ]);
});

test("a privilege-relevant content change remains review-required", () => {
  const fixture = createFixture(
    reusable("uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"),
  );
  write(fixture.root, ".github/workflows/caller.yml", caller(fixture.newSha));
  writeSnapshots({
    root: fixture.root,
    sources: sources(fixture.source, fixture.newSha),
    base: fixture.base,
  });
  const result = checkJobClassification(fixture.root, fixture.base);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("Missing or changed job review");
  }
});
