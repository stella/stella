import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

// The desktop shell renders in the system WebView of its minimum macOS
// version (tauri.conf.json `minimumSystemVersion`), whose newest Safari is
// 15.6. Built-ins that first shipped in Safari 16 or later throw there, and
// the bundler does not polyfill them, so desktop sources must not call them.
const MINIMUM_MACOS = "10.15";

const UNSUPPORTED_BUILT_INS = [
  { name: "Array#toSorted", pattern: /\.toSorted\(/u },
  { name: "Array#toReversed", pattern: /\.toReversed\(/u },
  { name: "Array#toSpliced", pattern: /\.toSpliced\(/u },
  { name: "Array.fromAsync", pattern: /\bArray\.fromAsync\b/u },
  { name: "Object.groupBy", pattern: /\bObject\.groupBy\b/u },
  { name: "Map.groupBy", pattern: /\bMap\.groupBy\b/u },
  { name: "Promise.withResolvers", pattern: /\bPromise\.withResolvers\b/u },
  { name: "String#isWellFormed", pattern: /\.isWellFormed\(/u },
  { name: "String#toWellFormed", pattern: /\.toWellFormed\(/u },
  // These names exist only on Set, so any receiver is flagged.
  {
    name: "Set relation methods",
    pattern:
      /\.(?:symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/u,
  },
  // Schema and date libraries share these names (`v.union(...)`), so only a
  // call with a Set argument is flagged.
  {
    name: "Set composition methods",
    pattern: /\.(?:union|intersection|difference)\(\s*new Set\b/u,
  },
] as const;

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const SOURCE_ROOT = path.join(import.meta.dir, "../src");

const isSource = (file: string) =>
  /\.[cm]?[jt]sx?$/u.test(file) &&
  !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/u.test(file) &&
  !/(?:^|[/\\])(?:__tests__|tests|__fixtures__|fixtures)(?:[/\\]|$)/u.test(
    file,
  );

const desktopSources = async () =>
  (await readdir(SOURCE_ROOT, { recursive: true }))
    .map((file) => path.join(SOURCE_ROOT, file))
    .filter(isSource);

const importClosure = async (
  entries: readonly string[],
  readSource = (file: string) => readFile(file, "utf-8"),
) => {
  const pending = [...entries];
  const sources = new Map<string, string>();
  const packages = new Set(
    [
      ...new Bun.Glob("packages/*/package.json").scanSync({ cwd: REPO_ROOT }),
    ].map((manifest) => path.dirname(path.join(REPO_ROOT, manifest))),
  );
  const ts = new Bun.Transpiler({ loader: "ts" });
  const tsx = new Bun.Transpiler({
    loader: "tsx",
    tsconfig: {
      compilerOptions: { jsx: "react", jsxFactory: "React.createElement" },
    },
  });
  for (const file of pending) {
    if (sources.has(file) || !isSource(file)) {
      continue;
    }
    const source = await readSource(file);
    sources.set(file, source);
    // scanImports omits type-only imports and re-exports, and includes lazy imports.
    const transpiler = file.endsWith("x") ? tsx : ts;
    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (specifier.startsWith(".")) {
        pending.push(Bun.resolveSync(specifier, path.dirname(file)));
      } else if (specifier.startsWith("@stll/")) {
        const [name] = specifier.slice("@stll/".length).split("/");
        const packageRoot = path.join(REPO_ROOT, "packages", name ?? "");
        if (packages.has(packageRoot)) {
          // Self-reference resolution uses the workspace package's exports map.
          pending.push(Bun.resolveSync(specifier, packageRoot));
        }
      }
    }
  }
  return sources;
};

const unsupportedCalls = (file: string, source: string) =>
  UNSUPPORTED_BUILT_INS.filter(({ pattern }) => pattern.test(source)).map(
    ({ name }) => `${file}: ${name}`,
  );

describe("desktop WebView baseline", () => {
  test("the guard targets the configured minimum macOS version", async () => {
    const config = await readFile(
      path.join(import.meta.dir, "../src-tauri/tauri.conf.json"),
      "utf-8",
    );
    expect(config).toContain(`"minimumSystemVersion": "${MINIMUM_MACOS}"`);
  });

  test("the import closure includes bundled UI logic", async () => {
    const sources = await importClosure(await desktopSources());
    expect(
      sources.has(
        path.join(REPO_ROOT, "packages/ui/src/lib/inline-reorder.ts"),
      ),
    ).toBe(true);
  });

  test("package exports resolve calendar logic into the import closure", async () => {
    const entry = path.join(SOURCE_ROOT, "calendar-import-fixture.ts");
    const sources = await importClosure([entry], (file) =>
      file === entry
        ? Promise.resolve('import "@stll/ui/day-calendar.logic";')
        : readFile(file, "utf-8"),
    );
    expect(
      sources.has(
        path.join(REPO_ROOT, "packages/ui/src/calendar/day-calendar.logic.ts"),
      ),
    ).toBe(true);
  });

  test("desktop sources call no built-in newer than the minimum WebView", async () => {
    const sources = await importClosure(await desktopSources());
    expect(sources.size).toBeGreaterThan(0);
    const findings: string[] = [];
    for (const [file, source] of sources) {
      findings.push(
        ...unsupportedCalls(repoRelativePath(REPO_ROOT, file), source),
      );
    }
    expect(findings).toEqual([]);
  });

  test("each unsupported built-in is detected", () => {
    const samples = [
      "items.toSorted((a, b) => a - b)",
      "items.toReversed()",
      "items.toSpliced(0, 1)",
      "await Array.fromAsync(stream)",
      "Object.groupBy(items, key)",
      "Map.groupBy(items, key)",
      "Promise.withResolvers()",
      "text.isWellFormed()",
      "text.toWellFormed()",
      "left.isSubsetOf(right)",
      "left.union(new Set(right))",
    ];
    expect(
      samples.map((sample) => unsupportedCalls("sample.ts", sample)),
    ).toEqual(UNSUPPORTED_BUILT_INS.map(({ name }) => [`sample.ts: ${name}`]));
    expect(
      unsupportedCalls("sample.ts", "[...items].sort((a, b) => a - b)"),
    ).toEqual([]);
    for (const call of [
      "left.symmetricDifference(right)",
      "left.isSupersetOf(right)",
      "left.isDisjointFrom(right)",
    ]) {
      expect(unsupportedCalls("sample.ts", call)).toEqual([
        "sample.ts: Set relation methods",
      ]);
    }
    expect(unsupportedCalls("sample.ts", "v.union([a, b])")).toEqual([]);
  });
});
