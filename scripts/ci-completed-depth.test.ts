import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Script } from "node:vm";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";
import { createSha256 } from "@stll/sha256/node";

import { PILOT_ALWAYS } from "./ci-pr-pilot-plan";
import { renderResultInputs } from "./ci-result-inputs";
import { contextWithPlanOutputs, evaluate } from "./github-expression";
import {
  ARMED_LABEL,
  prDepthJobs,
  queueAdmittedJobs,
  thinJobs,
} from "./main-heavy-plan";

// Wall-clock checks: no reused or queued plan can certify them, so they run.
const ALWAYS_RUN: readonly string[] = PILOT_ALWAYS;

const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
});
const workflow = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.string()),
        outputs: v.optional(v.record(v.string(), v.string()), {}),
        steps: v.optional(v.array(stepSchema), []),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const jobs = workflow.jobs;
const prDepth = prDepthJobs({ jobs });
const patchId = "d".repeat(40);
const planConfig =
  '{"CI_POSTGRES_PR_SELECTION":"","CI_PR_DEPTH_PILOT":"","CI_PR_DEPTH_PILOT_CERTIFIED_UNTIL":"","MERGE_QUEUE_DEPTH":""}';
const planner = jobs["ci-plan"];
const result = jobs["ci-result"];
if (!planner || !result) {
  throw new Error("Missing CI structural jobs");
}
const lookup = planner.steps.find((step) => step.id === "completed-depth")?.with
  ?.script;
const aggregate = result.steps.find(
  (step) => step.name === "Evaluate CI outcome",
)?.run;
if (!lookup || !aggregate) {
  throw new Error("Missing completion-depth contract");
}
const labels: { name: string }[] = [];
const pr = {
  number: 123,
  title: "fix: example",
  body: "Test evidence",
  head: { sha: "a".repeat(40), repo: { id: 456 } },
  base: { sha: "b".repeat(40) },
  labels,
};
const scope = createSha256()
  .update(JSON.stringify([pr.title, pr.body, false]))
  .digest("hex");
const testedTree = "1".repeat(40);
const workflowTree = "2".repeat(40);
const scopedPlanConfig = createSha256()
  .update(JSON.stringify([scope, planConfig]))
  .digest("hex");
const marker = (depth: string, profile = "normal-v1", version = 7) =>
  `ci-completed-v${version}-${profile}-123-456-${pr.head.sha}-${depth}-${scope}`;
const artifact = (depth: string, profile = "normal-v1") => ({
  id: 7,
  size_in_bytes: 400,
  name: marker(depth, profile),
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  // Uploaded by ci-result after every other job of its run finished.
  created_at: "2026-10-17T10:30:00Z",
  updated_at: "2026-10-17T10:30:00Z",
  workflow_run: { id: 99, head_sha: pr.head.sha, head_repository_id: 456 },
});
const successfulRun = {
  id: 99,
  head_sha: pr.head.sha,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
};
// The evidence ci-result records for a run whose planned jobs all succeeded.
const evidenceFor = (depth: string, profile = "normal-v1") => ({
  version: 7,
  marker: marker(depth, profile),
  event: "pull_request",
  plan_config: scopedPlanConfig,
  run_id: 99,
  run_attempt: 1,
  pr_number: 123,
  head_repo_id: 456,
  head_sha: pr.head.sha,
  base_sha: pr.base.sha,
  patch_id: patchId,
  workflow_version: pr.head.sha,
  tested_tree: testedTree,
  workflow_tree: workflowTree,
  pr_depth_jobs: prDepth,
  suite_depth: depth,
  coverage_profile: profile,
  planned: ["ci-tests", "ci-checks-generated"],
  jobs: {
    "ci-plan": "success",
    ...Object.fromEntries(prDepth.map((job) => [job, "success"])),
    "ci-tests": "success",
    "ci-checks-generated": "success",
    "web-build": "skipped",
  },
});
const publisherStep = (payload: string) => ({
  name: `Publish armed suite depth ${createSha256().update(payload).digest("hex")}`,
  status: "completed",
  conclusion: "success",
});
const armedMarker = marker("fast-armed");
const armedArtifact = { ...artifact("fast"), name: armedMarker };
const armedEvidence = {
  ...evidenceFor("fast"),
  marker: armedMarker,
  heavy_proof: true,
  planned: ["ci-tests", "ci-checks-generated", "mobile-build"],
  jobs: { ...evidenceFor("fast").jobs, "mobile-build": "success" },
};
const armedPull = { ...pr, labels: [{ name: ARMED_LABEL }] };
const autoMergePull = { ...pr, auto_merge: { merge_method: "squash" } };

const sourceJobs = [
  {
    name: "ci-tests",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-17T10:00:00Z",
    completed_at: "2026-10-17T10:20:00Z",
  },
  {
    name: "ci-result",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-17T10:25:00Z",
    completed_at: "2026-10-17T10:35:00Z",
    steps: [publisherStep(JSON.stringify(armedEvidence))],
  },
];
// A source run certifies one exact producer payload, independently of the
// downloaded archive; mutations of the archive never rewrite this receipt.
const publisherJobs = (payload: string) =>
  sourceJobs.map((job) =>
    job.name === "ci-result"
      ? { ...job, steps: [publisherStep(payload)] }
      : job,
  );

