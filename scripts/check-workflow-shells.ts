import { readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

class WorkflowShellInvariantError extends Error {
  override name = "WorkflowShellInvariantError";
  readonly _tag = "WorkflowShellInvariantError";
}

export type WorkflowShellError = {
  file: string;
  line: number;
  message: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const lineOf = (source: string, needle: string): number => {
  const index = source.indexOf(needle);
  return index === -1 ? 1 : source.slice(0, index).split("\n").length;
};

type RunDefaults = {
  malformed: boolean;
  shell: unknown;
};

const runDefaults = (value: unknown): RunDefaults => {
  const defaults = record(value) ? value : undefined;
  const run = record(defaults?.["run"]) ? defaults["run"] : undefined;
  return {
    malformed:
      (value !== undefined && defaults === undefined) ||
      (defaults?.["run"] !== undefined && run === undefined),
    shell: run?.["shell"],
  };
};

// Constructs PowerShell cannot parse as written.
const BASH_ONLY_SYNTAX = [
  /\[\[/u,
  /\bset\s+-e(?:uo\s+pipefail)?\b/u,
  /<<<|\$\{[^}]+:-[^}]*\}/u,
  /\bif\b[^\n;]*;\s*then\b/u,
  /\bfor\b[^\n;]*;\s*do\b/u,
  /^\s*[A-Za-z_][A-Za-z0-9_]*=\S+\s+\S/mu,
] as const;

// Valid PowerShell too (subexpressions and the cp/mkdir aliases), so these
// only count under shells other than PowerShell.
const POWERSHELL_AMBIGUOUS_SYNTAX = [
  /\$\([^)]*\)/u,
  /(?:^|[;&|]\s*)cp\s+/mu,
  /(?:^|[;&|]\s*)mkdir\s+-p\b/mu,
] as const;

const isPowerShell = (shell: unknown): boolean =>
  typeof shell === "string" && /^(?:pwsh|powershell)(?:\s|$)/u.test(shell);

const hasBashSyntax = (command: string, shell: unknown): boolean =>
  BASH_ONLY_SYNTAX.some((pattern) => pattern.test(command)) ||
  (!isPowerShell(shell) &&
    POWERSHELL_AMBIGUOUS_SYNTAX.some((pattern) => pattern.test(command)));

const isBash = (shell: unknown): boolean =>
  typeof shell === "string" && /^bash(?:\s|$)/u.test(shell);

const isDefaultBash = (shell: unknown): boolean => shell === "bash";

const matrixValues = (job: Record<string, unknown>): unknown[] => {
  const strategy = record(job["strategy"]) ? job["strategy"] : undefined;
  const matrix = record(strategy?.["matrix"]) ? strategy["matrix"] : undefined;
  if (matrix === undefined) {
    return [];
  }
  return Object.values(matrix).flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
};

const canRunOnWindows = (job: Record<string, unknown>): boolean => {
  const runner = job["runs-on"];
  const candidates = [runner, ...matrixValues(job)].flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  if (
    candidates.some((value) => String(value).toLowerCase().includes("windows"))
  ) {
    return true;
  }
  return !candidates.every((value) =>
    /(?:ubuntu|macos)-/u.test(String(value).toLowerCase()),
  );
};

export const checkWorkflowSource = (
  file: string,
  source: string,
): WorkflowShellError[] => {
  const parsed = Bun.YAML.parse(source);
  if (!record(parsed)) {
    throw new WorkflowShellInvariantError(`Expected YAML object in ${file}`);
  }
  const errors: WorkflowShellError[] = [];
  const workflowDefaults = runDefaults(parsed["defaults"]);
  if (workflowDefaults.malformed) {
    errors.push({
      file,
      line: lineOf(source, "defaults:"),
      message: "defaults and defaults.run must be mappings",
    });
  }
  const workflowShell = workflowDefaults.shell;
  if (!isDefaultBash(workflowShell)) {
    errors.push({
      file,
      line: 1,
      message: "workflow must define defaults.run.shell: bash",
    });
  }

  const jobs = record(parsed["jobs"]) ? parsed["jobs"] : {};
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    if (!record(rawJob) || rawJob["uses"] !== undefined) {
      continue;
    }
    const job = rawJob;
    const jobDefaults = runDefaults(job["defaults"]);
    if (jobDefaults.malformed) {
      errors.push({
        file,
        line: lineOf(source, "defaults:"),
        message: `${jobName}: defaults and defaults.run must be mappings`,
      });
    }
    const jobShell = jobDefaults.shell;
    if (jobShell !== undefined && !isDefaultBash(jobShell)) {
      errors.push({
        file,
        line: lineOf(source, "defaults:"),
        message: `${jobName}: defaults.run.shell must be exactly bash`,
      });
    }
    const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
    for (const rawStep of steps) {
      if (!record(rawStep)) {
        continue;
      }
      const step = rawStep;
      const run = step["run"];
      if (typeof run !== "string") {
        continue;
      }
      const name = typeof step["name"] === "string" ? step["name"] : jobName;
      const effectiveShell = step["shell"] ?? jobShell ?? workflowShell;
      const line = lineOf(source, `name: ${name}`);
      if (canRunOnWindows(job) && effectiveShell === undefined) {
        errors.push({
          file,
          line,
          message: `${name}: Windows-capable run step needs an applicable shell; add defaults.run.shell: bash or an explicit shell`,
        });
      }
      if (hasBashSyntax(run, effectiveShell) && !isBash(effectiveShell)) {
        errors.push({
          file,
          line,
          message: `${name}: bash syntax requires an effective bash shell; add shell: bash`,
        });
      }
    }
  }
  return errors;
};

