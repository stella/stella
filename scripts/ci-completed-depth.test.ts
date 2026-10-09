import { expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Script } from "node:vm";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { pilotQueueJobs } from "./ci-pr-pilot-plan";
import { contextWithPlanOutputs, evaluate } from "./github-expression";
import { prDepthJobs, thinJobs } from "./main-heavy-plan";

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
const scope = createHash("sha256")
  .update(JSON.stringify([pr.title, pr.body, false]))
  .digest("hex");
const marker = (depth: string, profile = "normal-v1", version = 6) =>
  `ci-completed-v${version}-${profile}-123-456-${pr.head.sha}-${depth}-${scope}`;
const artifact = (depth: string, profile = "normal-v1") => ({
  id: 7,
  size_in_bytes: 400,
  name: marker(depth, profile),
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
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
  version: 6,
  marker: marker(depth, profile),
  event: "pull_request",
  run_id: 99,
  run_attempt: 1,
  pr_number: 123,
  head_repo_id: 456,
  head_sha: pr.head.sha,
  base_sha: pr.base.sha,
  patch_id: patchId,
  workflow_version: pr.head.sha,
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
  pull?: typeof pr;
  evidence?: unknown;
  archive?: Buffer;
  downloadFailure?: boolean;
};
const decide = async ({
  depth = "full",
  profile = "normal-v1",
  action = "labeled",
  event = "pull_request",
  artifacts = [artifact(depth, profile)],
  failure = false,
  artifactFailure = false,
  comparisonFailure = false,
  runFailure = false,
  sourceRun = successfulRun,
  pull = pr,
  queueDepth = "full",
  comparison = { status: "ahead", merge_base_commit: { sha: pull.head.sha } },
  groupRef = `refs/heads/gh-readonly-queue/main/pr-123-${"b".repeat(40)}`,
  evidence = event === "merge_group" && queueDepth === "thin"
    ? evidenceFor("fast")
    : evidenceFor(depth, profile),
  archive = zipEvidence(JSON.stringify(evidence)),
  downloadFailure = false,
}: LookupOptions = {}) => {
  const outputs = new Map<string, string>();
  const requests: unknown[] = [];
  await new Script(`(async () => {${lookup}\n})()`).runInNewContext({
    Buffer,
    require: (name: string) => {
      if (name === "node:crypto") {
        return { createHash };
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
        PATCH_ID: patchId,
        WORKFLOW_VERSION: pr.head.sha,
        PR_DEPTH_JOBS: JSON.stringify(prDepth),
      },
    },
    context: {
      eventName: event,
      payload: {
        action,
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
      rest: {
        pulls: {
          get: async (request: unknown) => {
            requests.push(request);
            if (failure) {
              throw new Error("Queued PR unavailable");
            }
            return { data: pull };
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
          downloadArtifact: async (request: unknown) => {
            requests.push(request);
            if (downloadFailure) {
              throw new Error("Evidence archive unavailable");
            }
            return {
              data: archive.buffer.slice(
                archive.byteOffset,
                archive.byteOffset + archive.byteLength,
              ),
            };
          },
          getWorkflowRun: async (request: unknown) => {
            requests.push(request);
            if (runFailure) {
              throw new Error("Source run unavailable");
            }
            return { data: sourceRun };
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
      expect(
        (
          await decide({ action, depth, artifacts: [artifact(opposite)] })
        ).outputs.get("run_required"),
      ).toBe("true");
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
      await decide({ pull: { ...pr, base: { sha: "c".repeat(40) } } })
    ).outputs.get("run_required"),
  ).toBe("false");
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
      values: {
        "github.event_name": "pull_request",
        "needs.ci-plan.outputs.run_required": "false",
      },
    },
    outputs: planner.outputs,
  });
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "ci-plan" || name === "ci-result") {
      continue;
    }
    expect(evaluate(job.if ?? "true", reused), name).toBe(false);
  }
  const checkout = planner.steps.findIndex((step) => step.name === "Checkout");
  expect(checkout).toBeGreaterThan(-1);
  for (const step of planner.steps.slice(checkout)) {
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
  const start = aggregate.indexOf(`if [[ "\${RUN_REQUIRED:-true}" == false ]]`);
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
    const condition = result.steps.find((step) => step.name === name)?.if;
    if (!condition) {
      throw new Error("Missing completion publisher condition");
    }
    for (const success of [true, false]) {
      for (const event of [
        "pull_request",
        "merge_group",
        "workflow_dispatch",
      ]) {
        for (const runRequired of ["true", "false"]) {
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
                      "needs.ci-plan.outputs.run_required": runRequired,
                      "needs.ci-plan.outputs.completion_marker": markerName,
                      "needs.*.result": ["success", "success", sibling],
                      "steps.outcome.outputs.evidence": evidence,
                    },
                  }),
                  `${name} ${String(success)} ${event} ${runRequired} ${markerName} ${sibling} ${evidence}`,
                ).toBe(
                  success &&
                    event === "pull_request" &&
                    runRequired === "true" &&
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
  } = {},
) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-evidence-"));
  const output = nodePath.join(directory, "output");
  try {
    const child = Bun.spawnSync(["bash", "-eu", "-c", script], {
      env: {
        PATH: process.env["PATH"] ?? "",
        GITHUB_OUTPUT: output,
        GITHUB_RUN_ID: "99",
        GITHUB_RUN_ATTEMPT: "1",
        EVENT: "pull_request",
        RUN_REQUIRED: runRequired,
        COMPLETION_MARKER: marker(depth),
        PR_NUMBER: "123",
        HEAD_REPO_ID: "456",
        HEAD_SHA: head,
        BASE_SHA: pr.base.sha,
        SUITE_DEPTH: depth,
        COVERAGE_PROFILE: "normal-v1",
        PATCH_ID: patchId,
        WORKFLOW_VERSION: pr.head.sha,
        PR_DEPTH_JOBS: JSON.stringify(prDepth),
        JOB_SCOPES: resultEnv["JOB_SCOPES"] ?? "",
        FAST_JOB_SCOPES: resultEnv["FAST_JOB_SCOPES"] ?? "",
        FAST_REQUIRED: resultEnv["FAST_REQUIRED"] ?? "",
        PLAN: JSON.stringify({ package_checks_required: "true" }),
        NEEDS: JSON.stringify(
          Object.fromEntries(
            Object.entries(results).map(([job, outcome]) => [
              job,
              { result: outcome },
            ]),
          ),
        ),
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
    version: 6,
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
    ["missing PR-depth set", { ...valid, pr_depth_jobs: [] }],
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
    (step) => step.name === "Publish completed suite depth",
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
      values: {
        "github.event_name": "pull_request",
        "needs.ci-plan.outputs.run_required": "false",
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      },
    },
    outputs: planner.outputs,
  });
  for (const [name, job] of Object.entries(jobs)) {
    if (["ci-plan", "ci-result"].includes(name)) {
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

test("thin groups run and require every deferred normal PR check unless normal completion is certified", async () => {
  const deferred = pilotQueueJobs(workflow);
  if (deferred.status !== "valid") {
    throw new Error(deferred.message);
  }
  expect(deferred.jobs).toContain("ci-browser");
  expect(deferred.jobs).toContain("dependency-malware");
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
          "inputs.heavy_only": false,
          "steps.completed-depth.outputs.normal_completion": completion,
          "steps.pilot-queue-plan.outputs.queue_jobs": JSON.stringify(
            deferred.jobs,
          ),
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.suite_depth": "full",
          "needs.ci-plan.outputs.queue_depth": "thin",
          "inputs.pr_depth_only": false,
          ...Object.fromEntries(
            Object.entries(allScopes).map(([name, value]) => [
              `needs.ci-plan.outputs.${name}`,
              value,
            ]),
          ),
        },
        status: { success: true, failure: false, cancelled: false },
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
    expect(queueJobs).toEqual(completion === "complete" ? [] : deferred.jobs);
    const dependencies = Object.fromEntries(
      Object.entries(scopes).map(([name]) => [
        name,
        {
          result:
            thin.includes(name) || queueJobs.includes(name)
              ? "success"
              : "skipped",
        },
      ]),
    );
    dependencies["ci-plan"] = { result: "success" };
    const runAggregation = (needs: typeof dependencies) =>
      Bun.spawnSync(["bash", "-e", "-c", aggregation.run ?? ""], {
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
          PR_DEPTH_JOBS: JSON.stringify(prDepth),
          QUEUE_VALIDATION: "false",
          PLAN_RESULT: "success",
          TRUSTED: "true",
          THIN_JOBS: JSON.stringify(thin),
          QUEUE_REQUIRED_JOBS: JSON.stringify(queueJobs),
          PLAN: JSON.stringify(allScopes),
          NEEDS: JSON.stringify(needs),
        },
      });
    expect(runAggregation(dependencies).exitCode).toBe(0);
    for (const job of deferred.jobs) {
      const scheduled = evaluate(jobs[job]?.if ?? "true", context);
      if (completion !== "complete") {
        expect(scheduled, job).toBe(true);
        for (const outcome of ["skipped", "failure"]) {
          expect(
            runAggregation({ ...dependencies, [job]: { result: outcome } })
              .exitCode,
            `${job}/${outcome}`,
          ).toBe(1);
        }
      } else if (!thin.includes(job)) {
        expect(scheduled, job).toBe(false);
      }
    }
  }
});