// The archive upload-artifact produces for one file: a streamed (data
// descriptor) entry whose sizes live only in the central directory.
const zipEvidence = (
  text: string,
  { name = "ci-completed-depth.json", method = 8 } = {},
) => {
  const raw = Buffer.from(text);
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04_03_4b_50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x08, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(fileName.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08_07_4b_50, 0);
  descriptor.writeUInt32LE(data.length, 8);
  descriptor.writeUInt32LE(raw.length, 12);
  const entries = Buffer.concat([local, fileName, data, descriptor]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02_01_4b_50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x08, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(entries.length, 16);
  return Buffer.concat([entries, central, fileName, end]);
};
type LookupOptions = {
  /** This run's patch id; empty for a pull request without a net change. */
  currentPatchId?: string;
  depth?: string;
  profile?: string;
  action?: string;
  event?: string;
  artifacts?: unknown;
  failure?: boolean;
  artifactFailure?: boolean;
  comparisonFailure?: boolean;
  runFailure?: boolean;
  sourceRun?: unknown;
  queueDepth?: string;
  comparison?: unknown;
  groupRef?: string;
  pull?: typeof pr & { auto_merge?: unknown };
  /** The label a labeled/unlabeled event carries. */
  label?: string;
  evidence?: unknown;
  archive?: Buffer;
  downloadFailure?: boolean;
  /** The earlier head a merge of the base sits on, as the patch-id step names it. */
  mergeParent?: string;
  jobs?: unknown[];
  /** The patch-id step's queue chain; defaults to the queued pull request alone. */
  entryChain?: unknown;
  /** Pull requests a chain names, by number; others resolve to `pull`. */
  queuedPulls?: Record<number, unknown>;
  /** Evidence archives by artifact id; others download `archive`. */
  archives?: Record<number, Buffer>;
  /** Source runs by id; others resolve to `sourceRun`. */
  sourceRuns?: Record<number, unknown>;
  jobsByRun?: Record<number, unknown[]>;
  targetBase?: string;
  retryScript?: string;
  testedTree?: string;
  workflowTree?: string;
};
const decide = async ({
  depth = "full",
  profile = "normal-v1",
  // A code-run event that may reuse evidence; metadata events never start
  // suites (see the metadata test below).
  action = "reopened",
  event = "pull_request",
  artifacts = [artifact(depth, profile)],
  failure = false,
  artifactFailure = false,
  comparisonFailure = false,
  runFailure = false,
  sourceRun = successfulRun,
  pull = pr,
  label,
  queueDepth = "full",
  comparison = { status: "ahead", merge_base_commit: { sha: pull.head.sha } },
  groupRef = `refs/heads/gh-readonly-queue/main/pr-123-${"b".repeat(40)}`,
  evidence = event === "merge_group" && queueDepth === "thin"
    ? evidenceFor("fast")
    : evidenceFor(depth, profile),
  archive = zipEvidence(`${JSON.stringify(evidence)}\n`),
  downloadFailure = false,
  jobs: runJobs = sourceJobs,
  currentPatchId = patchId,
  mergeParent = "",
  entryChain = [{ pr: pull.number, patch_id: currentPatchId }],
  queuedPulls = {},
  archives = {},
  sourceRuns = {},
  jobsByRun = {},
  targetBase: currentBase = pr.base.sha,
  testedTree: currentTestedTree = testedTree,
  workflowTree: currentWorkflowTree = workflowTree,
}: LookupOptions = {}) => {
  const outputs = new Map<string, string>();
  const requests: unknown[] = [];
  // Metadata events mirror the head's earlier code run; one exists here.
  const listWorkflowRuns = async (_request: unknown) => ({ data: undefined });
  await new Script(`(async () => {${lookup}\n})()`).runInNewContext({
    Buffer,
    require: (name: string) => {
      if (name === "node:crypto") {
        return {
          createHash: (algorithm: string) => {
            expect(algorithm).toBe("sha256");
            return createSha256();
          },
        };
      }
      if (name === "node:zlib") {
        return { inflateRawSync };
      }
      throw new Error("Unexpected module");
    },
    process: {
      env: {
        SUITE_DEPTH: depth,
        COVERAGE_PROFILE: profile,
        QUEUE_DEPTH: queueDepth,
        GITHUB_RUN_ATTEMPT: "1",
        PATCH_ID: currentPatchId,
        ENTRY_CHAIN:
          event === "merge_group" ? JSON.stringify(entryChain) : "null",
        MERGE_PARENT: mergeParent,
        WORKFLOW_VERSION: pr.head.sha,
        TARGET_BASE_SHA: currentBase,
        TESTED_TREE: currentTestedTree,
        WORKFLOW_TREE: currentWorkflowTree,
        PLAN_CONFIG: planConfig,
        PR_DEPTH_JOBS: JSON.stringify(prDepth),
      },
    },
    context: {
      eventName: event,
      payload: {
        action,
        ...(label === undefined ? {} : { label: { name: label } }),
        pull_request: pull,
        merge_group: { head_ref: groupRef, head_sha: "c".repeat(40) },
      },
      repo: { owner: "stella", repo: "stella" },
      runId: 100,
    },
    core: {
      setOutput: (key: string, value: string) => outputs.set(key, value),
      info: () => {},
    },
    github: {
      paginate: async (
        method: (request: unknown) => Promise<{ data: unknown }>,
        request: unknown,
      ) =>
        method === listWorkflowRuns
          ? [
              {
                id: 50,
                head_sha: pull.head.sha,
                status: "completed",
                conclusion: "success",
                pull_requests: [{ number: pull.number }],
              },
            ]
          : (await method(request)).data,
      rest: {
        pulls: {
          get: async (request: { pull_number: number }) => {
            requests.push(request);
            if (failure) {
              throw new Error("Queued PR unavailable");
            }
            return { data: queuedPulls[request.pull_number] ?? pull };
          },
        },
        repos: {
          compareCommits: async (request: unknown) => {
            requests.push(request);
            if (failure || comparisonFailure) {
              throw new Error("Group comparison unavailable");
            }
            return { data: comparison };
          },
        },
        actions: {
          listWorkflowRuns,
          downloadArtifact: async (request: { artifact_id: number }) => {
            requests.push(request);
            if (downloadFailure) {
              throw new Error("Evidence archive unavailable");
            }
            const served = archives[request.artifact_id] ?? archive;
            return {
              data: served.buffer.slice(
                served.byteOffset,
                served.byteOffset + served.byteLength,
              ),
            };
          },
          listJobsForWorkflowRun: async (request: { run_id: number }) => {
            // Run 50 is the head's earlier code run that metadata mirrors;
            // only evidence lookups are recorded.
            if (request.run_id === 50) {
              return { data: [{ name: "ci-plan" }, { name: "ci-result" }] };
            }
            requests.push(request);
            return { data: jobsByRun[request.run_id] ?? runJobs };
          },
          getWorkflowRun: async (request: { run_id: number }) => {
            requests.push(request);
            if (runFailure) {
              throw new Error("Source run unavailable");
            }
            return { data: sourceRuns[request.run_id] ?? sourceRun };
          },
          listArtifactsForRepo: async (request: {
            name: string;
            per_page: number;
          }) => {
            requests.push(request);
            if (failure || artifactFailure) {
              throw new Error("Evidence unavailable");
            }
            return {
              data: {
                artifacts: Array.isArray(artifacts)
                  ? artifacts
                      .filter((item) => item?.name === request.name)
                      .slice(0, request.per_page)
                  : artifacts,
              },
            };
          },
        },
      },
    },
  });
  return { outputs, requests };
};

test("unchanged-head events reuse only the exact completed depth", async () => {
  for (const action of [
    "labeled",
    "unlabeled",
    "ready_for_review",
    "reopened",
    "auto_merge_enabled",
  ]) {
    for (const depth of ["fast", "full"]) {
      const { outputs, requests } = await decide({ action, depth });
      expect(outputs.get("run_required")).toBe("false");
      expect(outputs.get("completed_run_id")).toBe("99");
      expect(requests).toHaveLength(3);
      const opposite = depth === "fast" ? "full" : "fast";
      // A metadata event never starts suites; the code run owns them.
      const metadata = ["labeled", "unlabeled"].includes(action);
      expect(
        (
          await decide({ action, depth, artifacts: [artifact(opposite)] })
        ).outputs.get("run_required"),
      ).toBe(metadata ? "false" : "true");
    }
  }
});

test("default completion evidence follows the selected coverage profile", async () => {
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    const { outputs } = await decide({ profile });
    expect(outputs.get("run_required"), profile).toBe("false");
  }
});

test("missing, expired, mismatched or failed evidence runs CI", async () => {
  for (const artifacts of [
    [],
    null,
    [null],
    [{ ...artifact("full"), expired: true }],
    [{ ...artifact("full"), expires_at: "2000-01-01" }],
    [
      {
        ...artifact("full"),
        workflow_run: { ...artifact("full").workflow_run, id: 100 },
      },
    ],
    [
      {
        ...artifact("full"),
        workflow_run: {
          ...artifact("full").workflow_run,
          head_repository_id: 789,
        },
      },
    ],
    [
      {
        ...artifact("full"),
        workflow_run: {
          ...artifact("full").workflow_run,
          head_sha: "c".repeat(40),
        },
      },
    ],
  ]) {
    expect((await decide({ artifacts })).outputs.get("run_required")).toBe(
      "true",
    );
  }
  expect((await decide({ failure: true })).outputs.get("run_required")).toBe(
    "true",
  );
  expect(
    (
      await decide({ pull: { ...pr, labels: [{ name: "prove-fix" }] } })
    ).outputs.get("run_required"),
  ).toBe("true");
  for (const pull of [
    { ...pr, title: "fix: another scope" },
    { ...pr, body: "Changed evidence" },
  ]) {
    expect((await decide({ pull })).outputs.get("run_required")).toBe("true");
  }
});

test("push, dispatch and queue events always run without querying evidence", async () => {
  for (const options of [
    { action: "opened" },
    { action: "synchronize" },
    { event: "workflow_dispatch" },
  ]) {
    const { outputs, requests } = await decide(options);
    expect(outputs.get("run_required")).toBe("true");
    expect(requests).toHaveLength(0);
  }
});

test("reused depth prevents every nonstructural CI job and expensive planner step", () => {
  const reused = contextWithPlanOutputs({
    context: {
      status: { cancelled: false },
      values: {
        "github.event_name": "pull_request",
        "github.event.action": "reopened",
        "github.event.pull_request.draft": false,
        "inputs.heavy_only": false,
        "needs.ci-plan.result": "success",
        "needs.ci-plan.outputs.run_required": "false",
        "steps.completed-depth.outputs.run_required": "false",
        "steps.completed-depth.outputs.armed": "false",
        "steps.suites.outputs.heavy_proof": "false",
        "steps.suites.outputs.armed_delta": "false",
        "needs.pr-heavy-gate.result": "skipped",
      },
    },
    outputs: planner.outputs,
  });
  for (const [name, job] of Object.entries(jobs)) {
    if (
      name === "ci-plan" ||
      name === "ci-result" ||
      name.endsWith("-cancel")
    ) {
      continue;
    }
    expect(evaluate(job.if ?? "true", reused), name).toBe(
      ALWAYS_RUN.includes(name),
    );
  }
  const checkout = planner.steps.findIndex((step) => step.name === "Checkout");
  expect(checkout).toBeGreaterThan(-1);
  for (const step of planner.steps.slice(checkout)) {
    // A one-line shell step that must always publish run_required.
    if (step.id === "suites") {
      expect(step.if, step.name).toBeUndefined();
      continue;
    }
    expect(
      evaluate(step.if ?? "true", {
        status: { failure: false },
        values: {
          "steps.completed-depth.outputs.run_required": "false",
          "github.event_name": "pull_request",
        },
      }),
      step.name,
    ).toBe(false);
  }
});

