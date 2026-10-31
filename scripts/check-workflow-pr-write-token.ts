#!/usr/bin/env bun

import { TaggedError } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

class WorkflowPrivilegePolicyError extends TaggedError(
  "WorkflowPrivilegePolicyError",
)<{ message: string; file: string }> {}

type Finding = {
  file: string;
  job: string;
  step: string;
  class: "class 1" | "class 2" | "class 3";
  trigger: string;
};

type FindingKey = `${Finding["class"]}:${string}`;

type WorkflowPrivilegeExemption = {
  reason: string;
  /** The findings the reason covers; any other finding on the job is reported. */
  covers: readonly [FindingKey, ...FindingKey[]];
  /** Job-condition fragments the reason depends on; without one the exemption lapses. */
  requires: readonly string[];
};

const CI_PLAN_REASON =
  "pull-request credentials are platform-downgraded or admitted by the trusted CI plan";
const CI_PLAN_TRUSTED = "needs.ci-plan.outputs.trusted == 'true'";
const RELEASE_SHOULD_BUILD = "needs.resolve.outputs.should_build == 'true'";
const PULL_REQUEST_DEPENDABOT = ["class 3:pull_request"] as const;
const PULL_REQUEST_SECRET = [
  "class 2:pull_request",
  "class 3:pull_request",
] as const;
const WORKFLOW_RUN_WRITE = ["class 1:workflow_run"] as const;

export const WORKFLOW_PRIVILEGE_ALLOWLIST = {
  ".github/workflows/ci.yml:api-image-smoke": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:ci-browser": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [],
  },
  ".github/workflows/ci.yml:ci-checks-generated": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:ci-checks-policy": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:ci-checks-rest": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:ci-plan": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [],
  },
  ".github/workflows/ci.yml:ci-result": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [],
  },
  ".github/workflows/ci.yml:marketing-screenshots": {
    reason:
      "registry pull credentials reach the reusable capture only when the trusted CI plan admits the run",
    covers: PULL_REQUEST_SECRET,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:ci-tests": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:code-quality-api": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:code-quality-web-rest": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:dependency-malware": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:desktop-rust-lint": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:desktop-rust-tests": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:desktop-windows-dry-run": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:e2e-landing": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:e2e-production-shard": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_SECRET,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:e2e-report": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [],
  },
  ".github/workflows/ci.yml:e2e-vite-canary": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_SECRET,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:generated-sources": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:landing-build": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:legal-atlas-image": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:migration-upgrade-rehearsal": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:mobile-build": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:postgres-service-suites": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:release-typecheck": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:route-smoke": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_SECRET,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:scan-engine-wasm-drift": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:service-suites": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:stack-redaction-browsers": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:web-build": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:web-image-smoke": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:windows-scripts": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/release-desktop.yml:build": {
    reason:
      "the workflow_run release reference is resolved and admitted from the trusted release workflow",
    covers: WORKFLOW_RUN_WRITE,
    requires: [RELEASE_SHOULD_BUILD],
  },
  ".github/workflows/release-desktop.yml:manifest": {
    reason:
      "the workflow_run release reference is resolved and admitted from the trusted release workflow",
    covers: WORKFLOW_RUN_WRITE,
    requires: [RELEASE_SHOULD_BUILD],
  },
  ".github/workflows/ci.yml:database-migrations-check": {
    reason: "ci-plan trusted is false for Dependabot pull requests",
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
  ".github/workflows/ci.yml:database-migrations-apply-fresh": {
    reason: "ci-plan trusted is false for Dependabot pull requests",
    covers: PULL_REQUEST_DEPENDABOT,
    requires: [CI_PLAN_TRUSTED],
  },
} as const satisfies Record<string, WorkflowPrivilegeExemption>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => JSON.stringify(value ?? "");
const stringsOf = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsOf);
  }
  return record(value) ? Object.values(value).flatMap(stringsOf) : [];
};
// Actions evaluates only `${{ … }}` bodies. A `}}` inside a single-quoted
// literal does not close one (`''` escapes a quote, so toggling suffices),
// and an unclosed body runs to the end of the value.
const expressionBodies = (value: string): string[] => {
  const bodies: string[] = [];
  let start = value.indexOf("${{");
  while (start !== -1) {
    let index = start + 3;
    let quoted = false;
    while (index < value.length && (quoted || !value.startsWith("}}", index))) {
      if (value.charAt(index) === "'") {
        quoted = !quoted;
      }
      index += 1;
    }
    bodies.push(value.slice(start + 3, index));
    start = value.indexOf("${{", index);
  }
  return bodies;
};
const SECRETS_CONTEXT = /(?<![A-Za-z0-9_.-])secrets(?![A-Za-z0-9_-])/giu;
// Actions skips whitespace between tokens and matches names
// case-insensitively; only the workflow token itself is not a repository
// secret, so a computed key or the whole context counts as one.
const WORKFLOW_TOKEN_ACCESS =
  /^\s*(?:\.\s*github_token|\[\s*'github_token'\s*\])(?![A-Za-z0-9_-])/iu;
