import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as v from "valibot";

import { checkCiEventPolicies, workflowSchema } from "./check-ci-event-policy";

const directory = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(directory)
    .filter((file) => /\.ya?ml$/u.test(file))
    .map((file) => [
      file,
      Bun.YAML.parse(readFileSync(new URL(file, directory), "utf-8")),
    ]),
);
const policy = JSON.parse(
  readFileSync(
    new URL("../.github/ci-event-policy.json", import.meta.url),
    "utf-8",
  ),
);

test("compiler parity and seeded probes require dispatch-only policy in every workflow", () => {
  for (const command of [
    "bun run check:typecheck-parity",
    "bun scripts/typecheck-parity.ts",
    "bunx --no-install stll-typecheck-parity --project=tsconfig.json",
    "bash scripts/typecheck-command-probe.sh",
    "probe=packages/sha256/src/typecheck-command-probe.ts",
  ]) {
    const workflow = {
      on: { workflow_dispatch: {} },
      jobs: { proof: { steps: [{ run: command }] } },
    };
    expect(
      checkCiEventPolicies({
        workflows: { "fixture.yml": workflow },
        policy: { jobs: { "fixture.yml/proof": "main" } },
      }),
    ).toContain(
      "fixture.yml/proof: compiler parity and probes require dispatch-only policy",
    );
    expect(
      checkCiEventPolicies({
        workflows: {
          "fixture.yml": {
            ...workflow,
            jobs: { proof: { steps: [{ parallel: [{ run: command }] }] } },
          },
        },
        policy: { jobs: { "fixture.yml/proof": "main" } },
      }),
    ).toContain(
      "fixture.yml/proof: compiler parity and probes require dispatch-only policy",
    );
    const declared = { jobs: { "fixture.yml/proof": "dispatch-only" } };
    expect(
      checkCiEventPolicies({
        workflows: { "fixture.yml": workflow },
        policy: declared,
      }),
    ).toEqual([]);
    for (const event of [
      "schedule",
      "push",
      "pull_request",
      "pull_request_target",
      "merge_group",
      "workflow_call",
      "workflow_run",
      "repository_dispatch",
    ]) {
      expect(
        checkCiEventPolicies({
          workflows: {
            "fixture.yml": { ...workflow, on: { ...workflow.on, [event]: {} } },
          },
          policy: declared,
        }),
      ).toContain(
        "fixture.yml/proof: dispatch-only jobs require workflow_dispatch as the only trigger",
      );
    }
  }
});

test("moving compiler proofs into an automatic workflow fails the real policy census", () => {
  for (const file of ["ci.yml", "nightly-typecheck.yml"]) {
    const workflow = v.parse(workflowSchema, structuredClone(workflows[file]));
    const job = Object.values(workflow.jobs).find(
      (candidate) => candidate.steps,
    );
    if (!job?.steps) {
      panic("Missing workflow steps fixture");
    }
    for (const command of [
      "bun run check:typecheck-parity",
      "bash scripts/typecheck-command-probe.sh",
    ]) {
      job.steps.push({ run: command });
      expect(
        checkCiEventPolicies({
          workflows: { ...workflows, [file]: workflow },
          policy,
        }),
      ).toContainEqual(
        expect.stringContaining(
          "compiler parity and probes require dispatch-only policy",
        ),
      );
      job.steps.pop();
    }
  }
});

test("every real workflow job has an event policy and the fast gate follows it", () => {
  expect(checkCiEventPolicies({ workflows, policy })).toEqual([]);
});

test("duplicate raw event-policy job keys fail before JSON key collapse", () => {
  const source =
    '{"jobs":{"fixture.yml/job":"pr-fast","fixture.yml/job":"main"}}';
  const parsed: unknown = JSON.parse(source);
  expect(parsed).toEqual({ jobs: { "fixture.yml/job": "main" } });
  expect(
    checkCiEventPolicies({
      workflows: {},
      policy: parsed,
      policySource: source,
    }),
  ).toContain("CI event policy has duplicate job key: fixture.yml/job");
});

test("Postgres-only PR suites cannot lose their disabled-by-default switch", () => {
  const workflow = v.parse(
    workflowSchema,
    structuredClone(workflows["ci.yml"]),
  );
  const service = workflow.jobs["service-suites"];
  if (service === undefined || typeof service.if !== "string") {
    panic("Missing service-suite switch fixture");
  }
  const original = service.if;
  expect(original).toContain("vars.CI_POSTGRES_PR_SELECTION == 'on'");
  for (const replacement of [
    "true",
    "vars.CI_POSTGRES_PR_SELECTION != 'off'",
  ]) {
    service.if = original.replace(
      "vars.CI_POSTGRES_PR_SELECTION == 'on'",
      () => replacement,
    );
    expect(service.if).not.toBe(original);
    expect(
      checkCiEventPolicies({
        workflows: { ...workflows, "ci.yml": workflow },
        policy,
      }),
    ).toContain(
      "ci.yml/service-suites: Postgres PR suites must require the disabled-by-default switch",
    );
  }
});

