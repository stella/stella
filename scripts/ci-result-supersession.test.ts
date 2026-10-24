import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { renderResultInputs } from "./ci-result-inputs";

// ci-result's outcome step, run as CI runs it, against a GitHub API served
// from fixtures: a run whose required jobs were all cancelled is green only
// when a newer code run superseded it, and then only as a pass-through; a
// metadata run mirrors only a code run's evaluated success.

const root = new URL("../", import.meta.url).pathname;
const workflow = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        needs: v.optional(v.union([v.string(), v.array(v.string())])),
        steps: v.optional(
          v.array(
            v.looseObject({
              name: v.optional(v.string()),
              run: v.optional(v.string()),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        ),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  ),
);
const result = workflow.jobs["ci-result"];
const outcome = result?.steps?.find(
  ({ name }) => name === "Evaluate CI outcome",
);
if (!outcome?.run || !outcome.env || !Array.isArray(result?.needs)) {
  panic("Missing ci-result/Evaluate CI outcome");
}
const needs = result.needs;
const script = outcome.run;
const staticEnv = Object.fromEntries(
  Object.entries(outcome.env).filter(([, value]) => !value.includes("${{")),
);
const fastRequired = v.parse(
  v.array(v.string()),
  JSON.parse(staticEnv["FAST_REQUIRED"] ?? ""),
);

const REPO = "stella/stella";
const PR = 6634;
const HEAD = "a".repeat(40);
const RUN = 100;
const WORKFLOW_ID = 7;
const CREATED = "2026-10-23T06:28:05Z";
const checkRun = (id: number) =>
  `https://api.github.com/repos/${REPO}/check-runs/${id}`;

// Answers `gh-retry.sh api ... <endpoint>` and `gh-retry.sh run download`
// from a fixture map; any request without a fixture fails, as the API would.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == run && "$2" == download ]]; then
  run=$3
  shift 3
  dir=""
  while (($#)); do
    case "$1" in
      -D) dir=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  body=$(jq -ce --arg key "record:$run" '.[$key]' "$FIXTURES") || exit 1
  printf '%s\\n' "$body" > "$dir/ci-required-summary.json"
  exit 0
fi
endpoint=""
for arg in "$@"; do
  case "$arg" in
    api | --paginate | --slurp) ;;
    *) endpoint=$arg ;;
  esac
done
printf '%s\\n' "$endpoint" >> "$FIXTURES.requests"
# A {"sequence": [...]} fixture answers its nth request with its nth entry
# (the last one from then on).
count=$(grep -cxF -- "$endpoint" "$FIXTURES.requests")
jq -ce --arg key "$endpoint" --argjson n "$count" '.[$key]
  | if type == "object" and has("sequence")
    then .sequence[([$n, (.sequence | length)] | min) - 1] else . end' "$FIXTURES" || {
  echo "unexpected request: $endpoint" >&2
  exit 1
}
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const recordSchema = v.looseObject({
  basis: v.string(),
  pass_through_reason: v.nullable(v.string()),
  reused_from_run_id: v.nullable(v.number()),
  verdict: v.string(),
});

