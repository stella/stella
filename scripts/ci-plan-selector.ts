// The path-scope selector of ci.yml's `ci-plan` job, runnable outside CI.
// The workflow is the only copy of the selection rules: this module slices
// them out of a given ci.yml and runs them over a list of changed files, so
// the plan tests evaluate exactly what CI would.

import { panic, Result, TaggedError } from "better-result";

const SELECTOR_START = "          # Path scopes for the build/smoke jobs";
const SELECTOR_END = "          printf 'Changed files:";
const OUTPUT_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/u;
const VALUES_MARKER = "--- ci-plan-selector values ---";

export const extractPlanSelector = (workflowSource: string): string => {
  const start = workflowSource.indexOf(SELECTOR_START);
  const end = workflowSource.indexOf(SELECTOR_END, start);
  if (start === -1 || end <= start) {
    panic("ci.yml no longer marks the ci-plan path-scope selector");
  }
  return workflowSource.slice(start, end);
};

export class PlanSelectorError extends TaggedError("PlanSelectorError")<{
  message: string;
}> {}

type RunPlanSelectorOptions = {
  selector: string;
  files: readonly string[];
  // Selector variables to print, one line each, in this order.
  outputs: readonly string[];
  // Directory the selector's detector scripts run from: a repository root.
  cwd: string;
  suiteDepth?: string;
  // Detected from the files when omitted.
  e2eLandingRequired?: string;
  event?: string;
  title?: string;
};

/**
 * The preamble stands in for the lines ci.yml runs before the selector:
 * the preliminary detectors it calls. Package selection runs from the workflow.
 */
export const runPlanSelector = ({
  selector,
  files,
  outputs,
  cwd,
  suiteDepth = "fast",
  e2eLandingRequired,
  event = "pull_request",
  title = "",
}: RunPlanSelectorOptions) => {
  const invalid = outputs.find((output) => !OUTPUT_NAME_PATTERN.test(output));
  if (invalid !== undefined) {
    panic(`Not a selector variable name: ${invalid}`);
  }
  const process = Bun.spawnSync({
    cmd: [
      "bash",
      "-e",
      "-c",
      `changed_files=("$@"); e2e_core_required=$(bash scripts/detect-e2e-changes.sh core "$@")
e2e_landing_required=\${E2E_LANDING_REQUIRED:-$(bash scripts/detect-e2e-changes.sh landing "$@")}
desktop_rust_checks_required=$(bash scripts/detect-tauri-rust-changes.sh "$@")
${selector}
printf "%s\\n" "${VALUES_MARKER}" ${outputs.map((output) => `"$${output}"`).join(" ")}`,
      "ci-plan-selector",
      ...files,
    ],
    cwd,
    env: {
      E2E_LANDING_REQUIRED: e2eLandingRequired ?? "",
      EVENT_NAME: event,
      PATH: Bun.env["PATH"] ?? "",
      PR_TITLE: title,
      SUITE_DEPTH: suiteDepth,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) {
    return Result.err(
      new PlanSelectorError({
        message: `ci-plan selector exited ${process.exitCode}: ${new TextDecoder().decode(process.stderr)}`,
      }),
    );
  }
  // Anything the selector itself prints precedes the marker; a value that
  // spans lines changes the count. Either way the values are not a plan.
  const lines = new TextDecoder().decode(process.stdout).split("\n");
  const values = lines.slice(lines.lastIndexOf(VALUES_MARKER) + 1, -1);
  if (!lines.includes(VALUES_MARKER) || values.length !== outputs.length) {
    return Result.err(
      new PlanSelectorError({
        message: `ci-plan selector printed ${values.length} value(s) for ${outputs.length} output(s)`,
      }),
    );
  }
  return Result.ok(
    new Map(
      outputs.map((output, index) => [
        output,
        values[index] ?? panic("unreachable: the count matches the outputs"),
      ]),
    ),
  );
};

/**
 * Selector outputs read as path scopes. A scope that is not exactly "true"
 * or "false" (unset, empty, or garbled) fails the run instead of reading as
 * an unselected job.
 */
export const runPlanScopes = (options: RunPlanSelectorOptions) =>
  runPlanSelector(options).andThen((values) => {
    const scopes = new Map<string, boolean>();
    for (const [output, value] of values) {
      if (value !== "true" && value !== "false") {
        return Result.err(
          new PlanSelectorError({
            message: `ci-plan selector set ${output} to ${JSON.stringify(value)}, not true or false`,
          }),
        );
      }
      scopes.set(output, value === "true");
    }
    return Result.ok(scopes);
  });
