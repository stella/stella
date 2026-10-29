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

import {
  readDecisions,
  writeDecision,
} from "./ci-job-classification/decisions";
import {
  CLASSIFICATION_DECISIONS_PATH,
  CLASSIFICATION_INPUT_GLOBS,
  decisionPathForKey,
} from "./ci-job-classification/inputs";
import { AdmissionError, parseDocument } from "./ci-job-classification/yaml";
import { GENERATORS } from "./generated-files";

test("the classification generator reads and writes every input it owns", () => {
  const generator = GENERATORS.find(
    ({ id }) => id === "ci-job-classification-digests",
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
  writeFileSync(
    path.join(root, ".github/ci-job-classification-sources.json"),
    "{}",
  );
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

const run = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
};

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

const BEFORE =
  "jobs: {check: {steps: [{uses: acme/check@0000000000000000000000000000000000000000}]}}";
const AFTER =
  "jobs: {check: {steps: [{uses: acme/check@1111111111111111111111111111111111111111}]}}";

test("an ordinary step change needs no refreshed approval", () => {
  const ordinaryBefore = `jobs: {check: {steps: [{env: {TOKEN: '\${{ github.token }}'}, run: gh api /repos}, {run: bun test one}]}}`;
  const ordinaryAfter = `jobs: {check: {steps: [{env: {TOKEN: '\${{ github.token }}'}, run: gh api /repos}, {run: bun test two}]}}`;
  const decisions = reviewed(ordinaryBefore, "check");
  const { root } = repository(
    { workflow: ordinaryBefore, decisions },
    { workflow: ordinaryAfter, decisions },
  );
  expect(run(root, "--check").exitCode).toBe(0);

  const write = run(root, "--write");
  expect(write.exitCode).toBe(0);
  expect(write.stdout).toBe("");
  expect(decisionsIn(root)).toEqual(storedDecisions(decisions));
  expect(run(root, "--check")).toEqual({
    exitCode: 0,
    stdout: "Classified 1 workflows\n",
    stderr: "",
  });
  // A second refresh is a no-op.
  expect(run(root, "--write")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
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

for (const scenario of [
  {
    name: "a job that becomes privileged",
    before: BEFORE,
    after: "jobs: {check: {permissions: {contents: write}, steps: []}}",
    kind: "ordinary",
  },
  {
    name: "a job that stops being privileged",
    before: "jobs: {check: {permissions: {contents: write}, steps: []}}",
    after: AFTER,
    kind: "ordinary",
  },
  {
    name: "a privileged job",
    // A secret reference anywhere in the projected shape is privileged.
    before: "jobs: {check: {env: {TOKEN: secrets.TOKEN}, steps: []}}",
    after: "jobs: {check: {env: {TOKEN: secrets.TOKEN, MODE: two}, steps: []}}",
    kind: "ordinary",
  },
  {
    name: "a priority job",
    before: BEFORE,
    after: AFTER,
    kind: "priority",
  },
] as const) {
  test(`a sensitive digest change still fails: ${scenario.name}`, () => {
    const decisions = reviewed(scenario.before, "check", scenario.kind);
    const { root } = repository(
      { workflow: scenario.before, decisions },
      { workflow: scenario.after, decisions },
    );
    expect(run(root, "--write")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(decisionsIn(root)).toEqual(storedDecisions(decisions));
    const check = run(root, "--check");
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain(
      `::error title=Sensitive classification change::${keyOf("check")}`,
    );
  });
}

test("a new job is never classified by the refresh", () => {
  const decisions = reviewed(BEFORE, "check");
  const head =
    "jobs: {check: {steps: [{uses: acme/check@0000000000000000000000000000000000000000}]}, added: {steps: []}}";
  const { root } = repository(
    { workflow: BEFORE, decisions },
    { workflow: head, decisions },
  );
  expect(run(root, "--write").exitCode).toBe(0);
  expect(decisionsIn(root)).toEqual(storedDecisions(decisions));
  const check = run(root, "--check");
  expect(check.exitCode).toBe(1);
  expect(check.stderr).toContain(decisionPathForKey(keyOf("added")));
  expect(check.stderr).toContain("<choose ordinary, support, or priority>");
});

test("a job whose new decision lacks a base decision is never refreshed", () => {
  const base = "jobs: {other: {steps: []}}";
  const { root } = repository(
    { workflow: base, decisions: reviewed(base, "other") },
    {
      workflow: AFTER,
      decisions: {
        [keyOf("check")]: {
          kind: "ordinary",
          qualifier: "Reviewed checks",
          reviewedDigest: digestOf(BEFORE, "check"),
        },
      },
    },
  );
  expect(run(root, "--write").stdout).toBe("");
  expect(run(root, "--check").exitCode).toBe(1);
});

for (const change of [
  { name: "kind", edit: { kind: "support" } },
  { name: "qualifier", edit: { qualifier: "Re-described checks" } },
] as const) {
  test(`a ${change.name} change with a stale digest still needs review`, () => {
    const decisions = reviewed(BEFORE, "check");
    const original = decisions[keyOf("check")];
    if (original === undefined) {
      throw new AdmissionError({ message: "fixture decision missing" });
    }
    const edited = { [keyOf("check")]: { ...original, ...change.edit } };
    const { root } = repository(
      { workflow: BEFORE, decisions },
      { workflow: AFTER, decisions: edited },
    );
    expect(run(root, "--write").exitCode).toBe(0);
    expect(decisionsIn(root)).toEqual(storedDecisions(edited));
    expect(run(root, "--check").exitCode).toBe(1);
  });
}

test("pre-push skips pushes that touch no classification input", () => {
  const decisions = reviewed(BEFORE, "check");
  const { root, commitAll } = repository(
    { workflow: BEFORE, decisions },
    { workflow: BEFORE, decisions },
  );
  writeFileSync(path.join(root, "README.md"), "docs\n");
  commitAll("docs");
  // Even a stale working tree is not checked when the push cannot affect it.
  writeFileSync(path.join(root, ".github/workflows/ci.yml"), AFTER);
  expect(run(root, "--pre-push")).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("pre-push refreshes a mechanical digest and asks for a commit, then passes", () => {
  const decisions = reviewed(BEFORE, "check");
  const { root, commitAll } = repository(
    { workflow: BEFORE, decisions },
    { workflow: AFTER, decisions },
    true,
  );
  const first = run(root, "--pre-push");
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toContain("Refreshed 1 mechanical");
  expect(first.stderr).toBe(
    `Commit the refreshed decision files (${decisionPathForKey(keyOf("check"))}) and push again.\n`,
  );
  commitAll("refresh");
  expect(run(root, "--pre-push")).toEqual({
    exitCode: 0,
    stdout: "Classified 1 workflows\n",
    stderr: "",
  });
});

test("pre-push fails on a change that needs review", () => {
  const decisions = reviewed(BEFORE, "check");
  const { root } = repository(
    { workflow: BEFORE, decisions },
    {
      workflow: "jobs: {check: {permissions: {contents: write}, steps: []}}",
      decisions,
    },
    true,
  );
  const result = run(root, "--pre-push");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing or changed job review");
});

test("independent privileged approvals merge without conflict", () => {
  const baseWorkflow = `jobs:
  x:
    steps:
      - run: echo x-old

  y:
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
    stdout: "Classified 1 workflows\n",
    stderr: "",
  });
});

test("conflicting modes are rejected", () => {
  const decisions = reviewed(BEFORE, "check");
  const { root } = repository(
    { workflow: BEFORE, decisions },
    { workflow: BEFORE, decisions },
  );
  const result = run(root, "--write", "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("usage:");
});
