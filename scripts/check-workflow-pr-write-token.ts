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
  class: "class 1" | "class 2" | "class 3" | "main-only guard";
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
  return /pull_request\.head|github\.head_ref|workflow_run\.head_(?:sha|branch)|refs\/pull\/|github\.sha|github\.workflow_sha/u.test(
    value,
  );
};

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
    if (
      trigger === "pull_request" &&
      /github\.event_name\s*!=\s*['"]pull_request['"]/u.test(options.condition)
    ) {
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
    (
      entry,
    ): entry is [string, Record<string, unknown> & { steps: unknown[] }] =>
      record(entry[1]) &&
      Array.isArray(entry[1]["steps"]) &&
      !(`${file}:${entry[0]}` in WORKFLOW_PRIVILEGE_ALLOWLIST),
  );
  for (const [jobName, rawJob] of jobEntries) {
    const permissions = rawJob["permissions"] ?? parsed["permissions"];
    const write = hasWrite(permissions);
    const secret = hasSecret(rawJob);
    const condition = typeof rawJob["if"] === "string" ? rawJob["if"] : "";
    const excludesDependabot =
      /github\.actor\s*!=\s*['"]dependabot\[bot\]['"]/u.test(condition);
    let controlledRoot = false;
    let runsWorkflowRevision = false;
    for (const rawStep of rawJob.steps) {
      if (!record(rawStep)) {
        continue;
      }
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      const withValue = record(rawStep["with"]) ? rawStep["with"] : {};
      if (uses.startsWith("actions/checkout@")) {
        const ref = withValue["ref"];
        const base =
          typeof ref === "string" && /pull_request\.base\.sha/u.test(ref);
        controlledRoot =
          !base && controlledRef(ref, true) && withValue["path"] === undefined;
      }
      const artifact =
        uses.startsWith("actions/download-artifact@") &&
        (withValue["run-id"] !== undefined ||
          withValue["github-token"] !== undefined);
      const command = typeof rawStep["run"] === "string" ? rawStep["run"] : "";
      const runsControlled =
        artifact ||
        (controlledRoot && command !== "") ||
        (controlledRoot && uses.startsWith("./"));
      if (!runsControlled) {
        continue;
      }
      if (/github\.workflow_sha/u.test(text(rawJob))) {
        runsWorkflowRevision = true;
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
    if (
      runsWorkflowRevision &&
      (write || secret) &&
      !/github\.ref\s*==\s*['"]refs\/heads\/main['"]/u.test(condition)
    ) {
      findings.push({
        file,
        job: jobName,
        step: "job condition",
        class: "main-only guard",
        trigger: prTriggers.join(","),
      });
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