test("the duplicate-result gate accepts skips but rejects failed or cancelled dependencies", () => {
  const start = aggregate.indexOf(
    `if [[ "\${RUN_REQUIRED:-true}" == false && "$armed_delta" != true ]]`,
  );
  const end = aggregate.indexOf('case "$SUITE_DEPTH" in', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  for (const outcome of ["skipped", "success", "failure", "cancelled"]) {
    const child = Bun.spawnSync(["bash", "-c", aggregate.slice(start, end)], {
      env: {
        ...process.env,
        RUN_REQUIRED: "false",
        EVENT: "pull_request",
        COMPLETED_RUN_ID: "99",
        NEEDS: JSON.stringify({
          "ci-plan": { result: "success" },
          check: { result: outcome },
        }),
      },
    });
    expect(child.exitCode).toBe(
      ["skipped", "success"].includes(outcome) ? 0 : 1,
    );
  }
});

test("only a fully successful real validation publishes a completion marker", () => {
  for (const name of [
    "Record completed suite depth",
    "Publish completed suite depth",
  ]) {
    const condition = result.steps.find((step) =>
      name === "Publish completed suite depth"
        ? step.id === "completion-publisher"
        : step.name === name,
    )?.if;
    if (!condition) {
      throw new Error("Missing completion publisher condition");
    }
    for (const success of [true, false]) {
      for (const event of [
        "pull_request",
        "merge_group",
        "workflow_dispatch",
      ]) {
        // "delta": an armed run that reused the normal suites.
        for (const runRequired of ["true", "false", "delta"]) {
          for (const markerName of ["", marker("full")]) {
            for (const sibling of [
              "success",
              "skipped",
              "cancelled",
              "failure",
            ]) {
              for (const evidence of ["", "{}"]) {
                expect(
                  evaluate(condition, {
                    status: { success },
                    values: {
                      "github.event_name": event,
                      "needs.ci-plan.outputs.run_required":
                        runRequired === "delta" ? "false" : runRequired,
                      "needs.ci-plan.outputs.armed_delta": String(
                        runRequired === "delta",
                      ),
                      "needs.ci-plan.outputs.completion_marker": markerName,
                      "needs.*.result": ["success", "success", sibling],
                      "steps.outcome.outputs.evidence": evidence,
                    },
                  }),
                  `${name} ${String(success)} ${event} ${runRequired} ${markerName} ${sibling} ${evidence}`,
                ).toBe(
                  success &&
                    event === "pull_request" &&
                    runRequired !== "false" &&
                    markerName !== "" &&
                    ["success", "skipped"].includes(sibling) &&
                    evidence !== "",
                );
              }
            }
          }
        }
      }
    }
  }
});

// The evidence block of the result gate, run on its own after the gate passed.
const evidenceBlock = (() => {
  const start = aggregate.indexOf("# Completion evidence");
  if (start === -1) {
    throw new Error("Missing completion evidence block");
  }
  return aggregate.slice(start);
})();
const resultEnv = v.parse(
  v.object({ env: v.record(v.string(), v.string()) }),
  result.steps.find((step) => step.name === "Evaluate CI outcome"),
).env;
const recordEvidence = (
  results: Record<string, string>,
  {
    depth = "fast",
    head = pr.head.sha,
    script = evidenceBlock,
    runRequired = "true",
    env = {},
    armed = false,
    plan = { ci_tests_required: "true", package_checks_required: "true" },
  } = {},
) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-evidence-"));
  const output = nodePath.join(directory, "output");
  // The gate's prelude writes the plan outputs to PLAN_FILE; this block runs on its own.
  const planFile = nodePath.join(directory, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan));
  try {
    const child = Bun.spawnSync(["bash", "-eu", "-c", script], {
      env: {
        PATH: process.env["PATH"] ?? "",
        GITHUB_OUTPUT: output,
        GITHUB_RUN_ID: "99",
        GITHUB_RUN_ATTEMPT: "1",
        EVENT: "pull_request",
        RUN_REQUIRED: runRequired,
        COMPLETION_MARKER: marker(armed ? `${depth}-armed` : depth),
        HEAVY_PROOF: String(armed),
        HEAVY_PROOF_JOBS: resultEnv["HEAVY_PROOF_JOBS"] ?? "",
        PR_NUMBER: "123",
        HEAD_REPO_ID: "456",
        HEAD_SHA: head,
        BASE_SHA: pr.base.sha,
        SUITE_DEPTH: depth,
        COVERAGE_PROFILE: "normal-v1",
        PATCH_ID: patchId,
        WORKFLOW_VERSION: pr.head.sha,
        PLAN_CONFIG: scopedPlanConfig,
        TESTED_TREE: testedTree,
        WORKFLOW_TREE: workflowTree,
        ARMED_DELTA: "false",
        NORMAL_SOURCE_RUN_ID: "",
        PR_DEPTH_JOBS: JSON.stringify(prDepth),
        JOB_SCOPES: resultEnv["JOB_SCOPES"] ?? "",
        FAST_JOB_SCOPES: resultEnv["FAST_JOB_SCOPES"] ?? "",
        FAST_REQUIRED: resultEnv["FAST_REQUIRED"] ?? "",
        PLAN_FILE: planFile,
        NEEDS: JSON.stringify(
          Object.fromEntries(
            Object.entries(results).map(([job, outcome]) => [
              job,
              { result: outcome },
            ]),
          ),
        ),
        ...env,
      },
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const text = existsSync(output) ? readFileSync(output, "utf-8") : "";
    const line = text
      .split("\n")
      .find((entry) => entry.startsWith("evidence="));
    return line === undefined ? undefined : line.slice("evidence=".length);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};
const fastRequired = v.parse(
  v.array(v.string()),
  JSON.parse(resultEnv["FAST_REQUIRED"] ?? ""),
);
const allSucceeded = Object.fromEntries([
  ["ci-plan", "success"],
  ...fastRequired.map((job) => [job, "success"]),
  ["web-build", "skipped"],
]);

test("completion evidence inputs contain exactly one JSON document", () => {
  for (const [name, value] of [
    ["FAST_REQUIRED", "[] []"],
    ["PR_DEPTH_JOBS", "[] []"],
    ["JOB_SCOPES", "{} {}"],
    ["FAST_JOB_SCOPES", "{} {}"],
    ["NEEDS", "{} {}"],
  ] as const) {
    expect(
      recordEvidence(allSucceeded, { env: { [name]: value } }),
      name,
    ).toBeUndefined();
  }
});

test("a superseded, cancelled or failed run records no completion evidence", () => {
  expect(recordEvidence(allSucceeded)).toBeDefined();
  for (const outcome of ["cancelled", "failure", "skipped"]) {
    for (const job of ["ci-tests", "web-build", "ci-plan"]) {
      if (outcome === "skipped" && job === "web-build") {
        continue;
      }
      expect(
        recordEvidence({ ...allSucceeded, [job]: outcome }),
        `${job} ${outcome}`,
      ).toBeUndefined();
    }
  }
  expect(
    recordEvidence(allSucceeded, { runRequired: "false" }),
  ).toBeUndefined();
  expect(recordEvidence(allSucceeded, { head: "" })).toBeUndefined();
});

test("recorded evidence lets an unchanged head skip, and only that head", async () => {
  const text = recordEvidence(allSucceeded);
  if (text === undefined) {
    throw new Error("No evidence recorded for a fully successful run");
  }
  const recorded: unknown = JSON.parse(text);
  expect(recorded).toMatchObject({
    version: 7,
    run_id: 99,
    head_sha: pr.head.sha,
    marker: marker("fast"),
  });
  const passed = await decide({ depth: "fast", evidence: recorded });
  expect(passed.outputs.get("run_required")).toBe("false");
  expect(passed.outputs.get("completed_run_id")).toBe("99");
  // A mutated recorder that ignores cancellation is caught by the reader too.
  const lenient = evidenceBlock.replace(
    'all($jobs[]; . == "success" or . == "skipped")',
    "true",
  );
  expect(lenient).not.toBe(evidenceBlock);
  const leaked = recordEvidence(
    { ...allSucceeded, "web-build": "cancelled" },
    { script: lenient },
  );
  if (leaked === undefined) {
    throw new Error("Lenient recorder unexpectedly recorded nothing");
  }
  expect(
    (await decide({ depth: "fast", evidence: JSON.parse(leaked) })).outputs.get(
      "run_required",
    ),
  ).toBe("true");
});

test("only exact green PR-depth evidence reuses checks", async () => {
  const valid = evidenceFor("fast");
  const mutations = {
    head: { ...valid, head_sha: "e".repeat(40) },
    patch: { ...valid, patch_id: "e".repeat(40) },
    workflow: { ...valid, workflow_version: "e".repeat(40) },
    run: { ...valid, run_id: 98 },
    emptySet: { ...valid, pr_depth_jobs: [] },
    otherSet: { ...valid, pr_depth_jobs: prDepth.slice(1) },
    missingJob: {
      ...valid,
      jobs: Object.fromEntries(
        Object.entries(valid.jobs).filter(([job]) => job !== prDepth.at(0)),
      ),
    },
    failedJob: {
      ...valid,
      jobs: { ...valid.jobs, [prDepth.at(0) ?? "missing"]: "failure" },
    },
  } as const;
  await assertProperty(
    "only exact green PR-depth evidence reuses checks",
    fc.asyncProperty(
      fc.constantFrom(["valid", valid] as const, ...Object.entries(mutations)),
      async ([variant, evidence]) => {
        const outputs = (
          await decide({
            event: "merge_group",
            queueDepth: "full",
            artifacts: [artifact("fast")],
            evidence,
          })
        ).outputs;
        expect(outputs.get("pr_depth_reused")).toBe(
          variant === "valid" ? "true" : undefined,
        );
      },
    ),
  );
  // The identical change on a moved base still reuses its PR-depth checks.
  const moved = await decide({
    event: "merge_group",
    queueDepth: "full",
    artifacts: [artifact("fast")],
    evidence: valid,
    pull: { ...pr, base: { sha: "c".repeat(40) } },
  });
  expect(moved.outputs.get("pr_depth_reused")).toBe("true");
});

test("a change without a patch id never reuses, even against empty evidence", async () => {
  const empty = { ...evidenceFor("fast"), patch_id: "" };
  const group = await decide({
    event: "merge_group",
    queueDepth: "full",
    artifacts: [artifact("fast")],
    evidence: empty,
    currentPatchId: "",
  });
  expect(group.outputs.get("pr_depth_reused")).toBeUndefined();
  const pull = await decide({
    evidence: { ...evidenceFor("full"), patch_id: "" },
    currentPatchId: "",
  });
  expect(pull.outputs.get("run_required")).toBe("true");
});

test("a marker whose contents do not prove a complete run is ignored", async () => {
  const valid = evidenceFor("full");
  expect((await decide({ evidence: valid })).outputs.get("run_required")).toBe(
    "false",
  );
  const variants: [string, unknown][] = [
    ["v5 contents", { ...valid, version: 5 }],
    ["other head", { ...valid, head_sha: "c".repeat(40) }],
    ["other run", { ...valid, run_id: 98 }],
    ["other pr", { ...valid, pr_number: 124 }],
    ["other repo", { ...valid, head_repo_id: 789 }],
    ["other depth", { ...valid, suite_depth: "fast" }],
    ["other profile", { ...valid, coverage_profile: "pilot-fast-v1" }],
    ["other marker", { ...valid, marker: marker("fast") }],
    ["other event", { ...valid, event: "workflow_dispatch" }],
    ["bad attempt", { ...valid, run_attempt: 0 }],
    ["other patch", { ...valid, patch_id: "e".repeat(40) }],
    ["other workflow", { ...valid, workflow_version: "e".repeat(40) }],
    ["other plan config", { ...valid, plan_config: "e".repeat(64) }],
    ["no plan config", { ...valid, plan_config: undefined }],
    [
      "other plan config",
      { ...valid, plan_config: '{"CI_POSTGRES_PR_SELECTION":"on"}' },
    ],
    [
      "failed PR-depth job",
      {
        ...valid,
        jobs: { ...valid.jobs, [prDepth.at(0) ?? "missing"]: "failure" },
      },
    ],
    [
      "cancelled job",
      { ...valid, jobs: { ...valid.jobs, "web-build": "cancelled" } },
    ],
    [
      "failed job",
      { ...valid, jobs: { ...valid.jobs, "web-build": "failure" } },
    ],
    [
      "skipped planned job",
      { ...valid, jobs: { ...valid.jobs, "ci-tests": "skipped" } },
    ],
    [
      "planned job missing",
      { ...valid, planned: [...valid.planned, "ci-browser"] },
    ],
    ["no planned jobs", { ...valid, planned: [] }],
    ["duplicate planned job", { ...valid, planned: ["ci-tests", "ci-tests"] }],
    [
      "planner not successful",
      { ...valid, jobs: { ...valid.jobs, "ci-plan": "skipped" } },
    ],
    ["no jobs", { ...valid, jobs: {} }],
    ["jobs as list", { ...valid, jobs: ["ci-plan"] }],
    ["legacy text", "validated"],
    ["null", null],
  ];
  for (const [label, evidence] of variants) {
    expect(
      (await decide({ evidence })).outputs.get("run_required"),
      label,
    ).toBe("true");
  }
  for (const [label, archive] of [
    [
      "legacy v5 file",
      zipEvidence("validated\n", { name: "ci-completed-depth.txt" }),
    ],
    ["not json", zipEvidence("validated\n")],
    ["truncated", zipEvidence(JSON.stringify(valid)).subarray(0, 40)],
    ["empty", Buffer.alloc(0)],
  ] as const) {
    expect((await decide({ archive })).outputs.get("run_required"), label).toBe(
      "true",
    );
  }
  expect(
    (
      await decide({
        archive: zipEvidence(JSON.stringify(valid), { method: 0 }),
      })
    ).outputs.get("run_required"),
  ).toBe("false");
  expect(
    (await decide({ downloadFailure: true })).outputs.get("run_required"),
  ).toBe("true");
  for (const size of [0, 65_537, Number.NaN]) {
    expect(
      (
        await decide({
          artifacts: [{ ...artifact("full"), size_in_bytes: size }],
        })
      ).outputs.get("run_required"),
      String(size),
    ).toBe("true");
  }
});

test("old-version markers are never looked up or trusted", async () => {
  const { outputs, requests } = await decide({
    artifacts: [{ ...artifact("full"), name: marker("full", "normal-v1", 5) }],
  });
  expect(outputs.get("run_required")).toBe("true");
  expect(outputs.get("marker")).toBe(marker("full"));
  expect(requests).toHaveLength(1);
  expect(requests.at(0)).toMatchObject({ name: marker("full") });
});

test("completion publication replaces an existing marker on a second attempt", () => {
  const publisher = result.steps.find(
    (step) => step.id === "completion-publisher",
  );
  const inputs = v.parse(
    v.object({ name: v.string(), overwrite: v.literal(true) }),
    publisher?.with,
  );
  expect(inputs.overwrite).toBe(true);
  for (const attempt of [1, 2]) {
    expect(
      evaluate(inputs.name, {
        values: {
          "needs.ci-plan.outputs.completion_marker": marker("full"),
          "github.run_attempt": attempt,
        },
      }),
    ).toBe(marker("full"));
  }
});

test("completion lookup conditions belong only to the planner job", () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      if (step.if?.includes("steps.completed-depth")) {
        expect(name, step.name).toBe("ci-plan");
      }
    }
  }
  const condition = jobs["docker-checks"]?.steps.find(
    (step) => step.id === "api-deps",
  )?.if;
  if (!condition) {
    throw new Error("Missing image dependency scope condition");
  }
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  for (const cancelled of [true, false]) {
    for (const required of ["true", "false"]) {
      expect(
        evaluate(expression, {
          status: { cancelled },
          values: { "needs.ci-plan.outputs.api_image_deps_required": required },
        }),
      ).toBe(!cancelled && required === "true");
    }
  }
});

