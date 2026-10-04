import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RECEIVER_TYPED_AUTOFIX_RULES,
  lintCommand,
  runPrecommitLint,
} from "./precommit-lint";

// Every test runs oxlint; the control runs it once per listed rule, which
// passes the 5 s default on a busy CI runner.
setDefaultTimeout(60_000);

const ROOT = path.resolve(import.meta.dir, "..");
// Inside the repository so oxlint.config.ts applies exactly as in the hook.
const DIR = path.join("scripts", `__precommit_lint_${process.pid}__`);

// One fixture per rule whose autofix assumes a receiver type. Each is valid
// code the fix would break or change.
const RECEIVER_FIXTURES: Record<
  (typeof RECEIVER_TYPED_AUTOFIX_RULES)[number],
  string
> = {
  "unicorn/prefer-regexp-test": [
    "export const matches = (include: string, name: string): boolean => {",
    "  if (new Bun.Glob(include).match(name)) {",
    "    return true;",
    "  }",
    "  return false;",
    "};",
  ].join("\n"),
  "unicorn/prefer-string-starts-ends-with": [
    "export const startsWithA = (value: number): boolean => /^a/u.test(String(value));",
  ].join("\n"),
  "unicorn/prefer-string-slice": [
    "type Cursor = { substr: (start: number) => string };",
    "export const rest = (cursor: Cursor): string => cursor.substr(1);",
  ].join("\n"),
  "unicorn/prefer-array-flat-map": [
    "type Lines = { map: (fn: (line: number) => number) => { flat: () => number[] } };",
    "export const spread = (lines: Lines): number[] => lines.map((line) => line).flat();",
  ].join("\n"),
  "unicorn/prefer-at": [
    "type Row = { length: number; [index: number]: number };",
    "export const last = (row: Row): number | undefined => row[row.length - 1];",
  ].join("\n"),
  "unicorn/no-unnecessary-slice-end": [
    "type Text = { length: number; slice: (start: number, end: number) => string };",
    "export const tail = (text: Text): string => text.slice(1, text.length);",
  ].join("\n"),
  "unicorn/no-length-as-slice-end": [
    "type Chars = { length: number; slice: (start: number, end: number) => string };",
    "export const after = (chars: Chars): string => chars.slice(2, chars.length);",
  ].join("\n"),
  "unicorn/prefer-dom-node-text-content": [
    "export const visibleText = (element: HTMLElement): string => element.innerText;",
  ].join("\n"),
  "unicorn/no-typeof-undefined": [
    'export const hasValue = (value: unknown): boolean => typeof value === "undefined";',
  ].join("\n"),
};

const fixturePath = (name: string) =>
  path.join(DIR, `${name.replaceAll("/", "__")}.ts`);

const writeFixture = (name: string, body: string): string => {
  const file = fixturePath(name);
  writeFileSync(path.join(ROOT, file), `${body}\n`);
  return file;
};

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf-8");

beforeAll(() => {
  mkdirSync(path.join(ROOT, DIR), { recursive: true });
});

afterAll(() => {
  rmSync(path.join(ROOT, DIR), { recursive: true, force: true });
});