const hasSecret = (value: unknown): boolean =>
  stringsOf(value).some((item) =>
    expressionBodies(item).some((body) =>
      [...body.matchAll(SECRETS_CONTEXT)].some(
        (match) =>
          !WORKFLOW_TOKEN_ACCESS.test(
            body.slice(match.index + match[0].length),
          ),
      ),
    ),
  );
const hasWrite = (permissions: unknown, defaultIsWrite = false): boolean => {
  if (
    permissions === "write-all" ||
    (permissions === undefined && defaultIsWrite)
  ) {
    return true;
  }
  return record(permissions) && Object.values(permissions).includes("write");
};
const triggersOf = (on: unknown): string[] => {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.filter((item) => typeof item === "string");
  }
  return record(on) ? Object.keys(on) : [];
};
// `${{ <expression> }}` wrappers are stripped by string operations: the
// equivalent regular expressions backtrack super-linearly on long input.
const stripExpressionWrapper = (wrapped: string): string => {
  let expression = wrapped.trim();
  if (expression.startsWith("${{")) {
    expression = expression.slice(3).trimStart();
  }
  if (expression.endsWith("}}")) {
    expression = expression.slice(0, -2).trimEnd();
  }
  return expression;
};

const checkoutExpressionOf = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("${{") || !trimmed.endsWith("}}")) {
    return undefined;
  }
  const expression = stripExpressionWrapper(trimmed);
  return expression === "" || /[{}]/u.test(expression) ? undefined : expression;
};

// The comparison-base output is trusted only when the step that produces it is
// the repository's resolver, not merely a step with the same id.
const TARGET_BASE_STEP_ID = "target-base";
const TARGET_BASE_ACTION = "./.github/actions/merge-target-base";
const TARGET_BASE_RUN = 'bash "$RUNNER_TEMP/merge-target-base.sh"';

const TARGET_BASE_SCRIPT = "merge-target-base.sh";
const stagedResolverSource = (command: string): string | undefined => {
  const prefix = 'cp "$GITHUB_WORKSPACE/';
  const suffix = `/scripts/${TARGET_BASE_SCRIPT}" "$RUNNER_TEMP/${TARGET_BASE_SCRIPT}"`;
  const trimmed = command.trim();
  return trimmed.startsWith(prefix) && trimmed.endsWith(suffix)
    ? trimmed.slice(prefix.length, -suffix.length)
    : undefined;
};

type TrustedTargetBaseOptions = {
  steps: readonly unknown[];
  trigger: string;
  controlledDirectories: ReadonlyMap<string, ReadonlySet<string>>;
};

