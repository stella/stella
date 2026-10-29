import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

// Node runs the action before any dependency install, so this module uses
// built-ins only, like the install-store save action.
class QuarantineActionError extends Error {
  override name = "QuarantineActionError";
  readonly _tag = "QuarantineActionError";
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new QuarantineActionError(
      `The flaky-test quarantine action requires ${name} from GitHub Actions.`,
    );
  }
  return value;
};

export const configureFlakyTestQuarantine = (): void => {
  const workspace = requiredEnvironment("GITHUB_WORKSPACE");
  const environmentFile = requiredEnvironment("GITHUB_ENV");
  const runnerTemp = requiredEnvironment("RUNNER_TEMP");
  const preload = path.join(
    workspace,
    "scripts/flaky-test-quarantine-preload.ts",
  );
  const reportDirectory = path.join(runnerTemp, "flaky-test-quarantine");
  const existingOptions = process.env["BUN_OPTIONS"]?.trim();
  const bunOptions = [existingOptions, `--preload=${preload}`]
    .filter(Boolean)
    .join(" ");

  appendFileSync(
    environmentFile,
    `BUN_OPTIONS=${bunOptions}\nFLAKY_TEST_QUARANTINE_REPORT_DIR=${reportDirectory}\n`,
  );
};

export const reportFlakyTestQuarantine = (): void => {
  const workspace = requiredEnvironment("GITHUB_WORKSPACE");
  const runnerTemp = requiredEnvironment("RUNNER_TEMP");
  const summary = requiredEnvironment("GITHUB_STEP_SUMMARY");
  const token = requiredEnvironment("INPUT_TOKEN");
  const result = spawnSync(
    "bun",
    [
      "scripts/flaky-test-history.ts",
      "job-summary",
      "--reports",
      path.join(runnerTemp, "flaky-test-quarantine"),
      "--summary",
      summary,
    ],
    {
      cwd: workspace,
      stdio: "inherit",
      env: { ...process.env, GH_TOKEN: token },
    },
  );

  // Reporting is observational and must not replace the test job's verdict.
  if (result.error) {
    console.warn(`Unable to report quarantined tests: ${result.error.message}`);
  } else if (result.status !== 0) {
    const status = result.status === null ? "unknown" : String(result.status);
    console.warn(`Unable to report quarantined tests: bun exited ${status}.`);
  }
};
