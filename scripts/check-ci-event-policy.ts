import { readFileSync, readdirSync } from "node:fs";
import * as v from "valibot";

import { definitelyFalse, evaluate } from "./github-expression";

const policySchema = v.object({
  jobs: v.record(
    v.string(),
    v.picklist([
      "pr-fast",
      "queue",
      "main",
      "schema-pr",
      "pr-opt-in",
      "release-pr",
    ]),
  ),
  periodicJobs: v.optional(v.array(v.string()), []),
  pushMain: v.optional(
    v.record(
      v.string(),
      v.object({
        role: v.picklist(["analysis", "publish"]),
        cancelInProgress: v.boolean(),
      }),
    ),
    {},
  ),
});
export const workflowSchema = v.looseObject({
  on: v.record(v.string(), v.unknown()),
  permissions: v.optional(v.unknown()),
  concurrency: v.optional(
    v.object({
      group: v.string(),
      "cancel-in-progress": v.union([v.boolean(), v.string()]),
    }),
  ),
  jobs: v.record(
    v.string(),
    v.looseObject({
      permissions: v.optional(v.unknown()),
      if: v.optional(v.union([v.string(), v.boolean()])),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      steps: v.optional(
        v.array(
          v.looseObject({
            env: v.optional(v.record(v.string(), v.unknown())),
          }),
        ),
      ),
    }),
  ),
});

const pushesMain = (trigger: unknown) => {
  if (trigger === undefined) {
    return false;
  }
  const push = v.parse(
    v.nullable(
      v.looseObject({
        branches: v.optional(v.array(v.string())),
        "branches-ignore": v.optional(v.array(v.string())),
        tags: v.optional(v.array(v.string())),
      }),
    ),
    trigger,
  );
  if (push === null) {
    return true;
  }
  if (push.tags && !push.branches) {
    return false;
  }
  if (
    push["branches-ignore"]?.some((pattern) =>
      new Bun.Glob(pattern).match("main"),
    )
  ) {
    return false;
  }
  return (
    !push.branches ||
    push.branches.some((pattern) => new Bun.Glob(pattern).match("main"))
  );
};

const publishesWithToken = (permissions: unknown) => {
  if (typeof permissions === "string") {
    return permissions === "write-all";
  }
  const parsed = v.safeParse(v.record(v.string(), v.unknown()), permissions);
  return (
    parsed.success &&
    ["contents", "packages"].some((name) => parsed.output[name] === "write")
  );
};

type CheckMainConcurrencyOptions = {
  file: string;
  workflow: v.InferOutput<typeof workflowSchema>;
  concurrencyPolicy:
    | v.InferOutput<typeof policySchema>["pushMain"][string]
    | undefined;
};

const checkMainConcurrency = ({
  file,
  workflow,
  concurrencyPolicy,
}: CheckMainConcurrencyOptions) => {
  const problems: string[] = [];
  if (concurrencyPolicy === undefined) {
    problems.push(`${file}: missing main-push concurrency policy`);
  }
  if (workflow.concurrency === undefined) {
    problems.push(`${file}: main push needs a concurrency group`);
  } else {
    if (
      workflow.concurrency.group.replaceAll(
        /\$\{\{(.*?)\}\}/gu,
        (_, expression: string) => {
          const fragment = evaluate(expression, {
            values: {
              "github.event_name": "push",
              "github.ref": "refs/heads/main",
              "github.workflow": "Workflow",
            },
          });
          if (typeof fragment !== "string") {
            problems.push(
              `${file}: main push group expression must resolve to a string`,
            );
            return "";
          }
          return fragment;
        },
      ) !==
      (file === "ci.yml"
        ? "Workflow-ci-refs/heads/main"
        : "Workflow-refs/heads/main")
    ) {
      problems.push(
        `${file}: main push group must identify workflow and branch`,
      );
    }
    const rawCancel = workflow.concurrency["cancel-in-progress"];
    const cancel =
      typeof rawCancel === "boolean"
        ? rawCancel
        : evaluate(rawCancel, {
            values: {
              "github.event_name": "push",
              "github.ref": "refs/heads/main",
              "github.event.head_commit.message": "fix: ordinary change",
              "inputs.sha": "",
            },
          });
    if (
      concurrencyPolicy !== undefined &&
      cancel !== concurrencyPolicy.cancelInProgress
    ) {
      problems.push(`${file}: main push cancellation differs from its policy`);
    }
    const publishing =
      concurrencyPolicy?.role === "publish" ||
      Object.values(workflow.jobs).some((job) =>
        publishesWithToken(job.permissions ?? workflow.permissions),
      );
    if (publishing && cancel !== false) {
      problems.push(
        `${file}: publishing or deployment must finish its running job`,
      );
    }
  }
  return problems;
};