test("every CI condition is one expression without partial interpolation", () => {
  const conditions = new Set<string>();
  const visit = (value: unknown, location: string) => {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const current = `${location}.${key}`;
      if (key === "if") {
        conditions.add(current);
        expect(typeof entry, current).toBe("string");
        if (typeof entry === "string" && entry.includes("${{")) {
          const expression = entry.trim();
          expect(expression, current).toMatch(/^\$\{\{[\s\S]*\}\}$/u);
          expect(expression.slice(3, -2), current).not.toContain("${{");
        }
      }
      visit(entry, current);
    }
  };
  visit(
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
    "ci.yml",
  );
  expect(conditions.size).toBeGreaterThan(0);
});

test("surviving artifacts require the latest source attempt to succeed", async () => {
  for (const sourceRun of [
    { ...successfulRun, conclusion: "failure" },
    { ...successfulRun, conclusion: "cancelled" },
    { ...successfulRun, status: "in_progress", conclusion: null },
    { ...successfulRun, run_attempt: 2, conclusion: "failure" },
    { ...successfulRun, run_attempt: 2, conclusion: "success" },
    { ...successfulRun, path: ".github/workflows/other.yml" },
    null,
  ]) {
    expect((await decide({ sourceRun })).outputs.get("run_required")).toBe(
      "true",
    );
  }
  expect((await decide({ runFailure: true })).outputs.get("run_required")).toBe(
    "true",
  );
  for (const conclusion of ["success", "failure"]) {
    expect(
      (
        await decide({
          artifacts: [artifact("full")],
          sourceRun: { ...successfulRun, run_attempt: 2, conclusion },
          evidence: { ...evidenceFor("full"), run_attempt: 2 },
        })
      ).outputs.get("run_required"),
    ).toBe(conclusion === "success" ? "false" : "true");
  }
});

test("exact-name lookup finds evidence behind more than a page of unrelated artifacts", async () => {
  const artifacts = [
    ...Array.from({ length: 150 }, (_, index) => ({
      ...artifact("full"),
      name: `unrelated-${index}`,
    })),
    artifact("full"),
  ];
  const { outputs, requests } = await decide({ artifacts });
  expect(outputs.get("run_required")).toBe("false");
  expect(requests).toHaveLength(3);
  expect(requests.at(0)).toMatchObject({ name: marker("full"), per_page: 100 });
});

test("switching the pilot on or off cannot reuse the other fast coverage profile", async () => {
  for (const { profile, previous } of [
    { profile: "normal-v1", previous: "pilot-fast-v1" },
    { profile: "pilot-fast-v1", previous: "normal-v1" },
  ]) {
    expect(
      (
        await decide({
          depth: "fast",
          profile,
          artifacts: [artifact("fast", previous)],
        })
      ).outputs.get("run_required"),
    ).toBe("true");
    expect(
      (
        await decide({
          depth: "fast",
          profile,
          artifacts: [artifact("fast", profile)],
        })
      ).outputs.get("run_required"),
    ).toBe("false");
  }
});

test("enqueue events leave every PR suite to unchanged merge-group validation", async () => {
  const { outputs, requests } = await decide({ action: "enqueued" });
  expect(outputs.get("run_required")).toBe("false");
  expect(outputs.get("queue_validation")).toBe("true");
  expect(requests).toHaveLength(0);
  const enqueued = contextWithPlanOutputs({
    context: {
      status: { cancelled: false },
      values: {
        "github.event_name": "pull_request",
        "github.event.pull_request.draft": false,
        "inputs.heavy_only": false,
        "needs.ci-plan.result": "success",
        "needs.ci-plan.outputs.run_required": "false",
        "github.event.action": "enqueued",
        "steps.completed-depth.outputs.run_required": "false",
        "steps.completed-depth.outputs.armed": "false",
        "steps.suites.outputs.heavy_proof": "false",
        "steps.suites.outputs.armed_delta": "false",
        "needs.pr-heavy-gate.result": "skipped",
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      },
    },
    outputs: planner.outputs,
  });
  // Even the wall-clock quick checks skip: the merge group runs them on the
  // queued tree, so an enqueued head starts no job besides the plan and result.
  for (const [name, job] of Object.entries(jobs)) {
    if (["ci-plan", "ci-result"].includes(name) || name.endsWith("-cancel")) {
      continue;
    }
    expect(evaluate(job.if ?? "true", enqueued), name).toBe(false);
  }
});

