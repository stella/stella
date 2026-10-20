import { afterEach, expect, mock, test } from "bun:test";

import { LOCAL_CLIENT_IDENTITY_HEADER } from "@stll/api-contract/local-client-identity";

import { apiFetch, CLI_LOCAL_CLIENT_IDENTITY } from "./api-fetch";

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

  expect(observed?.get(LOCAL_CLIENT_IDENTITY_HEADER)).toBe(
    CLI_LOCAL_CLIENT_IDENTITY,
  );
  expect(observed?.get("authorization")).toBe("Bearer test");
});
