import { readFileSync } from "node:fs";
import path from "node:path";

import { VerifyError } from "./verify-error";
import { flattenWorkflowSteps } from "./workflow-steps";

export type VerifyWorkflowMode = "verify" | "autofix";
export type VerifyWorkflowPhase = "prepare" | "check";
export type VerifyWorkflowStep = {
  job: string;
  name: string;
  run: string;
  cwd: string;
  env: Record<string, string>;
  phase: VerifyWorkflowPhase;
};

// The runner supplies these from the local checkout and authenticated gh session.
const LOCAL_CONTEXT_KEYS = new Set([
  "GENERATOR_IDS",
  "AFFECTED_FLAG",
  "BASE_REF",
  "BASE_SHA",
  "HEAD_SHA",
  "EVENT_NAME",
  "CHECK_BASE_REF",
  "RATCHET_BASE_REF",
  "MERGE_GROUP_BASE_SHA",
  "GREEN_BASE",
  "REPOSITORY",
  "GH_TOKEN",
]);
const VERIFY_MARKER = "STELLA_VERIFY";
const AUTOFIX_MARKER = "STELLA_LOCAL_AUTOFIX";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new VerifyError(`${label} must be an object`);
  }
  return value;
};

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VerifyError(`${label} must be a non-empty string`);
  }
  return value;
};

const staticString = (value: unknown, label: string): string => {
  const text = requiredString(value, label);
  if (text.includes("${{")) {
    throw new VerifyError(`${label} must not contain GitHub expressions`);
  }
  return text;
};

const runDefaults = (
  owner: Record<string, unknown>,
  label: string,
): Record<string, unknown> => {
  if (owner["defaults"] === undefined) {
    return {};
  }
  const defaults = record(owner["defaults"], `${label} defaults`);
  return defaults["run"] === undefined
    ? {}
    : record(defaults["run"], `${label} defaults.run`);
};

const phaseFromMarker = (
  value: unknown,
  mode: VerifyWorkflowMode,
  label: string,
): VerifyWorkflowPhase => {
  switch (mode) {
    case "verify":
      if (value === "prepare" || value === "check") {
        return value;
      }
      throw new VerifyError(
        `${label} ${VERIFY_MARKER} must be 'prepare' or 'check'`,
      );
    case "autofix":
      if (value === "true") {
        return "prepare";
      }
      throw new VerifyError(
        `${label} ${AUTOFIX_MARKER} must be the string 'true'`,
      );
    default:
      mode satisfies never;
      throw new VerifyError(`Unknown workflow mode: ${String(mode)}`);
  }
};

const modeMarker = (mode: VerifyWorkflowMode): string => {
  switch (mode) {
    case "verify":
      return VERIFY_MARKER;
    case "autofix":
      return AUTOFIX_MARKER;
    default:
      mode satisfies never;
      throw new VerifyError(`Unknown workflow mode: ${String(mode)}`);
  }
};

type WorkflowJob = {
  job: string;
  definition: Record<string, unknown>;
  steps: Record<string, unknown>[];
};
type ParsedWorkflow = {
  workflow: Record<string, unknown>;
  jobs: WorkflowJob[];
};
const parseWorkflowJobs = (source: string): ParsedWorkflow => {
  const parsed: unknown = Bun.YAML.parse(source);
  const workflow = record(parsed, "Workflow");
  const jobs: WorkflowJob[] = [];
  for (const [job, jobValue] of Object.entries(
    record(workflow["jobs"], "Workflow jobs"),
  )) {
    const definition = record(jobValue, `Job ${job}`);
    const steps = definition["steps"];
    if (steps === undefined) {
      continue;
    }
    if (!Array.isArray(steps)) {
      throw new VerifyError(`Job ${job} steps must be an array`);
    }
    jobs.push({ job, definition, steps: flattenWorkflowSteps(steps) });
  }
  return { workflow, jobs };
};

type MarkedStepOptions = {
  step: Record<string, unknown>;
  marker: string;
  label: string;
};
const isMarked = ({ step, marker, label }: MarkedStepOptions): boolean =>
  step["env"] !== undefined &&
  Object.hasOwn(record(step["env"], `${label} env`), marker);