test("Postgres shard eligibility cannot bypass the disabled-by-default PR switch", () => {
  for (const replacement of [
    "true",
    "vars.CI_POSTGRES_PR_SELECTION != 'off'",
  ]) {
    const workflow = v.parse(
      workflowSchema,
      structuredClone(workflows["ci.yml"]),
    );
    const outputs = workflow.jobs["ci-plan"]?.outputs;
    const original = outputs?.["postgres_service_suites_required"];
    if (!outputs || !original) {
      panic("Missing Postgres eligibility fixture");
    }
    outputs["postgres_service_suites_required"] = original.replace(
      "vars.CI_POSTGRES_PR_SELECTION == 'on'",
      () => replacement,
    );
    expect(outputs["postgres_service_suites_required"]).not.toBe(original);
    expect(
      checkCiEventPolicies({
        workflows: { ...workflows, "ci.yml": workflow },
        policy,
      }),
    ).toContain(
      "ci.yml/postgres-service-suites: Postgres PR suites must require the disabled-by-default switch",
    );
  }
});

test("repeating a fast check cannot replace another declared check", () => {
  const workflow = structuredClone(workflows["ci.yml"]);
  const parsed = v.parse(workflowSchema, workflow);
  const gate = parsed.jobs["ci-result"]?.steps?.find(
    (step) => step.env?.["FAST_REQUIRED"],
  );
  if (!gate?.env) {
    panic("Missing fast-required fixture");
  }
  const required = v.parse(
    v.array(v.string()),
    JSON.parse(v.parse(v.string(), gate.env["FAST_REQUIRED"])),
  );
  expect(required.length).toBeGreaterThan(1);
  const first = required.at(0);
  if (first === undefined) {
    panic("Missing first fast-required fixture");
  }
  gate.env["FAST_REQUIRED"] = JSON.stringify(
    required.map((id, index) => (index === 1 ? first : id)),
  );
  expect(
    checkCiEventPolicies({
      workflows: { ...workflows, "ci.yml": parsed },
      policy,
    }),
  ).toContain("ci.yml: FAST_REQUIRED must equal declared PR checks");
});

test("new heavy jobs require a policy that excludes every pull request", () => {
  const workflow = {
    on: { pull_request: {}, merge_group: {} },
    jobs: { image: { if: "true", services: { postgres: {} } } },
  };
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: { jobs: {} },
    }),
  ).toEqual(["fixture.yml/image: missing event policy"]);
  const declared = { jobs: { "fixture.yml/image": "queue" } };
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: declared,
    }),
  ).toEqual(["fixture.yml/image: queue job can run on pull_request"]);
  workflow.jobs.image.if =
    "github.event_name != 'pull_request' && needs.plan.outputs.required == 'true'";
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: declared,
    }),
  ).toEqual([]);
  workflow.jobs.image.if += " || always()";
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: declared,
    }),
  ).toEqual(["fixture.yml/image: queue job can run on pull_request"]);
});

test("removed jobs cannot leave an event policy behind", () => {
  expect(
    checkCiEventPolicies({
      workflows: {},
      policy: {
        jobs: { "old.yml/image": "queue" },
      },
    }),
  ).toEqual(["old.yml/image: stale event policy"]);
});

test("main-push workflows require a group and publishing never cancels a running job", () => {
  const workflow = {
    on: { push: { branches: ["main"] } },
    jobs: { publish: { permissions: { contents: "write" } } },
  };
  const declared = {
    jobs: { "fixture.yml/publish": "main" },
    pushMain: { "fixture.yml": { role: "publish", cancelInProgress: false } },
  };
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: declared,
    }),
  ).toContain("fixture.yml: main push needs a concurrency group");
  const concurrency = {
    group: `\${{ github.workflow }}-\${{ github.ref }}`,
    "cancel-in-progress": true,
  };
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": { ...workflow, concurrency } },
      policy: declared,
    }),
  ).toContain(
    "fixture.yml: publishing or deployment must finish its running job",
  );
  concurrency["cancel-in-progress"] = false;
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": { ...workflow, concurrency } },
      policy: declared,
    }),
  ).toEqual([]);
  for (const expression of ["false", "github.event", "github.unknown"]) {
    concurrency.group = `\${{ github.workflow }}-\${{ github.ref }}\${{ ${expression} }}`;
    expect(
      checkCiEventPolicies({
        workflows: { "fixture.yml": { ...workflow, concurrency } },
        policy: declared,
      }),
    ).toContain(
      "fixture.yml: main push group expression must resolve to a string",
    );
  }
});

