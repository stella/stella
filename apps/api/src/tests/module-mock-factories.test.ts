import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  countModuleMockCallSites,
  readModuleExports,
  readModuleMockFactories,
  resolveModuleFile,
} from "./module-mock-factories";

const API_ROOT = path.resolve(import.meta.dir, "../..");
// Assembled so this file does not read as a module-mock call site to the
// runner's scan (scripts/run-tests.ts) or to the batcher.
const MOCK_CALL = ["mock", "module("].join(".");

const apiSourceFiles = [
  ...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({
    cwd: API_ROOT,
    onlyFiles: true,
  }),
].toSorted();

const allFactories = apiSourceFiles.flatMap((filePath) =>
  readModuleMockFactories(
    readFileSync(path.join(API_ROOT, filePath), "utf-8"),
    filePath,
  ),
);

describe("module mock factories", () => {
  test("every declared key is a real export of the mocked module", () => {
    // A module mock is a plain object: a key the real module does not export
    // overrides nothing, so the behaviour the suite believes it forced never
    // happens and the assertions pass for the wrong reason. Compare the keys
    // against the target's exports, read from its SOURCE — importing the
    // module here would run its side effects and register it in the same
    // process the mocks live in, which is the leak this whole file exists to
    // police.
    const drifted = allFactories.flatMap((factory) => {
      const moduleFile = resolveModuleFile(factory.moduleId, API_ROOT);
      if (moduleFile === undefined) {
        return [];
      }
      const realExports = readModuleExports(moduleFile, API_ROOT);
      const unknownKeys = factory.declaredKeys.filter(
        (key) => !realExports.has(key),
      );
      if (unknownKeys.length === 0) {
        return [];
      }
      return [
        `${factory.filePath}:${factory.line} mocks ${factory.moduleId} ` +
          `with keys it does not export: ${unknownKeys.join(", ")}`,
      ];
    });

    expect(drifted).toEqual([]);
  });

  test("every in-package mock target resolves to a module file", () => {
    // A specifier that resolves to nothing installs a mock nobody can load:
    // the stub is inert and the real collaborator keeps running.
    const unresolved = allFactories
      .filter(
        (factory) =>
          factory.moduleId.startsWith("src/") &&
          resolveModuleFile(factory.moduleId, API_ROOT) === undefined,
      )
      .map(
        ({ filePath, line, moduleId }) => `${filePath}:${line} → ${moduleId}`,
      );

    expect(unresolved).toEqual([]);
  });

  test("scans the repository's factories rather than silently finding none", () => {
    const callSites = apiSourceFiles.filter((filePath) =>
      readFileSync(path.join(API_ROOT, filePath), "utf-8").includes(MOCK_CALL),
    );

    expect(allFactories.length).toBeGreaterThanOrEqual(callSites.length);
  });

  test("returns one factory per call site, in every file", () => {
    // A file may hold many mocks, so a repository-wide count has slack: the
    // reader could stop recognizing a body shape and stay above any floor.
    // Per file and in both directions there is no slack, and the two guards
    // above cannot quietly narrow to the mocks that still happen to parse.
    const mismatches = apiSourceFiles.flatMap((filePath) => {
      const source = readFileSync(path.join(API_ROOT, filePath), "utf-8");
      const sites = countModuleMockCallSites(source);
      const read = readModuleMockFactories(source, filePath).length;
      if (sites === read) {
        return [];
      }
      return [`${filePath}: ${sites} call sites, ${read} factories read`];
    });

    expect(mismatches).toEqual([]);
  });

  test("reports a factory body it cannot read as opaque, not as absent", () => {
    // Dropping these would remove the call site from every guard built on the
    // reader. Reported instead, with no keys and marked as spreading, so the
    // key-drift comparisons skip a shape they cannot judge.
    const factories = readModuleMockFactories(
      [
        `void ${MOCK_CALL}"@/api/lib/analytics/capture", () => {`,
        "  return { captureError: () => {} };",
        "});",
        `void ${MOCK_CALL}"@/api/lib/s3", () => stub);`,
      ].join("\n"),
      "src/lib/example.test.ts",
    );

    expect(factories.map((factory) => factory.moduleId)).toEqual([
      "src/lib/analytics/capture",
      "src/lib/s3",
    ]);
    expect(factories.map((factory) => factory.spreadsAnother)).toEqual([
      true,
      true,
    ]);
    expect(factories.flatMap((factory) => factory.declaredKeys)).toEqual([]);
  });

  test("reads keys, spreads, and quoted keys out of a factory", () => {
    const factories = readModuleMockFactories(
      [
        `void ${MOCK_CALL}"@/api/lib/analytics/capture", () => ({`,
        "  ...realCapture,",
        "  captureError: () => {},",
        '  "captureRequestError": (input: { url: string }) => input,',
        "  nested: { captureError: 1 },",
        "  fromArray: [{ captureError: 2 }],",
        "}));",
      ].join("\n"),
      "src/lib/example.test.ts",
    );

    expect(factories).toHaveLength(1);
    expect(factories.at(0)?.moduleId).toBe("src/lib/analytics/capture");
    expect(factories.at(0)?.spreadsAnother).toBe(true);
    expect(factories.at(0)?.declaredKeys).toEqual([
      "captureError",
      "captureRequestError",
      "nested",
      "fromArray",
    ]);
  });

  test("follows `export *` re-exports when reading a module's exports", () => {
    const constsFile = resolveModuleFile(
      "src/handlers/case-law/consts",
      API_ROOT,
    );
    if (constsFile === undefined) {
      throw new TypeError("missing re-export fixture");
    }

    // consts.ts declares nothing itself; every name comes through `export *`.
    expect([...readModuleExports(constsFile, API_ROOT)]).toContain(
      "PARSER_VERSIONS",
    );
  });

  test("reads the exports a module declares, without its types", () => {
    const captureFile = resolveModuleFile(
      "src/lib/analytics/capture",
      API_ROOT,
    );
    if (captureFile === undefined) {
      throw new TypeError("missing capture fixture");
    }

    expect([...readModuleExports(captureFile, API_ROOT)].toSorted()).toEqual([
      "captureError",
      "captureRequestError",
      "resetCaptureWindows",
    ]);
  });
});
