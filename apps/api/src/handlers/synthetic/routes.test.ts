import { expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import { apiPipeline } from "@/api/api-pipeline";
import { createHttpApp } from "@/api/http/app";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { createSyntheticRoute } from "./routes";

const key = `stl_syn_${"a".repeat(43)}`;
const nowMs = Date.parse("2026-10-19T12:00:00Z");
const notAfter = "2026-10-20T12:00:00Z";
const keys = [{ label: "current", sha256: sha256Hex(key), notAfter }];
const session = {
  cookieName: "session",
  cookieValue: "signed-cookie",
  expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
};
const mintRequest = (credential?: string) =>
  new Request("http://localhost/synthetic/session", {
    method: "POST",
    headers:
      credential === undefined
        ? {}
        : { "x-stella-synthetic-key": credential, "user-agent": "monitor" },
  });
// The production pipeline, so the route sees the request id every request
// carries.
const serveFor = (options: Parameters<typeof createSyntheticRoute>[0]) =>
  serveForTest(
    createHttpApp({
      routes: createSyntheticRoute(options),
      middleware: apiPipeline,
    }),
  );
const describeResponse = async (response: Response) => ({
  status: response.status,
  body: new Uint8Array(await response.arrayBuffer()),
  contentType: response.headers.get("content-type"),
});

test("configured credentials mint the session and preserve its expiry", async () => {
  const received: Parameters<
    Parameters<typeof createSyntheticRoute>[0]["mintSession"]
  >[0][] = [];
  await using server = serveFor({
    keys,
    nowMs: () => nowMs,
    reserveBudget: async () => true,
    mintSession: async (metadata) => {
      received.push(metadata);
      return session;
    },
  });
  const response = await server.fetch(mintRequest(key));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(session);
  expect(received).toEqual([
    {
      keyLabel: "current",
      requestId: expect.stringMatching(/^req_/u),
      userAgent: "monitor",
    },
  ]);
});

test("unavailable credentials have the same response as an unmounted route", async () => {
  const mintSession = async () => session;
  await using unavailable = serveFor({ keys: undefined, mintSession });
  const expected = await describeResponse(
    await unavailable.fetch(mintRequest()),
  );
  expect(expected).toEqual({
    status: 404,
    body: new Uint8Array(),
    contentType: null,
  });
  await using configured = serveFor({
    keys,
    mintSession,
    reserveBudget: async () => true,
    nowMs: () => nowMs,
  });
  await using expired = serveFor({
    keys,
    mintSession,
    nowMs: () => Date.parse(notAfter),
  });
  const cases = [
    { server: configured, credential: undefined },
    { server: configured, credential: `stl_syn_${"b".repeat(43)}` },
    { server: configured, credential: "malformed" },
    { server: expired, credential: key },
    { server: unavailable, credential: key },
  ];
  for (const { server, credential } of cases) {
    expect(
      await describeResponse(await server.fetch(mintRequest(credential))),
    ).toEqual(expected);
  }
});

test("the next configured credential is accepted during rotation", async () => {
  const next = `stl_syn_${"c".repeat(43)}`;
  await using server = serveFor({
    keys: [...keys, { label: "next", sha256: sha256Hex(next), notAfter }],
    nowMs: () => nowMs,
    reserveBudget: async () => true,
    mintSession: async ({ keyLabel }) => {
      expect(keyLabel).toBe("next");
      return session;
    },
  });
  expect((await server.fetch(mintRequest(next))).status).toBe(200);
});

test("the session budget refuses requests before minting", async () => {
  await using server = serveFor({
    keys,
    nowMs: () => nowMs,
    reserveBudget: async () => false,
    mintSession: async () => {
      throw new TypeError("Unexpected mint");
    },
  });
  expect((await server.fetch(mintRequest(key))).status).toBe(429);
});

test("disabled session controls return the unavailable response", async () => {
  await using server = serveFor({
    keys,
    nowMs: () => nowMs,
    reserveBudget: async () => true,
    mintSession: async () => null,
  });
  await using reference = serveFor({
    keys: undefined,
    mintSession: async () => null,
  });
  expect(await describeResponse(await server.fetch(mintRequest(key)))).toEqual(
    await describeResponse(await reference.fetch(mintRequest(key))),
  );
});

test("unavailable credentials ignore request body content", async () => {
  await using server = serveFor({
    keys,
    nowMs: () => nowMs,
    mintSession: async () => null,
  });
  await using reference = serveFor({
    keys: undefined,
    mintSession: async () => null,
  });
  const response = await server.fetch(
    new Request("http://localhost/synthetic/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  expect(await describeResponse(response)).toEqual(
    await describeResponse(await reference.fetch(mintRequest())),
  );
});

test("the session credential is read only from its dedicated header", async () => {
  await using server = serveFor({
    keys,
    nowMs: () => nowMs,
    mintSession: async () => {
      throw new TypeError("Unexpected mint");
    },
  });
  const response = await server.fetch(
    new Request("http://localhost/synthetic/session", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    }),
  );
  expect(response.status).toBe(404);
});