test("analysis cancellation is pinned to main and tag-only workflows do not consume its policy", () => {
  const workflow = {
    on: { push: { branches: ["main"] } },
    jobs: { analyze: {} },
    concurrency: {
      group: `\${{ github.workflow }}-\${{ github.ref }}`,
      "cancel-in-progress": `\${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`,
    },
  };
  expect(
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: {
        jobs: { "fixture.yml/analyze": "main" },
        pushMain: {
          "fixture.yml": { role: "analysis", cancelInProgress: true },
        },
      },
    }),
  ).toEqual([]);
  expect(
    checkCiEventPolicies({
      workflows: {
        "fixture.yml": {
          on: { push: { tags: ["v*"] } },
          jobs: { publish: {} },
        },
      },
      policy: { jobs: { "fixture.yml/publish": "main" } },
    }),
  ).toEqual([]);
});

test("main push cancellation is evaluated for an ordinary commit, so a release-commit exemption keeps the policy true", () => {
  const workflow = {
    on: { push: { branches: ["main"] } },
    jobs: { analyze: {} },
    concurrency: {
      group: `\${{ github.workflow }}-\${{ github.ref }}`,
      "cancel-in-progress": `\${{ (github.event_name != 'workflow_dispatch' || !inputs.sha) && !startsWith(github.event.head_commit.message, 'chore: release v') }}`,
    },
  };
  const check = (cancelInProgress: boolean) =>
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: {
        jobs: { "fixture.yml/analyze": "main" },
        pushMain: { "fixture.yml": { role: "analysis", cancelInProgress } },
      },
    });
  expect(check(true)).toEqual([]);
  expect(check(false)).toEqual([
    "fixture.yml: main push cancellation differs from its policy",
  ]);
});

test("reusable CI main calls coalesce without cancelling their parent workflow", () => {
  const jobs = {
    "ci-result": { needs: [], steps: [{ env: { FAST_REQUIRED: "[]" } }] },
  };
  const declared = {
    jobs: { "ci.yml/ci-result": "pr-fast" },
    pushMain: { "ci.yml": { role: "analysis", cancelInProgress: true } },
  };
  const concurrency = {
    group: `\${{ github.workflow }}-\${{ github.ref }}`,
    "cancel-in-progress": true,
  };
  const workflow = { on: { workflow_call: {} }, jobs, concurrency };
  expect(
    checkCiEventPolicies({
      workflows: { "ci.yml": workflow },
      policy: declared,
    }),
  ).toContain("ci.yml: main push group must identify workflow and branch");
  concurrency.group = `\${{ github.workflow }}-ci-\${{ github.ref }}`;
  expect(
    checkCiEventPolicies({
      workflows: { "ci.yml": workflow },
      policy: declared,
    }),
  ).toEqual([]);
});

test("advisory fix evidence is an explicit label opt-in rather than an automatic PR suite", () => {
  const declared = {
    jobs: {
      "ci.yml/ci-result": "pr-fast",
      "ci.yml/fix-tests-on-base": "pr-opt-in",
    },
  };
  const proof = { if: "github.event_name == 'pull_request'" };
  const workflow = {
    on: { pull_request: {} },
    jobs: {
      "ci-result": {
        needs: ["fix-tests-on-base"],
        steps: [{ env: { FAST_REQUIRED: "[]" } }],
      },
      "fix-tests-on-base": proof,
    },
  };
  expect(
    checkCiEventPolicies({
      workflows: { "ci.yml": workflow },
      policy: declared,
    }),
  ).toContain(
    "ci.yml/fix-tests-on-base: advisory proof must require the prove-fix label",
  );
  proof.if +=
    " && contains(github.event.pull_request.labels.*.name, 'prove-fix')";
  expect(
    checkCiEventPolicies({
      workflows: { "ci.yml": workflow },
      policy: declared,
    }),
  ).toEqual([]);
});

test("the actual reusable CI main group is distinct from its caller and coalesces", () => {
  expect(
    checkCiEventPolicies({
      workflows: { "ci.yml": workflows["ci.yml"] },
      policy: {
        jobs: Object.fromEntries(
          Object.entries(policy.jobs).filter(([key]) =>
            key.startsWith("ci.yml/"),
          ),
        ),
        pushMain: { "ci.yml": policy.pushMain["ci.yml"] },
      },
    }),
  ).toEqual([]);
});

