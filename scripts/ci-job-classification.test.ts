import { expect, test } from "bun:test";

import { generateClassification } from "./ci-job-classification/generate";
import type { DerivedJob } from "./ci-job-classification/generate";

const CALLER = "candidate:.github/workflows/caller.yml/call";
const CALLEE = "candidate:.github/workflows/shared.yml/check";

const workflow = (
  call: string,
  calleeStep: string,
): Record<string, string> => ({
  ".github/workflows/caller.yml": `on: push
jobs:
  call:
${call}
`,
  ".github/workflows/shared.yml": `on: workflow_call
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - ${calleeStep}
`,
});

const jobsFor = (documents: Record<string, string>) => {
  let jobs: ReadonlyMap<string, DerivedJob> | undefined;
  generateClassification({
    decisions: {},
    snapshots: {},
    reader: {
      workflows: () => [".github/workflows/caller.yml"],
      read: (_repository, file) => {
        const document = documents[file];
        if (document === undefined) {
          throw new Error(`Missing fixture document: ${file}`);
        }
        return document;
      },
    },
    localActionPath: (directory) => `${directory}/action.yml`,
    observeJobs: (derived) => {
      jobs = derived;
    },
  });
  if (!jobs) {
    throw new Error("Fixture jobs were not derived");
  }
  return jobs;
};

const digest = (jobs: ReadonlyMap<string, DerivedJob>, key: string) => {
  const value = jobs.get(key)?.digest;
  if (value === undefined) {
    throw new Error(`Missing fixture job: ${key}`);
  }
  return value;
};

const BASE_CALL = "    uses: ./.github/workflows/shared.yml";
const SECRET_REFERENCE = String.raw`\${{ secrets.DEPLOY }}`;

test("callee content changes do not change the reusable-workflow caller digest", () => {
  const before = jobsFor(
    workflow(
      BASE_CALL,
      "uses: acme/check@0000000000000000000000000000000000000000",
    ),
  );
  const after = jobsFor(
    workflow(
      BASE_CALL,
      "uses: acme/check@1111111111111111111111111111111111111111",
    ),
  );

  expect(digest(after, CALLER)).toBe(digest(before, CALLER));
  expect(digest(after, CALLEE)).not.toBe(digest(before, CALLEE));
});

test("composite action changes do not change the reusable-workflow caller digest", () => {
  const documents = workflow(BASE_CALL, "uses: ./.github/actions/setup");
  const before = jobsFor({
    ...documents,
    ".github/actions/setup/action.yml":
      "runs: {using: composite, steps: [{uses: acme/setup@0000000000000000000000000000000000000000}]}",
  });
  const after = jobsFor({
    ...documents,
    ".github/actions/setup/action.yml":
      "runs: {using: composite, steps: [{uses: acme/setup@1111111111111111111111111111111111111111}]}",
  });

  expect(digest(after, CALLER)).toBe(digest(before, CALLER));
  expect(digest(after, CALLEE)).not.toBe(digest(before, CALLEE));
});

test.each([
  ["secrets", `${BASE_CALL}\n    secrets: inherit`],
  ["with", `${BASE_CALL}\n    with: {suite: full}`],
  ["permissions", `${BASE_CALL}\n    permissions: {contents: read}`],
  ["uses target", "    uses: ./.github/workflows/other.yml"],
] as const)("changing caller %s changes its digest", (_, changedCall) => {
  const before = jobsFor(workflow(BASE_CALL, "run: echo unchanged"));
  const afterDocuments = workflow(changedCall, "run: echo unchanged");
  if (changedCall.includes("other.yml")) {
    const shared = afterDocuments[".github/workflows/shared.yml"];
    if (shared === undefined) {
      throw new Error("Shared fixture document missing");
    }
    afterDocuments[".github/workflows/other.yml"] = shared;
  }
  const after = jobsFor(afterDocuments);
  expect(digest(after, CALLER)).not.toBe(digest(before, CALLER));
});

test("a secret newly read by a callee changes only the callee digest", () => {
  const call = `${BASE_CALL}\n    secrets: inherit`;
  const before = jobsFor(workflow(call, "run: echo unchanged"));
  const after = jobsFor(
    workflow(
      call,
      `env: {TOKEN: '${SECRET_REFERENCE}'}\n        run: echo unchanged`,
    ),
  );

  expect(digest(after, CALLER)).toBe(digest(before, CALLER));
  expect(digest(after, CALLEE)).not.toBe(digest(before, CALLEE));
  expect(after.get(CALLEE)?.privileged).toBe(true);
});

test("a privileged callee change keeps its own approval digest", () => {
  const before = jobsFor(
    workflow(
      BASE_CALL,
      `env: {TOKEN: '${SECRET_REFERENCE}'}\n        run: echo before`,
    ),
  );
  const after = jobsFor(
    workflow(
      BASE_CALL,
      `env: {TOKEN: '${SECRET_REFERENCE}'}\n        run: echo after`,
    ),
  );

  expect(digest(after, CALLER)).toBe(digest(before, CALLER));
  expect(digest(after, CALLEE)).not.toBe(digest(before, CALLEE));
  expect(after.get(CALLEE)?.privileged).toBe(true);
});
