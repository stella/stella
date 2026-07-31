import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  batchModuleMockTests,
  readModuleMockMetadata,
  type ModuleMockTest,
} from "./module-mock-batching";

type ModuleMockTestOptions = {
  hasUnknownMock?: boolean;
  mockedModules: readonly string[];
  testPath: string;
};

const moduleMockTest = ({
  hasUnknownMock = false,
  mockedModules,
  testPath,
}: ModuleMockTestOptions): ModuleMockTest => ({
  hasUnknownMock,
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
    const metadata = readModuleMockMetadata(`
      ${literalMock}
      void mock.module(moduleName, () => ({}));
    `);

    expect([...metadata.mockedModules]).toEqual(["@/api/lib/s3"]);
    expect(metadata.hasUnknownMock).toBe(true);
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