type Fixtures = Record<string, unknown>;
const runOutcome = (env: Record<string, string>, fixtures: Fixtures) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-result-"));
  directories.push(directory);
  const gh = path.join(directory, "gh-retry.sh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const fixtureFile = path.join(directory, "fixtures.json");
  writeFileSync(fixtureFile, JSON.stringify(fixtures));
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  // Job results and plan outputs reach the outcome script as the inputs step
  // writes them, never through the environment.
  const rendered = renderResultInputs(script, {
    needs: env["NEEDS"] ?? "{}",
    plan: env["PLAN"] ?? "{}",
  });
  // A mirror that waits would poll for 90 minutes: fail fast instead.
  const child = Bun.spawnSync(
    ["bash", "-e", "-o", "pipefail", "-c", rendered],
    {
      timeout: 60_000,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: directory,
        GITHUB_WORKFLOW: "CI Checks",
        TMPDIR: directory,
        ...staticEnv,
        EVENT: "pull_request",
        PR_NUMBER: String(PR),
        REPO,
        HEAD_SHA: HEAD,
        BASE_SHA: "b".repeat(40),
        GITHUB_RUN_ID: String(RUN),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
        GH_RETRY_SCRIPT: gh,
        FIXTURES: fixtureFile,
        PLAN: "{}",
        PLAN_RESULT: "success",
        RUN_REQUIRED: "true",
        TRUSTED: "true",
        SUITE_DEPTH: "fast",
        QUEUE_DEPTH: "full",
        QUEUE_VALIDATION: "false",
        METADATA_ONLY: "false",
        PR_ACTION: "synchronize",
        PR_HEAVY_SUITES: "run",
        COVERAGE_PROFILE: "normal-v1",
        HEAVY_ONLY: "false",
        PR_DEPTH_ONLY: "false",
        ...env,
      },
    },
  );
  const line = readFileSync(output, "utf-8")
    .split("\n")
    .find((entry) => entry.startsWith("required_summary="));
  return {
    exitCode: child.exitCode,
    log: child.stdout.toString() + child.stderr.toString(),
    record: line
      ? v.parse(
          recordSchema,
          JSON.parse(line.slice("required_summary=".length)),
        )
      : undefined,
  };
};

// Every required job cancelled, every other job skipped.
const cancelledNeeds = JSON.stringify(
  Object.fromEntries([
    ...needs.map((job) => [
      job,
      { result: fastRequired.includes(job) ? "cancelled" : "skipped" },
    ]),
    ["ci-plan", { result: "success" }],
  ]),
);

type NewerRun = { status: string; jobs: string[] };
const supersessionFixtures = ({
  annotation,
  newer,
}: {
  annotation: string;
  newer: NewerRun[];
}): Fixtures => {
  const fixtures: Fixtures = {
    [`repos/${REPO}/actions/runs/${RUN}/attempts/1/jobs?per_page=100`]: [
      {
        jobs: fastRequired.map((name, index) => ({
          name,
          conclusion: "cancelled",
          check_run_url: checkRun(1000 + index),
          html_url: "",
          steps: [],
        })),
      },
    ],
    [`repos/${REPO}/actions/runs/${RUN}`]: {
      id: RUN,
      run_number: 10,
      workflow_id: WORKFLOW_ID,
      name: "CI Checks",
      event: "pull_request",
      created_at: CREATED,
    },
    [`repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&created=%3E%3D${encodeURIComponent(CREATED)}&per_page=100`]:
      [
        {
          workflow_runs: newer.map(({ status }, index) => ({
            id: RUN + 1 + index,
            run_number: 11 + index,
            workflow_id: WORKFLOW_ID,
            name: "CI Checks",
            event: "pull_request",
            status,
            created_at: "2026-10-23T06:28:09Z",
            pull_requests: [{ number: PR }],
          })),
        },
      ],
  };
  for (const index of fastRequired.keys()) {
    fixtures[`${checkRun(1000 + index)}/annotations?per_page=100`] = [
      index === 0 && annotation !== "" ? [{ message: annotation }] : [],
    ];
  }
  for (const [index, { jobs }] of newer.entries()) {
    fixtures[
      `repos/${REPO}/actions/runs/${RUN + 1 + index}/jobs?per_page=100`
    ] = [{ jobs: jobs.map((name) => ({ name })) }];
  }
  return fixtures;
};

const YIELD = "The run was canceled by @ci-operator.";
const CONCURRENCY = `Canceling since a higher priority waiting request for CI Checks-pr-${PR} exists`;
const metadataRun = { status: "in_progress", jobs: ["ci-metadata-plan"] };
const codeRun = { status: "in_progress", jobs: ["ci-plan"] };

