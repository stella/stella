/**
 * The predicate shapes the merge gate can model for the fast-required jobs of
 * `.github/workflows/ci.yml`.
 *
 * The merge gate decides whether a pull request's green CI still covers what
 * main's CI would run. It reads the fast-required job list and each such
 * job's `if:` predicate, so a predicate shape it cannot model must fail in
 * the change that introduces it. This module is the contract both sides
 * share: the gate's model is checked against these constants.
 */
import { panic } from "better-result";
import * as v from "valibot";

/**
 * The predicate of a job that is planned on every non-heavy, non-draft run
 * except an enqueued head's, whose queued tree the merge group validates.
 */
export const ALWAYS_PLANNED_PREDICATE = `\${{ !cancelled() && inputs.heavy_only != true && inputs.pr_depth_only != true && github.event_name == 'pull_request' && github.event.pull_request.draft != true && github.event.action != 'enqueued' }}`;

const JOB_PLACEHOLDER = "<job>";
const OUTPUT_PLACEHOLDER = "<output>";

/**
 * Every atom a fast-required predicate may combine with `&&`, `||` and
 * parentheses. `<job>` stands for the job id; the `<output>` atom applies only
 * to a job gated by a plan output.
 */
export const FAST_REQUIRED_PREDICATE_ATOMS = [
  "needs.ci-plan.outputs.run_required != 'false'",
  "needs.ci-plan.result == 'success'",
  "needs.pr-heavy-gate.result == 'success'",
  // A repository check waits on the gate only when the plan schedules it; a
  // push that merges only the base runs its checks ungated.
  "needs.ci-plan.outputs.pr_heavy_gate_required != 'true'",
  // A check that waits on the gate past `!cancelled()` still requires its
  // generated sources explicitly.
  "needs.generated-sources.result == 'success'",
  "inputs.heavy_only != true",
  "inputs.heavy_only == true",
  "inputs.pr_depth_only != true",
  "needs.ci-plan.outputs.pr_depth_reused != 'true'",
  "needs.ci-plan.outputs.trusted == 'true'",
  "github.event_name == 'workflow_dispatch'",
  "github.event_name == 'pull_request'",
  "github.event_name != 'pull_request'",
  "github.event.pull_request.draft != true",
  "github.event.action != 'enqueued'",
  "github.event_name == 'merge_group'",
  "github.event_name != 'merge_group'",
  "vars.QUEUE_BROWSER_SUITES != 'off'",
  "always()",
  "!cancelled()",
  "needs.web-build.result == 'success'",
  "needs.heavy-web-build.result == 'success'",
  "needs.ci-plan.outputs.web_build_required == 'true'",
  "needs.ci-plan.outputs.queue_depth != 'thin'",
  "needs.ci-plan.outputs.coverage_profile == 'normal-v1'",
  "needs.ci-plan.outputs.coverage_profile != 'pilot-fast-v1'",
  `contains(fromJSON(needs.ci-plan.outputs.pilot_fast_jobs || '[]'), '${JOB_PLACEHOLDER}')`,
  `contains(fromJSON(needs.ci-plan.outputs.queue_required_jobs || '[]'), '${JOB_PLACEHOLDER}')`,
  `needs.ci-plan.outputs.${OUTPUT_PLACEHOLDER} == 'true'`,
] as const;

/**
 * Reusable-workflow jobs the merge gate handles by name rather than by atom.
 * The exception holds only while the job calls a reusable workflow.
 */
export const REUSABLE_WORKFLOW_EXCEPTIONS: ReadonlySet<string> = new Set([
  "query-perf",
]);

const RESIDUE = /^[\s()&|]*$/u;

/** Placeholder predicate reported for a fast-required id with no job. */
export const MISSING_JOB_PREDICATE = "<no job definition>";

/** The allowed atoms for one job, with its id and gating output filled in. */
export function predicateAtoms(job: string, output: string | null): string[] {
  return FAST_REQUIRED_PREDICATE_ATOMS.flatMap((atom) => {
    if (atom.includes(OUTPUT_PLACEHOLDER)) {
      return output === null
        ? []
        : [atom.replace(OUTPUT_PLACEHOLDER, () => output)];
    }
    return [atom.replace(JOB_PLACEHOLDER, () => job)];
  });
}

const jobSchema = v.looseObject({
  if: v.optional(v.union([v.string(), v.boolean(), v.number()])),
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  uses: v.optional(v.string()),
});
type Job = v.InferOutput<typeof jobSchema>;

