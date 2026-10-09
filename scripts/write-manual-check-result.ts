import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type ManualCheckResult = {
  version: 1;
  sha: string;
  ref: string;
  check: string;
  target: string;
  exit: number;
  seconds: number;
  failures: string[];
};

type WriteResultOptions = {
  sha: string;
  ref: string;
  check: string;
  target: string;
  exit: number;
  seconds: number;
  log: string;
};

// Compiler and lint errors, `bun test` failures and the validator's refusals.
const FAILURE_LINE = /error|\(fail\)/iu;

// A missing file means the step that writes it never ran.
const readOptional = (file: string | undefined) =>
  file !== undefined && existsSync(file)
    ? readFileSync(file, "utf-8").trim()
    : "";

export const createManualCheckResult = ({
  sha,
  ref,
  check,
  target,
  exit,
  seconds,
  log,
}: WriteResultOptions): ManualCheckResult => ({
  version: 1,
  sha,
  ref,
  check,
  target,
  exit,
  seconds,
  failures: log
    .split(/\r?\n/u)
    .filter((line) => FAILURE_LINE.test(line))
    .slice(0, 20),
});

if (import.meta.main) {
  const result = createManualCheckResult({
    sha: process.env["CHECK_SHA"] ?? "",
    ref: process.env["CHECK_REF"] ?? "",
    check: process.env["CHECK_CHECK"] ?? "",
    target: process.env["CHECK_TARGET"] ?? "",
    exit: Number(readOptional(process.env["CHECK_EXIT_FILE"]) || "1"),
    seconds: Math.max(
      0,
      Math.floor(Date.now() / 1000) -
        Number(
          readOptional(process.env["CHECK_START_FILE"]) ||
            Math.floor(Date.now() / 1000),
        ),
    ),
    log:
      readOptional(process.env["CHECK_LOG_FILE"]) ||
      "error: a setup step failed before the check ran",
  });
  const json = JSON.stringify(result);
  writeFileSync("manual-check-result.json", `${json}\n`);
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    writeFileSync(process.env["GITHUB_STEP_SUMMARY"], `${json}\n`, {
      flag: "a",
    });
  }
}
