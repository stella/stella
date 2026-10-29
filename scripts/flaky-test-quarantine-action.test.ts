import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";

import { createTestState } from "../apps/api/src/tests/helpers/test-state";
import { reportFlakyTestQuarantine } from "./flaky-test-quarantine-action";

const testState = createTestState({ file: import.meta.path, config: {} });

test("history reporting has a deadline and preserves timeout warnings", () => {
  const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
    pid: 0,
    output: [],
    stdout: null,
    stderr: null,
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new TypeError("history deadline exceeded"), {
      code: "ETIMEDOUT",
    }),
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [key, value] of Object.entries({
      GITHUB_WORKSPACE: "/workspace",
      RUNNER_TEMP: "/runner-temp",
      GITHUB_STEP_SUMMARY: "/summary",
      INPUT_TOKEN: "fixture-token",
    })) {
      testState.setEnv(key, value);
    }
    reportFlakyTestQuarantine();
    const options = spawn.mock.calls.at(0)?.at(2);
    expect(
      typeof options === "object" && options !== null && "timeout" in options
        ? options.timeout
        : undefined,
    ).toBe(120_000);
    expect(warning).toHaveBeenCalledWith(
      "Unable to report quarantined tests: history deadline exceeded",
    );
  } finally {
    spawn.mockRestore();
    warning.mockRestore();
  }
});