const workflowSchema = v.looseObject({
  jobs: v.record(v.string(), v.unknown()),
});

const resultJobSchema = v.looseObject({
  steps: v.array(v.unknown()),
});

const outcomeEnvSchema = v.object({
  FAST_REQUIRED: v.string(),
  JOB_SCOPES: v.string(),
  FAST_JOB_SCOPES: v.string(),
});

const stepSchema = v.looseObject({
  env: v.optional(v.record(v.string(), v.unknown())),
});

export type FastRequiredJob = {
  job: string;
  /** The plan output that gates the job, or null when none does. */
  output: string | null;
  /** The job definition, or null when the id names no job. */
  definition: Job | null;
};

/**
 * The fast-required jobs as the merge gate enumerates them: the ids in the
 * `ci-result` outcome step's FAST_REQUIRED, each gated by its FAST_JOB_SCOPES
 * output when it has one and by its JOB_SCOPES output otherwise, the same
 * precedence ci-result applies to fast-depth evidence.
 */
export function fastRequiredJobs(ciYmlSource: string): FastRequiredJob[] {
  const { jobs } = v.parse(workflowSchema, Bun.YAML.parse(ciYmlSource));
  const { steps } = v.parse(resultJobSchema, jobs["ci-result"]);
  const outcomeSteps = steps
    .map((step) => v.parse(stepSchema, step).env)
    .filter((env) => env !== undefined && Object.hasOwn(env, "FAST_REQUIRED"));
  if (outcomeSteps.length !== 1) {
    panic("ci-result must have exactly one step declaring FAST_REQUIRED");
  }
  const env = v.parse(outcomeEnvSchema, outcomeSteps.at(0));
  const required = v.parse(v.array(v.string()), JSON.parse(env.FAST_REQUIRED));
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(env.JOB_SCOPES),
  );
  const fastScopes = v.parse(
    v.record(v.string(), v.string()),
    JSON.parse(env.FAST_JOB_SCOPES),
  );
  return required.map((job) => {
    const raw = Object.hasOwn(jobs, job) ? jobs[job] : undefined;
    return {
      definition: raw === undefined ? null : v.parse(jobSchema, raw),
      job,
      output: gatingOutput(job, fastScopes, scopes),
    };
  });
}

function gatingOutput(
  job: string,
  fastScopes: Record<string, string>,
  scopes: Record<string, string | null>,
): string | null {
  if (Object.hasOwn(fastScopes, job)) {
    return fastScopes[job] ?? null;
  }
  return Object.hasOwn(scopes, job) ? (scopes[job] ?? null) : null;
}

function needsPlan(job: Job): boolean {
  const { needs } = job;
  return Array.isArray(needs) ? needs.includes("ci-plan") : needs === "ci-plan";
}

function normalize(condition: Job["if"]): string {
  return condition === undefined
    ? ""
    : String(condition).replaceAll(/\s+/gu, " ").trim();
}

/** Whether the merge gate can model this job's predicate. */
export function isModeled({
  job,
  output,
  definition,
}: FastRequiredJob): boolean {
  if (definition === null) {
    return false;
  }
  if (REUSABLE_WORKFLOW_EXCEPTIONS.has(job) && definition.uses !== undefined) {
    return true;
  }
  const condition = normalize(definition.if);
  if (output === null && condition === ALWAYS_PLANNED_PREDICATE) {
    return true;
  }
  if (output === null && !needsPlan(definition)) {
    return false;
  }
  // A job gated by a plan output must test that output: otherwise it runs in
  // cases where the merge gate believes it is not planned.
  if (
    output !== null &&
    !condition.includes(`needs.ci-plan.outputs.${output} == 'true'`)
  ) {
    return false;
  }
  let residue = condition;
  for (const atom of predicateAtoms(job, output)) {
    residue = residue.replaceAll(atom, "");
  }
  return RESIDUE.test(residue);
}

/** Every fast-required job whose predicate the merge gate cannot model. */
export function unmodeledFastRequiredJobs(
  ciYmlSource: string,
): { job: string; predicate: string }[] {
  return fastRequiredJobs(ciYmlSource)
    .filter((entry) => !isModeled(entry))
    .map(({ job, definition }) => ({
      job,
      predicate:
        definition === null ? MISSING_JOB_PREDICATE : normalize(definition.if),
    }));
}