// The run form is trusted only when the script it runs was staged by exactly
// one earlier step, copied from a checkout this trigger does not control.
const trustedTargetBase = ({
  steps,
  trigger,
  controlledDirectories,
}: TrustedTargetBaseOptions): boolean => {
  const index = steps.findIndex(
    (step) => record(step) && step["id"] === TARGET_BASE_STEP_ID,
  );
  const resolver = steps[index];
  if (!record(resolver)) {
    return false;
  }
  if (resolver["uses"] === TARGET_BASE_ACTION) {
    return true;
  }
  if (
    typeof resolver["run"] !== "string" ||
    resolver["run"].trim() !== TARGET_BASE_RUN
  ) {
    return false;
  }
  const writers = steps
    .slice(0, index)
    .filter(
      (step): step is Record<string, unknown> =>
        record(step) &&
        typeof step["run"] === "string" &&
        step["run"].includes(TARGET_BASE_SCRIPT),
    );
  const [writer] = writers;
  if (writers.length !== 1 || writer === undefined) {
    return false;
  }
  const source =
    typeof writer["run"] === "string"
      ? stagedResolverSource(writer["run"])
      : undefined;
  const controlled =
    source === undefined ? undefined : controlledDirectories.get(source);
  return controlled !== undefined && !controlled.has(trigger);
};

type TrustedCheckoutValueOptions = TrustedTargetBaseOptions & {
  value: unknown;
  field: "ref" | "repository";
};

const trustedCheckoutValue = ({
  value,
  trigger,
  field,
  steps,
  controlledDirectories,
}: TrustedCheckoutValueOptions): boolean => {
  // actions/checkout treats an empty input like an omitted one.
  if (value === undefined || value === "") {
    return field === "repository" || trigger !== "pull_request";
  }
  if (typeof value !== "string") {
    return false;
  }
  const checkoutExpression = checkoutExpressionOf(value);
  if (checkoutExpression === undefined) {
    // A literal is trusted; an expression interpolated into a longer value
    // (`refs/heads/${{ ... }}`) is not an approved form.
    return !value.includes("${{");
  }
  // On pull_request the workflow revision is the PR merge commit, so it is
  // trusted only for events whose workflow runs from the base branch.
  if (checkoutExpression === "github.workflow_sha") {
    return trigger !== "pull_request";
  }
  if (field === "repository" && checkoutExpression === "github.repository") {
    return true;
  }
  if (checkoutExpression === "github.sha" && trigger !== "pull_request") {
    return true;
  }
  return (
    checkoutExpression === `steps.${TARGET_BASE_STEP_ID}.outputs.base_sha` &&
    trustedTargetBase({ steps, trigger, controlledDirectories })
  );
};

type Truth = "false" | "true" | "unknown";
type ConditionContext = {
  actor?: string;
  eventName?: string;
};

const conditionTokens = (condition: string): string[] | undefined => {
  let expression = stripExpressionWrapper(condition);
  let previous = "";
  while (previous !== expression) {
    previous = expression;
    // The lookbehind starts each match at an identifier boundary, so a
    // failed call is not re-walked from every later character.
    expression = expression.replace(
      /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_.]*\([^()]*\)/gu,
      "opaque",
    );
  }
  // Whitespace is skipped by the scanner, not by the pattern, so the sticky
  // match stays linear.
  const token =
    /&&|\|\||!=|==|!|\(|\)|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_.-]*/uy;
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    if (/\s/u.test(expression.charAt(index))) {
      index += 1;
      continue;
    }
    token.lastIndex = index;
    const match = token.exec(expression);
    if (match === null) {
      return undefined;
    }
    tokens.push(match[0]);
    index = token.lastIndex;
  }
  return tokens;
};

const negate = (value: Truth): Truth => {
  if (value === "true") {
    return "false";
  }
  if (value === "false") {
    return "true";
  }
  return "unknown";
};

