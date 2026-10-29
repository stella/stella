import { readdirSync, readFileSync } from "node:fs";
import * as v from "valibot";

import {
  contextWithPlanOutputs,
  definitelyFalse,
  evaluate,
} from "./github-expression";
import { HEAVY_PROOF_GATE } from "./heavy-proof-gate";
import { flattenWorkflowSteps } from "./workflow-steps";

const policySchema = v.object({
  jobs: v.record(
    v.string(),
    v.picklist([
      "pr-fast",
      "queue",
      "armed",
      "main",
      "schema-pr",
      "pr-opt-in",
      "release-pr",
      "dispatch-only",
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
      outputs: v.optional(v.record(v.string(), v.string())),
      if: v.optional(v.union([v.string(), v.boolean()])),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      steps: v.optional(
        v.pipe(
          v.unknown(),
          v.transform((steps) => flattenWorkflowSteps(steps)),
          v.array(
            v.looseObject({
              env: v.optional(v.record(v.string(), v.unknown())),
              run: v.optional(v.string()),
            }),
          ),
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
    v.InferOutput<typeof policySchema>["pushMain"][string] | undefined;
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
  planOutputs: Record<string, string>;
};

type PostgresPrSwitchOptions = {
  key: string;
  condition: string;
  planOutputs: Record<string, string>;
};

const requiresPostgresPrSwitch = ({
  key,
  condition,
  planOutputs,
}: PostgresPrSwitchOptions) =>
  key === "ci.yml/postgres-service-suites"
    ? condition.includes(
        "needs.ci-plan.outputs.postgres_service_suites_required == 'true'",
      ) &&
      planOutputs["postgres_service_suites_required"]?.includes(
        "vars.CI_POSTGRES_PR_SELECTION == 'on'",
      )
    : condition.includes("vars.CI_POSTGRES_PR_SELECTION == 'on'");

type CheckCompilerProofPolicyOptions = Pick<
  CheckJobEventPolicyOptions,
  "key" | "job" | "eventPolicy" | "triggers"
>;

const checkCompilerProofPolicy = ({
  key,
  job,
  eventPolicy,
  triggers,
}: CheckCompilerProofPolicyOptions) => {
  const problems: string[] = [];
  const compilerProof = job.steps?.some((step) =>
    /\btypecheck-command-probe\.(?:sh|ts)\b/u.test(step.run ?? ""),
  );
  if (compilerProof && eventPolicy !== "dispatch-only") {
    problems.push(`${key}: compiler probes require dispatch-only policy`);
  }
  if (
    eventPolicy === "dispatch-only" &&
    (Object.keys(triggers).length !== 1 ||
      !Object.hasOwn(triggers, "workflow_dispatch"))
  ) {
    problems.push(
      `${key}: dispatch-only jobs require workflow_dispatch as the only trigger`,
    );
  }
  return problems;
};

// Queue-only suites a pull request runs once it is armed for merge: the one
// ci-plan output decides, so no other path can run them on an unarmed pull
// request.
const checkArmedPolicy = ({
  key,
  job,
  eventPolicy,
  triggers,
}: Pick<
  CheckJobEventPolicyOptions,
  "key" | "job" | "eventPolicy" | "triggers"
>) => {
  const problems: string[] = [];
  if (eventPolicy !== "armed") {
    return problems;
  }
  const condition =
    typeof job.if === "boolean" ? String(job.if) : (job.if ?? "true");
  if (!condition.includes(HEAVY_PROOF_GATE)) {
    problems.push(`${key}: armed job must gate on ${HEAVY_PROOF_GATE}`);
  }
  for (const event of ["pull_request", "pull_request_target"]) {
    if (
      Object.hasOwn(triggers, event) &&
      !definitelyFalse(condition, {
        values: {
          "github.event_name": event,
          "needs.ci-plan.outputs.heavy_proof": "false",
        },
      })
    ) {
      problems.push(`${key}: armed job can run on an unarmed ${event}`);
    }
  }
  return problems;
};

const checkJobEventPolicy = ({
  key,
  file,
  job,
  eventPolicy,
  triggers,
  periodic,
  planOutputs,
}: CheckJobEventPolicyOptions) => {
  const problems: string[] = [];
  if (eventPolicy === "dispatch-only") {
    return problems;
  }
  if (file === "codeql.yml" && eventPolicy !== "release-pr") {
    return [`${key}: CodeQL jobs must declare nightly/manual/release policy`];
  }
  if (eventPolicy === "release-pr") {
    if (file !== "codeql.yml") {
      return [`${key}: nightly/manual/release policy belongs to CodeQL`];
    }
    return [];
  }
  const condition =
    typeof job.if === "boolean" ? String(job.if) : (job.if ?? "true");
  if (
    (key === "ci.yml/service-suites" ||
      key === "ci.yml/postgres-service-suites") &&
    (!requiresPostgresPrSwitch({ key, condition, planOutputs }) ||
      ["", "off"].some(
        (value) =>
          !definitelyFalse(
            condition,
            contextWithPlanOutputs({
              outputs: planOutputs,
              context: {
                values: {
                  "github.event_name": "pull_request",
                  "vars.CI_POSTGRES_PR_SELECTION": value,
                  "needs.ci-plan.outputs.corpus_suites_required": "false",
                },
              },
            }),
          ),
      ))
  ) {
    problems.push(
      `${key}: Postgres PR suites must require the disabled-by-default switch`,
    );
  }
  if (
    eventPolicy === "pr-opt-in" &&
    (key === "ci.yml/service-suites" ||
      key === "ci.yml/postgres-service-suites")
  ) {
    return problems;
  }
  if (eventPolicy === "pr-opt-in") {
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
  if (eventPolicy === "schema-pr" && file !== "ci.yml") {
    problems.push(`${key}: schema policy belongs to CI Checks`);
  }
  if (periodic) {
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
          "needs.ci-plan.outputs.heavy_proof": "true",
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
  policySource?: string;
};

const duplicatePolicyJobKeys = (source: string) => {
  const match = /"jobs"\s*:\s*\{/u.exec(source);
  if (!match) {
    return [];
  }
  const opening = source.indexOf("{", match.index);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let depth = 1;
  for (let index = opening + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== '"') {
      continue;
    }
    const start = index;
    index += 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
        continue;
      }
      if (source[index] === '"') {
        break;
      }
    }
    if (depth !== 1) {
      continue;
    }
    let after = index + 1;
    while (/\s/u.test(source[after] ?? "")) {
      after += 1;
    }
    if (source[after] !== ":") {
      continue;
    }
    const key = v.parse(v.string(), JSON.parse(source.slice(start, index + 1)));
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }
  return [...duplicates];
};

export const checkCiEventPolicies = ({
  workflows,
  policy,
  policySource,
}: CheckCiEventPoliciesOptions) => {
  const declared = v.parse(policySchema, policy);
  const seen = new Set<string>();
  const mainWorkflows = new Set<string>();
  const problems: string[] = [];
  for (const key of policySource ? duplicatePolicyJobKeys(policySource) : []) {
    problems.push(`CI event policy has duplicate job key: ${key}`);
  }
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
        ...checkCompilerProofPolicy({
          key,
          job,
          eventPolicy,
          triggers: workflow.on,
        }),
        ...checkArmedPolicy({
          key,
          job,
          eventPolicy,
          triggers: workflow.on,
        }),
        ...checkJobEventPolicy({
          key,
          file,
          job,
          eventPolicy,
          triggers: workflow.on,
          periodic: declared.periodicJobs.includes(key),
          planOutputs: workflow.jobs["ci-plan"]?.outputs ?? {},
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
        ["pr-fast", "schema-pr"].includes(declared.jobs[`${file}/${id}`] ?? ""),
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
  const policySource = readFileSync(
    new URL("../.github/ci-event-policy.json", import.meta.url),
    "utf-8",
  );
  const problems = checkCiEventPolicies({
    workflows,
    policy: JSON.parse(policySource),
    policySource,
  });
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  }
}