test("enqueue aggregation accepts only the queued PR event and successful structural checks", () => {
  const start = aggregate.indexOf('if [[ "$QUEUE_VALIDATION" == true');
  const end = aggregate.indexOf("# Read failure and timeout evidence", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const branch = `${aggregate.slice(start, end)}\nexit 9`;
  for (const [event, action, outcome, expected] of [
    ["pull_request", "enqueued", "success", 0],
    ["pull_request", "enqueued", "failure", 9],
    ["pull_request", "enqueued", "cancelled", 9],
    ["pull_request", "synchronize", "success", 9],
    ["merge_group", "enqueued", "success", 9],
  ] as const) {
    const child = Bun.spawnSync(["bash", "-c", branch], {
      env: {
        ...process.env,
        QUEUE_VALIDATION: "true",
        EVENT: event,
        PR_ACTION: action,
        NEEDS: JSON.stringify({
          "ci-plan": { result: outcome },
          checks: { result: "skipped" },
        }),
      },
    });
    expect(child.exitCode, child.stderr.toString()).toBe(expected);
  }
});

test("thin groups certify only normal-profile completion on a head included in the group", async () => {
  const options = {
    event: "merge_group",
    queueDepth: "thin",
    depth: "full",
    artifacts: [artifact("fast")],
  };
  const passed = await decide(options);
  expect(passed.outputs.get("normal_completion")).toBe("complete");
  expect(passed.outputs.get("run_required")).toBe("true");
  expect(passed.outputs.has("marker")).toBe(false);
  expect(
    (await decide({ ...options, profile: "pilot-fast-v1" })).outputs.get(
      "normal_completion",
    ),
  ).toBe("complete");
  for (const changed of [
    { artifacts: [artifact("fast", "pilot-fast-v1")] },
    { artifacts: [] },
    { artifacts: [artifact("full")] },
    { artifacts: [{ ...artifact("fast"), expired: true }] },
    { failure: true },
    { artifactFailure: true },
    { comparisonFailure: true },
    { runFailure: true },
    {
      sourceRun: { ...successfulRun, status: "in_progress", conclusion: null },
    },
    { sourceRun: { ...successfulRun, conclusion: "failure" } },
    { sourceRun: { ...successfulRun, head_sha: "d".repeat(40) } },
    {
      comparison: {
        status: "diverged",
        merge_base_commit: { sha: "d".repeat(40) },
      },
    },
    {
      comparison: {
        status: "ahead",
        merge_base_commit: { sha: "d".repeat(40) },
      },
    },
    { groupRef: "refs/heads/unknown" },
    { pull: { ...pr, number: 999 } },
  ]) {
    const fallback = await decide({ ...options, ...changed });
    expect(
      fallback.outputs.get("normal_completion"),
      JSON.stringify(changed),
    ).toBe("required");
    expect(fallback.outputs.get("run_required")).toBe("true");
  }
});

// Measured p95 is 33.8 s; this test must evaluate every queued job through the real aggregator.
test("thin groups require queued code checks regardless of normal PR completion", async () => {
  const admitted = queueAdmittedJobs(workflow);
  expect(admitted).toContain("ci-browser");
  expect(admitted).toContain("dependency-malware");
  const aggregation = result.steps.find(
    (step) => step.name === "Evaluate CI outcome",
  );
  if (!aggregation?.run) {
    throw new Error("Missing CI aggregation");
  }
  const env = v.parse(
    v.object({ env: v.record(v.string(), v.string()) }),
    aggregation,
  ).env;
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(env["JOB_SCOPES"] ?? ""),
  );
  const allScopes = Object.fromEntries(
    Object.values(scopes)
      .filter((scopeName) => scopeName !== null)
      .map((scopeName) => [scopeName, "true"]),
  );
  const thin = thinJobs(workflow);
  for (const options of [
    { artifacts: [artifact("fast", "pilot-fast-v1")] },
    { artifacts: [] },
    { artifacts: [artifact("fast")] },
    { artifacts: [artifact("fast")], runFailure: true },
    { artifacts: [artifact("fast")], artifactFailure: true },
  ]) {
    const evidence = await decide({
      ...options,
      event: "merge_group",
      queueDepth: "thin",
      depth: "full",
    });
    const completion = v.parse(
      v.picklist(["required", "complete"]),
      evidence.outputs.get("normal_completion"),
    );
    const context = contextWithPlanOutputs({
      outputs: planner.outputs,
      context: {
        values: {
          "github.event_name": "merge_group",
          "vars.QUEUE_BROWSER_SUITES": "on",
          "inputs.heavy_only": false,
          "steps.completed-depth.outputs.normal_completion": completion,
          "steps.heavy-plan.outputs.queue_jobs": JSON.stringify(admitted),
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.suite_depth": "full",
          "needs.ci-plan.outputs.queue_depth": "thin",
          "steps.suites.outputs.heavy_proof": "true",
          "needs.ci-plan.result": "success",
          "needs.pr-heavy-gate.result": "skipped",
          "needs.generated-sources.result": "success",
          "needs.web-build.result": "success",
          "needs.heavy-web-build.result": "skipped",
          "inputs.pr_depth_only": false,
          ...Object.fromEntries(
            Object.keys(planner.outputs)
              .filter((name) => name.endsWith("_required"))
              .map((name) => [`needs.ci-plan.outputs.${name}`, "true"]),
          ),
        },
        // GitHub exposes an unset output of this completed producer as empty.
        fallback: (name) =>
          name.startsWith("steps.completed-depth.outputs.")
            ? (evidence.outputs.get(
                name.slice("steps.completed-depth.outputs.".length),
              ) ?? "")
            : undefined,
        status: {
          always: true,
          success: true,
          failure: false,
          cancelled: false,
        },
      },
    });
    const queueJobs = v.parse(
      v.array(v.string()),
      JSON.parse(
        v.parse(
          v.string(),
          context.fallback?.("needs.ci-plan.outputs.queue_required_jobs"),
        ),
      ),
    );
    expect(queueJobs).toEqual(admitted);
    const dependencies = Object.fromEntries(
      Object.entries(scopes).map(([name]) => [
        name,
        {
          result:
            thin.includes(name) ||
            queueJobs.includes(name) ||
            name === "desktop-rust-tests"
              ? "success"
              : "skipped",
        },
      ]),
    );
    dependencies["ci-plan"] = { result: "success" };
    const runAggregation = (needs: typeof dependencies, plan = allScopes) =>
      Bun.spawnSync(
        [
          "bash",
          "-e",
          "-c",
          renderResultInputs(aggregation.run ?? "", {
            needs: JSON.stringify(needs),
            plan: JSON.stringify(plan),
          }),
        ],
        {
          env: {
            ...process.env,
            ...env,
            EVENT: "merge_group",
            QUEUE_DEPTH: "thin",
            SUITE_DEPTH: "full",
            HEAVY_ONLY: "false",
            COVERAGE_PROFILE: "normal-v1",
            PATCH_ID: patchId,
            WORKFLOW_VERSION: pr.head.sha,
            PLAN_CONFIG: planConfig,
            PR_DEPTH_JOBS: JSON.stringify(prDepth),
            GITHUB_STEP_SUMMARY: "/dev/null",
            PR_DEPTH_REUSED: evidence.outputs.get("pr_depth_reused") ?? "false",
            PR_DEPTH_SOURCE_RUN_ID:
              evidence.outputs.get("pr_depth_source_run_id") ?? "",
            QUEUE_VALIDATION: "false",
            PLAN_RESULT: "success",
            TRUSTED: "true",
            THIN_JOBS: JSON.stringify(thin),
            QUEUE_REQUIRED_JOBS: JSON.stringify(queueJobs),
          },
        },
      );
    const successfulAggregation = runAggregation(dependencies);
    expect(
      successfulAggregation.exitCode,
      successfulAggregation.stdout.toString() +
        successfulAggregation.stderr.toString(),
    ).toBe(0);
    expect(evaluate(jobs["desktop-rust-tests"]?.if ?? "false", context)).toBe(
      true,
    );
    for (const outcome of ["skipped", "failure", "cancelled"]) {
      expect(
        runAggregation({
          ...dependencies,
          "desktop-rust-tests": { result: outcome },
        }).exitCode,
        `desktop-rust-tests/${completion}/${outcome}`,
      ).toBe(1);
    }
    for (const job of admitted) {
      const scheduled = evaluate(jobs[job]?.if ?? "true", context);
      expect(typeof scheduled, job).toBe("boolean");
      expect(scheduled, job).toBe(true);
      for (const outcome of ["skipped", "failure"]) {
        expect(
          runAggregation({ ...dependencies, [job]: { result: outcome } })
            .exitCode,
          `${job}/${outcome}`,
        ).toBe(1);
      }
    }
  }
}, 70_000);

