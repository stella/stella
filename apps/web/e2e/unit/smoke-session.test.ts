import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { fetchSmokeSessionStorageState } from "../helpers/smoke-session";

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});

const mintedSession = () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        await Promise.resolve(
          Response.json({
            cookieName: "__Secure-stella.session_token",
            cookieValue: "token",
            expiresAt: "2026-10-25T00:00:00.000Z",
          }),
        ),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  restores.push(() => {
    fetchSpy.mockRestore();
  });
};

describe("the smoke session as storage state", () => {
  test("is stored for the web host and the API host the request fixture calls", async () => {
    mintedSession();
    const state = await fetchSmokeSessionStorageState({
      apiUrl: "https://api-staging.example.test",
      headers: {},
      secret: "secret",
      sessionUrl: "https://api-staging.example.test/smoke/session",
      webUrl: "https://staging.example.test",
    });

    expect(state.cookies.map(({ domain }) => domain)).toEqual([
      "staging.example.test",
      "api-staging.example.test",
    ]);
    expect(new Set(state.cookies.map(({ value }) => value))).toEqual(
      new Set(["token"]),
    );
  });

  test("keeps one cookie when the web app and the API share a host", async () => {
    mintedSession();
    const state = await fetchSmokeSessionStorageState({
      apiUrl: "https://localhost:3001",
      headers: {},
      secret: "secret",
      sessionUrl: "https://localhost:3001/smoke/session",
      webUrl: "https://localhost:3000",
    });

    expect(state.cookies.map(({ domain }) => domain)).toEqual(["localhost"]);
  });
});
