import { ExitCode as StricliExitCode } from "@stricli/core";
import { describe, expect, test } from "bun:test";

import {
  CliCommandError,
  determineCommandExitCode,
  normalizeProcessExitCode,
} from "./cli-exit-code.js";
import { EXIT_CODES } from "./mcp-constants.js";

describe("normalizeProcessExitCode", () => {
  test("stricli's unknown-command and bad-flag codes become usage errors, raw or folded", () => {
    for (const code of [
      StricliExitCode.UnknownCommand,
      StricliExitCode.InvalidArgument,
    ]) {
      expect(normalizeProcessExitCode(code)).toBe(EXIT_CODES.validation);
      expect(normalizeProcessExitCode(code + 256)).toBe(EXIT_CODES.validation);
    }
  });

  test("other stricli internals become unexpected errors", () => {
    expect(normalizeProcessExitCode(StricliExitCode.InternalError)).toBe(
      EXIT_CODES.unexpected,
    );
    expect(normalizeProcessExitCode(StricliExitCode.CommandLoadError)).toBe(
      EXIT_CODES.unexpected,
    );
  });

  test("codes on the contract pass through", () => {
    for (const code of Object.values(EXIT_CODES)) {
      expect(normalizeProcessExitCode(code)).toBe(code);
    }
    expect(normalizeProcessExitCode(undefined)).toBeUndefined();
  });
});

describe("determineCommandExitCode", () => {
  test("a tagged command error keeps its class", () => {
    expect(
      determineCommandExitCode(new CliCommandError("nope", EXIT_CODES.auth)),
    ).toBe(EXIT_CODES.auth);
  });

  test("an untagged throw is an unexpected error", () => {
    expect(determineCommandExitCode(new Error("boom"))).toBe(
      EXIT_CODES.unexpected,
    );
  });
});
