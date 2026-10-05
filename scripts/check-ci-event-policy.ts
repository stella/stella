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
      "pending",
    ]),
  ),
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
  pending: v.record(
    v.string(),
    v.object({ owner: v.string(), reason: v.string() }),
  ),
});
const workflowSchema = v.looseObject({
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
        (_, expression: string) =>
          String(
            evaluate(expression, {
              values: {
                "github.event_name": "push",
                "github.ref": "refs/heads/main",
                "github.workflow": "Workflow",
              },
            }),
          ),
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

type CheckJobEventPolicyOptions = {
  key: string;
  file: string;
  job: v.InferOutput<typeof workflowSchema>["jobs"][string];
  eventPolicy: v.InferOutput<typeof policySchema>["jobs"][string];
  pending: v.InferOutput<typeof policySchema>["pending"][string] | undefined;
  triggers: v.InferOutput<typeof workflowSchema>["on"];
};

const checkJobEventPolicy = ({
  key,
  file,
  job,
  eventPolicy,
  pending,
  triggers,
}: CheckJobEventPolicyOptions) => {
  const problems: string[] = [];
  if (eventPolicy === "pending") {
    if (
      key !== "ci.yml/ci-tests" ||
      pending?.owner !== "email-inbound" ||
      pending.reason !== "event policy moves after the run-tests rework lands"
    ) {
      problems.push(`${key}: undeclared pending owner or reason`);
    }
    return problems;
  }
  if (eventPolicy === "pr-opt-in") {
    const condition =
      typeof job.if === "boolean" ? String(job.if) : (job.if ?? "true");
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
          pending: declared.pending[key],
          triggers: workflow.on,
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
      (id) =>
        id !== "ci-plan" &&
        ["pr-fast", "pending"].includes(declared.jobs[`${file}/${id}`] ?? ""),
    );
    if (
      actual.length !== expected.length ||
      actual.some((id) => !expected.includes(id))
    ) {
      problems.push(
        "ci.yml: FAST_REQUIRED must equal declared PR checks and the named pending job",
      );
    }
  }
  for (const file of Object.keys(declared.pushMain)) {
    if (!mainWorkflows.has(file)) {
      problems.push(`${file}: stale main-push concurrency policy`);
    }
  }
  for (const key of Object.keys(declared.jobs)) {
    if (!seen.has(key)) {
      problems.push(`${key}: stale event policy`);
    }
  }
  for (const key of Object.keys(declared.pending)) {
    if (declared.jobs[key] !== "pending") {
      problems.push(`${key}: stale pending entry`);
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
