import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkJobClassification } from "../check-ci-job-classification";
import { writeDecision } from "./decisions";
import { generateClassification, readClassificationInputs } from "./generate";
import type { DerivedJob } from "./generate";

const git = (directory: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
};

const workflow = (job: string) => `name: fixture
on: push
jobs:
  job:
    runs-on: ubuntu-latest
${job}
`;
const RUN_STEP = "    steps:\n      - run: echo ok";

// One workflow job, classified with `kind` at its current digest.
const classifiedFixture = (job: string, kind: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-writers-"));
  git(root, "init", "-q");
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(root, ".github/ci-job-classification-decisions"));
  writeFileSync(
    path.join(root, ".github/workflows/fixture.yml"),
    workflow(job),
  );
  writeFileSync(
    path.join(root, ".github/ci-job-classification-sources.json"),
    "{}\n",
  );
  let jobs: ReadonlyMap<string, DerivedJob> | undefined;
  generateClassification({
    ...readClassificationInputs(root),
    observeJobs: (value) => {
      jobs = value;
    },
  });
  for (const [key, derived] of jobs ?? []) {
    writeDecision(root, key, {
      kind,
      qualifier: `reviewed ${key}`,
      reviewedDigest: derived.digest,
    });
  }
  return { root, jobs: jobs ?? new Map<string, DerivedJob>() };
};

const CONTENTS_WRITE = `    permissions:\n      contents: write\n${RUN_STEP}`;
const writerJobs = [
  ["contents write permission", CONTENTS_WRITE],
  ["write-all permissions", `    permissions: write-all\n${RUN_STEP}`],
  [
    "an app token requesting contents write",
    "    steps:\n      - uses: actions/create-github-app-token@0000000000000000000000000000000000000000\n        with:\n          permission-contents: write",
  ],
  [
    "the signed-commit action",
    "    steps:\n      - uses: stella/.github/.github/actions/signed-commit@0000000000000000000000000000000000000000",
  ],
] as const;

test.each(writerJobs)("a job with %s writes the repository", (_, job) => {
  const { jobs } = classifiedFixture(job, "priority");
  expect([...jobs.values()].map((derived) => derived.writesRepository)).toEqual(
    [true],
  );
});

test("pull-request write alone publishes nothing", () => {
  const { jobs } = classifiedFixture(
    `    permissions:\n      pull-requests: write\n${RUN_STEP}`,
    "ordinary",
  );
  expect([...jobs.values()].map((derived) => derived.writesRepository)).toEqual(
    [false],
  );
});

test("a repository writer must be classified priority", () => {
  const job = CONTENTS_WRITE;
  for (const kind of ["ordinary", "support"]) {
    const refused = checkJobClassification(classifiedFixture(job, kind).root);
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) {
      expect(refused.error.message).toContain("must be classified priority");
    }
  }
  expect(
    checkJobClassification(classifiedFixture(job, "priority").root).isOk(),
  ).toBe(true);
});