test("a run cancelled by an actor, with only a metadata run after it, is not green", () => {
  const run = runOutcome(
    { NEEDS: cancelledNeeds },
    supersessionFixtures({ annotation: YIELD, newer: [metadataRun] }),
  );
  expect(run.exitCode, run.log).toBe(1);
  expect(run.log).toContain("cancelled by @ci-operator");
  expect(run.record?.verdict).toBe("failure");
});

test("a metadata run never supersedes a code run", () => {
  const run = runOutcome(
    { NEEDS: cancelledNeeds },
    supersessionFixtures({ annotation: "", newer: [metadataRun] }),
  );
  expect(run.exitCode, run.log).toBe(1);
  expect(run.record?.verdict).toBe("failure");
});

test("an actor cancel is never supersession, even with a newer code run", () => {
  const run = runOutcome(
    { NEEDS: cancelledNeeds },
    supersessionFixtures({ annotation: YIELD, newer: [codeRun] }),
  );
  expect(run.exitCode, run.log).toBe(1);
});

// Still waiting on a concurrency group: a metadata run can wait on its own.
const waitingRun = { status: "pending", jobs: [] };

test("a newer run that lists no job yet proves no supersession", () => {
  const run = runOutcome(
    { NEEDS: cancelledNeeds },
    supersessionFixtures({ annotation: "", newer: [waitingRun] }),
  );
  expect(run.exitCode, run.log).toBe(1);
  expect(run.record?.verdict).toBe("failure");
});

test("a run superseded by a newer code run passes through without an evaluated verdict", () => {
  for (const proof of [
    // cancel-in-progress named this run's code concurrency group.
    { annotation: CONCURRENCY, newer: [metadataRun, waitingRun] },
    // Queued jobs carry no annotation; the newer run planned as a code run.
    { annotation: "", newer: [metadataRun, codeRun] },
  ]) {
    const run = runOutcome(
      { NEEDS: cancelledNeeds },
      supersessionFixtures(proof),
    );
    expect(run.exitCode, run.log).toBe(0);
    expect(run.record).toMatchObject({
      basis: "pass_through",
      pass_through_reason: "superseded",
      verdict: "success",
    });
  }
});

type CodeRun = {
  id: number;
  record?: unknown;
  attempt?: number;
  status?: string;
};
const codeRunJobs = (id: number, attempt: number): Fixtures => ({
  [`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`]: [
    {
      jobs: [
        { name: "ci-plan", id: id * 10 },
        // The conclusion a pass-through run reports: never evidence.
        {
          name: "ci-result",
          id: id * 10 + 1,
          status: "completed",
          conclusion: "success",
          run_attempt: attempt,
        },
      ],
    },
  ],
});
const mirrorFixtures = (runs: CodeRun[], extra: Fixtures = {}): Fixtures => {
  const fixtures: Fixtures = {
    [`repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100`]:
      [
        {
          workflow_runs: runs.map(({ id, status = "completed" }) => ({
            id,
            run_number: id,
            head_sha: HEAD,
            status,
            pull_requests: [{ number: PR }],
          })),
        },
      ],
    ...extra,
  };
  for (const { id, record, attempt = 1 } of runs) {
    Object.assign(fixtures, codeRunJobs(id, attempt));
    if (record !== undefined) {
      fixtures[`record:${id}`] = record;
    }
  }
  return fixtures;
};
const record = (
  id: number,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  version: 1,
  event: "pull_request",
  head_sha: HEAD,
  run_id: id,
  run_attempt: 1,
  basis: "evaluated",
  pass_through_reason: null,
  reused_from_run_id: null,
  required: fastRequired.map((job) => ({ job, conclusion: "success" })),
  verdict: "success",
  ...fields,
});
const superseded = (id: number) =>
  record(id, {
    basis: "pass_through",
    pass_through_reason: "superseded",
    required: fastRequired.map((job) => ({ job, conclusion: "cancelled" })),
  });
const mirror = (fixtures: Fixtures) =>
  runOutcome(
    {
      METADATA_ONLY: "true",
      PR_ACTION: "labeled",
      // A mirror skips every suite.
      NEEDS: JSON.stringify(
        Object.fromEntries([
          ...needs.map((job) => [job, { result: "skipped" }]),
          ["ci-plan", { result: "success" }],
        ]),
      ),
    },
    fixtures,
  );

