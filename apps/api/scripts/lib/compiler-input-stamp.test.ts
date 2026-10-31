import { panic } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "tsrs/unstable/async";
import * as v from "valibot";

import {
  type CompilerInputRecorder,
  type CompilerInputStamp,
  compilerInputStampSchema,
  createCompilerInputRecorder,
  isCompilerInputStampCurrent,
  localizeStamp,
  scriptSourceHash,
} from "./compiler-input-stamp";

const CONTEXT = "context";
let directory = "";

const write = (file: string, source: string) => {
  const destination = path.join(directory, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
};

// Builds a program from the directory's tsconfig the way the generator does:
// the TypeScript 7 compiler, asking every question through the recorder.
const buildProgram = async (recorder: CompilerInputRecorder) => {
  const tsconfig = path.join(directory, "tsconfig.json");
  const api = new API({ cwd: directory, fs: recorder.fileSystem() });
  try {
    const snapshot = await api.createSnapshot({ openProjects: [tsconfig] });
    return (
      (await snapshot
        .getConfiguredProject(tsconfig)
        ?.program.getSourceFile(path.join(directory, "src/a.ts"))) !== undefined
    );
  } finally {
    await api.close();
  }
};

const recordProgram = async (): Promise<CompilerInputStamp> => {
  const recorder = createCompilerInputRecorder();
  expect(await buildProgram(recorder)).toBe(true);
  // Stored as JSON, so the replay must accept what JSON gives back.
  const stored = JSON.stringify(recorder.stamp(CONTEXT));
  return v.parse(compilerInputStampSchema, JSON.parse(stored));
};

beforeEach(() => {
  directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "compiler-input-stamp-")),
  );
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

test("an untouched program is current", async () => {
  const stamp = await recordProgram();
  expect(Object.keys(stamp.contents)).toContain(
    path.join(directory, "src/b.ts"),
  );
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(true);
});

test("a different context is not current", async () => {
  expect(
    await isCompilerInputStampCurrent(await recordProgram(), "other"),
  ).toBe(false);
});

test("an edited dependency is not current", async () => {
  const stamp = await recordProgram();
  write("src/b.ts", "export type B = number;\n");
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(false);
});

test("an edited tsconfig is not current", async () => {
  const stamp = await recordProgram();
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
  const stamp = await recordProgram();
  // `./c` now resolves to c.ts before c/index.ts.
  write("src/c.ts", "export type C = number;\n");
  expect(await isCompilerInputStampCurrent(stamp, CONTEXT)).toBe(false);
});

test("a new ambient declaration under the included tree is not current", async () => {
  const stamp = await recordProgram();
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

test("portable stamps keep directory entries as names", async () => {
  // The generator runs inside the checkout. Relative names must keep their
  // meaning even when cwd could resolve them into paths under the root.
  const recorded = Bun.spawnSync(
    [
      "bun",
      "-e",
      `
      import { createCompilerInputRecorder } from ${JSON.stringify(path.join(import.meta.dir, "compiler-input-stamp.ts"))};
      const root = process.cwd();
      const recorder = createCompilerInputRecorder();
      const fileSystem = recorder.fileSystem();
      if (typeof fileSystem.getAccessibleEntries === "function") fileSystem.getAccessibleEntries(root);
      console.log(JSON.stringify(recorder.portableStamp("context", root)));
    `,
    ],
    { cwd: directory },
  );
  expect(recorded.exitCode).toBe(0);
  const portable = v.parse(
    compilerInputStampSchema,
    JSON.parse(recorded.stdout.toString()),
  );
  expect(Object.values(portable.entries)).toContainEqual({
    files: ["tsconfig.json"],
    directories: ["src"],
    symlinks: [],
  });
  const localized = localizeStamp(portable, realpathSync(directory));
  expect(localized).toBeDefined();
  if (localized === undefined) {
    panic("portable fixture cannot be localized");
  }
  expect(await isCompilerInputStampCurrent(localized, CONTEXT)).toBe(true);
});

test("a portable stamp rejects an unrecorded destination ancestor dependency", async () => {
  const packageName = `stamp-ancestor-${process.pid}`;
  write(
    "src/a.ts",
    `import type { Missing } from ${JSON.stringify(packageName)};\nexport type A = Missing;\n`,
  );
  const recorder = createCompilerInputRecorder();
  await buildProgram(recorder);
  const portable = recorder.portableStamp(CONTEXT, directory);
  // The stamp records ancestors relative to the checkout, as deep as the
  // source checkout sits. A destination nested deeper than that has an
  // ancestor (its temporary root) the stamp never described.
  const destinationRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "compiler-input-destination-")),
  );
  const destination = path.join(
    destinationRoot,
    ...directory.split(path.sep).map((_, index) => `depth-${String(index)}`),
  );
  mkdirSync(destination, { recursive: true });
  const dependency = path.join(
    destinationRoot,
    "node_modules",
    packageName,
    "index.d.ts",
  );
  mkdirSync(path.dirname(dependency), { recursive: true });
  writeFileSync(dependency, "export interface Missing {}\n");
  try {
    expect(localizeStamp(portable, destination)).toBeUndefined();
    rmSync(path.join(destinationRoot, "node_modules"), {
      recursive: true,
      force: true,
    });
    expect(localizeStamp(portable, destination)).toBeDefined();
  } finally {
    rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test("a portable stamp rejects a dependency in an unrecorded ancestor of a symlinked checkout path", async () => {
  const packageName = `stamp-link-ancestor-${process.pid}`;
  write(
    "src/a.ts",
    `import type { Missing } from ${JSON.stringify(packageName)};\nexport type A = Missing;\n`,
  );
  const recorder = createCompilerInputRecorder();
  await buildProgram(recorder);
  const portable = recorder.portableStamp(CONTEXT, directory);
  // The checkout's resolved path is shallow; only the path it is reached
  // through is nested deeper than the source, under a dependency directory.
  const linkRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "compiler-input-link-")),
  );
  const target = path.join(linkRoot, "checkout");
  mkdirSync(target);
  const linkParent = path.join(
    linkRoot,
    "lexical",
    ...directory.split(path.sep).map((_, index) => `depth-${String(index)}`),
  );
  mkdirSync(linkParent, { recursive: true });
  const destination = path.join(linkParent, "stella");
  symlinkSync(target, destination, "dir");
  const dependency = path.join(
    linkRoot,
    "lexical",
    "node_modules",
    packageName,
    "index.d.ts",
  );
  mkdirSync(path.dirname(dependency), { recursive: true });
  writeFileSync(dependency, "export interface Missing {}\n");
  try {
    expect(localizeStamp(portable, destination)).toBeUndefined();
    rmSync(path.join(linkRoot, "lexical", "node_modules"), {
      recursive: true,
      force: true,
    });
    expect(localizeStamp(portable, destination)).toBeDefined();
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }
});

test("a portable stamp for an unreadable checkout is not reused", async () => {
  expect(
    localizeStamp(
      await recordProgram(),
      path.join(directory, "missing-checkout"),
    ),
  ).toBeUndefined();
});
