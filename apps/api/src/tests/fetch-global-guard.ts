import { panic } from "better-result";
import { afterAll, afterEach, beforeEach } from "bun:test";

const processFetch = globalThis.fetch;
let fileFetch = processFetch;
let testFile = "unknown API test file";

const currentTestFile = () => Bun.argv.at(-1) ?? testFile;

beforeEach(() => {
  const currentFile = currentTestFile();
  if (currentFile !== testFile) {
    testFile = currentFile;
    fileFetch = globalThis.fetch;
  }
});

afterEach(() => {
  if (globalThis.fetch === fileFetch) {
    return;
  }

  globalThis.fetch = fileFetch;
  panic(
    `API test leaked a replacement globalThis.fetch: ${testFile}. Restore fetch in the test or a test-scoped cleanup hook.`,
  );
});

afterAll(() => {
  if (globalThis.fetch === processFetch) {
    return;
  }

  globalThis.fetch = processFetch;
  panic(
    `API test file left globalThis.fetch replaced after its cleanup hooks: ${testFile}.`,
  );
});
