import { expect, test } from "bun:test";
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

import { checkJobClassification } from "../check-ci-job-classification";
import { decisionKeyFromPath, writeDecision } from "./decisions";
import { generateClassification, readClassificationInputs } from "./generate";
import type { DerivedJob } from "./generate";
import { decisionPathForKey } from "./inputs";
import { verifyPublicMetadata } from "./public-metadata";
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

const createFixture = (
  newWorkflow = reusable(),
  callers = [".github/workflows/caller.yml"],
) => {
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

  for (const file of callers) {
    write(root, file, caller(oldSha));
  }
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
      decisionKeyFromPath(
        `.github/ci-job-classification-decisions/${name}/decision.json`,
      ),
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

test("a pin bumped in one of two callers copies the decision to the new revision", () => {
  const fixture = createFixture(reusable(), [
    ".github/workflows/caller.yml",
    ".github/workflows/other.yml",
  ]);
  write(fixture.root, ".github/workflows/caller.yml", caller(fixture.newSha));
  writeSnapshots({
    root: fixture.root,
    sources: sources(fixture.source, fixture.newSha),
    base: fixture.base,
  });

  const snapshots = readClassificationInputs(fixture.root).snapshots;
  expect(Object.keys(snapshots).toSorted()).toEqual(["supplier6", "supplier7"]);
  const decisionKind = (key: string) =>
    JSON.parse(
      readFileSync(path.join(fixture.root, decisionPathForKey(key)), "utf-8"),
    ).kind;
  // The revision still pinned keeps its decision; the new one starts from
  // a copy, which passes only while the job's digest is unchanged.
  expect(decisionKind("supplier6:.github/workflows/shared.yml/shared")).toBe(
    "ordinary",
  );
  expect(decisionKind("supplier7:.github/workflows/shared.yml/shared")).toBe(
    "ordinary",
  );
  const result = checkJobClassification(fixture.root, fixture.base);
  const message = result.isErr() ? result.error.message : "";
  expect(message).not.toContain("supplier7:");
});

test("a bump of one of two workflows from one source moves only that job's decision", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "classification-snapshots-"),
  );
  const source = path.join(directory, "source");
  const root = path.join(directory, "candidate");
  for (const repository of [source, root]) {
    mkdirSync(repository);
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "tests@example.com");
    git(repository, "config", "user.name", "Tests");
  }
  const lint = reusable().replace("shared:", "lint:");
  write(source, ".github/workflows/shared.yml", reusable());
  write(source, ".github/workflows/lint.yml", lint);
  const oldSha = commit(source, "old");
  const newSha = commit(source, "new");
  const lintCaller = (sha: string) =>
    caller().replace(
      "echo local\n",
      () =>
        `echo local\n  lint:\n    uses: acme/shared/.github/workflows/lint.yml@${sha}\n`,
    );
  write(root, ".github/workflows/caller.yml", caller(oldSha));
  write(root, ".github/workflows/other.yml", lintCaller(oldSha));
  write(
    root,
    ".github/ci-job-classification-sources.json",
    `${JSON.stringify(
      {
        supplier6: {
          origin: { type: "git", owner: "acme", repo: "shared", sha: oldSha },
          documents: {
            ".github/workflows/lint.yml": lint,
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
  for (const [key, job] of jobs ?? new Map<string, DerivedJob>()) {
    writeDecision(root, key, {
      kind: "ordinary",
      qualifier: `reviewed ${key}`,
      reviewedDigest: job.digest,
    });
  }
  const base = commit(root, "base");
  write(root, ".github/workflows/caller.yml", caller(newSha));
  writeSnapshots({ root, sources: sources(source, newSha), base });

  const remoteDecisions = readdirSync(
    path.join(root, ".github/ci-job-classification-decisions"),
  )
    .map((name) =>
      decisionKeyFromPath(
        `.github/ci-job-classification-decisions/${name}/decision.json`,
      ),
    )
    .filter((key) => key.startsWith("supplier"))
    .toSorted();
  expect(remoteDecisions).toEqual([
    "supplier6:.github/workflows/lint.yml/lint",
    "supplier7:.github/workflows/shared.yml/shared",
  ]);
  const result = checkJobClassification(root, base);
  const message = result.isErr() ? result.error.message : "";
  expect(message).not.toContain("supplier");
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

const createConvergingFixture = (
  kinds: readonly [string, string],
  split = false,
) => {
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
  const firstSha = commit(source, "first");
  const secondSha = commit(source, "second");
  const newSha = commit(source, "new");
  const otherSha = split ? commit(source, "other") : newSha;
  write(root, ".github/workflows/first.yml", caller(firstSha));
  write(root, ".github/workflows/second.yml", caller(secondSha));
  const snapshot = (sha: string) => ({
    origin: { type: "git", owner: "acme", repo: "shared", sha },
    documents: { ".github/workflows/shared.yml": reusable() },
  });
  write(
    root,
    ".github/ci-job-classification-sources.json",
    `${JSON.stringify(
      { supplier6: snapshot(firstSha), supplier7: snapshot(secondSha) },
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
    const kind = key.startsWith("supplier7:") ? kinds[1] : kinds[0];
    writeDecision(root, key, {
      kind,
      qualifier: `reviewed ${key}`,
      reviewedDigest: job.digest,
    });
  }
  const base = commit(root, "base");
  write(root, ".github/workflows/first.yml", caller(newSha));
  write(root, ".github/workflows/second.yml", caller(otherSha));
  writeSnapshots({
    root,
    sources: { ...sources(source, newSha), ...sources(source, otherSha) },
    base,
  });
  const remoteDecisions = readdirSync(
    path.join(root, ".github/ci-job-classification-decisions"),
  )
    .map((name) =>
      decisionKeyFromPath(
        `.github/ci-job-classification-decisions/${name}/decision.json`,
      ),
    )
    .filter((key) => key.startsWith("supplier"));
  const kindOf = (sha: string) => {
    const supplier =
      Object.entries(readClassificationInputs(root).snapshots).find(
        ([, entry]) => entry.origin.sha === sha,
      )?.[0] ?? "missing";
    const key = `${supplier}:.github/workflows/shared.yml/shared`;
    return remoteDecisions.includes(key)
      ? JSON.parse(
          readFileSync(path.join(root, decisionPathForKey(key)), "utf-8"),
        ).kind
      : undefined;
  };
  return { root, base, remoteDecisions, kindOf, newSha, otherSha };
};

test("two old revisions bumped to two new ones keep their own decisions", () => {
  const fixture = createConvergingFixture(["ordinary", "priority"], true);
  expect(fixture.remoteDecisions).toHaveLength(2);
  expect(fixture.kindOf(fixture.newSha)).toBe("ordinary");
  expect(fixture.kindOf(fixture.otherSha)).toBe("priority");
});

test("two old revisions converging on one keep a decision they agree on", () => {
  const fixture = createConvergingFixture(["ordinary", "ordinary"]);
  expect(Object.keys(readClassificationInputs(fixture.root).snapshots)).toEqual(
    ["supplier8"],
  );
  expect(fixture.remoteDecisions).toEqual([
    "supplier8:.github/workflows/shared.yml/shared",
  ]);
});

test("two old revisions converging on one with different kinds need a review", () => {
  const fixture = createConvergingFixture(["ordinary", "priority"]);
  expect(fixture.remoteDecisions).toEqual([]);
  const result = checkJobClassification(fixture.root, fixture.base);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("Missing or changed job review");
  }
});

