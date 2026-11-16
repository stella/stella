import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { withoutCiEventContext } from "../packages/scripts/src/without-ci-event-context";
import {
  readDecisions,
  writeDecision,
} from "./ci-job-classification/decisions";
import {
  generateClassification,
  readClassificationInputs,
  readClassificationInputsAtRevision,
} from "./ci-job-classification/generate";
import {
  CLASSIFICATION_DECISIONS_PATH,
  CLASSIFICATION_INPUT_GLOBS,
  CLASSIFICATION_INPUT_PATHS,
  decisionDirectoryForKey,
  decisionPathForKey,
  isClassificationInput,
} from "./ci-job-classification/inputs";
import { writeClassificationFixtureInputs } from "./ci-job-classification/test-fixtures";
import { AdmissionError, parseDocument } from "./ci-job-classification/yaml";
import { GENERATORS } from "./generated-files";

const repositoryRoot = path.resolve(import.meta.dir, "..");

const classificationReads = () => {
  const reads = new Set<string>();
  const inputs = readClassificationInputs(repositoryRoot, {
    observeRead: (file) => {
      reads.add(file);
    },
  });
  generateClassification(inputs);
  return reads;
};

const covers = (input: string, file: string) =>
  file === input || file.startsWith(`${input}/`);

test("every repository file read by classification is an input", () => {
  const uncovered = [...classificationReads()].filter(
    (file) => !isClassificationInput(file),
  );
  expect(uncovered).toEqual([]);
});

test("every classification input is read by the real program", async () => {
  const runtimeReads = classificationReads();
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "check-ci-job-classification.ts")],
    target: "bun",
    metafile: true,
  });
  expect(
    build.success,
    build.logs.map(({ message }) => message).join("\n"),
  ).toBe(true);
  const executableReads = new Set(
    Object.values(build.metafile?.outputs ?? {}).flatMap((output) =>
      Object.keys(output.inputs),
    ),
  );
  const unread = CLASSIFICATION_INPUT_PATHS.filter(
    (input) =>
      ![...runtimeReads, ...executableReads].some((file) =>
        covers(input, file),
      ),
  );
  expect(unread).toEqual([]);
});

test("the classification generator reads and writes every input it owns", () => {
  const generator = GENERATORS.find(
    ({ id }) => id === "ci-job-classification-decisions",
  );
  expect(generator?.inputs).toEqual(CLASSIFICATION_INPUT_GLOBS);
  expect(generator?.outputs).toEqual([
    `${CLASSIFICATION_DECISIONS_PATH}/**`,
    ".github/ci-job-classification-sources.json",
  ]);
  // The autofix action may not modify .github/, where every output lives.
  expect(generator?.autofix).toBe(false);
  expect(generator?.write).toEqual([
    "bun",
    "scripts/check-ci-job-classification.ts",
    "--write",
  ]);
});