const conditionTruth = (
  condition: string,
  context: ConditionContext,
): Truth => {
  const tokens = conditionTokens(condition);
  if (tokens === undefined || tokens.length === 0) {
    return condition === "" ? "true" : "unknown";
  }
  let cursor = 0;
  const valueOf = (token: string): string | undefined => {
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      return token.slice(1, -1);
    }
    if (token === "github.event_name") {
      return context.eventName;
    }
    if (token === "github.actor") {
      return context.actor;
    }
    if (token === "true" || token === "false") {
      return token;
    }
    return undefined;
  };
  const parseComparison = (): Truth => {
    const leftToken = tokens.at(cursor);
    if (leftToken === undefined) {
      return "unknown";
    }
    cursor += 1;
    if (leftToken === "true" || leftToken === "false") {
      return leftToken;
    }
    const operator = tokens.at(cursor);
    if (operator !== "==" && operator !== "!=") {
      return "unknown";
    }
    cursor += 1;
    const rightToken = tokens.at(cursor);
    if (rightToken === undefined) {
      return "unknown";
    }
    cursor += 1;
    const left = valueOf(leftToken);
    const right = valueOf(rightToken);
    if (left === undefined || right === undefined) {
      return "unknown";
    }
    // Actions compares strings case-insensitively.
    const equal = left.toLowerCase() === right.toLowerCase();
    return (operator === "==") === equal ? "true" : "false";
  };
  const parsePrimary = (): Truth => {
    if (tokens.at(cursor) === "(") {
      cursor += 1;
      const result = parseOr();
      if (tokens.at(cursor) !== ")") {
        return "unknown";
      }
      cursor += 1;
      return result;
    }
    return parseComparison();
  };
  const parseUnary = (): Truth => {
    if (tokens.at(cursor) === "!") {
      cursor += 1;
      return negate(parseUnary());
    }
    return parsePrimary();
  };
  const parseAnd = (): Truth => {
    let result = parseUnary();
    while (tokens.at(cursor) === "&&") {
      cursor += 1;
      const right = parseUnary();
      if (result === "false" || right === "false") {
        result = "false";
      } else if (result === "true" && right === "true") {
        result = "true";
      } else {
        result = "unknown";
      }
    }
    return result;
  };
  const parseOr = (): Truth => {
    let result = parseAnd();
    while (tokens.at(cursor) === "||") {
      cursor += 1;
      const right = parseAnd();
      if (result === "true" || right === "true") {
        result = "true";
      } else if (result === "false" && right === "false") {
        result = "false";
      } else {
        result = "unknown";
      }
    }
    return result;
  };
  const result = parseOr();
  return cursor === tokens.length ? result : "unknown";
};

const excludesEvent = (condition: string, eventName: string): boolean =>
  conditionTruth(condition, { eventName }) === "false";
const excludesActor = (condition: string, actor: string): boolean =>
  conditionTruth(condition, { actor }) === "false";

const isExpression = (value: unknown): boolean =>
  typeof value === "string" && value.includes("${{");

// Every spelling of the workspace root (omitted, empty, `.`, `./`, `a/..`)
// is `.`. An expression may name any directory, so it counts as the root,
// whose checks match every step.
const checkoutDirectory = (value: unknown): string => {
  if (typeof value !== "string" || isExpression(value)) {
    return ".";
  }
  const normalized = path.posix.normalize(value).replace(/\/+$/u, "");
  return normalized === "" ? "." : normalized;
};

type StepRunsDirectoryOptions = {
  step: Record<string, unknown>;
  directory: string;
  // `defaults.run.working-directory` of the job, else of the workflow.
  inheritedWorkingDirectory: unknown;
};

const stepRunsDirectory = ({
  step,
  directory,
  inheritedWorkingDirectory,
}: StepRunsDirectoryOptions): boolean => {
  const command = typeof step["run"] === "string" ? step["run"] : "";
  const uses = typeof step["uses"] === "string" ? step["uses"] : "";
  const rawWorkingDirectory =
    step["working-directory"] ?? inheritedWorkingDirectory;
  const workingDirectory = checkoutDirectory(rawWorkingDirectory);
  // A remote action reads the paths its inputs name (a build context, a
  // Dockerfile) and may run what it finds there; a checkout only writes one.
  const actionInputs =
    uses === "" || uses.startsWith("./") || uses.startsWith("actions/checkout@")
      ? []
      : stringsOf(step["with"]);
  if (directory === ".") {
    return (
      command !== "" ||
      uses.startsWith("./") ||
      actionInputs.some(
        (input) =>
          input === "." ||
          input.startsWith("./") ||
          /github\.workspace|GITHUB_WORKSPACE/u.test(input),
      )
    );
  }
  if (
    command !== "" &&
    (isExpression(rawWorkingDirectory) ||
      workingDirectory === directory ||
      workingDirectory.startsWith(`${directory}/`))
  ) {
    return true;
  }
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Any mention of the directory counts, including `cd untrusted && ...`.
  const repositoryPath = new RegExp(
    `(?:^|[\\s'"=/])\\.?/?${escaped}(?:/|$|[\\s'";&|)])`,
    "u",
  );
  return [command, uses, ...actionInputs].some((value) =>
    repositoryPath.test(value),
  );
};