test("a metadata event without completed evidence starts no suites", async () => {
  for (const action of ["labeled", "unlabeled"]) {
    const { outputs } = await decide({ action, artifacts: [] });
    expect(outputs.get("run_required"), action).toBe("false");
    expect(outputs.get("metadata_only"), action).toBe("true");
  }
  // An unrelated label on an armed pull request stays metadata too.
  const { outputs } = await decide({
    action: "labeled",
    label: "documentation",
    pull: { ...pr, labels: [{ name: ARMED_LABEL }] },
    artifacts: [],
  });
  expect(outputs.get("run_required")).toBe("false");
  expect(outputs.get("metadata_only")).toBe("true");
});

// Armed heavy proof: once a pull request is armed for merge (auto-merge or
// the armed label) its run proves the queue-only suites and records evidence
// under its own marker, which a merge group needs before it skips them.
test("arming by label or auto-merge starts the armed suites when the head lacks them", async () => {
  for (const options of [
    { action: "labeled", label: ARMED_LABEL, pull: armedPull },
    { action: "auto_merge_enabled", pull: autoMergePull },
  ] satisfies LookupOptions[]) {
    const { outputs } = await decide({
      depth: "fast",
      artifacts: [],
      ...options,
    });
    const label = JSON.stringify(options);
    expect(outputs.get("run_required"), label).toBe("true");
    expect(outputs.get("metadata_only"), label).toBeUndefined();
    expect(outputs.get("armed"), label).toBe("true");
    expect(outputs.get("marker"), label).toBe(armedMarker);
  }
  // Every later push to an armed pull request proves the suites again.
  for (const pull of [armedPull, autoMergePull]) {
    const { outputs, requests } = await decide({
      action: "synchronize",
      depth: "fast",
      pull,
    });
    expect(outputs.get("run_required")).toBe("true");
    expect(outputs.get("armed")).toBe("true");
    expect(requests).toHaveLength(0);
  }
  // Removing the label from a pull request without auto-merge disarms it.
  const { outputs } = await decide({
    action: "unlabeled",
    label: ARMED_LABEL,
    depth: "fast",
    artifacts: [],
  });
  expect(outputs.get("run_required")).toBe("true");
  expect(outputs.get("armed")).toBe("false");
});

test("a re-armed unchanged head reuses only armed evidence", async () => {
  for (const options of [
    { action: "labeled", label: ARMED_LABEL, pull: armedPull },
    { action: "auto_merge_enabled", pull: autoMergePull },
  ] satisfies LookupOptions[]) {
    const reused = await decide({
      depth: "fast",
      artifacts: [armedArtifact],
      evidence: armedEvidence,
      ...options,
    });
    expect(reused.outputs.get("run_required")).toBe("false");
    expect(reused.outputs.get("completed_run_id")).toBe("99");
    // Evidence under the armed name that does not record the proof is not it.
    const unproven = await decide({
      depth: "fast",
      artifacts: [armedArtifact],
      evidence: { ...armedEvidence, heavy_proof: false },
      ...options,
    });
    expect(unproven.outputs.get("run_required")).toBe("true");
  }
  // Armed evidence never satisfies an unarmed run's lookup either.
  const unarmed = await decide({
    depth: "fast",
    artifacts: [artifact("fast")],
    evidence: { ...evidenceFor("fast"), heavy_proof: true },
  });
  expect(unarmed.outputs.get("run_required")).toBe("true");
});

test("a merge group records armed proof only from exact armed evidence", async () => {
  const group = async (options: LookupOptions) =>
    decide({ event: "merge_group", queueDepth: "thin", ...options });
  const proven = await group({
    artifacts: [armedArtifact],
    evidence: armedEvidence,
  });
  expect(proven.outputs.get("armed_proof")).toBe("complete");
  expect(proven.outputs.get("armed_proof_source_run_id")).toBe("99");
  for (const options of [
    // Only unarmed PR-depth evidence exists.
    { artifacts: [artifact("fast")], evidence: evidenceFor("fast") },
    { artifacts: [] },
    {
      artifacts: [armedArtifact],
      evidence: { ...armedEvidence, heavy_proof: false },
    },
    { artifacts: [armedArtifact], currentPatchId: "e".repeat(40) },
    {
      artifacts: [armedArtifact],
      evidence: {
        ...armedEvidence,
        jobs: { ...armedEvidence.jobs, "mobile-build": "skipped" },
      },
    },
    {
      artifacts: [armedArtifact],
      sourceRun: { ...successfulRun, conclusion: "failure" },
    },
    { artifacts: [armedArtifact], comparisonFailure: true },
    {
      artifacts: [armedArtifact],
      comparison: {
        status: "diverged",
        merge_base_commit: { sha: "f".repeat(40) },
      },
    },
  ] satisfies LookupOptions[]) {
    const { outputs } = await group({ evidence: armedEvidence, ...options });
    expect(outputs.get("armed_proof"), JSON.stringify(options)).toBeUndefined();
  }
});

test("an armed run records its planned queue-only suites as armed proof", async () => {
  const heavy = v.parse(
    v.array(v.string()),
    JSON.parse(resultEnv["HEAVY_PROOF_JOBS"] ?? ""),
  );
  const plan = {
    ci_tests_required: "true",
    package_checks_required: "true",
    mobile_build_required: "true",
  };
  const results = {
    ...allSucceeded,
    ...Object.fromEntries(heavy.map((job) => [job, "skipped"])),
    "mobile-build": "success",
  };
  const text = recordEvidence(results, { armed: true, plan });
  if (text === undefined) {
    throw new Error("No evidence recorded for a fully successful armed run");
  }
  const recorded = v.parse(
    v.looseObject({ heavy_proof: v.boolean(), planned: v.array(v.string()) }),
    JSON.parse(text),
  );
  expect(recorded.heavy_proof).toBe(true);
  expect(recorded.planned).toContain("mobile-build");
  // A planned queue-only suite that did not succeed records no proof.
  expect(
    recordEvidence(
      { ...results, "mobile-build": "skipped" },
      { armed: true, plan },
    ),
  ).toBeUndefined();
  // The recorded proof is what a merge group needs before it skips them.
  const group = await decide({
    event: "merge_group",
    queueDepth: "thin",
    artifacts: [armedArtifact],
    evidence: recorded,
    archive: zipEvidence(`${text}\n`),
    jobs: publisherJobs(text),
  });
  expect(group.outputs.get("armed_proof")).toBe("complete");
  // An unarmed run records no armed proof.
  const unarmed = recordEvidence(allSucceeded);
  expect(unarmed && JSON.parse(unarmed)).toMatchObject({ heavy_proof: false });
});

test("arming a head with green normal evidence runs only the queue-only delta", async () => {
  for (const options of [
    { action: "labeled", label: ARMED_LABEL, pull: armedPull },
    { action: "auto_merge_enabled", pull: autoMergePull },
  ] satisfies LookupOptions[]) {
    const { outputs } = await decide({
      depth: "fast",
      artifacts: [artifact("fast")],
      evidence: evidenceFor("fast"),
      ...options,
    });
    const label = JSON.stringify(options);
    // Planning still runs; the normal suites come from the recorded run.
    expect(outputs.get("run_required"), label).toBe("true");
    expect(outputs.get("normal_reused"), label).toBe("true");
    expect(outputs.get("normal_source_run_id"), label).toBe("99");
    expect(outputs.get("marker"), label).toBe(armedMarker);
  }
  for (const options of [
    // No normal evidence at all.
    { action: "labeled", label: ARMED_LABEL, pull: armedPull, artifacts: [] },
    // An unarmed pull request never takes the delta.
    { action: "reopened", artifacts: [] },
    // Metadata on an armed pull request starts nothing.
    {
      action: "labeled",
      label: "documentation",
      pull: armedPull,
      artifacts: [artifact("fast")],
    },
  ] satisfies LookupOptions[]) {
    const { outputs } = await decide({
      depth: "fast",
      evidence: evidenceFor("fast"),
      ...options,
    });
    expect(
      outputs.get("normal_reused"),
      JSON.stringify(options),
    ).toBeUndefined();
  }
});

test("a moved base never forces a re-test of an identical head", async () => {
  for (const action of ["reopened", "ready_for_review"]) {
    const { outputs } = await decide({
      action,
      depth: "fast",
      pull: { ...pr, base: { sha: "c".repeat(40) } },
    });
    expect(outputs.get("run_required"), action).toBe("false");
    expect(outputs.get("completed_run_id"), action).toBe("99");
  }
});

// The head a merge of the base sits on, and the evidence its run published.
const parentSha = "e".repeat(40);
const parentMarker = `ci-completed-v7-normal-v1-123-456-${parentSha}-fast-${scope}`;
const parentArtifact = {
  ...artifact("fast"),
  name: parentMarker,
  workflow_run: { ...artifact("fast").workflow_run, head_sha: parentSha },
};
const parentRun = { ...successfulRun, head_sha: parentSha };
const parentEvidence = {
  ...evidenceFor("fast"),
  marker: parentMarker,
  head_sha: parentSha,
  base_sha: "f".repeat(40),
};
const mergeFromBase = async (options: LookupOptions = {}) =>
  decide({
    action: "synchronize",
    depth: "fast",
    mergeParent: parentSha,
    artifacts: [parentArtifact],
    sourceRun: parentRun,
    evidence: parentEvidence,
    ...options,
  });