test("the classification input paths load alone, without packages or siblings", () => {
  // The autofix planner reads them from a sparse checkout without package
  // dependencies, so the module imports nothing beyond the runtime.
  const root = mkdtempSync(path.join(tmpdir(), "classification-inputs-"));
  try {
    const copy = path.join(root, "inputs.ts");
    writeFileSync(
      copy,
      readFileSync(
        path.join(import.meta.dir, "ci-job-classification/inputs.ts"),
        "utf-8",
      ),
    );
    const loaded = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(copy)}); if (!m.CLASSIFICATION_INPUT_GLOBS.length) process.exit(2);`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(loaded.exitCode, loaded.stderr.toString()).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a revision from before the global rule manifest still classifies, and records it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-revision-"));
  try {
    writeClassificationFixtureInputs(root);
    // The base a branch forked from before the manifest existed.
    rmSync(path.join(root, ".github/global-rule-inputs.json"));
    writeFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "jobs: {check: {steps: []}}",
    );
    const git = (...args: string[]) =>
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Classification Test",
          "-c",
          "user.email=classification-test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-C",
          root,
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    expect(git("init", "--quiet").exitCode).toBe(0);
    expect(git("add", ".").exitCode).toBe(0);
    expect(git("commit", "--quiet", "-m", "base").exitCode).toBe(0);
    const reads = new Set<string>();
    const inputs = readClassificationInputsAtRevision(root, "HEAD", {
      observeRead: (file) => {
        reads.add(file);
      },
    });
    expect(generateClassification(inputs).isOk()).toBe(true);
    expect(reads.has(".github/global-rule-inputs.json")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SCRIPT = path.join(import.meta.dir, "check-ci-job-classification.ts");
const decoder = new TextDecoder();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const digestOf = (workflow: string, job: string) => {
  const parsed = parseDocument(workflow);
  const digest = parsed.isOk() ? parsed.value.jobs[job]?.digest : undefined;
  if (digest === undefined) {
    throw new AdmissionError({ message: `fixture job missing: ${job}` });
  }
  return digest;
};

type Decision = { kind: string; qualifier: string; reviewedDigest: string };
type Fixture = { workflow: string; decisions: Record<string, Decision> };

const keyOf = (job: string) => `candidate:.github/workflows/ci.yml/${job}`;
const reviewed = (workflow: string, job: string, kind = "ordinary") => ({
  [keyOf(job)]: {
    kind,
    qualifier: "Reviewed checks",
    reviewedDigest: digestOf(workflow, job),
  },
});

// A repository whose origin/main holds `base`; the working tree then holds
// `head`, uncommitted unless `commit` is set.
const repository = (base: Fixture, head: Fixture, commit = false) => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-refresh-"));
  roots.push(root);
  writeClassificationFixtureInputs(root);
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  const write = ({ workflow, decisions }: Fixture) => {
    writeFileSync(path.join(root, ".github/workflows/ci.yml"), workflow);
    // One file per decision, the directory replaced as a whole.
    rmSync(path.join(root, CLASSIFICATION_DECISIONS_PATH), {
      recursive: true,
      force: true,
    });
    for (const [key, decision] of Object.entries(decisions)) {
      writeDecision(root, key, decision);
    }
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Classification Test",
        "-c",
        "user.email=classification-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, decoder.decode(result.stderr)).toBe(0);
  };
  const commitAll = (message: string) => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    );
  };
  write(base);
  git("init", "--quiet");
  commitAll("base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  write(head);
  if (commit) {
    commitAll("head");
  }
  return { root, commitAll };
};

const runIn = (
  root: string,
  eventContext: Record<string, string>,
  ...args: string[]
) => {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: root,
    env: { ...withoutCiEventContext(), ...eventContext },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
};
const run = (root: string, ...args: string[]) => runIn(root, {}, ...args);

const decisionsIn = (root: string) =>
  readDecisions({ type: "working-tree", root });
const storedDecisions = (decisions: Record<string, Decision>) =>
  Object.fromEntries(
    Object.entries(decisions).map(([key, decision]) => [
      key,
      {
        kind: decision.kind,
        qualifier: decision.qualifier,
        approvedDigests: [decision.reviewedDigest],
      },
    ]),
  );

// Not privileged: no write permission, secret, environment or runner label.
const BEFORE =
  "jobs: {check: {steps: [{uses: acme/check@0000000000000000000000000000000000000000}]}}";
const AFTER =
  "jobs: {check: {steps: [{uses: acme/check@1111111111111111111111111111111111111111}]}}";
// The same job with an OIDC token, which makes it privileged.
const PRIVILEGED_BEFORE =
  "jobs: {check: {permissions: {id-token: write}, steps: [{uses: acme/check@0000000000000000000000000000000000000000}]}}";
const PRIVILEGED_AFTER =
  "jobs: {check: {permissions: {id-token: write}, steps: [{uses: acme/check@1111111111111111111111111111111111111111}]}}";
const SENSITIVE = `::error title=Sensitive classification change::${keyOf("check")}\n`;

test("a job that is not privileged needs no decision, however it changes", () => {
  const { root } = repository(
    { workflow: BEFORE, decisions: {} },
    { workflow: AFTER, decisions: {} },
  );
  expect(run(root, "--check")).toEqual({
    exitCode: 0,
    stdout: "Classified 1 workflows\n",
    stderr: "",
  });
  expect(run(root, "--write")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(decisionsIn(root)).toEqual({});
});

test.each([
  [
    "inherited write permission",
    "permissions: {contents: write}\njobs: {check: {steps: [{run: bun test one}]}}",
    "permissions: {contents: write}\njobs: {check: {steps: [{run: bun test two}]}}",
  ],
  [
    "inherited secret",
    `permissions: {contents: read}\nenv: {TOKEN: "\${{ secrets.X }}"}\njobs: {check: {steps: [{run: bun test one}]}}`,
    `permissions: {contents: read}\nenv: {TOKEN: "\${{ secrets.X }}"}\njobs: {check: {steps: [{run: bun test two}]}}`,
  ],
  [
    "deployment environment",
    "jobs: {check: {environment: staging, steps: []}}",
    "jobs: {check: {environment: production, steps: []}}",
  ],
  [
    "runner",
    "jobs: {check: {'runs-on': ubuntu-latest, steps: []}}",
    "jobs: {check: {'runs-on': self-hosted, steps: []}}",
  ],
] as const)(
  "%s changes an effectively privileged job digest",
  (_, before, after) => {
    expect(digestOf(after, "check")).not.toBe(digestOf(before, "check"));
  },
);

test.each([
  [
    "write permissions",
    "permissions: {id-token: write}\njobs: {check: {steps: [{run: bun test one}]}}",
    "permissions: {id-token: write}\njobs: {check: {steps: [{run: bun test two}]}}",
  ],
  [
    "credentials",
    `jobs: {check: {env: {TOKEN: '\${{ secrets.DEPLOY }}'}, steps: [{run: bun test one}]}}`,
    `jobs: {check: {env: {TOKEN: '\${{ secrets.DEPLOY }}'}, steps: [{run: bun test two}]}}`,
  ],
  [
    "deployment environments",
    "jobs: {check: {environment: staging, steps: [{run: bun test one}]}}",
    "jobs: {check: {environment: staging, steps: [{run: bun test two}]}}",
  ],
  [
    "base-branch triggers",
    "on: pull_request_target\njobs: {check: {steps: [{run: bun test one}]}}",
    "on: pull_request_target\njobs: {check: {steps: [{run: bun test two}]}}",
  ],
  [
    "self-hosted runners",
    "jobs: {check: {'runs-on': [self-hosted, linux], steps: [{run: bun test one}]}}",
    "jobs: {check: {'runs-on': [self-hosted, linux], steps: [{run: bun test two}]}}",
  ],
  [
    "untrusted checkouts",
    `jobs: {check: {steps: [{uses: actions/checkout@v4, with: {ref: '\${{ github.event.pull_request.head.sha }}'}}, {run: bun test one}]}}`,
    `jobs: {check: {steps: [{uses: actions/checkout@v4, with: {ref: '\${{ github.event.pull_request.head.sha }}'}}, {run: bun test two}]}}`,
  ],
  [
    "untrusted checkouts through the shared retrying checkout",
    `jobs: {check: {steps: [{uses: stella/.github/actions/partial-clone-checkout@c6d66dfa2a5ad1f96a21b819fe456fecdd3d6f6d, with: {ref: '\${{ github.event.pull_request.head.sha }}'}}, {run: bun test one}]}}`,
    `jobs: {check: {steps: [{uses: stella/.github/actions/partial-clone-checkout@c6d66dfa2a5ad1f96a21b819fe456fecdd3d6f6d, with: {ref: '\${{ github.event.pull_request.head.sha }}'}}, {run: bun test two}]}}`,
  ],
] as const)(
  "privilege source: %s requires approval for an ordinary run change",
  (_, before, after) => {
    expect(digestOf(after, "check")).not.toBe(digestOf(before, "check"));
    const decisions = reviewed(before, "check");
    const { root } = repository(
      { workflow: before, decisions },
      { workflow: after, decisions },
    );
    expect(run(root, "--check").exitCode).toBe(1);
  },
);

test.each([
  ["job env", "env: {DESTINATION: one}", "env: {DESTINATION: two}"],
  [
    "reusable workflow input",
    "uses: acme/shared/.github/workflows/deploy.yml@v1, with: {destination: one}",
    "uses: acme/shared/.github/workflows/deploy.yml@v1, with: {destination: two}",
  ],
  [
    "strategy matrix",
    "strategy: {matrix: {node: [20]}}",
    "strategy: {matrix: {node: [22]}}",
  ],
] as const)(
  "a write job requires approval for a changed %s",
  (_, beforeField, afterField) => {
    const before = `jobs: {check: {permissions: {contents: write}, ${beforeField}, steps: []}}`;
    const after = `jobs: {check: {permissions: {contents: write}, ${afterField}, steps: []}}`;
    const decisions = reviewed(before, "check");
    const { root } = repository(
      { workflow: before, decisions },
      { workflow: after, decisions },
    );
    expect(run(root, "--check").exitCode).toBe(1);
  },
);

test("pull_request_target with an untrusted checkout requires approval for every step change", () => {
  const checkout = `{uses: actions/checkout@v4, with: {ref: '\${{ github.event.pull_request.head.sha }}'}}`;
  const before = `on: pull_request_target\njobs: {check: {steps: [${checkout}, {run: echo one}]}}`;
  const after = `on: pull_request_target\njobs: {check: {steps: [${checkout}, {run: echo two}]}}`;
  const decisions = reviewed(before, "check");
  const { root } = repository(
    { workflow: before, decisions },
    { workflow: after, decisions },
  );
  expect(run(root, "--check").exitCode).toBe(1);
});

test.each([
  [
    "renamed secret",
    "on: push\njobs: {check: {env: {TOKEN: secrets.OLD}, steps: []}}",
    "on: push\njobs: {check: {env: {TOKEN: secrets.NEW}, steps: []}}",
  ],
  [
    "removed secret",
    "on: push\njobs: {check: {env: {TOKEN: secrets.OLD}, steps: []}}",
    "on: push\njobs: {check: {steps: []}}",
  ],
  [
    "write permission",
    "on: push\njobs: {check: {steps: []}}",
    "on: push\njobs: {check: {permissions: {contents: write}, steps: []}}",
  ],
  [
    "third-party action",
    "on: push\njobs: {check: {steps: []}}",
    "on: push\njobs: {check: {steps: [{uses: acme/check@0000000000000000000000000000000000000000}]}}",
  ],
  [
    "trigger",
    "on: push\njobs: {check: {steps: []}}",
    "on: pull_request_target\njobs: {check: {steps: []}}",
  ],
] as const)("%s changes the privileged-surface digest", (_, before, after) => {
  expect(digestOf(after, "check")).not.toBe(digestOf(before, "check"));
});

const SECRET_BEFORE = "jobs: {check: {env: {TOKEN: secrets.TOKEN}, steps: []}}";
for (const scenario of [
  {
    // The transition is the protection: no record at the base or the head
    // lets the job through.
    name: "a job that becomes privileged without ever having a decision",
    before: BEFORE,
    after: "jobs: {check: {permissions: {contents: write}, steps: []}}",
    decisions: {},
  },
  {
    name: "a privileged job",
    // A secret reference anywhere in the projected shape is privileged.
    before: SECRET_BEFORE,
    after: "jobs: {check: {env: {TOKEN: secrets.TOKEN, MODE: two}, steps: []}}",
    decisions: reviewed(SECRET_BEFORE, "check"),
  },
  {
    name: "a priority job",
    before: BEFORE,
    after: AFTER,
    decisions: reviewed(BEFORE, "check", "priority"),
  },
] as const) {
  test(`a sensitive digest change still fails: ${scenario.name}`, () => {
    const { root } = repository(
      { workflow: scenario.before, decisions: scenario.decisions },
      { workflow: scenario.after, decisions: scenario.decisions },
    );
    // Nothing a reviewer decides is ever written for them.
    expect(run(root, "--write")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(decisionsIn(root)).toEqual(storedDecisions(scenario.decisions));
    const check = run(root, "--check");
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toBe(SENSITIVE);
    expect(check.stderr).toContain("Missing or changed job review");
    expect(check.stderr).toContain(decisionPathForKey(keyOf("check")));
  });
}

test("a job that stops being privileged leaves a stale decision for --write to remove", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: AFTER, decisions },
  );
  const stale = run(root, "--check");
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain(`Stale decisions: ${keyOf("check")}.`);
  expect(stale.stderr).toContain(decisionDirectoryForKey(keyOf("check")));
  expect(stale.stderr).not.toContain("Missing or changed job review");

  expect(run(root, "--write")).toEqual({
    exitCode: 0,
    stdout: `Removed 1 stale classification decision(s): ${keyOf("check")}\n`,
    stderr: "",
  });
  expect(decisionsIn(root)).toEqual({});
  // Losing the privilege passes, and is still reported as sensitive.
  expect(run(root, "--check")).toEqual({
    exitCode: 0,
    stdout: `${SENSITIVE}Classified 1 workflows\n`,
    stderr: "",
  });
  // A second removal is a no-op.
  expect(run(root, "--write")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});

test("a decision for a removed job is stale", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: "jobs: {other: {steps: []}}", decisions },
  );
  const stale = run(root, "--check");
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain(`Stale decisions: ${keyOf("check")}.`);
  expect(run(root, "--write").stdout).toContain(keyOf("check"));
  expect(run(root, "--check").exitCode).toBe(0);
});

test("a new privileged job waits for a reviewer", () => {
  const head =
    "jobs: {check: {steps: [{uses: acme/check@0000000000000000000000000000000000000000}]}, added: {permissions: {id-token: write}, steps: []}}";
  const { root } = repository(
    { workflow: BEFORE, decisions: {} },
    { workflow: head, decisions: {} },
  );
  expect(run(root, "--write")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(decisionsIn(root)).toEqual({});
  const check = run(root, "--check");
  expect(check.exitCode).toBe(1);
  expect(check.stderr).toContain(decisionPathForKey(keyOf("added")));
  expect(check.stderr).toContain("<choose ordinary, support, or priority>");
  expect(check.stderr).not.toContain(decisionPathForKey(keyOf("check")));
});

test("approvals without a decision fail instead of being skipped", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: PRIVILEGED_BEFORE, decisions },
  );
  rmSync(path.join(root, decisionPathForKey(keyOf("check"))));
  const check = run(root, "--check");
  expect(check.exitCode).toBe(1);
  expect(check.stderr).toContain(
    `Approvals without a decision: ${decisionDirectoryForKey(keyOf("check"))}`,
  );
});

test("pre-push skips pushes that touch no classification input", () => {
  const { root, commitAll } = repository(
    { workflow: BEFORE, decisions: {} },
    { workflow: BEFORE, decisions: {} },
  );
  writeFileSync(path.join(root, "README.md"), "docs\n");
  commitAll("docs");
  // Even a working tree that needs review is not checked when the push
  // cannot affect it.
  writeFileSync(path.join(root, ".github/workflows/ci.yml"), PRIVILEGED_AFTER);
  expect(run(root, "--pre-push")).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("pre-push removes a stale decision and asks for a commit, then passes", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root, commitAll } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: AFTER, decisions },
    true,
  );
  expect(run(root, "--pre-push")).toEqual({
    exitCode: 1,
    stdout: `Removed 1 stale classification decision(s): ${keyOf("check")}\n`,
    stderr: `Commit the changes under ${CLASSIFICATION_DECISIONS_PATH} and push again.\n`,
  });
  commitAll("remove the stale decision");
  expect(run(root, "--pre-push")).toEqual({
    exitCode: 0,
    stdout: `${SENSITIVE}Classified 1 workflows\n`,
    stderr: "",
  });
});

test("pre-push fails on a change that needs review", () => {
  const { root } = repository(
    { workflow: BEFORE, decisions: {} },
    {
      workflow: "jobs: {check: {permissions: {contents: write}, steps: []}}",
      decisions: {},
    },
    true,
  );
  const result = run(root, "--pre-push");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing or changed job review");
});

test("independent approvals of privileged jobs merge without conflict", () => {
  // Privileged digests bind the run commands, so each branch owes the job
  // it edits a new approval; one add-only file per digest keeps the two
  // approvals from touching the same file.
  const baseWorkflow = `jobs:
  x:
    permissions: {id-token: write}
    steps:
      - run: echo x-old

  y:
    permissions: {id-token: write}
    steps:
      - run: echo y-old
`;
  const decisions = {
    ...reviewed(baseWorkflow, "x"),
    ...reviewed(baseWorkflow, "y"),
  };
  const { root, commitAll } = repository(
    { workflow: baseWorkflow, decisions },
    { workflow: baseWorkflow, decisions },
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Classification Test",
        "-c",
        "user.email=classification-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, decoder.decode(result.stderr)).toBe(0);
  };

  git("switch", "-c", "approve-x");
  const workflowX = baseWorkflow.replace("echo x-old", "echo x-new");
  expect(digestOf(workflowX, "x")).not.toBe(digestOf(baseWorkflow, "x"));
  writeFileSync(path.join(root, ".github/workflows/ci.yml"), workflowX);
  writeDecision(root, keyOf("x"), {
    kind: "ordinary",
    qualifier: "Reviewed checks",
    reviewedDigest: digestOf(workflowX, "x"),
  });
  commitAll("approve x");

  git("switch", "-c", "approve-y", "refs/remotes/origin/main");
  const workflowY = baseWorkflow.replace("echo y-old", "echo y-new");
  writeFileSync(path.join(root, ".github/workflows/ci.yml"), workflowY);
  writeDecision(root, keyOf("y"), {
    kind: "ordinary",
    qualifier: "Reviewed checks",
    reviewedDigest: digestOf(workflowY, "y"),
  });
  commitAll("approve y");
  git("merge", "--no-edit", "approve-x");

  expect(run(root, "--check")).toEqual({
    exitCode: 0,
    stdout: `::error title=Sensitive classification change::${keyOf("x")}, ${keyOf("y")}\nClassified 1 workflows\n`,
    stderr: "",
  });
});

const MERGE_GROUP = {
  GITHUB_EVENT_NAME: "merge_group",
  GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-42-${"a".repeat(40)}`,
};

