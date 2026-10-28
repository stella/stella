import { appendFileSync } from "node:fs";
import path from "node:path";

const workspace = process.env["GITHUB_WORKSPACE"];
const environmentFile = process.env["GITHUB_ENV"];
const runnerTemp = process.env["RUNNER_TEMP"];

if (!workspace || !environmentFile || !runnerTemp) {
  throw new TypeError(
    "The flaky-test quarantine action requires a GitHub Actions environment.",
  );
}

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