test("a head that only merges the base reuses its parent's heavy suites", async () => {
  const { outputs, requests } = await mergeFromBase();
  expect(outputs.get("pr_heavy_suites")).toBe("reused");
  expect(outputs.get("pr_heavy_source_run_id")).toBe("99");
  expect(outputs.get("pr_heavy_source_sha")).toBe(parentSha);
  // The merged head still runs its quick and PR-depth checks and publishes
  // its own evidence, so a later merge of the base can chain from it.
  expect(outputs.get("run_required")).toBe("true");
  expect(outputs.get("completed_run_id")).toBeUndefined();
  expect(outputs.get("marker")).toBe(marker("fast"));
  expect(requests).toEqual([
    expect.objectContaining({ name: parentMarker }),
    expect.objectContaining({ run_id: 99 }),
    expect.objectContaining({ artifact_id: 7 }),
  ]);
});

test("a merge that changes the pull request side, or lacks parent evidence, runs the heavy suites", async () => {
  const cases: [string, LookupOptions][] = [
    ["changed patch id", { currentPatchId: "f".repeat(40) }],
    ["no patch id", { currentPatchId: "" }],
    ["evidence for the merged head", { artifacts: [artifact("fast")] }],
    ["no evidence", { artifacts: [] }],
    [
      "failed parent run",
      { sourceRun: { ...parentRun, conclusion: "failure" } },
    ],
    ["parent run for another head", { sourceRun: successfulRun }],
    [
      "evidence for another head",
      { evidence: { ...parentEvidence, head_sha: pr.head.sha } },
    ],
    [
      "other CI version",
      { evidence: { ...parentEvidence, workflow_version: "f".repeat(40) } },
    ],
    [
      "other plan config",
      {
        evidence: {
          ...parentEvidence,
          plan_config: '{"CI_POSTGRES_PR_SELECTION":"on"}',
        },
      },
    ],
    ["other depth", { depth: "full" }],
    ["changed scope", { pull: { ...pr, title: "fix: another scope" } }],
    ["parent is the head", { mergeParent: pr.head.sha }],
    ["malformed parent", { mergeParent: "main" }],
    ["evidence lookup failure", { artifactFailure: true }],
  ];
  for (const [label, options] of cases) {
    const { outputs } = await mergeFromBase(options);
    expect(outputs.get("pr_heavy_suites"), label).toBe("run");
    expect(outputs.get("run_required"), label).toBe("true");
    expect(outputs.has("pr_heavy_source_run_id"), label).toBe(false);
  }
  for (const options of [{ mergeParent: "" }, { action: "opened" }]) {
    const { outputs, requests } = await mergeFromBase(options);
    expect(outputs.get("pr_heavy_suites")).toBe("run");
    expect(requests).toHaveLength(0);
  }
});