test("a merge group whose combined tree needs review names its pull request", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: PRIVILEGED_AFTER, decisions },
  );
  const refusal = "classification needs re-approval after #42";
  const output = path.join(root, "step-output");
  const result = runIn(
    root,
    { ...MERGE_GROUP, GITHUB_OUTPUT: output },
    "--check",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe(
    `${SENSITIVE}::error title=Classification refusal::${refusal}\n`,
  );
  expect(result.stderr.startsWith(`${refusal}\n`)).toBe(true);
  expect(result.stderr).toContain("Missing or changed job review");
  expect(readFileSync(output, "utf-8")).toBe(
    `privileged_classification_change=true\nclassification_refusal=${refusal}\n`,
  );
  const report = runIn(root, MERGE_GROUP, "--check", "--json");
  expect(report.exitCode).toBe(1);
  expect(JSON.parse(report.stdout)).toEqual({
    status: "stale",
    stale: [keyOf("check")],
    mechanical: [],
    privileged: [keyOf("check")],
    refusal,
  });
});

test("a merge group that passes never reads its ref", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: PRIVILEGED_BEFORE, decisions },
  );
  expect(runIn(root, { GITHUB_EVENT_NAME: "merge_group" }, "--check")).toEqual({
    exitCode: 0,
    stdout: "Classified 1 workflows\n",
    stderr: "",
  });
});

