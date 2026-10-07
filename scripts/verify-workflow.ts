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
  "EVENT_NAME",
  "CHECK_BASE_REF",
  "RATCHET_BASE_REF",
  "MERGE_GROUP_BASE_SHA",
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

/** Step markers select commands; workflow and job env remain CI-only context. */
export const parseVerifyWorkflow = (
  source: string,
  mode: VerifyWorkflowMode,
): VerifyWorkflowStep[] => {
  if (mode !== "verify" && mode !== "autofix") {
    throw new VerifyError(`Unknown workflow mode: ${String(mode)}`);
  }
  const parsed: unknown = Bun.YAML.parse(source);
  const workflow = record(parsed, "Workflow");
  const jobs = record(workflow["jobs"], "Workflow jobs");
  const selected: VerifyWorkflowStep[] = [];
  const marker = mode === "verify" ? VERIFY_MARKER : AUTOFIX_MARKER;
  for (const [job, jobValue] of Object.entries(jobs)) {
    const definition = record(jobValue, `Job ${job}`);
    const steps = definition["steps"];
    if (steps === undefined) {
      continue;
    }
    if (!Array.isArray(steps)) {
      throw new VerifyError(`Job ${job} steps must be an array`);
    }
    for (const [index, step] of flattenWorkflowSteps(steps).entries()) {
      const label = `Job ${job} step ${index + 1}`;
      if (step["env"] === undefined) {
        continue;
      }
      const environment = record(step["env"], `${label} env`);
      if (!Object.hasOwn(environment, marker)) {
        continue;
      }
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

type ReadVerifyWorkflowOptions = {
  root: string;
  mode: VerifyWorkflowMode;
};

export const readVerifyWorkflow = ({ root, mode }: ReadVerifyWorkflowOptions) =>
  parseVerifyWorkflow(
    readFileSync(
      path.join(
        root,
        ".github/workflows",
        mode === "verify" ? "ci.yml" : "autofix.yml",
      ),
      "utf-8",
    ),
    mode,
  );
