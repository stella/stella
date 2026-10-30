import { expect, test } from "bun:test";

import { generateClassification } from "./ci-job-classification/generate";
import type { DerivedJob } from "./ci-job-classification/generate";
import { expectedJobDigest } from "./ci-job-classification/job-digests";
import { verifyPublicMetadata } from "./ci-job-classification/public-metadata";
import { parseDocument } from "./ci-job-classification/yaml";

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

const readerFor = (documents: Record<string, string>) => ({
  workflows: () => [".github/workflows/caller.yml"],
  read: (_repository: string, file: string) => {
    const document = documents[file];
    if (document === undefined) {
      throw new Error(`Missing fixture document: ${file}`);
    }
    return document;
  },
});

const generateApproved = (documents: Record<string, string>) => {
  const jobs = jobsFor(documents);
  const decisions = Object.fromEntries(
    [...jobs].map(([key, job]) => [
      key,
      {
        kind: "ordinary" as const,
        qualifier: "fixture",
        approvedDigests: [job.digest],
      },
    ]),
  );
  const reader = readerFor(documents);
  const generated = generateClassification({
    decisions,
    snapshots: {},
    reader,
    localActionPath: (directory) => `${directory}/action.yml`,
  });
  if (generated.isErr()) {
    throw generated.error;
  }
  return { generated: generated.value, reader };
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

test("a callee inherits a privileged caller grant", () => {
  const before = jobsFor({
    ".github/workflows/caller.yml": `on: push
permissions: {actions: write}
jobs:
  call:
    uses: ./.github/workflows/shared.yml
`,
    ".github/workflows/shared.yml": `on: workflow_call
permissions: {}
jobs:
  check:
    permissions: {}
    runs-on: ubuntu-latest
    steps: []
`,
  });
  const after = jobsFor({
    ".github/workflows/caller.yml": `on: push
permissions: {actions: write}
jobs:
  call:
    uses: ./.github/workflows/shared.yml
`,
    ".github/workflows/shared.yml": `on: workflow_call
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.token }}
`,
  });

  expect(before.get(CALLEE)?.privileged).toBe(false);
  expect(after.get(CALLEE)?.privileged).toBe(true);
  expect(digest(after, CALLEE)).not.toBe(digest(before, CALLEE));
});

test("a uses change in an inherited-privileged callee changes its digest", () => {
  const privilegedWorkflow = (action: string) => ({
    ".github/workflows/caller.yml": `on: push
permissions: {actions: write}
jobs: {call: {uses: ./.github/workflows/shared.yml}}
`,
    ".github/workflows/shared.yml": `on: workflow_call
jobs: {check: {steps: [{uses: ${action}}]}}
`,
  });
  const before = jobsFor(
    privilegedWorkflow("acme/check@0000000000000000000000000000000000000000"),
  );
  const after = jobsFor(
    privilegedWorkflow("acme/check@1111111111111111111111111111111111111111"),
  );

  expect(after.get(CALLEE)?.privileged).toBe(true);
  expect(digest(after, CALLEE)).not.toBe(digest(before, CALLEE));
});

test("a callee reached only by read-only callers stays non-privileged", () => {
  const jobs = jobsFor({
    ".github/workflows/caller.yml": `on: push
permissions: {contents: read}
jobs: {call: {uses: ./.github/workflows/shared.yml}}
`,
    ".github/workflows/shared.yml": `on: workflow_call
jobs: {check: {steps: [{run: 'echo \${{ github.token }}'}]}}
`,
  });

  expect(jobs.get(CALLEE)?.privileged).toBe(false);
});

test("an inherited privileged grant has one generation and verification digest", () => {
  const documents = {
    ".github/workflows/caller.yml": `on: push
permissions: {actions: write}
jobs: {call: {uses: ./.github/workflows/shared.yml}}
`,
    ".github/workflows/shared.yml": `on: workflow_call
jobs: {check: {runs-on: ubuntu-latest, steps: [{run: echo inherited}]}}
`,
  };
  const { generated, reader } = generateApproved(documents);

  expect(verifyPublicMetadata({ manifest: generated, reader }).isOk()).toBe(
    true,
  );

  const parsed = parseDocument(documents[".github/workflows/shared.yml"]);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  const definition = parsed.value.jobs["check"];
  if (!definition) {
    throw new Error("Missing fixture callee");
  }
  const digestWithoutInheritedGrant = expectedJobDigest({
    definition,
    privileged: true,
    dependencyDigests: {},
  });
  const withoutInheritedGrant = structuredClone(generated);
  const callee = withoutInheritedGrant.nodes.find(
    (node) => node.type === "metadata" && node.path.endsWith("shared.yml"),
  );
  if (!callee || callee.type !== "metadata") {
    throw new Error("Missing generated callee");
  }
  const calleeJob = callee.jobs.find((job) => job.id === "check");
  if (!calleeJob) {
    throw new Error("Missing generated callee job");
  }
  calleeJob.digest = digestWithoutInheritedGrant;

  const rejected = verifyPublicMetadata({
    manifest: withoutInheritedGrant,
    reader,
  });
  expect(rejected.isErr()).toBe(true);
  if (rejected.isErr()) {
    expect(rejected.error.message).toContain(
      "Classification-relevant shape changed",
    );
  }
});

test.each([
  ["ordinary", workflow(BASE_CALL, "run: echo ordinary")],
  [
    "privileged",
    workflow(
      BASE_CALL,
      `env: {TOKEN: '${SECRET_REFERENCE}'}\n        run: echo privileged`,
    ),
  ],
  [
    "inherited privileged",
    {
      ".github/workflows/caller.yml": `on: push\npermissions: {contents: write}\njobs: {call: {uses: ./.github/workflows/shared.yml}}\n`,
      ".github/workflows/shared.yml": `on: workflow_call\njobs: {check: {runs-on: ubuntu-latest, steps: []}}\n`,
    },
  ],
] as const)("every generated %s fixture verifies", (_, documents) => {
  const { generated, reader } = generateApproved(documents);
  expect(verifyPublicMetadata({ manifest: generated, reader }).isOk()).toBe(
    true,
  );
});

test("changing workflow permissions changes a caller call-surface digest", () => {
  const documents = workflow(BASE_CALL, "run: echo unchanged");
  const before = jobsFor({
    ...documents,
    ".github/workflows/caller.yml": `on: push
permissions: {contents: read}
jobs: {call: {uses: ./.github/workflows/shared.yml}}
`,
  });
  const after = jobsFor({
    ...documents,
    ".github/workflows/caller.yml": `on: push
permissions: {actions: read}
jobs: {call: {uses: ./.github/workflows/shared.yml}}
`,
  });

  expect(digest(after, CALLER)).not.toBe(digest(before, CALLER));
});
