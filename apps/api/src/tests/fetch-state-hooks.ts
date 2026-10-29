import { afterEach, expect } from "bun:test";

import { testFetch } from "./helpers/test-fetch";

// Global teardown runs outside file-local teardown. Restore before asserting so
// a failed cleanup cannot contaminate the next test or file in the batch.
afterEach(() => {
  const remainingFetch = globalThis.fetch;
  globalThis.fetch = testFetch;
  expect(
    remainingFetch,
    "Test leaked globalThis.fetch; restore it in local teardown",
  ).toBe(testFetch);
});