type PatchIdStepOptions = {
  repository: string;
  event?: string;
  base: string;
  head: string;
  groupRef?: string;
  targetBase?: string;
  retryScript?: string;
};
const patchIdStep = planner.steps.find((step) => step.id === "patch-id")?.run;
const runPatchIdStep = ({
  repository,
  event = "pull_request",
  base,
  head,
  groupRef = "",
  targetBase = base,
  retryScript = new URL("retry.sh", import.meta.url).pathname,
}: PatchIdStepOptions) => {
  const output = nodePath.join(repository, ".git", "step-output");
  writeFileSync(output, "");
  const step = Bun.spawnSync(
    ["bash", "-e", "-o", "pipefail", "-c", patchIdStep ?? ""],
    {
      cwd: repository,
      env: {
        PATH: process.env["PATH"] ?? "",
        EVENT_NAME: event,
        PR_BASE_SHA: base,
        PR_HEAD_SHA: head,
        GROUP_BASE_SHA: base,
        TARGET_BASE_SHA: targetBase,
        GROUP_HEAD_SHA: head,
        GROUP_HEAD_REF: groupRef,
        CI_RETRY_SCRIPT: retryScript,
        RETRY_ATTEMPTS: "1",
        RETRY_DELAYS_SECONDS: "0",
        WORKFLOW_SHA: head,
        GITHUB_OUTPUT: output,
      },
    },
  );
  expect(step.exitCode, step.stderr.toString()).toBe(0);
  return Object.fromEntries(
    readFileSync(output, "utf-8")
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
};

test("the patch-id step names the parent only of a merge of the base, with the parent's patch id when the merge is clean", () => {
  const repository = mkdtempSync(nodePath.join(tmpdir(), "ci-merge-parent-"));
  const git = (...args: string[]) => {
    const command = Bun.spawnSync(["git", ...args], {
      cwd: repository,
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_AUTHOR_NAME: "CI",
        GIT_AUTHOR_EMAIL: "ci@example.test",
        GIT_COMMITTER_NAME: "CI",
        GIT_COMMITTER_EMAIL: "ci@example.test",
      },
    });
    expect(command.exitCode, command.stderr.toString()).toBe(0);
    return command.stdout.toString().trim();
  };
  const write = (file: string, lines: readonly string[]) =>
    writeFileSync(nodePath.join(repository, file), `${lines.join("\n")}\n`);
  const numbered = Array.from({ length: 40 }, (_, line) => String(line + 1));
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet", "--initial-branch=main");
    mkdirSync(nodePath.join(repository, ".github", "workflows"), {
      recursive: true,
    });
    write(".github/workflows/ci.yml", ["name: CI"]);
    write("feature.txt", numbered);
    write("unrelated.txt", ["one"]);
    const root = commit("base");
    git("checkout", "--quiet", "-b", "feature");
    write(
      "feature.txt",
      numbered.map((line) => (line === "20" ? "twenty" : line)),
    );
    const parent = commit("feature");
    git("checkout", "--quiet", "main");
    write("unrelated.txt", ["one", "two"]);
    const far = commit("unrelated change on main");
    git("checkout", "--quiet", "feature");
    git("merge", "--quiet", "--no-edit", far);
    const merged = git("rev-parse", "HEAD");

    const before = runPatchIdStep({ repository, base: root, head: parent });
    expect(before["merge_parent"]).toBe("");
    const after = runPatchIdStep({ repository, base: far, head: merged });
    expect(after["merge_parent"]).toBe(parent);
    expect(after["patch_id"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(after["patch_id"]).toBe(before["patch_id"]);

    // Reusing the same parents is insufficient when a manual resolution
    // changes the automatic merge tree.
    write("resolution.txt", ["manual resolution"]);
    git("add", "resolution.txt");
    git("commit", "--quiet", "--amend", "--no-edit");
    expect(
      runPatchIdStep({
        repository,
        base: far,
        head: git("rev-parse", "HEAD"),
      })["merge_parent"],
    ).toBe("");
    git("reset", "--quiet", "--hard", merged);

    // A merge-queue run never names a parent.
    expect(
      runPatchIdStep({
        repository,
        event: "merge_group",
        base: far,
        head: merged,
      })["merge_parent"],
    ).toBe("");

    // Main edits next to the change: the parent is named, but the patch id
    // moves, so the planner's lookup finds no matching evidence.
    git("checkout", "--quiet", "main");
    write(
      "feature.txt",
      numbered.map((line) => (line === "22" ? "22b" : line)),
    );
    const near = commit("nearby change on main");
    git("checkout", "--quiet", "feature");
    git("merge", "--quiet", "--no-edit", near);
    const nearMerge = runPatchIdStep({
      repository,
      base: near,
      head: git("rev-parse", "HEAD"),
    });
    expect(nearMerge["merge_parent"]).toBe(git("rev-parse", "HEAD^1"));
    expect(nearMerge["patch_id"]).not.toBe(before["patch_id"]);

    // A merge of anything outside the base, or an ordinary commit, names none.
    git("checkout", "--quiet", "-b", "other", root);
    write("other.txt", ["other"]);
    const other = commit("another branch");
    git("checkout", "--quiet", "feature");
    git("merge", "--quiet", "--no-edit", other);
    expect(
      runPatchIdStep({
        repository,
        base: near,
        head: git("rev-parse", "HEAD"),
      })["merge_parent"],
    ).toBe("");
    write("feature.txt", ["rewritten"]);
    expect(
      runPatchIdStep({ repository, base: near, head: commit("ordinary") })[
        "merge_parent"
      ],
    ).toBe("");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("a batched group skips the queue-only suites only when every entry carries armed proof", async () => {
  // #124 was queued before #123; the group merges both.
  const earlier = {
    ...pr,
    number: 124,
    head: { sha: "e".repeat(40), repo: { id: 456 } },
  };
  const earlierPatch = "f".repeat(40);
  const earlierMarker = `ci-completed-v7-normal-v1-124-456-${earlier.head.sha}-fast-armed-${scope}`;
  const earlierArtifact = {
    ...armedArtifact,
    id: 8,
    name: earlierMarker,
    workflow_run: {
      id: 98,
      head_sha: earlier.head.sha,
      head_repository_id: 456,
    },
  };
  const earlierEvidence = {
    ...armedEvidence,
    marker: earlierMarker,
    run_id: 98,
    pr_number: 124,
    head_sha: earlier.head.sha,
    patch_id: earlierPatch,
  };
  const chain = [
    { pr: 123, patch_id: patchId },
    { pr: 124, patch_id: earlierPatch },
  ];
  const group = async (options: LookupOptions) =>
    decide({
      event: "merge_group",
      queueDepth: "thin",
      evidence: armedEvidence,
      entryChain: chain,
      queuedPulls: { 124: earlier },
      archives: { 8: zipEvidence(`${JSON.stringify(earlierEvidence)}\n`) },
      jobsByRun: { 98: publisherJobs(JSON.stringify(earlierEvidence)) },
      sourceRuns: {
        98: { ...successfulRun, id: 98, head_sha: earlier.head.sha },
      },
      ...options,
    });
  // The queued pull request is proven; the earlier entry is not.
  const partial = await group({ artifacts: [armedArtifact] });
  expect(partial.outputs.get("armed_proof")).toBeUndefined();
  const proven = await group({ artifacts: [armedArtifact, earlierArtifact] });
  expect(proven.outputs.get("armed_proof")).toBe("complete");
  expect(proven.outputs.get("armed_proof_source_run_id")).toBe("99");
  // Proof for another patch of the earlier pull request is not proof.
  const otherPatch = await group({
    artifacts: [armedArtifact, earlierArtifact],
    entryChain: [chain[0], { pr: 124, patch_id: "0".repeat(40) }],
  });
  expect(otherPatch.outputs.get("armed_proof")).toBeUndefined();
  // An unresolved chain, or one not led by the queued pull request, proves nothing.
  for (const entryChain of [null, [], chain.toReversed()]) {
    const { outputs } = await group({
      artifacts: [armedArtifact, earlierArtifact],
      entryChain,
    });
    expect(
      outputs.get("armed_proof"),
      JSON.stringify(entryChain),
    ).toBeUndefined();
  }
});

test("the patch-id step lists every queue entry's own patch down to the group base", () => {
  const repository = mkdtempSync(nodePath.join(tmpdir(), "ci-entry-chain-"));
  const git = (...args: string[]) => {
    const command = Bun.spawnSync(["git", ...args], {
      cwd: repository,
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_AUTHOR_NAME: "CI",
        GIT_AUTHOR_EMAIL: "ci@example.test",
        GIT_COMMITTER_NAME: "CI",
        GIT_COMMITTER_EMAIL: "ci@example.test",
      },
    });
    expect(command.exitCode, command.stderr.toString()).toBe(0);
    return command.stdout.toString().trim();
  };
  const commit = (file: string, message: string) => {
    writeFileSync(nodePath.join(repository, file), `${message}\n`);
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const patchOf = (from: string, to: string) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        `git diff --binary ${from}..${to} | git patch-id --stable | awk 'NR == 1 { print $1 }'`,
      ],
      {
        cwd: repository,
      },
    )
      .stdout.toString()
      .trim();
  try {
    git("init", "--quiet", "--template=", "--initial-branch=main");
    // The repository is its own origin, so ls-remote reads its queue refs.
    git("remote", "add", "origin", repository);
    // The step identifies the workflow version from the head's own ci.yml.
    mkdirSync(nodePath.join(repository, ".github", "workflows"), {
      recursive: true,
    });
    const base = commit(".github/workflows/ci.yml", "workflow");
    const first = commit("first.txt", "first entry");
    const second = commit("second.txt", "second entry");
    const firstRef = `refs/heads/gh-readonly-queue/main/pr-11-${base}`;
    const secondRef = `refs/heads/gh-readonly-queue/main/pr-12-${first}`;
    git("update-ref", firstRef, first);
    git("update-ref", secondRef, second);
    const chain = (head: string, groupRef: string) =>
      runPatchIdStep({
        repository,
        event: "merge_group",
        base,
        head,
        groupRef,
      })["entry_chain"];
    expect(JSON.parse(chain(second, secondRef) ?? "")).toEqual([
      { pr: 12, patch_id: patchOf(first, second) },
      { pr: 11, patch_id: patchOf(base, first) },
    ]);
    expect(JSON.parse(chain(first, firstRef) ?? "")).toEqual([
      { pr: 11, patch_id: patchOf(base, first) },
    ]);
    const batched = runPatchIdStep({
      repository,
      event: "merge_group",
      base: first,
      targetBase: base,
      head: second,
      groupRef: secondRef,
    });
    expect(JSON.parse(batched["entry_chain"] ?? "")).toEqual([
      { pr: 12, patch_id: patchOf(first, second) },
      { pr: 11, patch_id: patchOf(base, first) },
    ]);
    expect(batched["tested_tree"]).toBe(git("rev-parse", "HEAD^{tree}"));
    expect(batched["workflow_tree"]).toBe(git("rev-parse", `${second}^{tree}`));
    const retryFailure = nodePath.join(repository, ".git", "retry-failure.sh");
    writeFileSync(retryFailure, "exit 1\n");
    expect(
      runPatchIdStep({
        repository,
        event: "merge_group",
        base,
        head: first,
        groupRef: firstRef,
        retryScript: retryFailure,
      })["entry_chain"],
    ).toBe("null");
    // An entry whose queue ref is gone breaks the chain: nothing is proven.
    git("update-ref", "-d", firstRef);
    expect(chain(second, secondRef)).toBe("null");
    // A pull request run has no chain.
    expect(
      runPatchIdStep({ repository, base, head: second })["entry_chain"],
    ).toBe("null");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("armed proof counts only when ci-result uploaded it after every other job", async () => {
  const group = async (groupJobs: unknown[]) =>
    decide({
      event: "merge_group",
      queueDepth: "thin",
      artifacts: [armedArtifact],
      evidence: armedEvidence,
      jobs: groupJobs,
    });
  expect((await group(sourceJobs)).outputs.get("armed_proof")).toBe("complete");
  const [tests, ciResult] = sourceJobs;
  for (const candidate of [
    // A pull request job still running when the artifact appeared.
    [{ ...tests, status: "in_progress", completed_at: null }, ciResult],
    // A job that finished after the upload uploaded nothing ci-result vouches for.
    [{ ...tests, completed_at: "2026-10-17T10:40:00Z" }, ciResult],
    // Uploaded before ci-result started.
    [tests, { ...ciResult, started_at: "2026-10-17T10:35:00Z" }],
    // No successful ci-result.
    [tests, { ...ciResult, conclusion: "failure" }],
    [tests],
  ]) {
    expect(
      (await group(candidate)).outputs.get("armed_proof"),
      JSON.stringify(candidate),
    ).toBeUndefined();
  }
});

test("armed evidence requires one successful publisher of its exact payload", async () => {
  const group = async (options: LookupOptions = {}) =>
    await decide({
      event: "merge_group",
      queueDepth: "thin",
      artifacts: [armedArtifact],
      evidence: armedEvidence,
      ...options,
    });
  expect((await group()).outputs.get("armed_proof")).toBe("complete");
  const payload = JSON.stringify(armedEvidence);
  const receipt = publisherStep(payload);
  for (const steps of [
    [],
    [{ ...receipt, name: "Publish completed suite depth" }],
    [{ ...receipt, name: `Publish armed suite depth ${"0".repeat(64)}` }],
    [{ ...receipt, status: "in_progress" }],
    [{ ...receipt, conclusion: "failure" }],
    [receipt, receipt],
  ]) {
    const invalidPublisherJobs = sourceJobs.map((job) =>
      job.name === "ci-result" ? { ...job, steps } : job,
    );
    expect(
      (await group({ jobs: invalidPublisherJobs })).outputs.get("armed_proof"),
      JSON.stringify(steps),
    ).toBeUndefined();
  }
  const altered = { ...armedEvidence, planned: ["ci-tests"] };
  expect(
    (await group({ evidence: altered })).outputs.get("armed_proof"),
  ).toBeUndefined();
});

test("armed payload framing requires exactly one final line feed", async () => {
  const payload = JSON.stringify(armedEvidence);
  for (const { archive, certified } of [
    { archive: payload, certified: payload.slice(0, -1) },
    { archive: `${payload}\n\n`, certified: `${payload}\n` },
  ]) {
    // A malformed publisher receipt isolates framing from a digest mismatch.
    const { outputs } = await decide({
      event: "merge_group",
      queueDepth: "thin",
      artifacts: [armedArtifact],
      archive: zipEvidence(archive),
      jobs: publisherJobs(certified),
    });
    expect(outputs.get("armed_proof"), JSON.stringify(archive)).toBeUndefined();
  }
});

test("armed proof matches the latest attempt and both tested input trees", async () => {
  for (const options of [
    { sourceRun: { ...successfulRun, run_attempt: 2 } },
    { targetBase: "5".repeat(40) },
    { testedTree: "3".repeat(40) },
    { workflowTree: "4".repeat(40) },
  ]) {
    const { outputs } = await decide({
      event: "merge_group",
      queueDepth: "thin",
      artifacts: [armedArtifact],
      evidence: armedEvidence,
      ...options,
    });
    expect(outputs.get("armed_proof"), JSON.stringify(options)).toBeUndefined();
  }
});