test("conflicting modes are rejected", () => {
  const { root } = repository(
    { workflow: BEFORE, decisions: {} },
    { workflow: BEFORE, decisions: {} },
  );
  const result = run(root, "--write", "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("usage:");
});

const jsonRun = (root: string, ...args: string[]) => {
  const result = run(root, "--check", ...args, "--json");
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
};

test("--json rejects other modes and unknown flags", () => {
  const { root } = repository(
    { workflow: BEFORE, decisions: {} },
    { workflow: BEFORE, decisions: {} },
  );
  for (const args of [
    ["--check", "--unknown", "--json"],
    ["--write", "--json"],
    ["--pre-push", "--json"],
  ]) {
    const result = run(root, ...args);
    expect(result.exitCode, args.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout).status).toBe("error");
  }
});

test("--json reports an admissible tree", () => {
  const decisions = reviewed(PRIVILEGED_BEFORE, "check");
  const { root } = repository(
    { workflow: PRIVILEGED_BEFORE, decisions },
    { workflow: PRIVILEGED_BEFORE, decisions },
  );
  expect(jsonRun(root)).toEqual({
    exitCode: 0,
    report: { status: "ok", privileged: [] },
  });
});

test("--json separates a required review from a decision --write removes", () => {
  const base =
    "jobs: {lost: {permissions: {id-token: write}, steps: []}, gained: {steps: []}}";
  const head =
    "jobs: {lost: {steps: []}, gained: {permissions: {id-token: write}, steps: []}}";
  const decisions = reviewed(base, "lost");
  const { root } = repository(
    { workflow: base, decisions },
    { workflow: head, decisions },
    true,
  );
  expect(jsonRun(root)).toEqual({
    exitCode: 1,
    report: {
      status: "stale",
      stale: [keyOf("gained"), keyOf("lost")],
      mechanical: [keyOf("lost")],
      privileged: [keyOf("lost"), keyOf("gained")],
    },
  });
});