const runDefaultDirectory = (owner: Record<string, unknown>): unknown => {
  const defaults = owner["defaults"];
  const run = record(defaults) ? defaults["run"] : undefined;
  return record(run) ? run["working-directory"] : undefined;
};

const stepsOf = (job: Record<string, unknown>): unknown[] =>
  Array.isArray(job["steps"]) ? job["steps"] : [];

const stringField = (value: unknown): string =>
  typeof value === "string" ? value : "";

type StepFindingOptions = {
  condition: string;
  excludesDependabot: boolean;
  file: string;
  job: string;
  permissions: unknown;
  prTriggers: string[];
  rawJob: Record<string, unknown>;
  secret: boolean;
  step: string;
  write: boolean;
};

const findingsForStep = (options: StepFindingOptions): Finding[] => {
  const findings: Finding[] = [];
  for (const trigger of options.prTriggers) {
    if (excludesEvent(options.condition, trigger)) {
      continue;
    }
    const classes: Finding["class"][] = [];
    if (
      ["pull_request_target", "workflow_run", "issue_comment"].includes(
        trigger,
      ) &&
      (hasWrite(options.permissions, true) || options.secret)
    ) {
      classes.push("class 1");
    }
    if (
      trigger === "pull_request" &&
      (options.secret || /create-github-app-token/u.test(text(options.rawJob)))
    ) {
      classes.push("class 2");
    }
    if (
      trigger === "pull_request" &&
      !options.excludesDependabot &&
      (options.secret || options.write)
    ) {
      classes.push("class 3");
    }
    for (const violation of classes) {
      findings.push({
        file: options.file,
        job: options.job,
        step: options.step,
        class: violation,
        trigger,
      });
    }
  }
  return findings;
};

const WORKFLOW_PRIVILEGE_EXEMPTIONS = new Map(
  Object.entries(WORKFLOW_PRIVILEGE_ALLOWLIST),
);

type UnexemptedFindingsOptions = {
  key: string;
  condition: string;
  findings: readonly Finding[];
};

// An exemption covers only the findings it was approved for, and only while
// the job keeps every condition its reason depends on, so a later edit that
// adds a trigger, a privilege class or drops a guard condition is reported.
const unexemptedFindings = ({
  key,
  condition,
  findings,
}: UnexemptedFindingsOptions): readonly Finding[] => {
  const exemption = WORKFLOW_PRIVILEGE_EXEMPTIONS.get(key);
  if (
    exemption === undefined ||
    !exemption.requires.every((fragment) => condition.includes(fragment))
  ) {
    return findings;
  }
  return findings.filter(
    (finding) =>
      !exemption.covers.some(
        (covered) => covered === `${finding.class}:${finding.trigger}`,
      ),
  );
};

