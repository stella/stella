// Fixture exercises the global fetch replacement boundary.
import { beforeEach, spyOn, test } from "bun:test";

const fakeFetch = globalThis.fetch;

beforeEach(() => {
  // oxlint-disable-next-line no-global-fetch-replacement/no-global-fetch-replacement -- fixture: suite setup is intentionally forbidden
  globalThis.fetch = fakeFetch;
});

// oxlint-disable-next-line no-global-fetch-replacement/no-global-fetch-replacement -- fixture: spies must use the owner and must not leak across tests
spyOn(globalThis, "fetch");

// expect-clean: no-global-fetch-replacement/no-global-fetch-replacement
test("local replacement restores in finally", () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetch;
  } finally {
    globalThis.fetch = originalFetch;
  }
});
