import { panic } from "better-result";

const MODULE_MOCK_CALL_PATTERN = /\bmock\.module\s*\(/gu;
const MODULE_MOCK_TARGET_PATTERN = /\bmock\.module\s*\(\s*["']([^"']+)["']/gu;

export type ModuleMockMetadata = {
  hasUnknownMock: boolean;
  mockedModules: ReadonlySet<string>;
};

export type ModuleMockTest = ModuleMockMetadata & {
  testPath: string;
};

type ModuleMockBatch = {
  hasUnknownMock: boolean;
  mockedModules: Set<string>;
  testPaths: string[];
};

export const readModuleMockMetadata = (source: string): ModuleMockMetadata => {
  const mockedModules = new Set<string>();
  let literalCallCount = 0;
  for (const match of source.matchAll(MODULE_MOCK_TARGET_PATTERN)) {
    const mockedModule = match.at(1);
    if (mockedModule !== undefined) {
      mockedModules.add(mockedModule);
      literalCallCount += 1;
    }
  }
  const callCount = [...source.matchAll(MODULE_MOCK_CALL_PATTERN)].length;
  return {
    hasUnknownMock: literalCallCount < callCount,
    mockedModules,
  };
};

const canShareBatch = (batch: ModuleMockBatch, test: ModuleMockTest) => {
  if (batch.hasUnknownMock || test.hasUnknownMock) {
    return false;
  }
  for (const mockedModule of test.mockedModules) {
    if (batch.mockedModules.has(mockedModule)) {
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
        hasUnknownMock: test.hasUnknownMock,
        mockedModules: new Set(test.mockedModules),
        testPaths: [test.testPath],
      });
      continue;
    }

    batch.testPaths.push(test.testPath);
    for (const mockedModule of test.mockedModules) {
      batch.mockedModules.add(mockedModule);
    }
  }

  return batches.map(({ testPaths }) => testPaths);
};