test("CodeQL accepts the main release policy and rejects ordinary PR scans", () => {
  const workflow = structuredClone(workflows["codeql.yml"]);
  const declared = {
    jobs: {
      "codeql.yml/scope": "release-pr",
      "codeql.yml/analyze": "release-pr",
    },
  };
  expect(
    checkCiEventPolicies({
      workflows: { "codeql.yml": workflow },
      policy: declared,
    }),
  ).toEqual([]);
  if (!v.is(workflowSchema, workflow)) {
    panic("CodeQL workflow does not match its owner schema");
  }
  const scope = workflow.jobs["scope"];
  if (scope === undefined) {
    panic("CodeQL scope job is missing");
  }
  scope.if = "true";
  expect(
    checkCiEventPolicies({
      workflows: { "codeql.yml": workflow },
      policy: declared,
    }),
  ).toContain(
    "codeql.yml: pull_request/feature/example/false differs from nightly/manual/release policy",
  );
});

test("release-periodic jobs also run on non-release schedules and stay off pull requests", () => {
  const declared = {
    jobs: { "fixture.yml/compiler": "queue" },
    periodicJobs: ["fixture.yml/compiler"],
  };
  const job = {
    if: "github.event_name != 'pull_request' && inputs.heavy_only == true && needs.ci-plan.outputs.compiler_required == 'true'",
  };
  const workflow = {
    on: { schedule: [], pull_request: {} },
    jobs: { compiler: job },
  };
  const check = () =>
    checkCiEventPolicies({
      workflows: { "fixture.yml": workflow },
      policy: declared,
    });
  expect(check()).toEqual([]);
  job.if += " && github.event_name != 'schedule'";
  expect(check()).toContain(
    "fixture.yml/compiler: release-periodic job must run on non-release scheduled main",
  );
  job.if = "true";
  expect(check()).toContain(
    "fixture.yml/compiler: queue job can run on pull_request",
  );
  declared.periodicJobs.push("fixture.yml/removed");
  expect(check()).toContain("fixture.yml/removed: stale periodic job");
});

const CHEAP_PULL_REQUEST_GATES = [
  "code-quality-api",
  "ci-quick-checks",
] as const;
const EXPENSIVE_PULL_REQUEST_JOBS = [
  "ci-tests",
  "ci-browser",
  "postgres-service-suites",
  "service-suites",
  "e2e-production-shard",
  "e2e-vite-canary",
  "e2e-landing",
  "e2e-report",
  "query-perf",
  "web-build",
  "route-smoke",
] as const;

const cheapGateProblems = (workflow: unknown) => {
  const parsed = v.parse(workflowSchema, workflow);
  return EXPENSIVE_PULL_REQUEST_JOBS.flatMap((name) => {
    const job = parsed.jobs[name];
    if (job === undefined) {
      return [`${name}: expected expensive job is missing`];
    }
    const needs = typeof job.needs === "string" ? [job.needs] : job.needs;
    const condition = typeof job.if === "string" ? job.if : "";
    return CHEAP_PULL_REQUEST_GATES.flatMap((gate) => [
      ...(needs?.includes(gate) === true
        ? []
        : [`${name}: needs must include ${gate}`]),
      ...(condition.includes(`needs.${gate}.result != 'failure'`)
        ? []
        : [`${name}: condition must tolerate a skipped ${gate}`]),
    ]);
  });
};

test("expensive pull request jobs wait for both cheap gates", () => {
  const workflow = structuredClone(workflows["ci.yml"]);
  expect(cheapGateProblems(workflow)).toEqual([]);

  const parsed = v.parse(workflowSchema, workflow);
  const job = parsed.jobs[EXPENSIVE_PULL_REQUEST_JOBS[0]];
  if (job === undefined || !Array.isArray(job.needs)) {
    panic("Missing expensive-job mutation fixture");
  }
  job.needs = job.needs.filter((need) => need !== CHEAP_PULL_REQUEST_GATES[0]);
  expect(cheapGateProblems(parsed)).toContain(
    "ci-tests: needs must include code-quality-api",
  );
});

test("ci-result keeps failed cheap gates strict when gated jobs skip", () => {
  const workflow = v.parse(
    workflowSchema,
    structuredClone(workflows["ci.yml"]),
  );
  const result = workflow.jobs["ci-result"];
  if (result === undefined) {
    panic("Missing ci-result fixture");
  }
  const needs =
    typeof result.needs === "string" ? [result.needs] : result.needs;
  for (const gate of CHEAP_PULL_REQUEST_GATES) {
    expect(needs).toContain(gate);
  }
  const outcome = result.steps?.find(
    (step) => step.name === "Evaluate CI outcome",
  );
  const fastRequired = JSON.parse(outcome?.env?.["FAST_REQUIRED"] ?? "null");
  expect(fastRequired).toEqual(
    expect.arrayContaining(["code-quality-api", "pr-heavy-gate"]),
  );
  expect(outcome?.run).toContain(
    'if $result == "success" then empty else "\\($job) (planned, \\($result))" end',
  );
  expect(outcome?.run).toContain(
    'select(.value.result as $r | ["success", "skipped", "cancelled"] | index($r) | not)',
  );
});
