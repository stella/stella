import { spawnSync } from "node:child_process";
import path from "node:path";

const workspace = process.env["GITHUB_WORKSPACE"];
const runnerTemp = process.env["RUNNER_TEMP"];
const summary = process.env["GITHUB_STEP_SUMMARY"];

if (!workspace || !runnerTemp || !summary) {
  throw new TypeError(
    "The flaky-test quarantine action requires a GitHub Actions environment.",
  );
}

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
  { cwd: workspace, stdio: "inherit" },
);

// Reporting is observational and must not replace the test job's verdict.
if (result.error) {
  console.warn(`Unable to report quarantined tests: ${result.error.message}`);
} else if (result.status !== 0) {
  console.warn(
    `Unable to report quarantined tests: bun exited ${result.status}.`,
  );
}
