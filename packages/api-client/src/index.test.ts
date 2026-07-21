import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { createStellaEdenClient } from "./index";

const testApi = new Elysia({ prefix: "/v1" })
  .get("/health", () => ({
    status: "ok" as const,
  }))
  .get("/timestamp", () => ({ createdAt: new Date() }));

const jsonResponse = () =>
  new Response(
    JSON.stringify({ apiContractVersion: 1, commit: "test", status: "ok" }),
    { headers: { "content-type": "application/json" } },
  );

const testFetcher = (
  handler: (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => undefined });

const getRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

describe("createStellaEdenClient", () => {
  test("targets the versioned API and includes credentials by default", async () => {
    let requestInit: RequestInit | undefined;
    let requestUrl: string | undefined;
    const api = createStellaEdenClient<typeof testApi>(
      "https://api.example.com",
      {
        fetcher: testFetcher(async (input, init) => {
          requestInit = init;
          requestUrl = getRequestUrl(input);
          return jsonResponse();
        }),
      },
    ).v1;

    await api.health.get();

    expect(requestUrl).toBe("https://api.example.com/v1/health");
    expect(requestInit?.credentials).toBe("include");
  });

  test("preserves caller transport configuration", async () => {
    let requestInit: RequestInit | undefined;
    const api = createStellaEdenClient<typeof testApi>(
      "https://api.example.com/",
      {
        fetch: { cache: "no-store", credentials: "omit" },
        fetcher: testFetcher(async (_input, init) => {
          requestInit = init;
          return jsonResponse();
        }),
        headers: { "x-client": "test" },
      },
    ).v1;

    await api.health.get();

    expect(requestInit).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      headers: { "x-client": "test" },
    });
  });

  test("resolves dynamic headers for every request", async () => {
    let session = "first";
    const requestSessions: (string | null)[] = [];
    const api = createStellaEdenClient<typeof testApi>(
      "https://api.example.com",
      {
        fetch: { credentials: "omit" },
        fetcher: testFetcher(async (_input, init) => {
          requestSessions.push(new Headers(init?.headers).get("x-session"));
          return jsonResponse();
        }),
        headers: () => ({ "x-session": session }),
      },
    ).v1;

    await api.health.get();
    session = "second";
    await api.health.get();

    expect(requestSessions).toEqual(["first", "second"]);
  });

  test("keeps serialized API timestamps as strings", async () => {
    const timestamp = "2026-07-21T19:00:00.000Z";
    const api = createStellaEdenClient<typeof testApi>(
      "https://api.example.com",
      {
        fetcher: testFetcher(
          async () =>
            new Response(JSON.stringify({ createdAt: timestamp }), {
              headers: { "content-type": "application/json" },
            }),
        ),
      },
    ).v1;

    const response = await api.timestamp.get();

    expect(String(response.data?.createdAt)).toBe(timestamp);
  });
});
