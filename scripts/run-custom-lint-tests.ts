import { panic } from "better-result";

import { partitionRunnerArguments } from "../apps/api/scripts/test-path-filters";
import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { repoRoot } from "./oxlint-config-scopes";

// Subprocess cases measured a passing maximum of 15.814s under CI contention.
const CUSTOM_LINT_TEST_TIMEOUT_MS = 30_000;
const TEST_DIRECTORY = "./.oxlint-plugins/__tests__";

export const customLintTestCommand = (args: readonly string[] = []) => {
  if (
    args.some(
      (argument) =>
        argument === "--timeout" || argument.startsWith("--timeout="),
    )
  ) {
    panic("Custom lint test timeouts are owned by the shared runner");
  }
  const { patterns } = partitionRunnerArguments(args);
  const paths = patterns.length > 0 ? args : [...args, TEST_DIRECTORY];
  return [
    process.execPath,
    "test",
    "--timeout",
    String(CUSTOM_LINT_TEST_TIMEOUT_MS),
    ...paths,
  ];
};

if (import.meta.main) {
  const result = Bun.spawnSync(customLintTestCommand(Bun.argv.slice(2)), {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(childExitStatus(result));
}
