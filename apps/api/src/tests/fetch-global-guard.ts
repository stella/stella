import { panic } from "better-result";
import { afterAll, beforeEach, onTestFinished } from "bun:test";

const processFetch = globalThis.fetch;
let previousFile: string | undefined;
let fetchAtPreviousTestEnd = processFetch;

beforeEach(() => {
  // In a multi-file run `Bun.argv` keeps the command line; `Bun.main` is the
  // file whose tests are running.
  const testFile = Bun.main;
  // A preload's afterAll runs once for the whole run, so a module-scope or
  // suite replacement the previous file left installed is undone at this
  // file's first test. A replacement this file installed at module scope is a
  // different function and stays.
  if (testFile !== previousFile) {
    if (globalThis.fetch === fetchAtPreviousTestEnd) {
      globalThis.fetch = processFetch;
    }
    previousFile = testFile;
  }
  const testFetch = globalThis.fetch;
  onTestFinished(() => {
    fetchAtPreviousTestEnd = testFetch;
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