/** Step markers select commands; workflow and job env remain CI-only context. */
export const parseVerifyWorkflow = (
  source: string,
  mode: VerifyWorkflowMode,
): VerifyWorkflowStep[] => {
  const marker = modeMarker(mode);
  const { workflow, jobs } = parseWorkflowJobs(source);
  const selected: VerifyWorkflowStep[] = [];
  for (const { job, definition, steps } of jobs) {
    for (const [index, step] of steps.entries()) {
      const label = `Job ${job} step ${index + 1}`;
      if (!isMarked({ step, marker, label })) {
        continue;
      }
      const environment = record(step["env"], `${label} env`);
      const phase = phaseFromMarker(environment[marker], mode, label);
      const name = staticString(step["name"], `${label} name`);
      const run = staticString(step["run"], `${label} run`);
      if (step["uses"] !== undefined) {
        throw new VerifyError(`${label} marked steps must use run, not uses`);
      }
      const inherited = {
        ...runDefaults(workflow, "Workflow"),
        ...runDefaults(definition, `Job ${job}`),
      };
      const shell = step["shell"] ?? inherited["shell"] ?? "bash";
      if (shell !== "bash") {
        throw new VerifyError(`${label} shell must be bash`);
      }
      const cwd = staticString(
        step["working-directory"] ?? inherited["working-directory"] ?? ".",
        `${label} working-directory`,
      );
      const envEntries: [string, string][] = [];
      for (const [key, value] of Object.entries(environment)) {
        if (key === marker) {
          continue;
        }
        if (typeof value !== "string") {
          throw new VerifyError(`${label} env ${key} must be a string`);
        }
        if (LOCAL_CONTEXT_KEYS.has(key)) {
          continue;
        }
        if (value.includes("${{")) {
          throw new VerifyError(
            `${label} env ${key} must not contain GitHub expressions`,
          );
        }
        envEntries.push([key, value]);
      }
      const env = Object.fromEntries(envEntries);
      selected.push({ job, name, run, cwd, env, phase });
    }
  }
  return [
    ...selected.filter(({ phase }) => phase === "prepare"),
    ...selected.filter(({ phase }) => phase === "check"),
  ];
};

const RUNNER_TEMP_ENTRY = /RUNNER_TEMP\}?"?\/([A-Za-z0-9._-]+)/gu;
const CI_ONLY_ARM =
  /^([ \t]*)if \[\[ "\$\{STELLA_VERIFY_LOCAL:-false\}" == true \]\]; then\n([\s\S]*?)^\1else\n[\s\S]*?^\1fi$/gmu;

/**
 * `RUNNER_TEMP` entries that marked steps use but an unmarked step of the
 * same job touches first. In CI the unmarked step creates the entry; the
 * local runner skips unmarked steps, so it must create the entry itself.
 * The `else` arm of an exact `STELLA_VERIFY_LOCAL` branch never runs locally,
 * so it is ignored; everything else in a marked step is scanned.
 */
export const parseHarnessRunnerTempEntries = (
  source: string,
  mode: VerifyWorkflowMode,
): string[] => {
  const marker = modeMarker(mode);
  const entries = new Set<string>();
  for (const { job, steps } of parseWorkflowJobs(source).jobs) {
    const firstUseMarked = new Map<string, boolean>();
    const used = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const run = step["run"];
      if (typeof run !== "string") {
        continue;
      }
      const marked = isMarked({
        step,
        marker,
        label: `Job ${job} step ${index + 1}`,
      });
      const scanned = marked ? run.replaceAll(CI_ONLY_ARM, "$2") : run;
      for (const match of scanned.matchAll(RUNNER_TEMP_ENTRY)) {
        const name = match[1];
        if (name === undefined) {
          continue;
        }
        if (!firstUseMarked.has(name)) {
          firstUseMarked.set(name, marked);
        }
        if (marked) {
          used.add(name);
        }
      }
    }
    for (const name of used) {
      if (firstUseMarked.get(name) === false) {
        entries.add(name);
      }
    }
  }
  return [...entries].toSorted();
};

type ReadVerifyWorkflowOptions = {
  root: string;
  mode: VerifyWorkflowMode;
};

const readWorkflowSource = ({ root, mode }: ReadVerifyWorkflowOptions) =>
  readFileSync(
    path.join(
      root,
      ".github/workflows",
      mode === "verify" ? "ci.yml" : "autofix.yml",
    ),
    "utf-8",
  );

export const readVerifyWorkflow = (options: ReadVerifyWorkflowOptions) =>
  parseVerifyWorkflow(readWorkflowSource(options), options.mode);

export const readHarnessRunnerTempEntries = (
  options: ReadVerifyWorkflowOptions,
) => parseHarnessRunnerTempEntries(readWorkflowSource(options), options.mode);
