import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  batchModuleMockTests,
  readModuleMockMetadata,
  resolveModuleSpecifier,
  type ModuleMockTest,
} from "./module-mock-batching";

type ModuleMockTestOptions = {
  hasUnknownImport?: boolean;
  hasUnknownMock?: boolean;
  importedModules?: readonly string[];
  mockedModules: readonly string[];
  testPath: string;
};

const moduleMockTest = ({
  hasUnknownImport = false,
  hasUnknownMock = false,
  importedModules = [],
  mockedModules,
  testPath,
}: ModuleMockTestOptions): ModuleMockTest => ({
  hasUnknownImport,
  hasUnknownMock,
  importedModules: new Set(importedModules),
  mockedModules: new Set(mockedModules),
  testPath,
});

const API_ROOT = path.resolve(import.meta.dir, "../..");
const S3_MODULE_MOCK_CALL = ["void mock", 'module("@/api/lib/s3"'].join(".");
const S3_MODULE_MOCK_END = "}));";
const REAL_S3_SPREAD = ["...real", "S3"].join("");
const REQUIRED_S3_EXPORT_PATTERNS = [
  /deleteS3ObjectWithSignal/u,
  /putS3ObjectWithSignal/u,
];

describe("batchModuleMockTests", () => {
  test("S3 module mocks preserve the named file-helper exports", async () => {
    const testPaths = [
      ...new Bun.Glob("src/**/*.test.{ts,tsx}").scanSync({
        cwd: API_ROOT,
        onlyFiles: true,
      }),
    ];
    const incompleteMocks = (
      await Promise.all(
        testPaths.map(async (testPath) => {
          const source = await Bun.file(path.join(API_ROOT, testPath)).text();
          const mockStart = source.indexOf(S3_MODULE_MOCK_CALL);
          if (mockStart === -1) {
            return undefined;
          }
          const mockEnd = source.indexOf(S3_MODULE_MOCK_END, mockStart);
          if (mockEnd === -1) {
            return testPath;
          }
          const mockSource = source.slice(mockStart, mockEnd);
          if (mockSource.includes(REAL_S3_SPREAD)) {
            return undefined;
          }
          const hasRequiredExports = REQUIRED_S3_EXPORT_PATTERNS.every(
            (pattern) => pattern.test(mockSource),
          );
          return hasRequiredExports ? undefined : testPath;
        }),
      )
    ).filter((testPath) => testPath !== undefined);

    expect(incompleteMocks).toEqual([]);
  });

  test("extracts literal targets and fails closed for dynamic module mocks", () => {
    const literalMock = `${S3_MODULE_MOCK_CALL}, () => ({}));`;
    const metadata = readModuleMockMetadata(
      `
      ${literalMock}
      void mock.module(moduleName, () => ({}));
    `,
      "src/lib/example.test.ts",
    );

    expect([...metadata.mockedModules]).toEqual(["src/lib/s3"]);
    expect(metadata.hasUnknownMock).toBe(true);
  });

  test("collects the modules a test imports, in every literal specifier form", () => {
    const metadata = readModuleMockMetadata(
      `
      import { captureError } from "@/api/lib/analytics/capture";
      import type { Never } from "@/api/lib/analytics/erased-by-the-scanner";
      import { helper } from "./sibling";
      export { reexported } from "../analytics/capture";
      const loaded = await import("bullmq");
    `,
      "src/lib/chat/example.test.ts",
    );

    expect([...metadata.importedModules].toSorted()).toEqual([
      "bullmq",
      "src/lib/analytics/capture",
      "src/lib/chat/sibling",
    ]);
    expect(metadata.hasUnknownImport).toBe(false);
  });

  test("fails closed for a dynamic import with a computed specifier", () => {
    const metadata = readModuleMockMetadata(
      `const loaded = await import(moduleName);`,
      "src/lib/example.test.ts",
    );

    expect(metadata.hasUnknownImport).toBe(true);
  });

  test("canonicalizes alias, relative, and bare specifiers", () => {
    expect(
      resolveModuleSpecifier("@/api/lib/analytics/capture", "src/x.test.ts"),
    ).toBe("src/lib/analytics/capture");
    expect(
      resolveModuleSpecifier("../analytics/capture", "src/lib/chat/x.test.ts"),
    ).toBe("src/lib/analytics/capture");
    expect(
      resolveModuleSpecifier("./capture.ts", "src/lib/analytics/x.test.ts"),
    ).toBe("src/lib/analytics/capture");
    expect(resolveModuleSpecifier("bullmq", "src/x.test.ts")).toBe("bullmq");
  });

  test("never co-batches a module's mocker with a file that imports it", () => {
    // The failure this prevents: a partial mock of a shared module drops the
    // exports it does not declare, so a co-located file that imports one of
    // those exports for real sees `undefined` instead of the function.
    const tests = [
      moduleMockTest({
        mockedModules: ["src/lib/analytics/capture"],
        testPath: "model-ingress-guard.test.ts",
      }),
      moduleMockTest({
        importedModules: ["src/lib/analytics/capture"],
        mockedModules: ["src/lib/posthog-client"],
        testPath: "capture.test.ts",
      }),
      moduleMockTest({
        importedModules: ["src/lib/audit-log"],
        mockedModules: ["src/lib/s3"],
        testPath: "audit.test.ts",
      }),
    ];

    const batches = batchModuleMockTests(tests, 3);
    const mockerBatch = batches.find((batch) =>
      batch.includes("model-ingress-guard.test.ts"),
    );

    expect(mockerBatch).toBeDefined();
    expect(mockerBatch).not.toContain("capture.test.ts");
    expect(batches.flat().toSorted()).toEqual(
      tests.map(({ testPath }) => testPath).toSorted(),
    );
  });

  test("separates mocker from importer in either declaration order", () => {
    const importerFirst = batchModuleMockTests(
      [
        moduleMockTest({
          importedModules: ["src/lib/analytics/capture"],
          mockedModules: ["src/lib/posthog-client"],
          testPath: "importer.test.ts",
        }),
        moduleMockTest({
          mockedModules: ["src/lib/analytics/capture"],
          testPath: "mocker.test.ts",
        }),
      ],
      3,
    );

    expect(importerFirst).toEqual([["importer.test.ts"], ["mocker.test.ts"]]);
  });

  test("gives a file with an unresolvable dynamic import its own batch", () => {
    const batches = batchModuleMockTests(
      [
        moduleMockTest({
          hasUnknownImport: true,
          mockedModules: ["src/lib/s3"],
          testPath: "unknown-import.test.ts",
        }),
        moduleMockTest({
          mockedModules: ["src/lib/audit-log"],
          testPath: "audit.test.ts",
        }),
      ],
      3,
    );

    expect(batches).toEqual([["unknown-import.test.ts"], ["audit.test.ts"]]);
  });

  test("never co-batches tests that can overwrite the same module mock", () => {
    const tests = [
      moduleMockTest({
        mockedModules: ["@/api/lib/s3"],
        testPath: "upload-files.test.ts",
      }),
      moduleMockTest({
        mockedModules: ["@/api/lib/s3"],
        testPath: "copy-to-workspace.test.ts",
      }),
      moduleMockTest({
        mockedModules: ["@/api/lib/audit-log"],
        testPath: "audit.test.ts",
      }),
      moduleMockTest({
        hasUnknownMock: true,
        mockedModules: [],
        testPath: "dynamic.test.ts",
      }),
    ];

    const batches = batchModuleMockTests(tests, 3);
    const testByPath = new Map(tests.map((entry) => [entry.testPath, entry]));
    for (const batch of batches) {
      const mockedModules = new Set<string>();
      for (const testPath of batch) {
        const entry = testByPath.get(testPath);
        if (entry === undefined) {
          throw new TypeError(`unknown test path in batch: ${testPath}`);
        }
        for (const mockedModule of entry.mockedModules) {
          expect(mockedModules.has(mockedModule)).toBe(false);
          mockedModules.add(mockedModule);
        }
      }
    }

    const dynamicBatch = batches.find((batch) =>
      batch.includes("dynamic.test.ts"),
    );
    expect(dynamicBatch).toEqual(["dynamic.test.ts"]);
    expect(batches.flat().toSorted()).toEqual(
      tests.map(({ testPath }) => testPath).toSorted(),
    );
  });

  test("splits a mocker from a plain importer of the same module", () => {
    // The shape behind the original regression: one file replaces a widely
    // imported module, another only imports it. Co-locating them hands the
    // importer the mock. No live test mocks the analytics capture module any
    // more (they run the real one behind a recording sink), so the pairing is
    // synthetic, and stays pinned regardless of which files happen to exist.
    const tests = [
      moduleMockTest({
        mockedModules: ["src/lib/analytics/capture"],
        testPath: "mocker.test.ts",
      }),
      moduleMockTest({
        importedModules: ["src/lib/analytics/capture"],
        mockedModules: [],
        testPath: "importer.test.ts",
      }),
    ];

    expect(batchModuleMockTests(tests, 3)).toEqual([
      ["mocker.test.ts"],
      ["importer.test.ts"],
    ]);
  });

  test("keeps every test exactly once while respecting the batch limit", () => {
    const tests = [
      moduleMockTest({ mockedModules: ["module-a"], testPath: "a.test.ts" }),
      moduleMockTest({ mockedModules: ["module-b"], testPath: "b.test.ts" }),
      moduleMockTest({ mockedModules: ["module-c"], testPath: "c.test.ts" }),
      moduleMockTest({ mockedModules: ["module-d"], testPath: "d.test.ts" }),
    ];

    const batches = batchModuleMockTests(tests, 3);
    expect(batches.every((batch) => batch.length <= 3)).toBe(true);
    expect(batches.flat().toSorted()).toEqual(
      tests.map(({ testPath }) => testPath).toSorted(),
    );
  });
});
