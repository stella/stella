import { afterEach, expect, mock, test } from "bun:test";

import { apiFetch, localCliClientHeaders } from "./api-fetch";
import { CLI_VERSION } from "./generated/cli-version";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("every CLI API request carries the shared client identity", async () => {
  let observed: Headers | undefined;
  globalThis.fetch = Object.assign(
    mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observed = new Headers(init?.headers);
      return new Response();
    }),
    { preconnect: originalFetch.preconnect },
  );

  await apiFetch("https://api.example.test/v1/me", {
    headers: { Authorization: "Bearer test" },
  });

  const expected = localCliClientHeaders(CLI_VERSION);
  expected.set("authorization", "Bearer test");
  expect(observed).toEqual(expected);
});
