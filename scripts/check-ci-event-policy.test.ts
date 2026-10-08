import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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

test("every real workflow job has an event policy and the fast gate follows it", () => {
  expect(checkCiEventPolicies({ workflows, policy })).toEqual([]);
});

test("Postgres PR opt-in cannot lose its disabled-by-default switch", () => {
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
