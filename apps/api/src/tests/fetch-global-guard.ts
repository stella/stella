import { panic } from "better-result";
import { afterAll, beforeEach, onTestFinished } from "bun:test";

const processFetch = globalThis.fetch;
let testFile = "unknown API test file";

// Bun narrows argv for a test worker to the file currently being executed.
const currentTestFile = () => Bun.argv[1] ?? testFile;

beforeEach(() => {
  testFile = currentTestFile();
  const testFetch = globalThis.fetch;
  onTestFinished(() => {
    if (globalThis.fetch === testFetch) {
      return;
    }

    globalThis.fetch = testFetch;
    panic(
      `API test leaked a replacement globalThis.fetch: ${testFile}. Restore fetch in the test or a test-scoped cleanup hook.`,
    );
  });
});

afterAll(() => {
  globalThis.fetch = processFetch;
});
