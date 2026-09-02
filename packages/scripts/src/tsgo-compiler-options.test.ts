import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

import {
  TSGO_ONLY_COMPILER_OPTIONS,
  withoutTsgoOnlyOptionDiagnostics,
} from "./tsgo-compiler-options";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const NO_INPUTS_DIAGNOSTIC_CODE = 18_003;

const parseErrors = (compilerOptions: Record<string, unknown>) =>
  ts.parseJsonConfigFileContent(
    { compilerOptions, files: ["a.ts"] },
    ts.sys,
    "/",
  ).errors;

const messages = (diagnostics: readonly ts.Diagnostic[]) =>
  diagnostics.map(({ messageText }) =>
    ts.flattenDiagnosticMessageText(messageText, "\n"),
  );

test.each([...TSGO_ONLY_COMPILER_OPTIONS])(
  "%s is still unknown to the JavaScript parser, and is excused",
  (option) => {
    const errors = parseErrors({ [option]: 1 });

    // A listed option the JavaScript parser has since learned is stale, so the
    // list cannot rot into excusing diagnostics nothing produces any more.
    expect(messages(errors)).toEqual([
      expect.stringContaining(`Unknown compiler option '${option}'`),
    ]);
    expect(withoutTsgoOnlyOptionDiagnostics(errors)).toEqual([]);
  },
);

test("a misspelled option still fails", () => {
  const errors = parseErrors({ chekcers: 1 });

  expect(messages(withoutTsgoOnlyOptionDiagnostics(errors))).toEqual([
    expect.stringContaining("Unknown compiler option 'chekcers'"),
  ]);
});

test("the shared base config is valid once tsgo-only options are excused", () => {
  const configPath = path.join(
    REPO_ROOT,
    "packages/typescript-config/base.json",
  );
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );

  // base.json declares no inputs of its own; only the option diagnostic is
  // this test's subject.
  const errors = parsed.errors.filter(
    ({ code }) => code !== NO_INPUTS_DIAGNOSTIC_CODE,
  );

  expect(messages(errors)).toEqual([
    expect.stringContaining("Unknown compiler option 'checkers'"),
  ]);
  expect(withoutTsgoOnlyOptionDiagnostics(errors)).toEqual([]);
});