test("a metadata run mirrors a code run's evaluated success", () => {
  const run = mirror(mirrorFixtures([{ id: 90, record: record(90) }]));
  expect(run.exitCode, run.log).toBe(0);
  expect(run.record).toMatchObject({
    basis: "pass_through",
    pass_through_reason: "metadata",
    reused_from_run_id: 90,
  });
});

test("a metadata run never waits on a newer run of its head", () => {
  // A newer metadata run waits on this run's concurrency group, listing no
  // job yet: waiting on it would deadlock until the deadline.
  const run = mirror(
    mirrorFixtures([
      { id: RUN + 50, status: "pending" },
      { id: 90, record: record(90) },
    ]),
  );
  expect(run.exitCode, run.log).toBe(0);
  expect(run.record?.reused_from_run_id).toBe(90);
});

test("a metadata run never mirrors a code run that passed through", () => {
  const run = mirror(mirrorFixtures([{ id: 90, record: superseded(90) }]));
  expect(run.exitCode, run.log).toBe(1);
  expect(run.log).toContain("Re-run CI run 90");
});

test("an older code run that evaluated the head still counts", () => {
  const run = mirror(
    mirrorFixtures([
      { id: 91, record: superseded(91) },
      { id: 90, record: record(90) },
    ]),
  );
  expect(run.exitCode, run.log).toBe(0);
  expect(run.record?.reused_from_run_id).toBe(90);
});

const reusing = (sourceAttempt: number) =>
  mirrorFixtures(
    [
      {
        id: 91,
        record: record(91, {
          basis: "pass_through",
          pass_through_reason: "reused",
          reused_from_run_id: 80,
          required: [],
        }),
      },
    ],
    { "record:80": record(80), ...codeRunJobs(80, sourceAttempt) },
  );

test("a reused record is followed to the run that evaluated the head", () => {
  const run = mirror(reusing(1));
  expect(run.exitCode, run.log).toBe(0);
  expect(run.record?.reused_from_run_id).toBe(80);
});

test("a reused run re-run since its record was written is no evidence", () => {
  const run = mirror(reusing(2));
  expect(run.exitCode, run.log).toBe(1);
  expect(run.log).toContain("not from its latest attempt (2)");
});

test("no record, a stale attempt, another head or a cancelled required job is no evidence", () => {
  for (const runs of [
    [{ id: 90 }],
    [{ id: 90, record: record(90), attempt: 2 }],
    [{ id: 90, record: record(90, { head_sha: "c".repeat(40) }) }],
    [
      {
        id: 90,
        record: record(90, {
          required: [
            ...fastRequired
              .slice(1)
              .map((job) => ({ job, conclusion: "success" })),
            { job: fastRequired[0], conclusion: "cancelled" },
          ],
        }),
      },
    ],
  ]) {
    const run = mirror(mirrorFixtures(runs));
    expect(run.exitCode, JSON.stringify(runs) + run.log).toBe(1);
    expect(run.record?.verdict).toBe("failure");
  }
});

// The pass-through reasons merge-bar accepts in a required-jobs record
// (stella-ops merge-bar-v2/src/summary.rs, `PassThroughReason`); it refuses
// any other value, so every reason the step writes must be one of these.
const MERGE_BAR_PASS_THROUGH_REASONS = [
  "draft",
  "enqueued",
  "metadata",
  "reused",
  "superseded",
];

test("every pass-through reason the step writes is one merge-bar reads", () => {
  const written = [
    ...new Set(
      [...script.matchAll(/\bpass_through_reason=([a-z-]*)/gu)]
        .map((match) => match[1] ?? "")
        .filter((reason) => reason !== ""),
    ),
  ].toSorted();
  expect(written).toEqual(MERGE_BAR_PASS_THROUGH_REASONS);
});