const checkCodeqlEventPolicy = (condition: string) => {
  const problems: string[] = [];
  for (const event of ["pull_request", "workflow_dispatch", "schedule"]) {
    for (const branch of [
      "feature/example",
      "chore/release-0.1",
      "changeset-release/main",
    ]) {
      for (const draft of [false, true]) {
        const expected =
          event !== "pull_request" || (!draft && branch !== "feature/example");
        const actual = evaluate(condition, {
          values: {
            "github.event_name": event,
            "github.event.pull_request.draft": draft,
            "github.event.pull_request.head.ref": branch,
          },
        });
        if (actual !== expected) {
          problems.push(
            `codeql.yml: ${event}/${branch}/${draft} differs from nightly/manual/release policy`,
          );
        }
      }
    }
  }
  return problems;
};

type CheckJobEventPolicyOptions = {
  key: string;
  file: string;
  job: v.InferOutput<typeof workflowSchema>["jobs"][string];
  eventPolicy: v.InferOutput<typeof policySchema>["jobs"][string];
  triggers: v.InferOutput<typeof workflowSchema>["on"];
  periodic: boolean;
};

const checkJobEventPolicy = ({
  key,
  file,
  job,
  eventPolicy,
  triggers,
  periodic,
}: CheckJobEventPolicyOptions) => {
  const problems: string[] = [];
  if (file === "codeql.yml" && eventPolicy !== "release-pr") {
    return [`${key}: CodeQL jobs must declare nightly/manual/release policy`];
  }
  if (eventPolicy === "release-pr") {
    if (file !== "codeql.yml") {
      return [`${key}: nightly/manual/release policy belongs to CodeQL`];
    }
    return [];
  }
  if (eventPolicy === "pr-opt-in") {
    const condition =
      typeof job.if === "boolean" ? String(job.if) : (job.if ?? "true");
    if (key === "ci.yml/service-suites") {
      if (
        !condition.includes("vars.CI_POSTGRES_PR_SELECTION == 'on'") ||
        ["", "off"].some(
          (value) =>
            !definitelyFalse(condition, {
              values: {
                "github.event_name": "pull_request",
                "vars.CI_POSTGRES_PR_SELECTION": value,
              },
            }),
        )
      ) {
        problems.push(
          `${key}: Postgres PR suites must require the disabled-by-default switch`,
        );
      }
      return problems;
    }
    if (
      key !== "ci.yml/fix-tests-on-base" ||
      !condition.includes(
        "contains(github.event.pull_request.labels.*.name, 'prove-fix')",
      ) ||
      !definitelyFalse(condition, {
        values: {
          "github.event_name": "pull_request",
          "github.event.pull_request.labels.*.name": [],
        },
      })
    ) {
      problems.push(`${key}: advisory proof must require the prove-fix label`);
    }
    return problems;
  }
  if (eventPolicy === "schema-pr" && file !== "db-migrations.yml") {
    problems.push(`${key}: schema policy belongs to Database Migrations`);
  }
  if (periodic) {
    const condition =
      typeof job.if === "boolean" ? String(job.if) : (job.if ?? "true");
    const scopeValues = Object.fromEntries(
      Array.from(
        condition.matchAll(/needs\.ci-plan\.outputs\.(\w+_required)/gu),
        (match) => [match[0], "true"],
      ),
    );
    if (
      evaluate(condition, {
        values: {
          ...scopeValues,
          "github.event_name": "schedule",
          "github.ref": "refs/heads/main",
          "github.event.head_commit.message": "ordinary main change",
          "inputs.heavy_only": true,
          "inputs.pr_depth_only": false,
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.queue_depth": "full",
          "needs.ci-plan.outputs.trusted": "true",
        },
      }) !== true
    ) {
      problems.push(
        `${key}: release-periodic job must run on non-release scheduled main`,
      );
    }
  }
  if (eventPolicy !== "queue" && eventPolicy !== "main") {
    return problems;
  }
  for (const event of ["pull_request", "pull_request_target"]) {
    if (!Object.hasOwn(triggers, event)) {
      continue;
    }
    const condition =
      typeof job.if === "boolean" ? String(job.if) : (job.if ?? "true");
    if (
      !definitelyFalse(condition, {
        values: { "github.event_name": event },
      })
    ) {
      problems.push(`${key}: ${eventPolicy} job can run on ${event}`);
    }
  }
  return problems;
};