export const checkCompositeSource = (
  file: string,
  source: string,
): WorkflowShellError[] => {
  const parsed = Bun.YAML.parse(source);
  if (!record(parsed)) {
    throw new WorkflowShellInvariantError(`Expected YAML object in ${file}`);
  }
  const runs = record(parsed["runs"]) ? parsed["runs"] : undefined;
  const steps = runs?.["steps"];
  if (!Array.isArray(steps)) {
    return [];
  }
  return steps.flatMap((rawStep) => {
    if (!record(rawStep)) {
      return [];
    }
    const step = rawStep;
    const run = step["run"];
    if (typeof run !== "string") {
      return [];
    }
    const name = typeof step["name"] === "string" ? step["name"] : "run step";
    const line = lineOf(source, `name: ${name}`);
    if (typeof step["shell"] !== "string" || step["shell"].trim() === "") {
      return [
        {
          file,
          line,
          message: `${name}: composite run step must declare shell explicitly`,
        },
      ];
    }
    if (hasBashSyntax(run, step["shell"]) && !isBash(step["shell"])) {
      return [
        { file, line, message: `${name}: bash syntax requires shell: bash` },
      ];
    }
    return [];
  });
};

export const checkWorkflowShells = (root: string): WorkflowShellError[] => {
  const workflows = new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
    cwd: root,
  });
  const actions = new Bun.Glob(".github/actions/**/action.{yml,yaml}").scanSync(
    {
      cwd: root,
    },
  );
  return [
    ...[...workflows].flatMap((file) =>
      checkWorkflowSource(file, readFileSync(path.join(root, file), "utf-8")),
    ),
    ...[...actions].flatMap((file) =>
      checkCompositeSource(file, readFileSync(path.join(root, file), "utf-8")),
    ),
  ].toSorted((left, right) =>
    compareCodeUnit(`${left.file}:${left.line}`, `${right.file}:${right.line}`),
  );
};

if (import.meta.main) {
  const errors = checkWorkflowShells(process.cwd());
  for (const error of errors) {
    process.stderr.write(`${error.file}:${error.line}: ${error.message}\n`);
  }
  if (errors.length > 0) {
    process.exit(1);
  }
}