describe("pre-commit lint", () => {
  test("the CLI preserves lint exit codes and fails when lint is terminated by a signal", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "precommit-lint-exit-"));
    const source = "export const answer = 42;\n";
    writeFileSync(path.join(directory, "fixture.ts"), source);
    writeFileSync(
      path.join(directory, "bun"),
      '#!/bin/sh\ncase "$LINT_EXIT" in\n  signal) kill -TERM $$ ;;\n  *) exit "$LINT_EXIT" ;;\nesac\n',
      { mode: 0o755 },
    );
    try {
      for (const { lintExit, expectedExit } of [
        { lintExit: "0", expectedExit: 0 },
        { lintExit: "2", expectedExit: 2 },
        { lintExit: "signal", expectedExit: 1 },
      ]) {
        const result = Bun.spawnSync(
          [
            process.execPath,
            path.join(ROOT, "scripts/precommit-lint.ts"),
            "fixture.ts",
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              PATH: `${directory}:${process.env["PATH"] ?? ""}`,
              LINT_EXIT: lintExit,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(
          result.exitCode,
          `${lintExit}: ${result.stderr.toString()}`,
        ).toBe(expectedExit);
        expect(readFileSync(path.join(directory, "fixture.ts"), "utf-8")).toBe(
          source,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the fix pass leaves code whose receiver type a fix would assume untouched", () => {
    const files = Object.entries(RECEIVER_FIXTURES).map(([rule, body]) =>
      writeFixture(rule, body),
    );
    const before = files.map(read);
    const result = runPrecommitLint(files, { cwd: ROOT });
    expect(result.changed).toEqual([]);
    expect(files.map(read)).toEqual(before);
  });

  test("each listed rule, run alone, rewrites its fixture", () => {
    // Guards the list itself: a renamed rule or one that no longer autofixes
    // would make its entry dead weight, and a fixture another rule rewrites
    // would prove nothing about this one.
    for (const [rule, body] of Object.entries(RECEIVER_FIXTURES)) {
      const file = writeFixture(`control-${rule}`, body);
      Bun.spawnSync(
        ["bun", "--bun", "oxlint", "--fix", "-A", "all", "-D", rule, file],
        { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
      );
      expect(read(file), rule).not.toBe(`${body}\n`);
    }
  });

  test("the hook command turns off every listed rule and still fixes", () => {
    const command = lintCommand(["a.ts"]);
    for (const rule of RECEIVER_TYPED_AUTOFIX_RULES) {
      expect(command[command.indexOf(rule) - 1], rule).toBe("-A");
    }
    expect(command).toContain("--fix");
    expect(command.at(-1)).toBe("a.ts");
  });

  test("Bun.Glob#match still works after the pre-commit pass", async () => {
    const file = writeFixture(
      "glob-runtime",
      RECEIVER_FIXTURES["unicorn/prefer-regexp-test"],
    );
    runPrecommitLint([file], { cwd: ROOT });
    const loaded: unknown = await import(path.join(ROOT, file));
    const matches =
      typeof loaded === "object" && loaded !== null && "matches" in loaded
        ? loaded.matches
        : undefined;
    expect(matches).toBeFunction();
    if (typeof matches === "function") {
      expect(matches("*.ts", "a.ts")).toBe(true);
      expect(matches("*.ts", "a.js")).toBe(false);
    }
  });

  test("a would-be autofix fails the hook, prints it and leaves the file as staged", () => {
    // lefthook stages the files of every stage_fixed step when the hook ends,
    // whatever order the steps ran in, so only an unmodified file is safe.
    const body = "export const now = (): number => new Date().getTime();";
    const file = writeFixture("safe-fix", body);
    const result = runPrecommitLint([file], { cwd: ROOT });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toEqual([file]);
    expect(read(file)).toBe(`${body}\n`);
    expect(result.diff).toContain(`--- a/${file}`);
    expect(result.diff).toContain(`+++ b/${file}`);
    expect(result.diff).toContain(`-${body}`);
    expect(result.diff).toContain(
      "+export const now = (): number => Date.now();",
    );
  });

  test("--apply leaves the fix in the working tree for review", () => {
    const body = "export const later = (): number => new Date().getTime() + 1;";
    const file = writeFixture("apply-fix", body);
    const result = runPrecommitLint([file], { cwd: ROOT, apply: true });
    expect(result.changed).toEqual([file]);
    expect(read(file)).toBe(
      "export const later = (): number => Date.now() + 1;\n",
    );
  });

  test("a clean file passes", () => {
    const file = writeFixture(
      "clean",
      "export const double = (value: number): number => value * 2;",
    );
    expect(runPrecommitLint([file], { cwd: ROOT })).toEqual({
      exitCode: 0,
      changed: [],
      diff: "",
    });
  });

  test("a staged deletion is not reported as changed", () => {
    const missing = path.join(DIR, "deleted.ts");
    expect(runPrecommitLint([missing], { cwd: ROOT }).changed).toEqual([]);
  });

  test("lefthook runs this script on the staged text", () => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const config: unknown = Bun.YAML.parse(
      readFileSync(path.join(ROOT, "lefthook.yml"), "utf-8"),
    );
    const preCommit = isRecord(config) ? config["pre-commit"] : undefined;
    const commands = isRecord(preCommit) ? preCommit["commands"] : undefined;
    expect(isRecord(commands)).toBe(true);
    const { lint, ...others } = isRecord(commands) ? commands : {};
    expect(isRecord(lint) ? lint["run"] : undefined).toBe(
      "bun scripts/precommit-lint.ts {staged_files}",
    );
    // lefthook hides unstaged changes only while a stage_fixed command runs;
    // lint must see what the commit records, and it never leaves a change.
    expect(isRecord(lint) ? lint["stage_fixed"] : undefined).toBe(true);
    for (const command of Object.values(others)) {
      expect(isRecord(command) ? String(command["run"]) : "").not.toContain(
        "oxlint",
      );
    }
  });
});