const checkCodeqlWorkflow = (
  workflow: v.InferOutput<typeof workflowSchema>,
) => {
  const problems: string[] = [];
  const triggers = Object.keys(workflow.on);
  if (
    triggers.length !== 3 ||
    !triggers.includes("schedule") ||
    !triggers.includes("pull_request") ||
    !triggers.includes("workflow_dispatch")
  ) {
    problems.push(
      "codeql.yml: triggers must be nightly, manual and pull_request only",
    );
  }
  const scope = workflow.jobs["scope"];
  const analyze = workflow.jobs["analyze"];
  problems.push(
    ...checkCodeqlEventPolicy(
      typeof scope?.if === "string" ? scope.if : "true",
    ),
  );
  if (
    analyze?.needs !== "scope" ||
    typeof analyze.if !== "string" ||
    !definitelyFalse(analyze.if, {
      values: { "needs.scope.result": "skipped" },
    })
  ) {
    problems.push("codeql.yml: analysis must depend on eligible scope");
  }
  if (workflow.concurrency === undefined) {
    problems.push("codeql.yml: scans need a concurrency group");
  }
  return problems;
};

type CheckCiEventPoliciesOptions = {
  workflows: Record<string, unknown>;
  policy: unknown;
};

export const checkCiEventPolicies = ({
  workflows,
  policy,
}: CheckCiEventPoliciesOptions) => {
  const declared = v.parse(policySchema, policy);
  const seen = new Set<string>();
  const mainWorkflows = new Set<string>();
  const problems: string[] = [];
  for (const [file, raw] of Object.entries(workflows)) {
    const workflow = v.parse(workflowSchema, raw);
    if (file === "codeql.yml") {
      problems.push(...checkCodeqlWorkflow(workflow));
    }
    if (
      pushesMain(workflow.on["push"]) ||
      (file === "ci.yml" && Object.hasOwn(workflow.on, "workflow_call"))
    ) {
      mainWorkflows.add(file);
      problems.push(
        ...checkMainConcurrency({
          file,
          workflow,
          concurrencyPolicy: declared.pushMain[file],
        }),
      );
    }
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const key = `${file}/${id}`;
      seen.add(key);
      const eventPolicy = declared.jobs[key];
      if (eventPolicy === undefined) {
        problems.push(`${key}: missing event policy`);
        continue;
      }
      problems.push(
        ...checkJobEventPolicy({
          key,
          file,
          job,
          eventPolicy,
          triggers: workflow.on,
          periodic: declared.periodicJobs.includes(key),
        }),
      );
    }
    if (file !== "ci.yml") {
      continue;
    }
    const result = workflow.jobs["ci-result"];
    const env = result?.steps?.find((step) =>
      Object.hasOwn(step.env ?? {}, "FAST_REQUIRED"),
    )?.env;
    const actual = v.parse(
      v.array(v.string()),
      JSON.parse(v.parse(v.string(), env?.["FAST_REQUIRED"])),
    );
    const needs = v.parse(v.array(v.string()), result?.needs);
    const expected = needs.filter(
      (id) => id !== "ci-plan" && declared.jobs[`${file}/${id}`] === "pr-fast",
    );
    if (
      actual.length !== expected.length ||
      new Set(actual).size !== actual.length ||
      actual.some((id) => !expected.includes(id))
    ) {
      problems.push("ci.yml: FAST_REQUIRED must equal declared PR checks");
    }
  }
  for (const file of Object.keys(declared.pushMain)) {
    if (!mainWorkflows.has(file)) {
      problems.push(`${file}: stale main-push concurrency policy`);
    }
  }
  for (const key of declared.periodicJobs) {
    if (!seen.has(key)) {
      problems.push(`${key}: stale periodic job`);
    }
  }
  for (const key of Object.keys(declared.jobs)) {
    if (!seen.has(key)) {
      problems.push(`${key}: stale event policy`);
    }
  }
  return problems;
};

if (import.meta.main) {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = Object.fromEntries(
    readdirSync(directory)
      .filter((file) => /\.ya?ml$/u.test(file))
      .map((file) => [
        file,
        Bun.YAML.parse(readFileSync(new URL(file, directory), "utf-8")),
      ]),
  );
  const problems = checkCiEventPolicies({
    workflows,
    policy: JSON.parse(
      readFileSync(
        new URL("../.github/ci-event-policy.json", import.meta.url),
        "utf-8",
      ),
    ),
  });
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  }
}