export const checkWorkflowPrivilegeSource = (
  file: string,
  source: string,
): Finding[] => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!record(parsed)) {
    throw new WorkflowPrivilegePolicyError({
      message: "workflow must be a mapping",
      file,
    });
  }
  const triggers = triggersOf(parsed["on"]);
  const prTriggers = triggers.filter((trigger) =>
    [
      "pull_request",
      "pull_request_target",
      "issue_comment",
      "workflow_run",
    ].includes(trigger),
  );
  if (prTriggers.length === 0 || !record(parsed["jobs"])) {
    return [];
  }
  const findings: Finding[] = [];
  const jobEntries = Object.entries(parsed["jobs"]).filter(
    (entry): entry is [string, Record<string, unknown>] => record(entry[1]),
  );
  for (const [jobName, rawJob] of jobEntries) {
    const jobFindings: Finding[] = [];
    const permissions = rawJob["permissions"] ?? parsed["permissions"];
    const write = hasWrite(permissions);
    const steps = stepsOf(rawJob);
    const secret =
      hasSecret(parsed["env"]) ||
      hasSecret(rawJob["env"]) ||
      hasSecret(rawJob["with"]) ||
      hasSecret(rawJob["run"]) ||
      steps.some(
        (step) =>
          record(step) &&
          (hasSecret(step["env"]) ||
            hasSecret(step["with"]) ||
            hasSecret(step["run"])),
      ) ||
      rawJob["secrets"] === "inherit" ||
      hasSecret(rawJob["secrets"]);
    const condition = stringField(rawJob["if"]);
    const excludesDependabot = excludesActor(condition, "dependabot[bot]");
    const controlledDirectories = new Map<string, Set<string>>();
    const inheritedWorkingDirectory =
      runDefaultDirectory(rawJob) ?? runDefaultDirectory(parsed);
    for (const rawStep of steps) {
      if (!record(rawStep)) {
        continue;
      }
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      const withValue = record(rawStep["with"]) ? rawStep["with"] : {};
      if (uses.startsWith("actions/checkout@")) {
        // A later checkout may be skipped by its own condition, so it never
        // clears triggers an earlier checkout already made untrusted.
        const directory = checkoutDirectory(withValue["path"]);
        controlledDirectories.set(
          directory,
          new Set([
            ...(controlledDirectories.get(directory) ?? []),
            ...prTriggers.filter(
              (trigger) =>
                !trustedCheckoutValue({
                  value: withValue["ref"],
                  trigger,
                  field: "ref",
                  steps,
                  controlledDirectories,
                }) ||
                !trustedCheckoutValue({
                  value: withValue["repository"],
                  trigger,
                  field: "repository",
                  steps,
                  controlledDirectories,
                }),
            ),
          ]),
        );
      }
      const artifact =
        uses.startsWith("actions/download-artifact@") &&
        (withValue["run-id"] !== undefined ||
          withValue["github-token"] !== undefined);
      const controlledTriggers = artifact
        ? prTriggers
        : prTriggers.filter((trigger) =>
            [...controlledDirectories].some(
              ([directory, controlled]) =>
                controlled.has(trigger) &&
                stepRunsDirectory({
                  step: rawStep,
                  directory,
                  inheritedWorkingDirectory,
                }),
            ),
          );
      // YAML reads a bare `if: false` as a boolean, not as expression text.
      const stepCondition =
        rawStep["if"] === false ? "false" : stringField(rawStep["if"]);
      const reachableTriggers = controlledTriggers.filter(
        (trigger) => !excludesEvent(stepCondition, trigger),
      );
      if (reachableTriggers.length === 0) {
        continue;
      }
      const step =
        typeof rawStep["name"] === "string" ? rawStep["name"] : "unnamed step";
      jobFindings.push(
        ...findingsForStep({
          condition,
          excludesDependabot,
          file,
          job: jobName,
          permissions,
          prTriggers: reachableTriggers,
          rawJob,
          secret,
          step,
          write,
        }),
      );
    }
    const reusableUses = stringField(rawJob["uses"]);
    if (reusableUses.startsWith("./") && (secret || write)) {
      jobFindings.push(
        ...findingsForStep({
          condition,
          excludesDependabot,
          file,
          job: jobName,
          permissions,
          prTriggers,
          rawJob,
          secret,
          step: reusableUses,
          write,
        }),
      );
    }
    findings.push(
      ...unexemptedFindings({
        key: `${file}:${jobName}`,
        condition,
        findings: jobFindings,
      }),
    );
  }
  return findings;
};

export const checkWorkflowPrivileges = (root = process.cwd()): Finding[] =>
  readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/u.test(file))
    .flatMap((file) => {
      const relative = `.github/workflows/${file}`;
      return checkWorkflowPrivilegeSource(
        relative,
        readFileSync(path.join(root, relative), "utf-8"),
      );
    })
    .toSorted((a, b) => {
      const left = `${a.file}:${a.job}:${a.step}`;
      const right = `${b.file}:${b.job}:${b.step}`;
      if (left < right) {
        return -1;
      }
      return left > right ? 1 : 0;
    });

if (import.meta.main) {
  const findings = checkWorkflowPrivileges();
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}: job ${finding.job}, ${finding.step}: ${finding.class} (${finding.trigger})\n`,
    );
  }
  if (findings.length > 0) {
    process.exit(1);
  }
}
