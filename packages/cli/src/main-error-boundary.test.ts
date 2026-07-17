import { describe, expect, test } from "bun:test";

import { reportFatalError } from "./main-error-boundary.js";
import { EXIT_CODES } from "./mcp-constants.js";

const makeReporter = () => {
  const stderr: string[] = [];
  return {
    stderr: { write: (text: string) => void stderr.push(text) },
    exitCode: undefined as number | string | null | undefined,
    lines: stderr,
  };
};

describe("reportFatalError", () => {
  test("maps a thrown Error to the unexpected exit code and a stderr line", () => {
    const reporter = makeReporter();
    reportFatalError(new Error("boom"), reporter);
    expect(reporter.exitCode).toBe(EXIT_CODES.unexpected);
    expect(reporter.lines).toEqual(["stella: boom\n"]);
  });

  test("stringifies a non-Error rejection value", () => {
    const reporter = makeReporter();
    reportFatalError("plain string failure", reporter);
    expect(reporter.exitCode).toBe(EXIT_CODES.unexpected);
    expect(reporter.lines).toEqual(["stella: plain string failure\n"]);
  });
});
