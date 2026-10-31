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

export const WORKFLOW_PRIVILEGE_ALLOWLIST = {
  ".github/workflows/ci.yml:database-migrations-check":
    "ci-plan trusted is false for Dependabot pull requests",
  ".github/workflows/ci.yml:database-migrations-apply-fresh":
    "ci-plan trusted is false for Dependabot pull requests",
  ".github/workflows/release-desktop.yml:promote-latest":
    "resolve accepts only a release tag produced from main",
  ".github/workflows/release-desktop.yml:carry-forward":
    "resolve accepts only a release tag produced from main",
  ".github/workflows/release-tag.yml:tag":
    "the workflow_run path is rejected by the dispatch-only job condition",
  ".github/workflows/scheduled-run-alerts.yml:notify":
    "the workflow_run condition accepts only non-pull-request source events from this repository",
} as const satisfies Record<string, string>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => JSON.stringify(value ?? "");
const hasSecret = (value: unknown): boolean =>
  /secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/u.test(text(value));
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
const controlledRef = (value: unknown, reachable: boolean): boolean => {
  if (typeof value !== "string") {
    return reachable;
  }
  return /pull_request\.head|github\.head_ref|workflow_run\.head_(?:sha|branch)|refs\/pull\/|github\.sha/u.test(
    value,
  );
};

type Truth = "false" | "true" | "unknown";
type ConditionContext = {
  actor?: string;
  eventName?: string;
};

const conditionTokens = (condition: string): string[] | undefined => {
  let expression = condition
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "");
  let previous = "";
  while (previous !== expression) {
    previous = expression;
    expression = expression.replace(
      /[A-Za-z_][A-Za-z0-9_.]*\([^()]*\)/gu,
      "opaque",
    );
  }
  const tokens = expression.match(
    /\s*(?:(&&|\|\||!=|==|!|\(|\))|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_.-]*))/gu,
  );
  if (tokens === null) {
    return expression === "" ? [] : undefined;
  }
  const normalized = tokens.map((token) => token.trim());
  if (normalized.join("").length !== expression.replaceAll(/\s/gu, "").length) {
    return undefined;
  }
  return normalized;
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
    const equal = left === right;
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

const checkoutDirectory = (value: unknown): string => {
  if (typeof value !== "string" || value === "" || value === ".") {
    return ".";
  }
  return value.replace(/^\.\//u, "").replace(/\/$/u, "");
};

const stepRunsDirectory = (
  step: Record<string, unknown>,
  directory: string,
): boolean => {
  const command = typeof step["run"] === "string" ? step["run"] : "";
  const uses = typeof step["uses"] === "string" ? step["uses"] : "";
  const workingDirectory = checkoutDirectory(step["working-directory"]);
  if (directory === ".") {
    return command !== "" || uses.startsWith("./");
  }
  if (command !== "" && workingDirectory === directory) {
    return true;
  }
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const repositoryPath = new RegExp(`(?:^|[\\s'"=])\\.?/?${escaped}/`, "u");
  return repositoryPath.test(command) || repositoryPath.test(uses);
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
    (entry): entry is [string, Record<string, unknown>] =>
      record(entry[1]) &&
      !(`${file}:${entry[0]}` in WORKFLOW_PRIVILEGE_ALLOWLIST),
  );
  for (const [jobName, rawJob] of jobEntries) {
    const permissions = rawJob["permissions"] ?? parsed["permissions"];
    const write = hasWrite(permissions);
    const steps = stepsOf(rawJob);
    const secret =
      hasSecret(parsed["env"]) ||
      hasSecret(rawJob["env"]) ||
      steps.some(
        (step) =>
          record(step) && (hasSecret(step["env"]) || hasSecret(step["with"])),
      ) ||
      rawJob["secrets"] === "inherit";
    const condition = stringField(rawJob["if"]);
    const excludesDependabot = excludesActor(condition, "dependabot[bot]");
    const controlledDirectories = new Map<string, boolean>();
    for (const rawStep of steps) {
      if (!record(rawStep)) {
        continue;
      }
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      const withValue = record(rawStep["with"]) ? rawStep["with"] : {};
      if (uses.startsWith("actions/checkout@")) {
        const ref = withValue["ref"];
        const base =
          typeof ref === "string" && /pull_request\.base\.sha/u.test(ref);
        controlledDirectories.set(
          checkoutDirectory(withValue["path"]),
          !base && controlledRef(ref, true),
        );
      }
      const artifact =
        uses.startsWith("actions/download-artifact@") &&
        (withValue["run-id"] !== undefined ||
          withValue["github-token"] !== undefined);
      const runsControlled =
        artifact ||
        [...controlledDirectories].some(
          ([directory, controlled]) =>
            controlled && stepRunsDirectory(rawStep, directory),
        );
      if (!runsControlled) {
        continue;
      }
      const step =
        typeof rawStep["name"] === "string" ? rawStep["name"] : "unnamed step";
      findings.push(
        ...findingsForStep({
          condition,
          excludesDependabot,
          file,
          job: jobName,
          permissions,
          prTriggers,
          rawJob,
          secret,
          step,
          write,
        }),
      );
    }
    const reusableUses = stringField(rawJob["uses"]);
    if (reusableUses.startsWith("./") && (secret || write)) {
      findings.push(
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
