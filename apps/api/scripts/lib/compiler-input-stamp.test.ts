import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import {
  type CompilerInputStamp,
  compilerInputStampSchema,
  createCompilerInputRecorder,
  isCompilerInputStampCurrent,
  scriptSourceHash,
} from "./compiler-input-stamp";

const CONTEXT = "context";
let directory = "";

const write = (file: string, source: string) => {
  const destination = path.join(directory, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
};

// Builds a small program the way the generator does: a parsed tsconfig and a
// default compiler host, both routed through the recorder.
const recordProgram = (): CompilerInputStamp => {
  const recorder = createCompilerInputRecorder();
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(directory, "tsconfig.json"),
    {},
    recorder.wrap({
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        throw new Error("unreadable tsconfig");
      },
    }),
  );
  if (config === undefined) {
    throw new Error("tsconfig not parsed");
  }
  const host = recorder.wrap(ts.createCompilerHost(config.options));
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    host,
  });
  expect(program.getSourceFile(path.join(directory, "src/b.ts"))).toBeDefined();
  // Stored as JSON, so the replay must accept what JSON gives back (an
  // omitted argument comes back as null).
  const stored = JSON.stringify(recorder.stamp(CONTEXT));
  return v.parse(compilerInputStampSchema, JSON.parse(stored));
};

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "compiler-input-stamp-"));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  write("src/a.ts", 'import type { B } from "./b";\nexport type A = B;\n');
  write("src/b.ts", "export type B = string;\n");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test("an untouched program is current, without building it again", async () => {
  const stamp = recordProgram();
  expect(Object.keys(stamp.contents)).toContain(
    path.join(directory, "src/b.ts"),
  );
  // Building a program reads every source through ts.sys.readFile; the replay
  // hashes bytes directly and never parses them.
  const readFile = spyOn(ts.sys, "readFile");
  try {
    expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  } finally {
    readFile.mockRestore();
  }
});

test("a different context is not current", async () => {
  expect(await isCompilerInputStampCurrent(recordProgram(), "other")).toBe(
    false,
  );
});

test("an edited dependency is not current", async () => {
  const stamp = recordProgram();
  write("src/b.ts", "export type B = number;\n");
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(false);
});

test("an edited tsconfig is not current", async () => {
  const stamp = recordProgram();
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "ESNext", strict: true, types: [] },
      include: ["src"],
    }),
  );
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(false);
});

test("a file that would change module resolution is not current", async () => {
  write("src/c/index.ts", "export type C = string;\n");
  write("src/a.ts", 'import type { C } from "./c";\nexport type A = C;\n');
  const stamp = recordProgram();
  // `./c` now resolves to c.ts before c/index.ts.
  write("src/c.ts", "export type C = number;\n");
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(false);
});

test("a new ambient declaration under the included tree is not current", async () => {
  const stamp = recordProgram();
  write("src/nested/globals.d.ts", "declare const injected: string;\n");
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(false);
});

test("a script's source hash is the same for checkouts at other paths", () => {
  write("tool/main.ts", 'import { helper } from "./lib/helper";\nhelper();\n');
  write("tool/lib/helper.ts", "export const helper = () => 1;\n");
  const moved = path.join(directory, "elsewhere/deeper/tool");
  cpSync(path.join(directory, "tool"), moved, { recursive: true });
  const original = scriptSourceHash(path.join(directory, "tool/main.ts"));
  expect(scriptSourceHash(path.join(moved, "main.ts"))).toBe(original);

  write("tool/lib/helper.ts", "export const helper = () => 2;\n");
  expect(scriptSourceHash(path.join(directory, "tool/main.ts"))).not.toBe(
    original,
  );
});
