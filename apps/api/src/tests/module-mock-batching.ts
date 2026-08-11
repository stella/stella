import { panic } from "better-result";
import path from "node:path";

const MODULE_MOCK_CALL_PATTERN = /\bmock\.module\s*\(/gu;
const MODULE_MOCK_TARGET_PATTERN = /\bmock\.module\s*\(\s*["']([^"']+)["']/gu;
// `import(` only when it starts an expression: a preceding identifier or dot
// makes it a property access or a longer identifier, never a dynamic import.
const DYNAMIC_IMPORT_CALL_PATTERN = /(?<![.\w$])import\s*\(/gu;
const MODULE_ALIAS_PREFIX = "@/api/";
const MODULE_ALIAS_TARGET = "src/";
const MODULE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/u;

const transpilers = new Map<string, Bun.Transpiler>();
const transpilerFor = (modulePath: string): Bun.Transpiler => {
  const loader = modulePath.endsWith("x") ? "tsx" : "ts";
  const cached = transpilers.get(loader);
  if (cached !== undefined) {
    return cached;
  }
  const transpiler = new Bun.Transpiler({ loader });
  transpilers.set(loader, transpiler);
  return transpiler;
};

/**
 * Canonicalize a module specifier so the alias, relative, and bare forms of the
 * same module compare equal. `fromModulePath` is the api-package-relative path
 * of the file the specifier was written in (e.g. `src/lib/analytics/x.test.ts`).
 */
export const resolveModuleSpecifier = (
  specifier: string,
  fromModulePath: string,
): string => {
  if (specifier.startsWith(MODULE_ALIAS_PREFIX)) {
    return `${MODULE_ALIAS_TARGET}${specifier.slice(MODULE_ALIAS_PREFIX.length)}`.replace(
      MODULE_EXTENSION_PATTERN,
      "",
    );
  }
  if (specifier.startsWith(".")) {
    return path.posix
      .join(path.posix.dirname(fromModulePath), specifier)
      .replace(MODULE_EXTENSION_PATTERN, "");
  }
  return specifier;
};

export type ModuleMockMetadata = {
  hasUnknownImport: boolean;
  hasUnknownMock: boolean;
  importedModules: ReadonlySet<string>;
  mockedModules: ReadonlySet<string>;
};

export type ModuleMockTest = ModuleMockMetadata & {
  testPath: string;
};

type ModuleMockBatch = {
  hasUnknownImport: boolean;
  hasUnknownMock: boolean;
  importedModules: Set<string>;
  mockedModules: Set<string>;
  testPaths: string[];
};

export const readModuleMockMetadata = (
  source: string,
  modulePath: string,
): ModuleMockMetadata => {
  const mockedModules = new Set<string>();
  let literalMockCount = 0;
  for (const match of source.matchAll(MODULE_MOCK_TARGET_PATTERN)) {
    const mockedModule = match.at(1);
    if (mockedModule !== undefined) {
      mockedModules.add(resolveModuleSpecifier(mockedModule, modulePath));
      literalMockCount += 1;
    }
  }
  const mockCallCount = [...source.matchAll(MODULE_MOCK_CALL_PATTERN)].length;

  // Static `import`/`export from` and dynamic `import()` with a literal
  // specifier. Type-only imports are erased by the scanner, which is what we
  // want: they bind nothing at runtime, so a mock cannot break them.
  const { imports } = transpilerFor(modulePath).scan(source);
  const importedModules = new Set(
    imports.map(({ path: specifier }) =>
      resolveModuleSpecifier(specifier, modulePath),
    ),
  );
  const literalDynamicImportCount = imports.filter(
    ({ kind }) => kind === "dynamic-import",
  ).length;
  const dynamicImportCallCount = [
    ...source.matchAll(DYNAMIC_IMPORT_CALL_PATTERN),
  ].length;

  return {
    hasUnknownImport: literalDynamicImportCount < dynamicImportCallCount,
    hasUnknownMock: literalMockCount < mockCallCount,
    importedModules,
    mockedModules,
  };
};

// bun's module-mock registry is process-wide, so a `mock.module` call in one
// file rewrites that module for every other file in the same process, even
// under `--isolate`. Two files therefore conflict when EITHER of them mocks a
// module the other one touches: co-mockers overwrite each other's factory, and
// a partial mock (one export overridden, the rest dropped) breaks any file that
// merely imports the module for real. Both directions are checked here.
const canShareBatch = (batch: ModuleMockBatch, test: ModuleMockTest) => {
  if (batch.hasUnknownMock || test.hasUnknownMock) {
    return false;
  }
  if (batch.hasUnknownImport || test.hasUnknownImport) {
    return false;
  }
  for (const mockedModule of test.mockedModules) {
    if (
      batch.mockedModules.has(mockedModule) ||
      batch.importedModules.has(mockedModule)
    ) {
      return false;
    }
  }
  for (const importedModule of test.importedModules) {
    if (batch.mockedModules.has(importedModule)) {
      return false;
    }
  }
  return true;
};

export const batchModuleMockTests = (
  tests: readonly ModuleMockTest[],
  batchSize: number,
): string[][] => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    panic("module-mock test batch size must be a positive integer");
  }

  const batches: ModuleMockBatch[] = [];
  for (const test of tests) {
    const batch = batches.find(
      (candidate) =>
        candidate.testPaths.length < batchSize &&
        canShareBatch(candidate, test),
    );
    if (batch === undefined) {
      batches.push({
        hasUnknownImport: test.hasUnknownImport,
        hasUnknownMock: test.hasUnknownMock,
        importedModules: new Set(test.importedModules),
        mockedModules: new Set(test.mockedModules),
        testPaths: [test.testPath],
      });
      continue;
    }

    batch.testPaths.push(test.testPath);
    for (const mockedModule of test.mockedModules) {
      batch.mockedModules.add(mockedModule);
    }
    for (const importedModule of test.importedModules) {
      batch.importedModules.add(importedModule);
    }
  }

  return batches.map(({ testPaths }) => testPaths);
};
