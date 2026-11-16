import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { createOutlookApiClient } from "@/lib/outlook-api-client";
import { OutlookAPIError } from "@/lib/outlook-api-error";

/** The outcome of `run`, keeping the thrown value itself as the error. */
const settle = async <T>(run: () => Promise<T>) =>
  await Result.tryPromise({ catch: (cause) => cause, try: run });

const parseAny = (input: unknown) => ({
  output: input,
  success: true as const,
});

const fakeAuth = (refreshed: string | null) => ({
  forget: mock(() => undefined),
  getAccessToken: mock(async () => await Promise.resolve("access-1")),
  refreshAfterUnauthorized: mock(
    async (_rejected: string) => await Promise.resolve(refreshed),
  ),
});

const answering = (...responses: Response[]) => {
  const authorizations: (string | null)[] = [];
  const fetch = mock(async (_input: string, init: RequestInit) => {
    authorizations.push(new Headers(init.headers).get("Authorization"));
    return await Promise.resolve(
      responses.shift() ?? new Response(null, { status: 500 }),
    );
  });
  return { authorizations, fetch };
};

describe("API client", () => {
  test("sends the bearer token to the versioned path", async () => {
    const auth = fakeAuth(null);
    const network = answering(Response.json({ ok: true }));
    const request = createOutlookApiClient({
      auth,
      baseUrl: "https://api.example.test",
      fetch: network.fetch,
    });

    expect(await request({ parse: parseAny, path: "/workspaces" })).toEqual({
      ok: true,
    });
    expect(network.fetch.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v1/workspaces",
    );
    expect(network.authorizations).toEqual(["Bearer access-1"]);
  });

  test("refreshes once after a 401 and retries with the new token", async () => {
    const auth = fakeAuth("access-2");
    const network = answering(
      new Response(null, { status: 401 }),
      Response.json({ ok: true }),
    );
    const request = createOutlookApiClient({
      auth,
      baseUrl: "https://api.example.test",
      fetch: network.fetch,
    });

    await request({ parse: parseAny, path: "/workspaces" });

    expect(auth.refreshAfterUnauthorized).toHaveBeenCalledWith("access-1");
    expect(network.authorizations).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
    expect(auth.forget).not.toHaveBeenCalled();
  });

  test("ends the session when the refreshed token is refused too", async () => {
    const auth = fakeAuth("access-2");
    const network = answering(
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    );
    const request = createOutlookApiClient({
      auth,
      baseUrl: "https://api.example.test",
      fetch: network.fetch,
    });

    const result = await settle(
      async () => await request({ parse: parseAny, path: "/workspaces" }),
    );

    expect(Result.isError(result) && result.error).toBeInstanceOf(
      OutlookAPIError,
    );
    expect(auth.forget).toHaveBeenCalledTimes(1);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  test("passes the API's refusal message through", async () => {
    const network = answering(
      Response.json({ message: "Forbidden" }, { status: 403 }),
    );
    const request = createOutlookApiClient({
      auth: fakeAuth(null),
      baseUrl: "https://api.example.test",
      fetch: network.fetch,
    });

    const result = await settle(
      async () => await request({ parse: parseAny, path: "/workspaces" }),
    );

    expect(Result.isError(result) && result.error).toMatchObject({
      message: "Forbidden",
      status: 403,
    });
  });
});
