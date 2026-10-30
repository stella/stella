import { panic } from "better-result";
import { afterAll, beforeEach, onTestFinished } from "bun:test";

const processFetch = globalThis.fetch;

beforeEach(() => {
  // In a multi-file run `Bun.argv` keeps the command line; `Bun.main` is the
  // file whose tests are running.
  const testFile = Bun.main;
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