test("nested composite actions retain the reusable workflow checkout mount", () => {
  const sha = "a".repeat(40);
  const fixture = createFixture(
    reusable(`uses: actions/checkout@${sha}
        with:
          ref: \${{ job.workflow_sha }}
          path: .tooling
      - uses: ./.tooling/.github/actions/outer`),
  );
  for (const { name, next } of [
    { name: "outer", next: "middle" },
    { name: "middle", next: "inner" },
  ]) {
    write(
      fixture.source,
      `.github/actions/${name}/action.yml`,
      `runs:
  using: composite
  steps:
    - uses: ./.tooling/.github/actions/${next}
`,
    );
  }
  write(
    fixture.source,
    ".github/actions/inner/action.yml",
    `runs:
  using: composite
  steps:
    - shell: bash
      run: echo nested
`,
  );
  const revision = commit(fixture.source, "nested metadata closure");
  write(fixture.root, ".github/workflows/caller.yml", caller(revision));
  writeSnapshots({
    root: fixture.root,
    sources: sources(fixture.source, revision),
    base: fixture.base,
  });
  const inputs = readClassificationInputs(fixture.root);
  const snapshot = Object.values(inputs.snapshots).find(
    ({ origin }) => origin.sha === revision,
  );
  expect(Object.keys(snapshot?.documents ?? {}).toSorted()).toEqual([
    ".github/actions/inner/action.yml",
    ".github/actions/middle/action.yml",
    ".github/actions/outer/action.yml",
    ".github/workflows/shared.yml",
  ]);
  // Fixture review decisions are explicit; production refresh never invents them.
  rmSync(path.join(fixture.root, ".github/ci-job-classification-decisions"), {
    recursive: true,
  });
  mkdirSync(path.join(fixture.root, ".github/ci-job-classification-decisions"));
  generateClassification({
    ...readClassificationInputs(fixture.root),
    observeJobs: (jobs) => {
      for (const [key, job] of jobs) {
        rmSync(path.dirname(path.join(fixture.root, decisionPathForKey(key))), {
          recursive: true,
          force: true,
        });
        writeDecision(fixture.root, key, {
          kind: "ordinary",
          qualifier: `fixture ${key}`,
          reviewedDigest: job.digest,
        });
      }
    },
  });
  const generated = generateClassification(
    readClassificationInputs(fixture.root),
  );
  if (generated.isErr()) {
    throw generated.error;
  }
  expect(generated.isOk()).toBe(true);
  const nested = generated.value.nodes.filter(
    (node) => node.type === "metadata" && node.path.includes("/actions/"),
  );
  expect(nested).toHaveLength(3);
  const changedOrigin = verifyPublicMetadata({
    manifest: generated.value,
    reader: {
      ...inputs.reader,
      read: (repository, file) => {
        const text = inputs.reader.read(repository, file);
        return file === ".github/workflows/shared.yml"
          ? text.replace(`\${{ job.workflow_sha }}`, "main")
          : text;
      },
    },
  });
  expect(changedOrigin.isErr()).toBe(true);
  if (changedOrigin.isErr()) {
    expect(changedOrigin.error.message).toContain("origin mismatch");
  }
});
