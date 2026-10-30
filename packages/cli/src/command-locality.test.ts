import { describe, expect, test } from "bun:test";

import {
  argumentsBeforeTerminator,
  commandNeedsRegistry,
} from "./command-locality.js";

describe("commandNeedsRegistry", () => {
  test("local hand-wired routes never need the registry", () => {
    expect(commandNeedsRegistry(["auth", "login"])).toBe(false);
    expect(commandNeedsRegistry(["auth", "whoami"])).toBe(false);
    expect(commandNeedsRegistry(["tools", "list"])).toBe(false);
    expect(commandNeedsRegistry(["compatibility", "check"])).toBe(false);
    expect(commandNeedsRegistry(["upload", "--file", "contract.txt"])).toBe(
      false,
    );
  });

  test("the root invocation and global flags stay local", () => {
    expect(commandNeedsRegistry([])).toBe(false);
    expect(commandNeedsRegistry(["--help"])).toBe(false);
    expect(commandNeedsRegistry(["--version"])).toBe(false);
    expect(commandNeedsRegistry(["-h"])).toBe(false);
  });

  test("generated domain commands and reference commands need the registry", () => {
    expect(commandNeedsRegistry(["matter", "list"])).toBe(true);
    expect(commandNeedsRegistry(["usage", "get"])).toBe(true);
    expect(commandNeedsRegistry(["reference", "get"])).toBe(true);
  });
});

test("startup argument scanning stops at the first positional terminator", () => {
  for (const suffix of [
    [],
    ["--help"],
    ["--version"],
    ["--schema"],
    ["--", "-h"],
  ]) {
    expect(
      argumentsBeforeTerminator(["tasks", "create", "--", ...suffix]),
    ).toEqual(["tasks", "create"]);
  }
  expect(
    argumentsBeforeTerminator(["tasks", "--help", "--", "create"]),
  ).toEqual(["tasks", "--help"]);
  expect(argumentsBeforeTerminator(["update"])).toEqual(["update"]);
  expect(argumentsBeforeTerminator([])).toEqual([]);
});
